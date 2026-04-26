// project-bots.js — Per-project Telegram bots manager.
//
// Each Drafts project (PAP) can have an attached Telegram bot.
// The bot acts as a public mini-app shell for the project + a broadcast channel.
//
// Per-bot state lives inside project.bot in drafts state.json:
//   project.bot = {
//     token: "<botfather-token>",
//     bot_id: <number>,
//     bot_username: "<string>",
//     bot_name: "<string>",         // last applied display name
//     installed_at: ISO,
//     last_synced_at: ISO|null,
//     subscribers: [tg_user_id, ...]
//   }
//
// Each bot runs an independent long-poll loop. On drafts.js startup,
// `initProjectBots()` rebuilds pollers from state.

import fs from 'fs';
import path from 'path';
import https from 'https';

// ─────────────────────────────────────────────────────────────
// Config (set by init from drafts.js)
// ─────────────────────────────────────────────────────────────
let PUBLIC_BASE = null;
let getDraftsState = null;
let saveDraftsState = null;
let findProjectByName = null;

const POLL_TIMEOUT = 25;
const SEND_THROTTLE_MS = 50; // ~20/sec, well under Telegram's 30/sec global limit

// pollers: project.name → { polling: bool, offset: number, abort?: bool }
const pollers = new Map();

// ─────────────────────────────────────────────────────────────
// Telegram HTTP client (per-bot — token passed in)
// ─────────────────────────────────────────────────────────────
function tgApi(token, method, params = {}, opts = {}) {
  if (!token) return Promise.reject(new Error('no_token'));
  const body = JSON.stringify(params);
  const reqOpts = {
    hostname: 'api.telegram.org', port: 443,
    path: `/bot${token}/${method}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: opts.timeout || 30000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            const err = new Error(parsed.description || 'tg_api_error');
            err.code = parsed.error_code;
            err.parameters = parsed.parameters;
            return reject(err);
          }
          resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tg_api_timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// Profile content extraction from project's live/index.html
// ─────────────────────────────────────────────────────────────
function readMeta(projectName) {
  // Returns { title, description, short_description } from live/index.html.
  // Falls back to project name when missing.
  const fallback = {
    title: projectName,
    short_description: 'A project on Drafts',
    description: 'Built with Drafts. Visit ' + PUBLIC_BASE + '/' + projectName + '/',
  };
  try {
    const livePath = path.join(process.env.DRAFTS_DIR || '/var/lib/drafts', projectName, 'live', 'index.html');
    if (!fs.existsSync(livePath)) return fallback;
    const html = fs.readFileSync(livePath, 'utf8');
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const descMatch = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
                  || html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const ogTitle = html.match(/<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
    const ogDesc  = html.match(/<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
    const title = (titleMatch?.[1] || ogTitle?.[1] || projectName).trim().slice(0, 64);
    const desc  = (descMatch?.[1]  || ogDesc?.[1]  || fallback.description).trim();
    const shortDesc = desc.slice(0, 120);
    const longDesc  = desc.slice(0, 510);
    return { title, short_description: shortDesc, description: longDesc };
  } catch (e) {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────
// Subscribers
// ─────────────────────────────────────────────────────────────
function addSubscriber(project, tgUserId) {
  if (!project.bot) return;
  if (!Array.isArray(project.bot.subscribers)) project.bot.subscribers = [];
  if (!project.bot.subscribers.includes(tgUserId)) {
    project.bot.subscribers.push(tgUserId);
    saveDraftsState();
  }
}

function removeSubscriber(project, tgUserId) {
  if (!project.bot || !Array.isArray(project.bot.subscribers)) return;
  const before = project.bot.subscribers.length;
  project.bot.subscribers = project.bot.subscribers.filter(id => id !== tgUserId);
  if (project.bot.subscribers.length !== before) saveDraftsState();
}

// ─────────────────────────────────────────────────────────────
// Bot per-project update handler (very minimal: /start, /stop, fallback)
// ─────────────────────────────────────────────────────────────
async function handleProjectBotUpdate(project, upd) {
  try {
    if (!upd.message || !upd.message.from || upd.message.from.is_bot) return;
    const token = project.bot?.token;
    if (!token) return;
    const chatId = upd.message.chat.id;
    const fromId = upd.message.from.id;
    const text = (upd.message.text || '').trim().toLowerCase();
    const liveUrl = PUBLIC_BASE + '/' + project.name + '/';

    if (text === '/start' || text === '/start@' + (project.bot.bot_username || '').toLowerCase()) {
      addSubscriber(project, fromId);
      const meta = readMeta(project.name);
      const html =
        '<b>' + escHtml(meta.title) + '</b>\n\n' +
        escHtml(meta.short_description) + '\n\n' +
        'Tap the menu button to open the app, or visit:\n' +
        '<a href="' + escHtml(liveUrl) + '">' + escHtml(liveUrl) + '</a>\n\n' +
        '<i>You\'ll receive updates from this project. Send /stop anytime to opt out.</i>';
      await tgApi(token, 'sendMessage', {
        chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
      }).catch(()=>{});
      return;
    }

    if (text === '/stop' || text === '/stop@' + (project.bot.bot_username || '').toLowerCase()) {
      removeSubscriber(project, fromId);
      await tgApi(token, 'sendMessage', {
        chat_id: chatId, text: '🔕 Unsubscribed. Send /start to opt back in.',
      }).catch(()=>{});
      return;
    }

    // Default: gentle nudge
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: 'Hi 👋 Open the menu button to use this app, or send /start to subscribe to updates.',
    }).catch(()=>{});
  } catch (e) {
    console.error('[project-bot:' + project.name + '] handle error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Per-project long-poll loop
// ─────────────────────────────────────────────────────────────
async function pollProjectBot(projectName) {
  const ctx = { polling: true, offset: 0, abort: false };
  pollers.set(projectName, ctx);
  console.log('[project-bot:' + projectName + '] long-polling started');

  while (ctx.polling && !ctx.abort) {
    const project = findProjectByName(projectName);
    if (!project || !project.bot || !project.bot.token) {
      console.log('[project-bot:' + projectName + '] project or bot gone, stopping poll');
      break;
    }
    try {
      const updates = await tgApi(project.bot.token, 'getUpdates', {
        offset: ctx.offset, timeout: POLL_TIMEOUT,
        allowed_updates: ['message'],
      }, { timeout: (POLL_TIMEOUT + 5) * 1000 });
      for (const upd of updates) {
        ctx.offset = Math.max(ctx.offset, upd.update_id + 1);
        await handleProjectBotUpdate(project, upd);
      }
    } catch (e) {
      if (e.code === 401) {
        console.error('[project-bot:' + projectName + '] token rejected (401), stopping');
        break;
      }
      if (e.code === 409) {
        // 409 = another getUpdates session in progress (e.g. webhook set, or duplicate poller)
        console.error('[project-bot:' + projectName + '] 409 conflict, stopping');
        break;
      }
      console.error('[project-bot:' + projectName + '] poll error:', e.message);
      await sleep(5000);
    }
  }
  pollers.delete(projectName);
  console.log('[project-bot:' + projectName + '] long-polling stopped');
}

function stopPolling(projectName) {
  const ctx = pollers.get(projectName);
  if (ctx) ctx.abort = true;
}

// ─────────────────────────────────────────────────────────────
// Profile sync (apply project metadata + chat menu button to the bot)
// ─────────────────────────────────────────────────────────────
async function applyBotProfile(project) {
  const token = project.bot?.token;
  if (!token) throw new Error('no_token');
  const liveUrl = PUBLIC_BASE + '/' + project.name + '/';
  const meta = readMeta(project.name);

  // Bot display name: use meta.title (max 64)
  // setMyName allows the same value as before — Telegram returns ok:true even if unchanged
  try { await tgApi(token, 'setMyName', { name: meta.title }); }
  catch (e) { console.warn('[project-bot:' + project.name + '] setMyName failed:', e.message); }

  try { await tgApi(token, 'setMyShortDescription', { short_description: meta.short_description }); }
  catch (e) { console.warn('[project-bot:' + project.name + '] setMyShortDescription failed:', e.message); }

  try { await tgApi(token, 'setMyDescription', { description: meta.description }); }
  catch (e) { console.warn('[project-bot:' + project.name + '] setMyDescription failed:', e.message); }

  // Chat menu button → mini-app pointing to live URL
  try {
    await tgApi(token, 'setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: meta.title.slice(0, 16) || 'Open',
        web_app: { url: liveUrl },
      },
    });
  } catch (e) {
    console.warn('[project-bot:' + project.name + '] setChatMenuButton failed:', e.message);
  }

  // Minimal commands
  try {
    await tgApi(token, 'setMyCommands', {
      commands: [
        { command: 'start', description: 'Subscribe to updates' },
        { command: 'stop',  description: 'Unsubscribe from updates' },
      ],
    });
  } catch (e) {
    console.warn('[project-bot:' + project.name + '] setMyCommands failed:', e.message);
  }

  project.bot.bot_name = meta.title;
  project.bot.last_synced_at = now();
  saveDraftsState();

  return { meta, liveUrl };
}

// ─────────────────────────────────────────────────────────────
// Broadcast to subscribers (throttled)
// ─────────────────────────────────────────────────────────────
async function broadcast(project, html) {
  const token = project.bot?.token;
  const subs = project.bot?.subscribers || [];
  if (!token || !subs.length) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const tgUserId of subs) {
    try {
      await tgApi(token, 'sendMessage', {
        chat_id: tgUserId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
      });
      sent++;
    } catch (e) {
      failed++;
      // 403 → user blocked the bot. Drop them silently.
      if (e.code === 403) {
        project.bot.subscribers = project.bot.subscribers.filter(id => id !== tgUserId);
      }
      console.warn('[project-bot:' + project.name + '] broadcast to ' + tgUserId + ' failed:', e.message);
    }
    await sleep(SEND_THROTTLE_MS);
  }
  saveDraftsState();
  return { sent, failed };
}

// ─────────────────────────────────────────────────────────────
// Public API: install / unlink / sync / status
// ─────────────────────────────────────────────────────────────
async function installBot(project, botToken) {
  if (project.bot && project.bot.token) {
    // Replacing an existing one — stop the old poller first
    stopPolling(project.name);
    await sleep(300);
  }
  // Validate token via getMe
  let me;
  try {
    me = await tgApi(botToken, 'getMe');
  } catch (e) {
    throw new Error('token_rejected_by_telegram: ' + e.message);
  }
  // Ensure no two projects share the same bot
  for (const p of getDraftsState().projects) {
    if (p.name !== project.name && p.bot?.bot_id === me.id) {
      throw new Error('bot_already_used_by_another_project');
    }
  }
  project.bot = {
    token: botToken,
    bot_id: me.id,
    bot_username: me.username,
    bot_name: me.first_name,
    installed_at: now(),
    last_synced_at: null,
    subscribers: [],
  };
  saveDraftsState();
  // Apply profile + start polling
  try { await applyBotProfile(project); } catch (e) { console.warn('initial sync failed:', e.message); }
  pollProjectBot(project.name);
  return { bot_id: me.id, bot_username: me.username, bot_name: me.first_name };
}

async function unlinkBot(project, opts = {}) {
  if (!project.bot) return { removed: false };
  const wasInstalled = !!project.bot.token;
  const subs = project.bot.subscribers || [];
  const token = project.bot.token;
  // Optionally notify subscribers before unlink
  if (opts.notify_subscribers && token && subs.length) {
    try {
      const html = '<i>This bot has been disconnected from its project. You will no longer receive updates.</i>';
      for (const id of subs) {
        await tgApi(token, 'sendMessage', { chat_id: id, text: html, parse_mode: 'HTML' }).catch(()=>{});
        await sleep(SEND_THROTTLE_MS);
      }
    } catch (e) {}
  }
  // Reset bot's chat menu button to default and clear commands so the bot
  // gracefully degrades if reused elsewhere
  if (token) {
    try { await tgApi(token, 'setChatMenuButton', { menu_button: { type: 'default' } }); } catch (e) {}
    try { await tgApi(token, 'setMyCommands', { commands: [] }); } catch (e) {}
  }
  stopPolling(project.name);
  delete project.bot;
  saveDraftsState();
  return { removed: wasInstalled };
}

async function syncBot(project, broadcastMessageHtml) {
  if (!project.bot || !project.bot.token) throw new Error('no_bot');
  const result = await applyBotProfile(project);
  let broadcastResult = { sent: 0, failed: 0, skipped: true };
  if (broadcastMessageHtml && broadcastMessageHtml.trim()) {
    broadcastResult = await broadcast(project, broadcastMessageHtml);
    broadcastResult.skipped = false;
  }
  return { meta: result.meta, live_url: result.liveUrl, broadcast: broadcastResult };
}

function getBotStatus(project) {
  if (!project.bot || !project.bot.token) return { installed: false };
  const ctx = pollers.get(project.name);
  return {
    installed: true,
    bot_id: project.bot.bot_id,
    bot_username: project.bot.bot_username,
    bot_name: project.bot.bot_name,
    installed_at: project.bot.installed_at,
    last_synced_at: project.bot.last_synced_at,
    subscriber_count: (project.bot.subscribers || []).length,
    polling: !!(ctx && ctx.polling && !ctx.abort),
  };
}

// ─────────────────────────────────────────────────────────────
// init — restart all pollers from state on drafts.js startup
// ─────────────────────────────────────────────────────────────
export function initProjectBots(opts) {
  PUBLIC_BASE = opts.publicBase;
  getDraftsState = opts.getDraftsState;
  saveDraftsState = opts.saveDraftsState;
  findProjectByName = opts.findProjectByName;

  const state = getDraftsState();
  let started = 0;
  for (const project of state.projects) {
    if (project.bot && project.bot.token) {
      pollProjectBot(project.name);
      started++;
    }
  }
  console.log('[project-bots] init complete — ' + started + ' bot poller(s) started');
}

export const projectBotsApi = {
  installBot,
  unlinkBot,
  syncBot,
  getBotStatus,
  broadcast,
  applyBotProfile,
  addSubscriber,
  removeSubscriber,
};

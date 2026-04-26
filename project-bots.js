// project-bots.js — Per-project Telegram bots manager (v0.6 — webhook forwarder).
//
// Each Drafts project (PAP) can have an attached Telegram bot. The bot acts
// as a public mini-app shell + a webhook forwarder.
//
// Two modes per project bot:
//
//   1) Webhook mode — project.bot.webhook_url is set:
//      Drafts long-polls Telegram for updates and POSTs each update to
//      webhook_url. The user hosts their bot logic anywhere (Vercel,
//      Cloudflare Workers, Render, their VPS) and replies to Telegram
//      directly using their own bot token. Drafts is a pure pipe.
//
//   2) Default mode — webhook_url is NOT set:
//      Drafts handles a minimal built-in flow: /start subscribes the user,
//      /stop unsubscribes, anything else gets a polite nudge. The owner
//      can broadcast updates via the WebApp dashboard.
//
// Per-bot state in project.bot:
//   token, bot_id, bot_username, bot_name, installed_at, last_synced_at,
//   subscribers, webhook_url, webhook_log
//
// webhook_log = ring buffer of last N calls:
//   [{ at: ISO, update_id, status, latency_ms, error?: string }]

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { URL as NodeURL } from 'url';

// ─────────────────────────────────────────────────────────────
// Config (set by init from drafts.js)
// ─────────────────────────────────────────────────────────────
let PUBLIC_BASE = null;
let getDraftsState = null;
let saveDraftsState = null;
let findProjectByName = null;

const POLL_TIMEOUT = 25;
const SEND_THROTTLE_MS = 50; // ~20/sec, well under Telegram's 30/sec global limit
const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_RETRY_DELAY_MS = 2000;
const WEBHOOK_LOG_MAX = 20;

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
// Webhook URL validation
// ─────────────────────────────────────────────────────────────
function validateWebhookUrl(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'empty' };
  let u;
  try { u = new NodeURL(raw.trim()); }
  catch (e) { return { ok: false, error: 'invalid_url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'must_be_http_or_https' };
  }
  // Block private/loopback addresses to prevent SSRF abuse
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
    return { ok: false, error: 'localhost_not_allowed' };
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return { ok: false, error: 'private_ip_not_allowed' };
  }
  if (/^169\.254\./.test(host)) return { ok: false, error: 'link_local_not_allowed' };
  if (host.endsWith('.internal') || host.endsWith('.local')) return { ok: false, error: 'internal_tld_not_allowed' };
  // Block our own host so users don't accidentally loop back
  try {
    const ourHost = new NodeURL(PUBLIC_BASE).hostname.toLowerCase();
    if (host === ourHost) return { ok: false, error: 'cannot_target_drafts_itself' };
  } catch (e) {}
  return { ok: true, url: u.toString() };
}

// ─────────────────────────────────────────────────────────────
// Webhook forwarder — POSTs a Telegram update to user's URL
// ─────────────────────────────────────────────────────────────
function forwardToWebhook(webhookUrl, update, headers = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let resolved = false;
    const finish = (out) => { if (!resolved) { resolved = true; resolve({ ...out, latency_ms: Date.now() - startTime }); } };
    let url;
    try { url = new NodeURL(webhookUrl); } catch (e) { return finish({ ok: false, error: 'invalid_url' }); }
    const body = JSON.stringify(update);
    const lib = url.protocol === 'https:' ? https : http;
    const reqOpts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: (url.pathname || '/') + (url.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Drafts-Webhook-Forwarder/0.6',
        ...headers,
      },
      timeout: WEBHOOK_TIMEOUT_MS,
    };
    const req = lib.request(reqOpts, (res) => {
      // Drain the body but cap it (we don't actually use it; user replies via Telegram API directly)
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; if (bytes > 65536) res.destroy(); });
      res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); finish({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => finish({ ok: false, error: e.message || 'network_error' }));
    req.write(body);
    req.end();
  });
}

function appendWebhookLog(project, entry) {
  if (!project.bot) return;
  if (!Array.isArray(project.bot.webhook_log)) project.bot.webhook_log = [];
  project.bot.webhook_log.unshift(entry);
  if (project.bot.webhook_log.length > WEBHOOK_LOG_MAX) {
    project.bot.webhook_log.length = WEBHOOK_LOG_MAX;
  }
  saveDraftsState();
}

// ─────────────────────────────────────────────────────────────
// Profile content extraction from project's live/index.html
// ─────────────────────────────────────────────────────────────
function readMeta(projectName) {
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
// Subscribers (only used in default mode, when no webhook_url)
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
// Default mode handler (no webhook_url) — minimal /start, /stop
// ─────────────────────────────────────────────────────────────
async function handleDefaultModeUpdate(project, upd) {
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
    console.error('[project-bot:' + project.name + '] default-mode handle error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Webhook mode handler — forward update to user's URL
// ─────────────────────────────────────────────────────────────
async function handleWebhookModeUpdate(project, upd) {
  const url = project.bot.webhook_url;
  const headers = {
    'X-Drafts-Project': project.name,
    'X-Drafts-Update-Id': String(upd.update_id || ''),
    'X-Drafts-Bot-Username': '@' + (project.bot.bot_username || ''),
  };
  let result = await forwardToWebhook(url, upd, headers);
  // Retry once on failure
  if (!result.ok) {
    await sleep(WEBHOOK_RETRY_DELAY_MS);
    result = await forwardToWebhook(url, upd, headers);
  }
  appendWebhookLog(project, {
    at: now(),
    update_id: upd.update_id,
    status: result.status || 0,
    latency_ms: result.latency_ms || 0,
    error: result.error || null,
  });
}

// ─────────────────────────────────────────────────────────────
// Update dispatcher — picks mode based on webhook_url presence
// ─────────────────────────────────────────────────────────────
async function dispatchUpdate(project, upd) {
  if (project.bot?.webhook_url) {
    await handleWebhookModeUpdate(project, upd);
  } else {
    await handleDefaultModeUpdate(project, upd);
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
      // In webhook mode, request all update types so user gets the full picture.
      // In default mode, only message (we only handle /start, /stop).
      const allowed = project.bot.webhook_url
        ? ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'inline_query', 'chosen_inline_result', 'shipping_query', 'pre_checkout_query', 'poll', 'poll_answer', 'my_chat_member', 'chat_member', 'chat_join_request']
        : ['message'];
      const updates = await tgApi(project.bot.token, 'getUpdates', {
        offset: ctx.offset, timeout: POLL_TIMEOUT,
        allowed_updates: allowed,
      }, { timeout: (POLL_TIMEOUT + 5) * 1000 });
      for (const upd of updates) {
        ctx.offset = Math.max(ctx.offset, upd.update_id + 1);
        // Don't await — fire-and-forget so slow webhook doesn't block polling
        dispatchUpdate(project, upd).catch(e =>
          console.error('[project-bot:' + projectName + '] dispatch error:', e.message)
        );
      }
    } catch (e) {
      if (e.code === 401) {
        console.error('[project-bot:' + projectName + '] token rejected (401), stopping');
        break;
      }
      if (e.code === 409) {
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

function restartPolling(projectName) {
  // Stop existing, wait briefly, restart with fresh context
  stopPolling(projectName);
  setTimeout(() => {
    const project = findProjectByName(projectName);
    if (project && project.bot && project.bot.token && !pollers.has(projectName)) {
      pollProjectBot(projectName);
    }
  }, 1000);
}

// ─────────────────────────────────────────────────────────────
// Profile sync (apply project metadata + chat menu button to the bot)
// ─────────────────────────────────────────────────────────────
async function applyBotProfile(project) {
  const token = project.bot?.token;
  if (!token) throw new Error('no_token');
  const liveUrl = PUBLIC_BASE + '/' + project.name + '/';
  const meta = readMeta(project.name);

  try { await tgApi(token, 'setMyName', { name: meta.title }); }
  catch (e) { console.warn('[project-bot:' + project.name + '] setMyName failed:', e.message); }

  try { await tgApi(token, 'setMyShortDescription', { short_description: meta.short_description }); }
  catch (e) { console.warn('[project-bot:' + project.name + '] setMyShortDescription failed:', e.message); }

  try { await tgApi(token, 'setMyDescription', { description: meta.description }); }
  catch (e) { console.warn('[project-bot:' + project.name + '] setMyDescription failed:', e.message); }

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

  // In webhook mode, leave commands empty — user's webhook handler manages them.
  // In default mode, set our minimal commands.
  if (!project.bot.webhook_url) {
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
  } else {
    // Clear commands in webhook mode so user can set their own via setMyCommands from their handler
    try { await tgApi(token, 'setMyCommands', { commands: [] }); } catch (e) {}
  }

  project.bot.bot_name = meta.title;
  project.bot.last_synced_at = now();
  saveDraftsState();

  return { meta, liveUrl };
}

// ─────────────────────────────────────────────────────────────
// Broadcast to subscribers (default mode only)
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
// Public API: install / unlink / sync / status / setWebhookUrl
// ─────────────────────────────────────────────────────────────
async function installBot(project, botToken, opts = {}) {
  if (project.bot && project.bot.token) {
    stopPolling(project.name);
    await sleep(300);
  }
  let me;
  try {
    me = await tgApi(botToken, 'getMe');
  } catch (e) {
    throw new Error('token_rejected_by_telegram: ' + e.message);
  }
  for (const p of getDraftsState().projects) {
    if (p.name !== project.name && p.bot?.bot_id === me.id) {
      throw new Error('bot_already_used_by_another_project');
    }
  }
  // Validate webhook URL if provided at install time
  let validatedWebhook = null;
  if (opts.webhook_url) {
    const v = validateWebhookUrl(opts.webhook_url);
    if (!v.ok) throw new Error('invalid_webhook_url: ' + v.error);
    validatedWebhook = v.url;
  }
  project.bot = {
    token: botToken,
    bot_id: me.id,
    bot_username: me.username,
    bot_name: me.first_name,
    installed_at: now(),
    last_synced_at: null,
    subscribers: [],
    webhook_url: validatedWebhook,
    webhook_log: [],
  };
  saveDraftsState();
  try { await applyBotProfile(project); } catch (e) { console.warn('initial sync failed:', e.message); }
  pollProjectBot(project.name);
  return { bot_id: me.id, bot_username: me.username, bot_name: me.first_name, webhook_url: validatedWebhook };
}

async function unlinkBot(project, opts = {}) {
  if (!project.bot) return { removed: false };
  const wasInstalled = !!project.bot.token;
  const subs = project.bot.subscribers || [];
  const token = project.bot.token;
  if (opts.notify_subscribers && token && subs.length) {
    try {
      const html = '<i>This bot has been disconnected from its project. You will no longer receive updates.</i>';
      for (const id of subs) {
        await tgApi(token, 'sendMessage', { chat_id: id, text: html, parse_mode: 'HTML' }).catch(()=>{});
        await sleep(SEND_THROTTLE_MS);
      }
    } catch (e) {}
  }
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
  // Broadcast only works in default mode (webhook mode users have their own users via webhook)
  if (broadcastMessageHtml && broadcastMessageHtml.trim() && !project.bot.webhook_url) {
    broadcastResult = await broadcast(project, broadcastMessageHtml);
    broadcastResult.skipped = false;
  }
  return { meta: result.meta, live_url: result.liveUrl, broadcast: broadcastResult };
}

// Set/clear/change webhook URL without re-installing the bot
async function setWebhookUrl(project, urlOrNull) {
  if (!project.bot || !project.bot.token) throw new Error('no_bot');
  if (urlOrNull == null || urlOrNull === '' || urlOrNull === false) {
    project.bot.webhook_url = null;
    project.bot.webhook_log = [];
    saveDraftsState();
    // Re-apply profile so commands/menu reflect default-mode posture
    try { await applyBotProfile(project); } catch (e) {}
    restartPolling(project.name);
    return { webhook_url: null };
  }
  const v = validateWebhookUrl(urlOrNull);
  if (!v.ok) throw new Error('invalid_webhook_url: ' + v.error);
  project.bot.webhook_url = v.url;
  if (!Array.isArray(project.bot.webhook_log)) project.bot.webhook_log = [];
  saveDraftsState();
  try { await applyBotProfile(project); } catch (e) {}
  restartPolling(project.name);
  return { webhook_url: v.url };
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
    webhook_url: project.bot.webhook_url || null,
    webhook_log: (project.bot.webhook_log || []).slice(0, WEBHOOK_LOG_MAX),
    mode: project.bot.webhook_url ? 'webhook' : 'default',
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
  setWebhookUrl,
  getBotStatus,
  broadcast,
  applyBotProfile,
  addSubscriber,
  removeSubscriber,
  validateWebhookUrl,
};

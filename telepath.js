// telepath.js — Drafts Telepath: control-plane Telegram bot for Drafts servers.
//
// v0.8 adds:
//   - SAP-event notifications: onDraftsBoot / onVersionBump / onSchemaMigration hooks
//   - notifySAPOnDraftsEvent() helper + notify_sap_on_drafts_event setting
//   - WebApp PAP card: GitHub repo input + autosync toggle
//   - Refreshed welcome/help texts + bot profile (name/short/long/commands)
//
// v0.7: Per-project bot analytics (summary/log/archives/wipe/toggle endpoints).

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { projectBotsApi } from './project-bots.js';
import {
  getSummary as analyticsGetSummary,
  getLogStream as analyticsGetLogStream,
  getLogStats as analyticsGetLogStats,
  getSummaryRaw as analyticsGetSummaryRaw,
  listArchives as analyticsListArchives,
  getArchiveStream as analyticsGetArchiveStream,
  wipeAnalytics as analyticsWipe,
} from './analytics.js';

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
let DRAFTS_DIR = null;
let PUBLIC_BASE = null;
let SERVER_NUMBER = 0;
let getSAP = null;
let getDraftsState = null;
let saveDraftsState = null;
let findProjectByName = null;
let findProjectByPAP = null;
let findProjectAndAAPByAAPToken = null;
let ensureProjectDirs = null;
let listVersions = null;
let serverHelpers = {};

const STATE_VERSION = 1;
const POLL_TIMEOUT  = 25;
const TAP_FILE      = '/etc/labs/drafts.tap';
const PENDING_TTL_MS = 10 * 60 * 1000;

let TAP = null;
let telepathState = null;
let polling = false;
let pollOffset = 0;
let botMeRefreshTimer = null;

const pendingCreate = new Map();

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function safeWriteJSON(filepath, data) {
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filepath);
}

function statePath() { return path.join(DRAFTS_DIR, '.telepath.json'); }

function loadState() {
  try {
    if (fs.existsSync(statePath())) {
      telepathState = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    }
  } catch (e) {
    console.error('[telepath] state load failed:', e.message);
  }
  if (!telepathState || telepathState.version !== STATE_VERSION) {
    telepathState = {
      version: STATE_VERSION,
      users: {},
      settings: {
        notify_sap_on_new_project: true,
        notify_sap_on_new_pap: true,
        notify_sap_on_drafts_event: true,
        notify_pap_on_aap_merge: true,
        notify_pap_on_main_commit: true,
      },
      installed_at: null,
    };
    persistState();
  }
  // v0.8: ensure new setting exists on previously-saved states
  if (!('notify_sap_on_drafts_event' in telepathState.settings)) {
    telepathState.settings.notify_sap_on_drafts_event = true;
    persistState();
  }
}

function persistState() {
  try {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    safeWriteJSON(statePath(), telepathState);
  } catch (e) {
    console.error('[telepath] state save failed:', e.message);
  }
}

function loadTAP() {
  try {
    if (fs.existsSync(TAP_FILE)) {
      TAP = JSON.parse(fs.readFileSync(TAP_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[telepath] TAP load failed:', e.message);
    TAP = null;
  }
}

function persistTAP() {
  try {
    fs.mkdirSync(path.dirname(TAP_FILE), { recursive: true });
    safeWriteJSON(TAP_FILE, TAP || {});
    fs.chmodSync(TAP_FILE, 0o600);
  } catch (e) {
    console.error('[telepath] TAP save failed:', e.message);
  }
}

export function getControlBotUsername() {
  return TAP && TAP.bot ? TAP.bot.username : null;
}

// ─────────────────────────────────────────────────────────────
// Telegram HTTP client (control-plane bot only)
// ─────────────────────────────────────────────────────────────
function tgApi(method, params = {}, opts = {}) {
  if (!TAP || !TAP.token) return Promise.reject(new Error('no_tap'));
  const body = JSON.stringify(params);
  const reqOpts = {
    hostname: 'api.telegram.org', port: 443,
    path: `/bot${TAP.token}/${method}`,
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

function tgSend(chatId, html, opts = {}) {
  return tgApi('sendMessage', {
    chat_id: chatId, text: html, parse_mode: 'HTML',
    disable_web_page_preview: true, ...opts,
  });
}

// ─────────────────────────────────────────────────────────────
// WebApp initData verification
// ─────────────────────────────────────────────────────────────
function verifyInitData(initDataRaw) {
  if (!initDataRaw || !TAP || !TAP.token) return null;
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k,v])=>`${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TAP.token).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;
  const auth_date = Number(params.get('auth_date') || 0);
  if (!auth_date || (Date.now()/1000 - auth_date) > 24*3600) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}
  return { user, auth_date, query_id: params.get('query_id') };
}

// ─────────────────────────────────────────────────────────────
// Token recognition
// ─────────────────────────────────────────────────────────────
function recognizeToken(text) {
  if (!text) return null;
  text = String(text).trim();
  const url = text.match(/drafts_(server|project|agent)_(\d+)_([a-f0-9]+)/i);
  if (url) {
    const tierWord = url[1].toLowerCase();
    const secret = url[3];
    if (tierWord === 'server') {
      if (secret === getSAP()) return { tier: 'sap', token: secret };
      return null;
    }
    if (tierWord === 'project') {
      const tok = 'pap_' + secret;
      const p = findProjectByPAP(tok);
      if (p) return { tier: 'pap', token: tok, project: p };
      return null;
    }
    if (tierWord === 'agent') {
      const tok = 'aap_' + secret;
      const hit = findProjectAndAAPByAAPToken(tok);
      if (hit) return { tier: 'aap', token: tok, project: hit.project, aap: hit.aap };
      return null;
    }
  }
  if (/^pap_[a-f0-9]+$/i.test(text)) {
    const p = findProjectByPAP(text);
    if (p) return { tier: 'pap', token: text, project: p };
    return null;
  }
  if (/^aap_[a-f0-9]+$/i.test(text)) {
    const hit = findProjectAndAAPByAAPToken(text);
    if (hit) return { tier: 'aap', token: text, project: hit.project, aap: hit.aap };
    return null;
  }
  if (/^[a-f0-9]{12,64}$/i.test(text) && text === getSAP()) {
    return { tier: 'sap', token: text };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// User bindings
// ─────────────────────────────────────────────────────────────
function getUser(tg_user_id) {
  return telepathState.users[String(tg_user_id)] || null;
}

function ensureUser(tgUser) {
  const id = String(tgUser.id);
  if (!telepathState.users[id]) {
    telepathState.users[id] = {
      tg_user_id: tgUser.id,
      tg_username: tgUser.username || null,
      first_name: tgUser.first_name || null,
      is_premium: !!tgUser.is_premium,
      bindings: [],
      notif_subscribed: true,
      created_at: now(),
    };
  } else {
    telepathState.users[id].tg_username = tgUser.username || telepathState.users[id].tg_username;
    telepathState.users[id].first_name = tgUser.first_name || telepathState.users[id].first_name;
    telepathState.users[id].is_premium = !!tgUser.is_premium;
  }
  return telepathState.users[id];
}

function bindToken(tg_user_id, recognized) {
  const user = telepathState.users[String(tg_user_id)];
  if (!user) return;
  user.bindings = user.bindings.filter(b => b.token !== recognized.token);
  user.bindings.push({
    tier: recognized.tier,
    token: recognized.token,
    project_name: recognized.project ? recognized.project.name : null,
    aap_id: recognized.aap ? recognized.aap.id : null,
    bound_at: now(),
  });
  persistState();
}

function unbindToken(tg_user_id, token) {
  const user = telepathState.users[String(tg_user_id)];
  if (!user) return false;
  const before = user.bindings.length;
  user.bindings = user.bindings.filter(b => b.token !== token);
  persistState();
  return user.bindings.length < before;
}

function findUsersBoundToTier(tier) {
  const out = [];
  for (const [id, u] of Object.entries(telepathState.users)) {
    if (u.bindings.some(b => b.tier === tier)) out.push(u);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Premium gate
// ─────────────────────────────────────────────────────────────
function isAllowed(tgFrom, user) {
  if (tgFrom && tgFrom.is_premium) return true;
  if (user && user.bindings.some(b => b.tier === 'sap')) return true;
  return false;
}

const PREMIUM_REFUSAL =
  '<b>Premium only ✨</b>\n\n' +
  'Drafts is free, but you need Telegram Premium to use it.\n' +
  'Upgrade in Telegram Settings → Premium.';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function webAppUrl(suffix) { return PUBLIC_BASE + '/telepath/app/' + suffix; }
function publicHostname() {
  try { return new URL(PUBLIC_BASE).hostname; } catch (e) { return 'this server'; }
}
function tierBadge(tier) {
  return { sap: '🔑 server', pap: '📁 project', aap: '🤝 agent' }[tier] || tier;
}

// v0.8: refreshed welcome
function welcomeText(user) {
  const name = user && user.first_name ? user.first_name : 'there';
  let t = `<b>Drafts</b> ✦ build by talking to Claude\n\n`;
  t += `gm ${esc(name)} 👋\n\n`;
  t += `here's the deal:\n`;
  t += `1. tap <b>/new</b> — pick a name, get a project\n`;
  t += `2. open the <b>pass-link</b> with Claude\n`;
  t += `3. tell Claude what to build — it ships\n\n`;
  t += `every project gets a live URL, version history, and an optional Telegram bot with analytics.\n\n`;
  t += `ready? → /new`;
  return t;
}

// v0.8: refreshed help
function helpText() {
  let t = '<b>how Drafts works</b>\n\n';
  t += '<b>/new</b> — make a project. you get a name, a live URL, and a pass-link.\n\n';
  t += 'open the pass-link in Claude (browser or Chrome extension). Claude reads what is there and builds whatever you ask. each commit auto-saves a version.\n\n';
  t += '<b>/projects</b> — see what you got. tap any to open the dashboard.\n\n';
  t += 'from the dashboard you can:\n';
  t += '· share with collaborators (agents)\n';
  t += '· attach a Telegram bot to your project\n';
  t += '· forward bot messages to your own webhook\n';
  t += '· see analytics: users, languages, countries, peak hours\n';
  t += '· download all data as JSON anytime\n';
  t += '· enable GitHub auto-sync\n\n';
  t += 'need a bot? → @BotFather → /newbot → paste token in dashboard\n\n';
  t += 'stuck? press /start.';
  return t;
}

function projectsListText(user) {
  if (!user || user.bindings.length === 0) {
    return 'nothing here yet. /new to start ✨';
  }
  let t = '<b>your stuff</b>\n\n';
  for (const b of user.bindings) {
    t += `${tierBadge(b.tier)}`;
    if (b.project_name) t += ` · <code>${esc(b.project_name)}</code>`;
    t += `\n`;
  }
  return t;
}

function dashboardKeyboardForBinding(binding) {
  let url, label;
  if (binding.tier === 'sap') {
    url = webAppUrl('sap');
    label = '🔑 server admin';
  } else if (binding.tier === 'pap') {
    url = webAppUrl('pap/' + binding.token);
    label = '✨ open ' + (binding.project_name || 'project');
  } else if (binding.tier === 'aap') {
    url = webAppUrl('aap/' + binding.token);
    label = '🤝 open agent';
  }
  return [[{ text: label, web_app: { url } }]];
}

// ─────────────────────────────────────────────────────────────
// /new flow
// ─────────────────────────────────────────────────────────────
function validateProjectName(raw) {
  const name = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
  if (!name) return { ok: false, error: 'empty' };
  if (name.length < 2) return { ok: false, error: 'too_short' };
  if (/^[-_]/.test(name) || /[-_]$/.test(name)) return { ok: false, error: 'edge_separators' };
  return { ok: true, name };
}

function previewUrl(name) { return PUBLIC_BASE + '/' + name + '/'; }

async function sendNewPrompt(chatId) {
  const exampleHost = publicHostname();
  const html =
    '<b>name your project</b>\n\n' +
    'send a name as your next message ✏️\n\n' +
    `it'll live at <code>${esc(exampleHost)}/&lt;name&gt;/</code>\n\n` +
    '<i>a–z, 0–9, <code>-</code>, <code>_</code> · 2–40 chars</i>';
  await tgSend(chatId, html, {
    reply_markup: { inline_keyboard: [[{ text: '✕ cancel', callback_data: 'new:cancel' }]] },
  });
}

async function sendNewPreview(chatId, name) {
  const url = previewUrl(name);
  const html =
    '<b>looks good?</b>\n\n' +
    `<code>${esc(name)}</code>\n` +
    `→ <a href="${esc(url)}">${esc(url)}</a>`;
  await tgSend(chatId, html, {
    reply_markup: { inline_keyboard: [
      [{ text: '✓ create', callback_data: 'new:confirm:' + name }],
      [{ text: '✎ rename', callback_data: 'new:rename' }, { text: '✕ cancel', callback_data: 'new:cancel' }],
    ]},
  });
}

function setPending(tgUserId) {
  pendingCreate.set(tgUserId, { expires_at: Date.now() + PENDING_TTL_MS });
}
function clearPending(tgUserId) { pendingCreate.delete(tgUserId); }
function getPending(tgUserId) {
  const p = pendingCreate.get(tgUserId);
  if (!p) return null;
  if (Date.now() > p.expires_at) { pendingCreate.delete(tgUserId); return null; }
  return p;
}

async function actuallyCreateProject(chatId, user, name) {
  if (!serverHelpers.createProject) {
    return await tgSend(chatId, 'oops, internal error.');
  }
  const owner = user.tg_username || user.first_name || ('user_' + user.tg_user_id);
  try {
    const res = await serverHelpers.createProject({ name, description: 'Created via Telepath by ' + owner });
    bindToken(user.tg_user_id, { tier: 'pap', token: res.pap_token, project: { name: res.project } });
    const html =
      '🎉 <b>it\'s yours</b>\n\n' +
      `<code>${esc(res.project)}</code>\n` +
      `→ <a href="${esc(res.live_url)}">${esc(res.live_url)}</a>\n\n` +
      'tap below to open the dashboard, then talk to Claude to build.';
    await tgSend(chatId, html, {
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({ tier: 'pap', token: res.pap_token, project_name: res.project }) },
    });
    notifySAPOwners(`🆕 new project: <code>${esc(res.project)}</code> by ${esc(owner)}`);
  } catch (e) {
    let msg = 'failed: ' + esc(e.message);
    if (e.message === 'exists') msg = `<code>${esc(name)}</code> is taken — try another with /new`;
    if (e.message === 'reserved_name') msg = `<code>${esc(name)}</code> is reserved — try another with /new`;
    if (e.message === 'invalid_name') msg = 'invalid name. a–z, 0–9, <code>-</code>, <code>_</code>. 2–40 chars.';
    await tgSend(chatId, msg);
  }
}

// ─────────────────────────────────────────────────────────────
// Update handler
// ─────────────────────────────────────────────────────────────
async function handleUpdate(upd) {
  try {
    if (upd.message) await handleMessage(upd.message);
    else if (upd.callback_query) await handleCallback(upd.callback_query);
  } catch (e) {
    console.error('[telepath] handleUpdate error:', e.message);
  }
}

async function handleMessage(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const user = ensureUser(msg.from);

  const recogPreview = recognizeToken(text);
  const isSapBindingAttempt = recogPreview && recogPreview.tier === 'sap';

  if (!isAllowed(msg.from, user) && !isSapBindingAttempt) {
    return await tgSend(chatId, PREMIUM_REFUSAL);
  }

  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    if (cmd !== '/new') clearPending(msg.from.id);

    if (cmd === '/start')    return await sendStart(chatId, user);
    if (cmd === '/help')     return await sendHelp(chatId);
    if (cmd === '/projects') return await sendProjects(chatId, user);
    if (cmd === '/forget')   return await sendForgetMenu(chatId, user);
    if (cmd === '/new')      return await handleNewCommand(chatId, user, parts.slice(1).join(' '));
    if (cmd === '/cancel') {
      if (getPending(msg.from.id)) { clearPending(msg.from.id); return await tgSend(chatId, 'cancelled.'); }
      return await tgSend(chatId, 'nothing to cancel.');
    }
    if (cmd === '/notif') {
      const arg = parts[1];
      if (arg === 'off') { user.notif_subscribed = false; persistState(); return await tgSend(chatId, '🔕 notifications off'); }
      if (arg === 'on')  { user.notif_subscribed = true;  persistState(); return await tgSend(chatId, '🔔 notifications on'); }
      return await tgSend(chatId, '<code>/notif on</code> or <code>/notif off</code>\nnow: '+(user.notif_subscribed?'on':'off'));
    }
    return await tgSend(chatId, "didn't catch that. /help");
  }

  const recog = recognizeToken(text);
  if (recog) {
    clearPending(msg.from.id);
    bindToken(msg.from.id, recog);
    let body = '✅ ' + tierBadge(recog.tier);
    if (recog.project) body += ' · <code>' + esc(recog.project.name) + '</code>';
    body += '\n\ntap to open ↓';
    return await tgSend(chatId, body, {
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({
        tier: recog.tier, token: recog.token, project_name: recog.project?.name,
      }) },
    });
  }

  if (getPending(msg.from.id)) {
    const v = validateProjectName(text);
    if (!v.ok) {
      const explain = v.error === 'empty' ? "that's empty."
        : v.error === 'too_short' ? 'too short (min 2 chars).'
        : v.error === 'edge_separators' ? "can't start/end with <code>-</code> or <code>_</code>."
        : 'invalid.';
      return await tgSend(chatId,
        explain + ' try again or /cancel.\n\n<i>a–z, 0–9, <code>-</code>, <code>_</code>. 2–40 chars.</i>'
      );
    }
    if (findProjectByName(v.name)) {
      return await tgSend(chatId,
        `<code>${esc(v.name)}</code> is taken. try another or /cancel.`
      );
    }
    clearPending(msg.from.id);
    return await sendNewPreview(chatId, v.name);
  }

  await tgSend(chatId,
    "didn't catch that.\n\n/new to make one, or paste a <code>pap_…</code> / <code>aap_…</code>"
  );
}

async function handleNewCommand(chatId, user, requestedName) {
  if (requestedName && requestedName.trim()) {
    const v = validateProjectName(requestedName);
    if (!v.ok) {
      const explain = v.error === 'too_short' ? 'too short.'
        : v.error === 'edge_separators' ? "can't start/end with <code>-</code> or <code>_</code>."
        : 'bad chars.';
      await tgSend(chatId, explain + ' try /new with another name.');
      return;
    }
    if (findProjectByName(v.name)) {
      return await tgSend(chatId, `<code>${esc(v.name)}</code> is taken.`);
    }
    return await sendNewPreview(chatId, v.name);
  }
  setPending(user.tg_user_id);
  await sendNewPrompt(chatId);
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || '';
  const user = ensureUser(cq.from);

  if (!isAllowed(cq.from, user)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'Premium only', show_alert: true });
    return;
  }

  if (data.startsWith('forget:')) {
    const tok = data.slice(7);
    const ok = unbindToken(cq.from.id, tok);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: ok ? 'gone.' : 'not found' });
    if (ok) await tgSend(chatId, 'forgotten.');
    return;
  }

  if (data === 'new:cancel') {
    clearPending(cq.from.id);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'cancelled' });
    try { await tgApi('editMessageText', {
      chat_id: chatId, message_id: cq.message.message_id,
      text: '✕ cancelled', parse_mode: 'HTML',
    }); } catch (e) {}
    return;
  }

  if (data === 'new:rename') {
    setPending(cq.from.id);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
    try { await tgApi('editMessageText', {
      chat_id: chatId, message_id: cq.message.message_id,
      text: '✏️ send a new name as your next message',
      parse_mode: 'HTML',
    }); } catch (e) {}
    return;
  }

  if (data.startsWith('new:confirm:')) {
    const name = data.slice('new:confirm:'.length);
    const v = validateProjectName(name);
    if (!v.ok) {
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'invalid name', show_alert: true });
      return;
    }
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'creating...' });
    try { await tgApi('editMessageText', {
      chat_id: chatId, message_id: cq.message.message_id,
      text: `⏳ creating <code>${esc(v.name)}</code>...`, parse_mode: 'HTML',
    }); } catch (e) {}
    await actuallyCreateProject(chatId, user, v.name);
    return;
  }

  await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
}

async function sendStart(chatId, user) { await tgSend(chatId, welcomeText(user)); }
async function sendHelp(chatId) { await tgSend(chatId, helpText()); }
async function sendProjects(chatId, user) {
  const text = projectsListText(user);
  const kb = (user?.bindings || []).slice(0, 8).flatMap(b => dashboardKeyboardForBinding(b));
  await tgSend(chatId, text, { reply_markup: kb.length ? { inline_keyboard: kb } : undefined });
}
async function sendForgetMenu(chatId, user) {
  if (!user || !user.bindings.length) {
    return await tgSend(chatId, 'nothing to forget');
  }
  const kb = user.bindings.map(b => [{
    text: 'forget ' + tierBadge(b.tier) + (b.project_name ? ' · ' + b.project_name : ''),
    callback_data: 'forget:' + b.token,
  }]);
  await tgSend(chatId, 'pick one to forget:', { reply_markup: { inline_keyboard: kb } });
}

// ─────────────────────────────────────────────────────────────
// Long polling
// ─────────────────────────────────────────────────────────────
async function pollLoop() {
  if (polling) return;
  polling = true;
  console.log('[telepath] long-polling started');
  while (polling && TAP && TAP.token) {
    try {
      const updates = await tgApi('getUpdates', {
        offset: pollOffset, timeout: POLL_TIMEOUT,
        allowed_updates: ['message', 'callback_query'],
      }, { timeout: (POLL_TIMEOUT + 5) * 1000 });
      for (const upd of updates) {
        pollOffset = Math.max(pollOffset, upd.update_id + 1);
        await handleUpdate(upd);
      }
    } catch (e) {
      if (e.code === 401) {
        console.error('[telepath] bot token rejected (401). Stopping polling.');
        polling = false;
        break;
      }
      console.error('[telepath] poll error:', e.message);
      await sleep(5000);
    }
  }
  console.log('[telepath] long-polling stopped');
}

function stopPolling() { polling = false; }

async function refreshBotMe() {
  if (!TAP || !TAP.token) return;
  try {
    const me = await tgApi('getMe');
    TAP.bot = { id: me.id, username: me.username, first_name: me.first_name };
    persistTAP();
  } catch (e) {
    console.error('[telepath] getMe failed:', e.message);
  }
}

// v0.8: refreshed bot profile (matches what Telegram API was set to)
async function configureBotProfile() {
  if (!TAP || !TAP.token) return;
  const commands = [
    { command: 'new',      description: '✨ start a project' },
    { command: 'projects', description: '📁 your projects' },
    { command: 'help',     description: '💡 how it works' },
    { command: 'notif',    description: '🔔 notifications on/off' },
    { command: 'forget',   description: '🗑 drop a token' },
    { command: 'cancel',   description: 'cancel current action' },
    { command: 'start',    description: 'welcome' },
  ];
  const name = 'Drafts';
  const shortDesc = 'Build websites, mini-apps, and Telegram bots by talking to Claude. No code. Premium only.';
  const longDesc =
    'Drafts turns Telegram into your build space.\n\n' +
    '/new makes a project — you get a live URL and a link for Claude. Tell Claude what to build, it ships. Every change is auto-versioned, so nothing is ever lost.\n\n' +
    'Want a Telegram bot for your project? Tap link bot in the dashboard — you get a custom @bot in seconds, with full analytics on who is using it.\n\n' +
    'Premium-only. Free to use forever.';
  try {
    await tgApi('setMyName', { name });
    await tgApi('setMyCommands', { commands });
    await tgApi('setMyShortDescription', { short_description: shortDesc });
    await tgApi('setMyDescription', { description: longDesc });
    console.log('[telepath] bot profile configured (v0.8)');
  } catch (e) {
    console.error('[telepath] configureBotProfile error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Notification dispatchers
// ─────────────────────────────────────────────────────────────
function notifySAPOwners(html) {
  if (!TAP) return;
  const subs = findUsersBoundToTier('sap').filter(u => u.notif_subscribed);
  for (const u of subs) {
    tgSend(u.tg_user_id, html).catch(e => console.error('[telepath] notify SAP failed:', e.message));
  }
}

// v0.8: dedicated channel for drafts internal events (boot/version/migration/errors)
function notifySAPOnDraftsEvent(html) {
  if (!TAP) return;
  if (!telepathState || !telepathState.settings.notify_sap_on_drafts_event) return;
  notifySAPOwners(html);
}

function notifyPAPOwners(projectName, html) {
  if (!TAP) return;
  const subs = Object.values(telepathState.users).filter(u =>
    u.notif_subscribed && u.bindings.some(b => b.tier === 'pap' && b.project_name === projectName)
  );
  for (const u of subs) {
    tgSend(u.tg_user_id, html).catch(e => console.error('[telepath] notify PAP failed:', e.message));
  }
}

function onNewProject(project) {
  if (!telepathState.settings.notify_sap_on_new_project) return;
  notifySAPOwners(`🆕 <code>${esc(project.name)}</code>`);
}
function onNewAAPCreated(project, aap) {
  notifyPAPOwners(project.name, `🤝 new agent on <code>${esc(project.name)}</code>: ${esc(aap.name || aap.id)}`);
}
function onAAPMerged(project, aap, versionN) {
  if (!telepathState.settings.notify_pap_on_aap_merge) return;
  notifyPAPOwners(project.name, `✅ merged into <code>${esc(project.name)}</code> · v${versionN}`);
}
function onMainCommit(project, commit, versionN) {
  if (!telepathState.settings.notify_pap_on_main_commit) return;
  const msg = (commit?.summary?.changes || commit?.commit || '').toString().slice(0, 80);
  notifyPAPOwners(project.name, `📝 <code>${esc(project.name)}</code> v${versionN}: ${esc(msg || 'commit')}`);
}

// v0.8: drafts internal event hooks
function onDraftsBoot(version, info) {
  const { projectCount = 0, botCount = 0, firstBoot = false } = info || {};
  const head = firstBoot ? `🚀 <b>drafts ${esc(version)}</b> · first boot` : `🟢 <b>drafts ${esc(version)}</b> · online`;
  const body = `\n${projectCount} project${projectCount===1?'':'s'} · ${botCount} bot${botCount===1?'':'s'}`;
  notifySAPOnDraftsEvent(head + body);
}
function onVersionBump(oldV, newV, info) {
  const { projectCount = 0, botCount = 0 } = info || {};
  const html = `⬆️ <b>drafts upgraded</b>\n${esc(oldV)} → <b>${esc(newV)}</b>\n${projectCount} project${projectCount===1?'':'s'} · ${botCount} bot${botCount===1?'':'s'}`;
  notifySAPOnDraftsEvent(html);
}
function onSchemaMigration(description) {
  notifySAPOnDraftsEvent(`🔧 <b>schema migration</b>\n${esc(description || 'completed')}`);
}

// ─────────────────────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────────────────────
function mountRoutes(app) {
  // ── TAP management (control bot) ──
  app.get('/drafts/tap', requireSAP, (req, res) => {
    if (!TAP) return res.json({ ok: true, installed: false });
    res.json({ ok: true, installed: true, bot: TAP.bot || null, installed_at: TAP.installed_at || null, polling });
  });

  app.put('/drafts/tap', requireSAP, async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return res.status(400).json({ ok: false, error: 'invalid_token_format' });
    }
    const oldTAP = TAP;
    TAP = { token };
    try {
      const me = await tgApi('getMe');
      TAP = { token, bot: { id: me.id, username: me.username, first_name: me.first_name }, installed_at: now() };
      persistTAP();
      stopPolling();
      await sleep(500);
      pollLoop();
      configureBotProfile().catch(()=>{});
      res.json({ ok: true, bot: TAP.bot });
    } catch (e) {
      TAP = oldTAP;
      res.status(400).json({ ok: false, error: 'token_rejected_by_telegram', detail: e.message });
    }
  });

  app.delete('/drafts/tap', requireSAP, (req, res) => {
    stopPolling();
    TAP = null;
    try { fs.unlinkSync(TAP_FILE); } catch (e) {}
    res.json({ ok: true, removed: true });
  });

  app.put('/drafts/tap/settings', requireSAP, (req, res) => {
    const allowed = [
      'notify_sap_on_new_project',
      'notify_sap_on_new_pap',
      'notify_sap_on_drafts_event',
      'notify_pap_on_aap_merge',
      'notify_pap_on_main_commit',
    ];
    for (const k of allowed) if (k in req.body) telepathState.settings[k] = !!req.body[k];
    persistState();
    res.json({ ok: true, settings: telepathState.settings });
  });

  app.post('/drafts/tap/configure', requireSAP, async (req, res) => {
    try { await configureBotProfile(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── WebApp pages ──
  app.get('/telepath/app/sap',           (req, res) => res.type('html').send(renderWebAppShell('sap')));
  app.get('/telepath/app/pap/:token',    (req, res) => res.type('html').send(renderWebAppShell('pap', req.params.token)));
  app.get('/telepath/app/aap/:token',    (req, res) => res.type('html').send(renderWebAppShell('aap', req.params.token)));

  // ── WebApp API ──
  app.post('/telepath/api/whoami', initDataAuth, (req, res) => {
    res.json({ ok: true, tg_user: req.tgUser });
  });

  app.get('/telepath/api/state/:tier/:token?', initDataAuth, (req, res) => {
    const tier = req.params.tier;
    const token = req.params.token;
    if (tier === 'sap') {
      const u = getUser(req.tgUser.id);
      if (!u || !u.bindings.some(b => b.tier === 'sap')) return res.status(403).json({ ok: false, error: 'no_sap_binding' });
      const projects = getDraftsState().projects.map(p => ({
        name: p.name, description: p.description, github_repo: p.github_repo,
        created_at: p.created_at,
        pap_active: !!(p.pap && !p.pap.revoked),
        aap_count: (p.aaps || []).filter(a => !a.revoked).length,
        bot_attached: !!(p.bot && p.bot.token),
        bot_username: p.bot?.bot_username || null,
        bot_mode: p.bot?.webhook_url ? 'webhook' : (p.bot ? 'default' : null),
      }));
      return res.json({ ok: true, tier: 'sap', server_number: SERVER_NUMBER, public_base: PUBLIC_BASE, projects, settings: telepathState.settings });
    }
    if (tier === 'pap') {
      const u = getUser(req.tgUser.id);
      if (!u || !u.bindings.some(b => b.token === token && b.tier === 'pap')) return res.status(403).json({ ok: false, error: 'not_bound' });
      const p = findProjectByPAP(token);
      if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
      return res.json({ ok: true, tier: 'pap', public_base: PUBLIC_BASE, project: {
        name: p.name, description: p.description, github_repo: p.github_repo,
        github_autosync: !!p.github_autosync,
        created_at: p.created_at, live_url: PUBLIC_BASE + '/' + p.name + '/',
        pass_url: PUBLIC_BASE + '/drafts/pass/drafts_project_' + SERVER_NUMBER + '_' + token.replace(/^pap_/,''),
        aaps: (p.aaps || []).map(a => ({ id: a.id, name: a.name, revoked: a.revoked, branch: a.branch })),
        bot: projectBotsApi.getBotStatus(p),
      }});
    }
    if (tier === 'aap') {
      const u = getUser(req.tgUser.id);
      if (!u || !u.bindings.some(b => b.token === token && b.tier === 'aap')) return res.status(403).json({ ok: false, error: 'not_bound' });
      const hit = findProjectAndAAPByAAPToken(token);
      if (!hit) return res.status(404).json({ ok: false, error: 'aap_not_found' });
      return res.json({ ok: true, tier: 'aap', public_base: PUBLIC_BASE,
        project: { name: hit.project.name, live_url: PUBLIC_BASE + '/' + hit.project.name + '/' },
        aap: { id: hit.aap.id, name: hit.aap.name, branch: hit.aap.branch },
        pass_url: PUBLIC_BASE + '/drafts/pass/drafts_agent_' + SERVER_NUMBER + '_' + token.replace(/^aap_/,''),
      });
    }
    return res.status(400).json({ ok: false, error: 'bad_tier' });
  });

  app.post('/telepath/api/sap/projects', initDataAuth, async (req, res) => {
    const u = getUser(req.tgUser.id);
    if (!u || !u.bindings.some(b => b.tier === 'sap')) return res.status(403).json({ ok: false, error: 'no_sap_binding' });
    const name = String(req.body.name || '').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
    if (!name) return res.status(400).json({ ok: false, error: 'invalid_name' });
    if (!serverHelpers.createProject) return res.status(500).json({ ok:false, error: 'createProject not wired' });
    try {
      const out = await serverHelpers.createProject({ name, description: req.body.description || '' });
      bindToken(req.tgUser.id, { tier: 'pap', token: out.pap_token, project: { name } });
      res.json({ ok: true, project: name, pap_activation_url: out.pap_activation_url, live_url: out.live_url });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/telepath/api/pap/aaps', initDataAuth, async (req, res) => {
    const u = getUser(req.tgUser.id);
    const token = String(req.body.pap_token || '');
    if (!u || !u.bindings.some(b => b.token === token && b.tier === 'pap')) return res.status(403).json({ ok: false, error: 'not_bound' });
    const p = findProjectByPAP(token);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!serverHelpers.createAAP) return res.status(500).json({ ok:false, error: 'createAAP not wired' });
    try {
      const out = await serverHelpers.createAAP(p, { name: req.body.name || null });
      onNewAAPCreated(p, out.aap);
      res.json({ ok: true, aap: out.aap, activation_url: out.activation_url });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/telepath/api/forget', initDataAuth, (req, res) => {
    const tok = String(req.body.token || '');
    const ok = unbindToken(req.tgUser.id, tok);
    res.json({ ok, removed: ok });
  });

  // ── Project Bots (per-PAP) ──
  function papOwnerCheck(req, res) {
    const u = getUser(req.tgUser.id);
    const token = String(req.body.pap_token || req.query.pap_token || '');
    if (!u || !u.bindings.some(b => b.token === token && b.tier === 'pap')) {
      res.status(403).json({ ok: false, error: 'not_bound' });
      return null;
    }
    const p = findProjectByPAP(token);
    if (!p) {
      res.status(404).json({ ok: false, error: 'project_not_found' });
      return null;
    }
    return p;
  }

  app.get('/telepath/api/pap/bot', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    res.json({ ok: true, bot: projectBotsApi.getBotStatus(p) });
  });

  app.put('/telepath/api/pap/bot', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const botToken = String(req.body.bot_token || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
      return res.status(400).json({ ok: false, error: 'invalid_bot_token_format' });
    }
    const webhookUrl = req.body.webhook_url ? String(req.body.webhook_url).trim() : null;
    try {
      const out = await projectBotsApi.installBot(p, botToken, { webhook_url: webhookUrl });
      res.json({ ok: true, bot: out });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete('/telepath/api/pap/bot', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    try {
      const out = await projectBotsApi.unlinkBot(p, { notify_subscribers: false });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/telepath/api/pap/bot/webhook', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    if (!p.bot || !p.bot.token) return res.status(400).json({ ok: false, error: 'no_bot_installed' });
    const url = req.body.webhook_url;
    try {
      const out = await projectBotsApi.setWebhookUrl(p, url == null || url === '' ? null : String(url).trim());
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/telepath/api/pap/bot/sync', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const message = String(req.body.message || '').trim();
    let html = null;
    if (message) {
      const ctrlBot = getControlBotUsername();
      const attribution = ctrlBot
        ? `\n\n<i>Built with Drafts → @${esc(ctrlBot)}</i>`
        : '\n\n<i>Built with Drafts</i>';
      html = esc(message).replace(/\n/g, '\n') + attribution;
    }
    try {
      const out = await projectBotsApi.syncBot(p, html);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── v0.8: GitHub repo + autosync (PAP-owned) ──
  app.put('/telepath/api/pap/github', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const repo = String(req.body.github_repo || '').trim();
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.status(400).json({ ok: false, error: 'bad_repo_format' });
    p.github_repo = repo || null;
    if (!p.github_repo) p.github_autosync = false;
    if (saveDraftsState) saveDraftsState();
    res.json({ ok: true, github_repo: p.github_repo, github_autosync: !!p.github_autosync });
  });

  app.patch('/telepath/api/pap/github_autosync', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    if (!p.github_repo) return res.status(400).json({ ok: false, error: 'project_not_linked_to_github' });
    p.github_autosync = !!req.body.enabled;
    if (saveDraftsState) saveDraftsState();
    res.json({ ok: true, github_autosync: p.github_autosync });
  });

  app.post('/telepath/api/pap/github_sync', initDataAuth, async (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    if (!serverHelpers.githubSyncProject) return res.status(500).json({ ok: false, error: 'sync_not_wired' });
    try {
      const out = await serverHelpers.githubSyncProject(p);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Analytics endpoints (v0.7) ──
  app.patch('/telepath/api/pap/bot/analytics', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    if (!p.bot || !p.bot.token) return res.status(400).json({ ok: false, error: 'no_bot_installed' });
    try {
      const out = projectBotsApi.setAnalyticsEnabled(p, !!req.body.enabled);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get('/telepath/api/pap/analytics/summary', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    try {
      const summary = analyticsGetSummary(p.name, DRAFTS_DIR);
      const logStats = analyticsGetLogStats(p.name, DRAFTS_DIR);
      res.json({ ok: true, summary, log: logStats });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/telepath/api/pap/analytics/log', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const stream = analyticsGetLogStream(p.name, DRAFTS_DIR);
    if (!stream) return res.status(404).json({ ok: false, error: 'no_log_yet' });
    res.set('Content-Type', 'application/jsonlines; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${p.name}-analytics-${new Date().toISOString().slice(0,10)}.jsonl"`);
    stream.pipe(res);
  });

  app.get('/telepath/api/pap/analytics/summary-raw', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const stream = analyticsGetSummaryRaw(p.name, DRAFTS_DIR);
    if (!stream) return res.status(404).json({ ok: false, error: 'no_summary_yet' });
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${p.name}-summary-${new Date().toISOString().slice(0,10)}.json"`);
    stream.pipe(res);
  });

  app.get('/telepath/api/pap/analytics/archives', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    res.json({ ok: true, archives: analyticsListArchives(p.name, DRAFTS_DIR) });
  });

  app.get('/telepath/api/pap/analytics/archive', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    const name = String(req.query.name || '');
    const stream = analyticsGetArchiveStream(p.name, DRAFTS_DIR, name);
    if (!stream) return res.status(404).json({ ok: false, error: 'archive_not_found' });
    res.set('Content-Type', 'application/jsonlines; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${p.name}-${name.replace(/^\./, '')}"`);
    stream.pipe(res);
  });

  app.delete('/telepath/api/pap/analytics', initDataAuth, (req, res) => {
    const p = papOwnerCheck(req, res);
    if (!p) return;
    try {
      const out = analyticsWipe(p.name, DRAFTS_DIR);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Express middlewares
// ─────────────────────────────────────────────────────────────
function requireSAP(req, res, next) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const tok = m ? m[1].trim() : null;
  if (!tok || tok !== getSAP()) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

function initDataAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body?._initData || '';
  const verified = verifyInitData(initData);
  if (!verified || !verified.user) return res.status(401).json({ ok: false, error: 'invalid_initdata' });
  req.tgUser = verified.user;
  next();
}

// ─────────────────────────────────────────────────────────────
// WebApp shell HTML — v0.8 (analytics card + GitHub card)
// ─────────────────────────────────────────────────────────────
function renderWebAppShell(tier, token) {
  const stateUrl = '/telepath/api/state/' + tier + (token ? '/' + token : '');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Drafts</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root { color-scheme: dark light; }
body { margin:0; padding:0; background: var(--tg-theme-bg-color, #000); color: var(--tg-theme-text-color, #f5f5f5); font-family: Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size:15px; line-height:1.5; }
.wrap { max-width: 600px; margin: 0 auto; padding: 16px 18px 80px; }
h1 { font-size: 26px; font-weight: 800; letter-spacing: -0.025em; margin: 4px 0 4px; }
.sub { color: var(--tg-theme-hint-color, #888); font-size: 13px; margin-bottom: 20px; }
.card { background: var(--tg-theme-secondary-bg-color, #111); border-radius: 14px; padding: 16px 18px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.04); }
.card h3 { font-size:11px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color: var(--tg-theme-hint-color, #888); margin:0 0 12px; display:flex; align-items:center; gap:6px; }
.card h3 .dot { display:inline-block; width:6px; height:6px; border-radius:50%; }
.card h3 .dot.on { background:#4ade80; }
.card h3 .dot.off { background:#666; }
.row { display:flex; justify-content:space-between; gap:10px; padding:8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size:13px; }
.row:last-child { border-bottom:none; }
.row .k { color: var(--tg-theme-hint-color, #888); flex-shrink:0; }
.row .v { text-align:right; word-break:break-all; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.btn { display:inline-block; padding:11px 18px; border-radius:12px; background: var(--tg-theme-button-color, #ea5a2e); color: var(--tg-theme-button-text-color, #fff); text-decoration:none; font-weight:700; font-size:14px; border:none; cursor:pointer; font-family:inherit; }
.btn:active { transform: scale(0.97); }
.btn.ghost { background: transparent; color: var(--tg-theme-link-color, #60a5fa); border: 1.5px solid rgba(96,165,250,0.3); }
.btn.danger { background: transparent; color: #ef4444; border: 1.5px solid rgba(239,68,68,0.3); }
.btn + .btn { margin-left: 8px; }
.btn.full { width:100%; display:block; text-align:center; }
.muted { color: var(--tg-theme-hint-color, #888); font-size:12px; line-height:1.55; }
input, textarea { width:100%; padding:12px 14px; border-radius:10px; border:1.5px solid rgba(255,255,255,0.1); background: var(--tg-theme-bg-color, #000); color: inherit; font-family:inherit; font-size:14px; box-sizing:border-box; margin-bottom:8px; }
input:focus, textarea:focus { outline:none; border-color:var(--tg-theme-button-color, #ea5a2e); }
.proj-item { padding:12px 0; border-bottom:1px solid rgba(255,255,255,0.05); }
.proj-item:last-child { border-bottom:none; }
.proj-name { font-weight:700; font-size:15px; }
.proj-meta { font-size:12px; color: var(--tg-theme-hint-color, #888); margin-top:3px; }
.empty { padding: 28px 0; text-align:center; color: var(--tg-theme-hint-color, #888); font-size:13px; }
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#222; color:#fff; padding:11px 18px; border-radius:10px; font-size:13px; z-index:100; box-shadow:0 4px 20px rgba(0,0,0,0.4); }
.actions { display:flex; gap:10px; flex-wrap:wrap; }
.bot-status { display:flex; align-items:center; gap:10px; padding:6px 0 14px; }
.bot-status .badge { font-size:13px; font-weight:600; color:#f5f5f5; }
.bot-status .meta { font-size:12px; color: var(--tg-theme-hint-color, #888); }
.help-block { background:rgba(96,165,250,0.06); border-left:3px solid #60a5fa; padding:10px 12px; border-radius:6px; font-size:12.5px; color:#a8a8a8; margin:8px 0; line-height:1.5; }
.mode-pill { display:inline-block; padding:3px 9px; border-radius:99px; font-size:10.5px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; }
.mode-pill.webhook { background:rgba(139,92,246,0.15); color:#a78bfa; }
.mode-pill.default { background:rgba(96,165,250,0.15); color:#60a5fa; }
.log-table { width:100%; border-collapse:collapse; margin-top:8px; font-size:11.5px; font-family: ui-monospace, Menlo, monospace; }
.log-table td { padding:5px 6px; border-bottom:1px solid rgba(255,255,255,0.04); vertical-align:top; }
.log-table .log-status { font-weight:700; }
.log-status.ok { color:#4ade80; }
.log-status.err { color:#ef4444; }
.log-time { color:#888; }
.divider { height:1px; background:rgba(255,255,255,0.06); margin:14px 0; }
.metric-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:6px 0 14px; }
.metric { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.04); border-radius:10px; padding:12px 14px; }
.metric .num { font-size:22px; font-weight:800; letter-spacing:-0.02em; line-height:1.1; }
.metric .lbl { font-size:11px; color:#888; margin-top:4px; text-transform:uppercase; letter-spacing:0.06em; font-weight:700; }
.metric.green .num { color:#4ade80; }
.metric.purple .num { color:#a78bfa; }
.metric.blue .num { color:#60a5fa; }
.metric.orange .num { color:#fb923c; }
.bars { display:flex; gap:2px; align-items:flex-end; height:42px; padding:6px 0 0; }
.bars .bar { flex:1; background:#a78bfa; border-radius:1px 1px 0 0; min-height:1px; opacity:0.85; }
.bars .bar:hover { opacity:1; }
.lang-row { display:flex; align-items:center; padding:5px 0; font-size:12.5px; gap:8px; }
.lang-row .l { font-family:ui-monospace, Menlo, monospace; min-width:42px; color:#a8a8a8; }
.lang-row .meter { flex:1; height:6px; background:rgba(255,255,255,0.05); border-radius:99px; overflow:hidden; }
.lang-row .meter > span { display:block; height:100%; background:#60a5fa; border-radius:99px; }
.lang-row .n { font-family:ui-monospace, Menlo, monospace; color:#888; font-size:11.5px; min-width:34px; text-align:right; }
.toggle-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; }
.toggle { position:relative; width:42px; height:24px; background:#333; border-radius:99px; cursor:pointer; transition:background 0.15s; flex-shrink:0; }
.toggle.on { background:#4ade80; }
.toggle::after { content:''; position:absolute; left:3px; top:3px; width:18px; height:18px; background:#fff; border-radius:50%; transition:left 0.15s; }
.toggle.on::after { left:21px; }
</style>
</head><body><div class="wrap" id="root"><div class="empty">loading…</div></div>
<script>
(function(){
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) { tg.ready(); tg.expand(); }
  const initData = tg ? tg.initData : '';
  const root = document.getElementById('root');
  const TIER = ${JSON.stringify(tier)};
  const TOKEN = ${JSON.stringify(token || null)};
  const STATE_URL = ${JSON.stringify(stateUrl)};

  function toast(msg){ const t=document.createElement('div'); t.className='toast'; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2400); }
  function copy(text){ navigator.clipboard.writeText(text).then(()=>toast('copied ✓')); }
  function esc(s){ if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function timeAgo(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }
  function fmtBytes(b) {
    if (!b) return '0';
    if (b < 1024) return b + ' B';
    if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
    return (b/(1024*1024)).toFixed(1) + ' MB';
  }
  function fmtNum(n) {
    if (n == null) return '0';
    if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n/1000).toFixed(1) + 'k';
    return String(n);
  }

  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type':'application/json', 'X-Telegram-Init-Data': initData } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const j = await r.json().catch(()=>({ok:false,error:'bad_json'}));
    if (!j.ok) throw new Error(j.error || 'request_failed');
    return j;
  }

  async function downloadAuth(url, filename) {
    const r = await fetch(url, { headers: { 'X-Telegram-Init-Data': initData } });
    if (!r.ok) {
      const j = await r.json().catch(()=>({error:'failed'}));
      throw new Error(j.error || 'download_failed');
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(objUrl); a.remove(); }, 200);
  }

  async function load(){
    if (!initData) {
      root.innerHTML = '<div class="card"><h3>open from telegram</h3><div class="muted">this only works inside the telegram app. open it via the bot.</div></div>';
      return;
    }
    try {
      const data = await api('GET', STATE_URL);
      if (data.tier === 'sap') return renderSAP(data);
      if (data.tier === 'pap') return renderPAP(data);
      if (data.tier === 'aap') return renderAAP(data);
    } catch (e) {
      root.innerHTML = '<div class="card"><h3>error</h3><div class="muted">'+esc(e.message)+'</div></div>';
    }
  }

  function renderSAP(d) {
    let h = '<h1>server</h1><div class="sub">'+esc(d.public_base.replace(/^https?:\\/\\//,''))+' · #'+d.server_number+'</div>';
    h += '<div class="card"><h3>new project</h3>';
    h += '<input id="newName" placeholder="project-name" maxlength="40"/>';
    h += '<input id="newDesc" placeholder="description (optional)"/>';
    h += '<button class="btn full" id="createBtn">create ✨</button></div>';
    h += '<div class="card"><h3>projects · '+d.projects.length+'</h3>';
    if (!d.projects.length) h += '<div class="empty">no projects yet</div>';
    for (const p of d.projects) {
      let botBadge = '';
      if (p.bot_attached) {
        const modeLabel = p.bot_mode === 'webhook' ? '🔌' : '📢';
        botBadge = ' · '+modeLabel+' @'+esc(p.bot_username||'bot');
      }
      h += '<div class="proj-item"><div class="proj-name">'+esc(p.name)+'</div>';
      h += '<div class="proj-meta">'+(p.description ? esc(p.description)+' · ' : '')+'agents: '+p.aap_count+botBadge+'</div></div>';
    }
    h += '</div>';
    root.innerHTML = h;
    document.getElementById('createBtn').addEventListener('click', async () => {
      const name = document.getElementById('newName').value.trim();
      const description = document.getElementById('newDesc').value.trim();
      if (!name) { toast('name required'); return; }
      try {
        await api('POST', '/telepath/api/sap/projects', { name, description });
        toast('created ✓');
        setTimeout(load, 600);
      } catch (e) { toast('failed: '+e.message); }
    });
  }

  function renderPAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">live · versions · bot · analytics</div>';

    h += '<div class="card"><h3>your project</h3>';
    h += '<div class="actions">';
    h += '<a class="btn" href="'+p.live_url+'" target="_blank">🌐 live</a>';
    h += '<button class="btn ghost" id="copyPass">🔗 pass-link</button>';
    h += '</div>';
    h += '<div class="muted" style="margin-top:10px">pass-link is what you share with Claude to build. tap to copy.</div>';
    h += '</div>';

    // Bot card
    h += '<div class="card" id="botCard"><h3><span class="dot '+(p.bot.installed?'on':'off')+'"></span>telegram bot</h3>';
    if (p.bot.installed) {
      const mode = p.bot.mode || 'default';
      h += '<div class="bot-status"><div>';
      h += '<div class="badge">@'+esc(p.bot.bot_username||'bot')+' <span class="mode-pill '+mode+'" style="margin-left:6px">'+mode+'</span></div>';
      h += '<div class="meta">';
      if (mode === 'webhook') {
        const total = (p.bot.webhook_log || []).length;
        const recentOk = (p.bot.webhook_log || []).filter(e => e.status >= 200 && e.status < 300).length;
        h += 'forwarding to your URL · '+recentOk+'/'+total+' ok';
      } else {
        h += p.bot.subscriber_count+' subscriber'+(p.bot.subscriber_count===1?'':'s');
      }
      if (p.bot.last_synced_at) h += ' · synced '+timeAgo(p.bot.last_synced_at);
      h += '</div></div></div>';

      h += '<div class="divider"></div>';
      h += '<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:8px">🔌 webhook</div>';
      if (mode === 'webhook') {
        h += '<input id="webhookInput" value="'+esc(p.bot.webhook_url)+'" placeholder="https://your-bot.vercel.app/webhook"/>';
        h += '<div class="actions">';
        h += '<button class="btn ghost" id="webhookSaveBtn">↻ update url</button>';
        h += '<button class="btn danger" id="webhookClearBtn">switch to default mode</button>';
        h += '</div>';
        if ((p.bot.webhook_log || []).length) {
          h += '<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:14px 0 6px">recent calls</div>';
          h += '<table class="log-table">';
          for (const e of p.bot.webhook_log.slice(0, 10)) {
            const okClass = (e.status >= 200 && e.status < 300) ? 'ok' : 'err';
            const statusText = e.status > 0 ? String(e.status) : (e.error || 'err');
            h += '<tr><td class="log-time">'+timeAgo(e.at)+'</td>';
            h += '<td class="log-status '+okClass+'">'+esc(statusText)+'</td>';
            h += '<td>'+e.latency_ms+'ms</td></tr>';
          }
          h += '</table>';
        } else {
          h += '<div class="muted" style="margin-top:8px">no calls yet. when telegram sends an update, it\\'ll show here.</div>';
        }
      } else {
        h += '<input id="webhookInput" placeholder="https://your-bot.vercel.app/webhook"/>';
        h += '<button class="btn full" id="webhookSaveBtn">🔌 enable webhook mode</button>';
        h += '<div class="help-block">webhook mode = drafts forwards every telegram update to your URL. you host your bot logic anywhere (vercel, cloudflare workers, render — all free), and reply to telegram from there using your own bot token.</div>';
      }

      if (mode === 'default') {
        h += '<div class="divider"></div>';
        h += '<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:8px">📢 default mode</div>';
        h += '<div class="actions">';
        h += '<button class="btn" id="syncBtn">↻ update bot</button>';
        h += '<button class="btn danger" id="unlinkBtn">unlink</button>';
        h += '</div>';
        h += '<div class="help-block">tap <b>update bot</b> to push project info + send broadcast to subscribers.</div>';
      } else {
        h += '<div class="divider"></div>';
        h += '<div class="actions">';
        h += '<button class="btn ghost" id="syncBtn">↻ resync profile</button>';
        h += '<button class="btn danger" id="unlinkBtn">unlink</button>';
        h += '</div>';
      }
    } else {
      h += '<div class="muted" style="margin-bottom:12px">turn your project into a telegram bot. either as a mini-app shell, or wire it to your own webhook for full custom logic.</div>';
      h += '<input id="botToken" placeholder="paste bot token from @BotFather" type="password" autocomplete="off"/>';
      h += '<input id="botWebhookOptional" placeholder="webhook URL (optional — set later)" autocomplete="off"/>';
      h += '<button class="btn full" id="linkBtn">🔗 link bot</button>';
      h += '<div class="help-block">need a bot? open <a href="https://t.me/BotFather" target="_blank" style="color:#60a5fa">@BotFather</a> → /newbot → copy the token here. webhook URL is optional — you can set it later.</div>';
    }
    h += '</div>';

    // Analytics card
    if (p.bot.installed) {
      h += '<div class="card" id="analyticsCard"><h3>📊 analytics</h3>';
      h += '<div id="analyticsBody"><div class="empty">loading…</div></div>';
      h += '</div>';
    }

    // v0.8: GitHub card
    h += '<div class="card" id="githubCard"><h3><span class="dot '+(p.github_repo?'on':'off')+'"></span>github</h3>';
    h += '<input id="githubRepoInput" value="'+esc(p.github_repo||'')+'" placeholder="owner/repo"/>';
    h += '<div class="actions">';
    if (p.github_repo) {
      h += '<button class="btn ghost" id="githubLinkBtn">↻ update link</button>';
      h += '<button class="btn ghost" id="githubSyncNowBtn">⤴ push now</button>';
      h += '<button class="btn danger" id="githubUnlinkBtn">unlink</button>';
    } else {
      h += '<button class="btn full" id="githubLinkBtn">🔗 link repo</button>';
    }
    h += '</div>';
    if (p.github_repo) {
      h += '<div class="divider"></div>';
      h += '<div class="toggle-row">';
      h += '<div><div style="font-size:13.5px;font-weight:600">auto-sync</div>';
      h += '<div class="muted">push to GitHub on every commit + merge</div></div>';
      h += '<div class="toggle '+(p.github_autosync?'on':'')+'" id="githubAutosyncToggle"></div>';
      h += '</div>';
    }
    h += '<div class="help-block">link a private GitHub repo to back up the project. when auto-sync is on, every commit/merge force-pushes <code>main</code> to your repo. you need a server-default GitHub token configured (or per-project via API).</div>';
    h += '</div>';

    // Agents
    h += '<div class="card"><h3>agents · '+p.aaps.length+'</h3>';
    if (!p.aaps.length) h += '<div class="empty">no agents yet</div>';
    for (const a of p.aaps) {
      h += '<div class="proj-item"><div class="proj-name">'+esc(a.name||a.id)+(a.revoked?' <span style="color:#ef4444">(revoked)</span>':'')+'</div>';
      h += '<div class="proj-meta">branch: '+esc(a.branch)+'</div></div>';
    }
    h += '<div style="margin-top:12px"><input id="aapName" placeholder="agent name (optional)" maxlength="60"/>';
    h += '<button class="btn full" id="newAap">+ invite agent</button></div>';
    h += '</div>';

    // Info
    h += '<div class="card"><h3>info</h3>';
    h += '<div class="row"><span class="k">created</span><span class="v">'+esc(p.created_at.slice(0,10))+'</span></div>';
    h += '<div class="row"><span class="k">about</span><span class="v">'+esc(p.description||'—')+'</span></div>';
    h += '</div>';

    root.innerHTML = h;

    document.getElementById('copyPass').addEventListener('click', () => copy(p.pass_url));
    document.getElementById('newAap').addEventListener('click', async () => {
      const name = document.getElementById('aapName').value.trim();
      try {
        const out = await api('POST', '/telepath/api/pap/aaps', { pap_token: TOKEN, name });
        copy(out.activation_url);
        toast('agent link copied ✓');
        setTimeout(load, 600);
      } catch (e) { toast('failed: '+e.message); }
    });

    // GitHub handlers
    const ghLinkBtn = document.getElementById('githubLinkBtn');
    if (ghLinkBtn) {
      ghLinkBtn.addEventListener('click', async () => {
        const repo = document.getElementById('githubRepoInput').value.trim();
        if (repo && !/^[\\w.-]+\\/[\\w.-]+$/.test(repo)) { toast('format: owner/repo'); return; }
        try {
          await api('PUT', '/telepath/api/pap/github', { pap_token: TOKEN, github_repo: repo });
          toast(repo ? 'linked ✓' : 'cleared');
          setTimeout(load, 500);
        } catch (e) { toast('failed: '+e.message); }
      });
    }
    const ghUnlink = document.getElementById('githubUnlinkBtn');
    if (ghUnlink) {
      ghUnlink.addEventListener('click', async () => {
        if (!confirm('unlink GitHub repo? auto-sync will turn off too.')) return;
        try {
          await api('PUT', '/telepath/api/pap/github', { pap_token: TOKEN, github_repo: '' });
          toast('unlinked ✓');
          setTimeout(load, 500);
        } catch (e) { toast('failed: '+e.message); }
      });
    }
    const ghSyncNow = document.getElementById('githubSyncNowBtn');
    if (ghSyncNow) {
      ghSyncNow.addEventListener('click', async () => {
        try {
          ghSyncNow.textContent = '⏳ pushing...';
          await api('POST', '/telepath/api/pap/github_sync', { pap_token: TOKEN });
          toast('pushed ✓');
          ghSyncNow.textContent = '⤴ push now';
        } catch (e) { ghSyncNow.textContent = '⤴ push now'; toast('failed: '+e.message); }
      });
    }
    const ghAutoToggle = document.getElementById('githubAutosyncToggle');
    if (ghAutoToggle) {
      ghAutoToggle.addEventListener('click', async () => {
        const newState = !ghAutoToggle.classList.contains('on');
        try {
          await api('PATCH', '/telepath/api/pap/github_autosync', { pap_token: TOKEN, enabled: newState });
          toast(newState ? 'auto-sync on ✓' : 'auto-sync off');
          setTimeout(load, 400);
        } catch (e) { toast('failed: '+e.message); }
      });
    }

    if (p.bot.installed) {
      document.getElementById('syncBtn').addEventListener('click', () => openBroadcastModal(p.bot.mode));
      document.getElementById('unlinkBtn').addEventListener('click', async () => {
        if (!confirm('unlink @'+(p.bot.bot_username||'bot')+'? '+(p.bot.mode==='webhook'?'updates will stop forwarding to your URL.':'subscribers will stop receiving updates.'))) return;
        try {
          await api('DELETE', '/telepath/api/pap/bot?pap_token='+encodeURIComponent(TOKEN));
          toast('unlinked ✓');
          setTimeout(load, 500);
        } catch (e) { toast('failed: '+e.message); }
      });
      const wsBtn = document.getElementById('webhookSaveBtn');
      if (wsBtn) {
        wsBtn.addEventListener('click', async () => {
          const url = document.getElementById('webhookInput').value.trim();
          if (!url) { toast('paste a URL first'); return; }
          try {
            await api('PATCH', '/telepath/api/pap/bot/webhook', { pap_token: TOKEN, webhook_url: url });
            toast(p.bot.mode === 'webhook' ? 'url updated ✓' : 'webhook on ✓');
            setTimeout(load, 600);
          } catch (e) { toast('failed: '+e.message); }
        });
      }
      const wcBtn = document.getElementById('webhookClearBtn');
      if (wcBtn) {
        wcBtn.addEventListener('click', async () => {
          if (!confirm('switch off webhook mode? drafts will handle /start, /stop, broadcast again.')) return;
          try {
            await api('PATCH', '/telepath/api/pap/bot/webhook', { pap_token: TOKEN, webhook_url: null });
            toast('switched to default ✓');
            setTimeout(load, 500);
          } catch (e) { toast('failed: '+e.message); }
        });
      }
      loadAnalytics(p.bot.analytics_enabled !== false);
    } else {
      document.getElementById('linkBtn').addEventListener('click', async () => {
        const token = document.getElementById('botToken').value.trim();
        const webhook = document.getElementById('botWebhookOptional').value.trim();
        if (!token) { toast('paste a token first'); return; }
        try {
          const body = { pap_token: TOKEN, bot_token: token };
          if (webhook) body.webhook_url = webhook;
          const out = await api('PUT', '/telepath/api/pap/bot', body);
          toast('linked: @'+out.bot.bot_username);
          setTimeout(load, 600);
        } catch (e) { toast('failed: '+e.message); }
      });
    }
  }

  async function loadAnalytics(enabled) {
    const body = document.getElementById('analyticsBody');
    if (!body) return;
    try {
      const r = await api('GET', '/telepath/api/pap/analytics/summary?pap_token=' + encodeURIComponent(TOKEN));
      renderAnalytics(body, r.summary, r.log, enabled);
    } catch (e) {
      body.innerHTML = '<div class="muted">analytics unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function renderAnalytics(body, s, log, enabled) {
    let h = '';
    h += '<div class="toggle-row">';
    h += '<div><div style="font-size:13.5px;font-weight:600">recording '+(enabled ? 'on' : 'off')+'</div>';
    h += '<div class="muted">privacy-safe metadata only — never raw text</div></div>';
    h += '<div class="toggle '+(enabled?'on':'')+'" id="analyticsToggle"></div>';
    h += '</div>';

    if (s.events_total === 0) {
      h += '<div class="empty" style="padding:18px 0">no events yet — write to your bot to start tracking</div>';
      body.innerHTML = h;
      document.getElementById('analyticsToggle').addEventListener('click', toggleAnalytics);
      return;
    }

    h += '<div class="divider"></div>';

    h += '<div class="metric-grid">';
    h += '<div class="metric blue"><div class="num">' + fmtNum(s.users_total) + '</div><div class="lbl">users total</div></div>';
    h += '<div class="metric green"><div class="num">' + fmtNum(s.events_total) + '</div><div class="lbl">events total</div></div>';
    h += '<div class="metric purple"><div class="num">' + s.users_active_7d + '</div><div class="lbl">DAU 7d</div></div>';
    h += '<div class="metric orange"><div class="num">' + s.premium_pct + '%</div><div class="lbl">premium</div></div>';
    h += '</div>';

    const dayKeys = Object.keys(s.by_day).sort();
    if (dayKeys.length > 1) {
      const last30 = dayKeys.slice(-30);
      const max = Math.max(...last30.map(k => s.by_day[k]));
      h += '<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:10px 0 4px">events · last ' + last30.length + ' days</div>';
      h += '<div class="bars">';
      for (const k of last30) {
        const v = s.by_day[k];
        const pct = max > 0 ? Math.max(2, (v / max) * 100) : 0;
        h += '<div class="bar" style="height:' + pct + '%" title="' + k + ': ' + v + '"></div>';
      }
      h += '</div>';
    }

    const hMax = Math.max(...s.by_hour_utc);
    if (hMax > 0) {
      h += '<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:14px 0 4px">activity by hour (UTC)</div>';
      h += '<div class="bars">';
      for (let i = 0; i < 24; i++) {
        const v = s.by_hour_utc[i];
        const pct = hMax > 0 ? Math.max(2, (v / hMax) * 100) : 0;
        h += '<div class="bar" style="height:' + pct + '%;background:#60a5fa" title="' + i + ':00 UTC: ' + v + '"></div>';
      }
      h += '</div>';
    }

    if (s.top_languages && s.top_languages.length) {
      h += '<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:14px 0 4px">top languages</div>';
      const total = s.top_languages.reduce((a, [, n]) => a + n, 0) || 1;
      for (const [lang, n] of s.top_languages.slice(0, 6)) {
        const pct = (n / total) * 100;
        h += '<div class="lang-row"><span class="l">' + esc(lang) + '</span><span class="meter"><span style="width:' + pct + '%"></span></span><span class="n">' + n + '</span></div>';
      }
    }

    if (s.top_countries && s.top_countries.length) {
      h += '<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin:14px 0 4px">top countries (guessed)</div>';
      const total = s.top_countries.reduce((a, [, n]) => a + n, 0) || 1;
      for (const [c, n] of s.top_countries.slice(0, 6)) {
        const pct = (n / total) * 100;
        h += '<div class="lang-row"><span class="l" style="min-width:90px">' + esc(c) + '</span><span class="meter"><span style="width:' + pct + '%;background:#a78bfa"></span></span><span class="n">' + n + '</span></div>';
      }
    }

    h += '<div class="divider"></div>';
    h += '<div class="row"><span class="k">DAU 30d</span><span class="v">' + s.users_active_30d + '</span></div>';
    h += '<div class="row"><span class="k">premium users</span><span class="v">' + s.users_premium + '</span></div>';
    if (s.subscribed || s.unsubscribed) {
      h += '<div class="row"><span class="k">subscribed / unsub</span><span class="v">' + s.subscribed + ' / ' + s.unsubscribed + '</span></div>';
    }
    if (s.payments_total_count) {
      const pay = Object.entries(s.payments_total_amount_by_currency).map(([c, v]) => v + ' ' + c).join(', ');
      h += '<div class="row"><span class="k">payments</span><span class="v">' + s.payments_total_count + ' · ' + pay + '</span></div>';
    }
    h += '<div class="row"><span class="k">last event</span><span class="v">' + (s.last_event_at ? timeAgo(s.last_event_at) : '—') + '</span></div>';
    if (log && log.exists) {
      h += '<div class="row"><span class="k">log file</span><span class="v">' + fmtBytes(log.size_bytes) + '</span></div>';
    }

    h += '<div class="divider"></div>';
    h += '<div class="actions">';
    h += '<button class="btn ghost" id="dlLog">⬇ events .jsonl</button>';
    h += '<button class="btn ghost" id="dlSummary">⬇ summary .json</button>';
    h += '</div>';
    h += '<div class="actions" style="margin-top:8px">';
    h += '<button class="btn danger" id="wipeAnalytics">wipe data</button>';
    h += '</div>';
    h += '<div class="help-block">events file = one JSON per line, perfect for excel, pandas, or feeding to claude. summary = ready aggregates with full users dict. <b>no raw message text</b> is ever recorded — only metadata.</div>';

    body.innerHTML = h;

    document.getElementById('analyticsToggle').addEventListener('click', toggleAnalytics);
    document.getElementById('dlLog').addEventListener('click', async () => {
      try {
        await downloadAuth(
          '/telepath/api/pap/analytics/log?pap_token=' + encodeURIComponent(TOKEN),
          (TOKEN ? TOKEN.replace(/^pap_/, '') : 'project') + '-events.jsonl'
        );
      } catch (e) { toast('failed: '+e.message); }
    });
    document.getElementById('dlSummary').addEventListener('click', async () => {
      try {
        await downloadAuth(
          '/telepath/api/pap/analytics/summary-raw?pap_token=' + encodeURIComponent(TOKEN),
          (TOKEN ? TOKEN.replace(/^pap_/, '') : 'project') + '-summary.json'
        );
      } catch (e) { toast('failed: '+e.message); }
    });
    document.getElementById('wipeAnalytics').addEventListener('click', async () => {
      if (!confirm('wipe ALL analytics data? this cannot be undone.')) return;
      try {
        await api('DELETE', '/telepath/api/pap/analytics?pap_token=' + encodeURIComponent(TOKEN));
        toast('wiped ✓');
        loadAnalytics(enabled);
      } catch (e) { toast('failed: '+e.message); }
    });
  }

  async function toggleAnalytics() {
    const el = document.getElementById('analyticsToggle');
    const newState = !el.classList.contains('on');
    try {
      await api('PATCH', '/telepath/api/pap/bot/analytics', { pap_token: TOKEN, enabled: newState });
      toast(newState ? 'recording on ✓' : 'recording off');
      loadAnalytics(newState);
    } catch (e) { toast('failed: '+e.message); }
  }

  function openBroadcastModal(mode) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;display:flex;align-items:flex-end;justify-content:center;';
    const isWebhook = mode === 'webhook';
    overlay.innerHTML = ''+
      '<div style="background:#181818;width:100%;max-width:600px;border-radius:16px 16px 0 0;padding:20px 18px 28px;">'+
        '<div style="font-size:18px;font-weight:800;margin-bottom:6px">'+(isWebhook?'resync profile':'update bot')+'</div>'+
        '<div class="muted" style="margin-bottom:14px">'+(isWebhook
          ? 'pushes the latest project name, description, and menu button to telegram. broadcast disabled in webhook mode (your handler manages users).'
          : 'syncs the bot\\'s name, description, and menu button to your project. optionally send a message to subscribers.')+
        '</div>'+
        (isWebhook ? '' : '<textarea id="bcMsg" rows="3" placeholder="what\\'s new? 👀  (leave empty to skip broadcast)"></textarea>')+
        '<button class="btn full" id="bcSend">↻ '+(isWebhook?'resync':'update bot')+'</button>'+
        '<button class="btn ghost full" id="bcCancel" style="margin-top:8px">cancel</button>'+
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('bcCancel').onclick = () => overlay.remove();
    document.getElementById('bcSend').onclick = async () => {
      const message = isWebhook ? '' : (document.getElementById('bcMsg').value || '').trim();
      try {
        const out = await api('POST', '/telepath/api/pap/bot/sync', { pap_token: TOKEN, message });
        if (out.broadcast && !out.broadcast.skipped) {
          toast('synced + sent to '+out.broadcast.sent);
        } else {
          toast('synced ✓');
        }
        overlay.remove();
        setTimeout(load, 600);
      } catch (e) { toast('failed: '+e.message); }
    };
  }

  function renderAAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">agent: '+esc(d.aap.name||d.aap.id)+'</div>';
    h += '<div class="card"><h3>your branch</h3>';
    h += '<div class="muted" style="margin-bottom:10px">open this pass-link in Claude. your work goes to <code>'+esc(d.aap.branch)+'</code>.</div>';
    h += '<div class="actions">';
    h += '<button class="btn" id="copyPass">🔗 pass-link</button>';
    h += '<a class="btn ghost" href="'+p.live_url+'" target="_blank">🌐 live</a>';
    h += '</div></div>';
    root.innerHTML = h;
    document.getElementById('copyPass').addEventListener('click', () => copy(d.pass_url));
  }

  load();
})();
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// init()
// ─────────────────────────────────────────────────────────────
export function initTelepath(opts) {
  DRAFTS_DIR = opts.draftsDir;
  PUBLIC_BASE = opts.publicBase;
  SERVER_NUMBER = opts.serverNumber || 0;
  getSAP = opts.getSAP;
  getDraftsState = opts.getDraftsState;
  saveDraftsState = opts.saveDraftsState;
  findProjectByName = opts.findProjectByName;
  findProjectByPAP = opts.findProjectByPAP;
  findProjectAndAAPByAAPToken = opts.findProjectAndAAPByAAPToken;
  ensureProjectDirs = opts.ensureProjectDirs;
  listVersions = opts.listVersions;
  serverHelpers = opts.serverHelpers || {};

  loadState();
  loadTAP();
  if (TAP && TAP.token) {
    refreshBotMe().then(() => {
      configureBotProfile().catch(()=>{});
      pollLoop();
    });
    if (botMeRefreshTimer) clearInterval(botMeRefreshTimer);
    botMeRefreshTimer = setInterval(refreshBotMe, 6 * 3600 * 1000);
  } else {
    console.log('[telepath] no TAP installed — bot inactive. Install via PUT /drafts/tap');
  }
}

export function mountTelepathRoutes(app) { mountRoutes(app); }

export const hooks = {
  onNewProject,
  onNewAAPCreated,
  onAAPMerged,
  onMainCommit,
  // v0.8
  onDraftsBoot,
  onVersionBump,
  onSchemaMigration,
};

export function getTelepathStatus() {
  return {
    installed: !!(TAP && TAP.token),
    bot: TAP ? TAP.bot : null,
    polling,
    users_count: telepathState ? Object.keys(telepathState.users).length : 0,
  };
}

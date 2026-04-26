// telepath.js — Drafts Telepath: Telegram bot integration for Drafts servers.
//
// Concept:
//   One Drafts server ↔ one Telegram bot.
//   Owner (SAP) installs the bot by pasting its token via TAP.
//   Users send their PAP/AAP/SAP into the bot → the bot binds it
//   to their Telegram user_id and opens the matching mini-app.
//
// Access policy:
//   The bot is restricted to Telegram Premium users. Non-premium users get
//   a polite refusal. SAP-bound users always pass (server owner).
//
// Formatting:
//   All bot messages use parse_mode: 'HTML'. Underscores in URLs/identifiers
//   would break Markdown parsing (Telegram interprets _ as italic), so HTML
//   is safer and only requires escaping &, <, >, " in user-supplied text.
//
// State:  /var/lib/drafts/.telepath.json  (separate from main state.json)

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import https from 'https';

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

let TAP = null;
let telepathState = null;
let polling = false;
let pollOffset = 0;
let botMeRefreshTimer = null;

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// HTML escape — required for any user-supplied text inserted into HTML-mode bot messages
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
        notify_pap_on_aap_merge: true,
        notify_pap_on_main_commit: true,
      },
      installed_at: null,
    };
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

// ─────────────────────────────────────────────────────────────
// Telegram HTTP client
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

// Convenience: send message in HTML mode with safe defaults
function tgSend(chatId, html, opts = {}) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
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
  '<b>Telegram Premium required</b>\n\n' +
  'This bot is open to Telegram Premium subscribers only. ' +
  'Upgrade to Premium in Telegram Settings to use Drafts.\n\n' +
  '<i>If you are the server owner, paste your SAP token first to unlock access.</i>';

// ─────────────────────────────────────────────────────────────
// Bot UI helpers
// ─────────────────────────────────────────────────────────────
function webAppUrl(suffix) { return PUBLIC_BASE + '/telepath/app/' + suffix; }

function tierBadge(tier) {
  return { sap: '🔑 server', pap: '📁 project', aap: '🤝 agent' }[tier] || tier;
}

function welcomeText(user) {
  const name = user && user.first_name ? user.first_name : 'there';
  const host = (() => { try { return new URL(PUBLIC_BASE).hostname; } catch (e) { return 'this server'; } })();
  let t = `<b>Drafts Telepath</b>\nHi ${esc(name)} 👋\n\n`;
  t += `Build a website by talking to Claude. This bot is your control center for <code>${esc(host)}</code>.\n\n`;
  t += '<b>To get started:</b>\n';
  t += '• /new — create your own project (free)\n';
  t += '• Or paste a <code>pap_…</code> / <code>aap_…</code> token to open an existing one\n\n';
  t += '<b>Other commands:</b> /help · /projects · /forget';
  return t;
}

function helpText() {
  let t = '<b>Drafts Telepath — commands</b>\n\n';
  t += '/new <code>[name]</code> — create a new project (you become its owner)\n';
  t += '/projects — list your projects and open dashboards\n';
  t += '/forget — remove a token binding\n';
  t += '/notif <code>on|off</code> — toggle notifications\n';
  t += '/start — show the welcome message\n';
  t += '/help — show this message\n\n';
  t += 'You can also paste any <code>pap_…</code>, <code>aap_…</code>, or <code>/drafts/pass/…</code> link directly into the chat.';
  return t;
}

function projectsListText(user) {
  if (!user || user.bindings.length === 0) {
    return 'No projects yet. Try /new to create one.';
  }
  let t = '<b>Your linked passes:</b>\n\n';
  for (const b of user.bindings) {
    t += `${tierBadge(b.tier)}`;
    if (b.project_name) t += ` · <code>${esc(b.project_name)}</code>`;
    t += ` · ${b.bound_at.slice(0,10)}\n`;
  }
  return t;
}

function dashboardKeyboardForBinding(binding) {
  let url, label;
  if (binding.tier === 'sap') {
    url = webAppUrl('sap');
    label = '🔑 Server admin';
  } else if (binding.tier === 'pap') {
    url = webAppUrl('pap/' + binding.token);
    label = '📁 Open ' + (binding.project_name || 'project');
  } else if (binding.tier === 'aap') {
    url = webAppUrl('aap/' + binding.token);
    label = '🤝 Open agent view';
  }
  return [[{ text: label, web_app: { url } }]];
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

  // Premium gate — applied to ALL incoming messages except SAP token binding.
  const recogPreview = recognizeToken(text);
  const isSapBindingAttempt = recogPreview && recogPreview.tier === 'sap';

  if (!isAllowed(msg.from, user) && !isSapBindingAttempt) {
    return await tgSend(chatId, PREMIUM_REFUSAL);
  }

  // Commands
  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    if (cmd === '/start')    return await sendStart(chatId, user);
    if (cmd === '/help')     return await sendHelp(chatId);
    if (cmd === '/projects') return await sendProjects(chatId, user);
    if (cmd === '/forget')   return await sendForgetMenu(chatId, user);
    if (cmd === '/new')      return await handleNew(chatId, user, parts.slice(1).join(' '));
    if (cmd === '/notif') {
      const arg = parts[1];
      if (arg === 'off') { user.notif_subscribed = false; persistState(); return await tgSend(chatId, '🔕 Notifications off.'); }
      if (arg === 'on')  { user.notif_subscribed = true;  persistState(); return await tgSend(chatId, '🔔 Notifications on.'); }
      return await tgSend(chatId, 'Usage: <code>/notif on</code> or <code>/notif off</code>\nCurrently: '+(user.notif_subscribed?'on':'off'));
    }
    return await tgSend(chatId, 'Unknown command. Try /help');
  }

  // Token recognition
  const recog = recognizeToken(text);
  if (recog) {
    bindToken(msg.from.id, recog);
    let body = '✅ Recognized as ' + tierBadge(recog.tier);
    if (recog.project) body += ' for <code>' + esc(recog.project.name) + '</code>';
    body += '.\n\nTap below to open the dashboard.';
    return await tgSend(chatId, body, {
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({
        tier: recog.tier, token: recog.token, project_name: recog.project?.name,
      }) },
    });
  }

  // Unrecognized text → gentle hint
  await tgSend(chatId,
    'I didn\'t recognize that.\n\nTry /new to create a project, or paste a <code>pap_…</code> / <code>aap_…</code> token. /help for more.'
  );
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || '';
  const user = ensureUser(cq.from);

  if (!isAllowed(cq.from, user)) {
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'Premium required', show_alert: true });
    return;
  }

  if (data.startsWith('forget:')) {
    const tok = data.slice(7);
    const ok = unbindToken(cq.from.id, tok);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: ok ? 'Forgotten.' : 'Not found.' });
    if (ok) await tgSend(chatId, 'Binding removed.');
    return;
  }
  await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
}

async function sendStart(chatId, user) {
  await tgSend(chatId, welcomeText(user));
}
async function sendHelp(chatId) {
  await tgSend(chatId, helpText());
}
async function sendProjects(chatId, user) {
  const text = projectsListText(user);
  const kb = (user?.bindings || []).slice(0, 8).flatMap(b => dashboardKeyboardForBinding(b));
  await tgSend(chatId, text, { reply_markup: kb.length ? { inline_keyboard: kb } : undefined });
}
async function sendForgetMenu(chatId, user) {
  if (!user || !user.bindings.length) {
    return await tgSend(chatId, 'Nothing to forget.');
  }
  const kb = user.bindings.map(b => [{
    text: 'Forget ' + tierBadge(b.tier) + (b.project_name ? ' · ' + b.project_name : ''),
    callback_data: 'forget:' + b.token,
  }]);
  await tgSend(chatId, 'Pick a binding to forget:', { reply_markup: { inline_keyboard: kb } });
}

// /new — anyone (premium) can create a project. They become its owner (PAP).
async function handleNew(chatId, user, requestedName) {
  if (!serverHelpers.createProject) {
    return await tgSend(chatId, 'Internal error: createProject not wired');
  }
  let name = String(requestedName || '').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
  if (!name) {
    name = 'pad-' + crypto.randomBytes(3).toString('hex'); // dash instead of underscore for safer URLs in chat
  }
  const owner = user.tg_username || user.first_name || ('user_' + user.tg_user_id);
  try {
    const res = await serverHelpers.createProject({ name, description: 'Created via Telepath by ' + owner });
    bindToken(user.tg_user_id, { tier: 'pap', token: res.pap_token, project: { name: res.project } });
    const html =
      '🎉 Project <code>' + esc(res.project) + '</code> is yours.\n\n' +
      'Live URL: <a href="' + esc(res.live_url) + '">' + esc(res.live_url) + '</a>\n\n' +
      'Tap below to open the dashboard, then start building by talking to Claude.';
    await tgSend(chatId, html, {
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({ tier: 'pap', token: res.pap_token, project_name: res.project }) },
    });
    notifySAPOwners(`🆕 New project via /new: <code>${esc(res.project)}</code> by ${esc(owner)}`);
  } catch (e) {
    let msg = 'Failed: ' + esc(e.message);
    if (e.message === 'exists') msg = 'A project with that name already exists. Try a different name: <code>/new my-name</code>';
    if (e.message === 'reserved_name') msg = 'That name is reserved by the system. Try another: <code>/new my-name</code>';
    if (e.message === 'invalid_name') msg = 'Invalid name. Use only lowercase letters, digits, <code>-</code>, <code>_</code> (max 40).';
    await tgSend(chatId, msg);
  }
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

async function configureBotProfile() {
  if (!TAP || !TAP.token) return;
  const commands = [
    { command: 'new',      description: 'Create a new project (you become the owner)' },
    { command: 'projects', description: 'List your projects and open dashboards' },
    { command: 'help',     description: 'Show available commands' },
    { command: 'forget',   description: 'Remove a token binding' },
    { command: 'notif',    description: 'Toggle notifications: /notif on or /notif off' },
    { command: 'start',    description: 'Welcome message' },
  ];
  const shortDesc = 'Build websites by talking to Claude. Premium-only.';
  const longDesc =
    'Drafts Telepath turns Telegram into your control center for building websites with Claude. ' +
    'Use /new to create a project, then talk to Claude through the Drafts pass-link. ' +
    'Each version is saved automatically. Telegram Premium required.';
  try {
    await tgApi('setMyCommands', { commands });
    await tgApi('setMyShortDescription', { short_description: shortDesc });
    await tgApi('setMyDescription', { description: longDesc });
    console.log('[telepath] bot profile configured (commands, short_description, description)');
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
  notifySAPOwners(`🆕 New project: <code>${esc(project.name)}</code>`);
}
function onNewAAPCreated(project, aap) {
  notifyPAPOwners(project.name, `🤝 New agent for <code>${esc(project.name)}</code>: ${esc(aap.name || aap.id)}`);
}
function onAAPMerged(project, aap, versionN) {
  if (!telepathState.settings.notify_pap_on_aap_merge) return;
  notifyPAPOwners(project.name, `✅ Agent ${esc(aap.name || aap.id)} merged into <code>${esc(project.name)}</code>. New version: v${versionN}`);
}
function onMainCommit(project, commit, versionN) {
  if (!telepathState.settings.notify_pap_on_main_commit) return;
  const msg = (commit?.summary?.changes || commit?.commit || '').toString().slice(0, 80);
  notifyPAPOwners(project.name, `📝 <code>${esc(project.name)}</code> v${versionN}: ${esc(msg || 'commit')}`);
}

// ─────────────────────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────────────────────
function mountRoutes(app) {
  app.get('/drafts/tap', requireSAP, (req, res) => {
    if (!TAP) return res.json({ ok: true, installed: false });
    res.json({ ok: true, installed: true, bot: TAP.bot || null, installed_at: TAP.installed_at || null, polling });
  });

  app.put('/drafts/tap', requireSAP, async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return res.status(400).json({ ok: false, error: 'invalid_token_format' });
    }
    const probe = { token };
    const oldTAP = TAP;
    TAP = probe;
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
    const allowed = ['notify_sap_on_new_project','notify_sap_on_new_pap','notify_pap_on_aap_merge','notify_pap_on_main_commit'];
    for (const k of allowed) if (k in req.body) telepathState.settings[k] = !!req.body[k];
    persistState();
    res.json({ ok: true, settings: telepathState.settings });
  });

  app.post('/drafts/tap/configure', requireSAP, async (req, res) => {
    try { await configureBotProfile(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/telepath/app/sap',           (req, res) => res.type('html').send(renderWebAppShell('sap')));
  app.get('/telepath/app/pap/:token',    (req, res) => res.type('html').send(renderWebAppShell('pap', req.params.token)));
  app.get('/telepath/app/aap/:token',    (req, res) => res.type('html').send(renderWebAppShell('aap', req.params.token)));

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
        created_at: p.created_at, live_url: PUBLIC_BASE + '/' + p.name + '/',
        pass_url: PUBLIC_BASE + '/drafts/pass/drafts_project_' + SERVER_NUMBER + '_' + token.replace(/^pap_/,''),
        aaps: (p.aaps || []).map(a => ({ id: a.id, name: a.name, revoked: a.revoked, branch: a.branch })),
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
// WebApp shell HTML (unchanged from v0.4.1)
// ─────────────────────────────────────────────────────────────
function renderWebAppShell(tier, token) {
  const stateUrl = '/telepath/api/state/' + tier + (token ? '/' + token : '');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Drafts Telepath</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root { color-scheme: dark light; }
body { margin:0; padding:0; background: var(--tg-theme-bg-color, #000); color: var(--tg-theme-text-color, #f5f5f5); font-family: Inter, system-ui, -apple-system, sans-serif; font-size:15px; line-height:1.5; }
.wrap { max-width: 600px; margin: 0 auto; padding: 16px 18px 80px; }
h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; margin: 4px 0 4px; }
.sub { color: var(--tg-theme-hint-color, #888); font-size: 13px; margin-bottom: 18px; }
.card { background: var(--tg-theme-secondary-bg-color, #111); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
.card h3 { font-size:11px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color: var(--tg-theme-hint-color, #888); margin:0 0 10px; }
.row { display:flex; justify-content:space-between; gap:10px; padding:8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size:13px; }
.row:last-child { border-bottom:none; }
.row .k { color: var(--tg-theme-hint-color, #888); flex-shrink:0; }
.row .v { text-align:right; word-break:break-all; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.btn { display:inline-block; padding:10px 16px; border-radius:10px; background: var(--tg-theme-button-color, #ea5a2e); color: var(--tg-theme-button-text-color, #fff); text-decoration:none; font-weight:600; font-size:14px; border:none; cursor:pointer; font-family:inherit; }
.btn.ghost { background: transparent; color: var(--tg-theme-link-color, #60a5fa); border: 1px solid rgba(96,165,250,0.3); }
.btn + .btn { margin-left: 8px; }
.muted { color: var(--tg-theme-hint-color, #888); font-size:12px; }
input, textarea { width:100%; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,0.12); background: var(--tg-theme-bg-color, #000); color: inherit; font-family:inherit; font-size:14px; box-sizing:border-box; margin-bottom:8px; }
.proj-item { padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.06); }
.proj-item:last-child { border-bottom:none; }
.proj-name { font-weight:700; font-size:14px; }
.proj-meta { font-size:12px; color: var(--tg-theme-hint-color, #888); margin-top:2px; }
.empty { padding: 24px 0; text-align:center; color: var(--tg-theme-hint-color, #888); }
.toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#222; color:#fff; padding:10px 16px; border-radius:8px; font-size:13px; z-index:100; }
</style>
</head><body><div class="wrap" id="root">
  <div class="empty">Loading…</div>
</div>
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
  function copy(text){ navigator.clipboard.writeText(text).then(()=>toast('Copied')); }
  function esc(s){ if(s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type':'application/json', 'X-Telegram-Init-Data': initData } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const j = await r.json().catch(()=>({ok:false,error:'bad_json'}));
    if (!j.ok) throw new Error(j.error || 'request_failed');
    return j;
  }

  async function load(){
    if (!initData) {
      root.innerHTML = '<div class="card"><h3>Open this from Telegram</h3><div class="muted">This page only works inside the Telegram WebApp. Open it via the bot.</div></div>';
      return;
    }
    try {
      const data = await api('GET', STATE_URL);
      if (data.tier === 'sap') return renderSAP(data);
      if (data.tier === 'pap') return renderPAP(data);
      if (data.tier === 'aap') return renderAAP(data);
    } catch (e) {
      root.innerHTML = '<div class="card"><h3>Error</h3><div class="muted">'+esc(e.message)+'</div></div>';
    }
  }

  function renderSAP(d) {
    let h = '<h1>Server admin</h1><div class="sub">Server #'+d.server_number+' · '+esc(d.public_base.replace(/^https?:\\/\\//,''))+'</div>';
    h += '<div class="card"><h3>New project</h3>';
    h += '<input id="newName" placeholder="project-name (a-z, 0-9, -, _)" maxlength="40"/>';
    h += '<input id="newDesc" placeholder="description (optional)"/>';
    h += '<button class="btn" id="createBtn">Create project</button></div>';
    h += '<div class="card"><h3>Projects ('+d.projects.length+')</h3>';
    if (!d.projects.length) h += '<div class="empty">No projects yet</div>';
    for (const p of d.projects) {
      h += '<div class="proj-item"><div class="proj-name">'+esc(p.name)+'</div>';
      h += '<div class="proj-meta">'+(p.description ? esc(p.description)+' · ' : '')+'AAPs: '+p.aap_count+' · '+(p.pap_active?'PAP active':'PAP revoked')+'</div></div>';
    }
    h += '</div>';
    root.innerHTML = h;
    document.getElementById('createBtn').addEventListener('click', async () => {
      const name = document.getElementById('newName').value.trim();
      const description = document.getElementById('newDesc').value.trim();
      if (!name) { toast('Name required'); return; }
      try {
        await api('POST', '/telepath/api/sap/projects', { name, description });
        toast('Created');
        setTimeout(load, 600);
      } catch (e) { toast('Failed: '+e.message); }
    });
  }

  function renderPAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">Project · '+esc(d.public_base.replace(/^https?:\\/\\//,''))+'</div>';
    h += '<div class="card"><h3>Build</h3>';
    h += '<div class="muted" style="margin-bottom:10px">Open the pass-link in Claude (Chrome extension or claude.ai) to start building.</div>';
    h += '<button class="btn" id="copyPass">Copy pass-link</button>';
    h += '<a class="btn ghost" href="'+p.live_url+'" target="_blank">Open live ↗</a>';
    h += '</div>';
    h += '<div class="card"><h3>Agents (AAP)</h3>';
    if (!p.aaps.length) h += '<div class="empty muted">No agents yet</div>';
    for (const a of p.aaps) {
      h += '<div class="proj-item"><div class="proj-name">'+esc(a.name||a.id)+(a.revoked?' (revoked)':'')+'</div>';
      h += '<div class="proj-meta">branch: '+esc(a.branch)+'</div></div>';
    }
    h += '<div style="margin-top:12px"><input id="aapName" placeholder="agent name (optional)" maxlength="60"/>';
    h += '<button class="btn" id="newAap">Generate agent link</button></div>';
    h += '</div>';
    h += '<div class="card"><h3>Project info</h3>';
    h += '<div class="row"><span class="k">created</span><span class="v">'+esc(p.created_at.slice(0,10))+'</span></div>';
    if (p.github_repo) h += '<div class="row"><span class="k">github</span><span class="v">'+esc(p.github_repo)+'</span></div>';
    h += '<div class="row"><span class="k">description</span><span class="v">'+esc(p.description||'—')+'</span></div>';
    h += '</div>';
    root.innerHTML = h;
    document.getElementById('copyPass').addEventListener('click', () => copy(p.pass_url));
    document.getElementById('newAap').addEventListener('click', async () => {
      const name = document.getElementById('aapName').value.trim();
      try {
        const out = await api('POST', '/telepath/api/pap/aaps', { pap_token: TOKEN, name });
        copy(out.activation_url);
        toast('Agent link copied');
        setTimeout(load, 600);
      } catch (e) { toast('Failed: '+e.message); }
    });
  }

  function renderAAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">Agent: '+esc(d.aap.name||d.aap.id)+'</div>';
    h += '<div class="card"><h3>Build in your branch</h3>';
    h += '<div class="muted" style="margin-bottom:10px">Open this pass-link in Claude to start contributing. Your work goes to '+esc(d.aap.branch)+'.</div>';
    h += '<button class="btn" id="copyPass">Copy pass-link</button>';
    h += '<a class="btn ghost" href="'+p.live_url+'" target="_blank">View live ↗</a>';
    h += '</div>';
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
};

export function getTelepathStatus() {
  return {
    installed: !!(TAP && TAP.token),
    bot: TAP ? TAP.bot : null,
    polling,
    users_count: telepathState ? Object.keys(telepathState.users).length : 0,
  };
}

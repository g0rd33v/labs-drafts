// telepath.js — Drafts Telepath: Telegram bot integration for Drafts servers.
//
// Concept:
//   One Drafts server ↔ one Telegram bot.
//   Owner (SAP) installs the bot by pasting its token via TAP.
//   Users send their PAP/AAP/SAP into the bot → the bot binds it
//   to their Telegram user_id and opens the matching mini-app.
//
// State:  /var/lib/drafts/.telepath.json  (separate from main state.json)
//
// HTTP routes mounted under /telepath/* by drafts.js:
//   GET  /telepath/app/sap            — SAP web-app (admin)
//   GET  /telepath/app/pap/:token     — PAP web-app (project dashboard)
//   GET  /telepath/app/aap/:token     — AAP web-app (agent view)
//   GET  /telepath/api/whoami         — initData-authed echo
//   POST /telepath/api/sap/projects   — create project (initData=SAP)
//   POST /telepath/api/pap/aaps       — generate AAP (initData=PAP)
//   POST /telepath/api/forget         — drop a token binding
//
// All web-app pages auth via Telegram WebApp initData (HMAC-SHA256).

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import https from 'https';

// ─────────────────────────────────────────────────────────────
// Config (set by init() from drafts.js)
// ─────────────────────────────────────────────────────────────
let DRAFTS_DIR = null;
let PUBLIC_BASE = null;
let SERVER_NUMBER = 0;
let getSAP = null;             // () => string
let getDraftsState = null;     // () => state ref
let saveDraftsState = null;    // () => void
let findProjectByName = null;
let findProjectByPAP = null;
let findProjectAndAAPByAAPToken = null;
let ensureProjectDirs = null;
let listVersions = null;
let mintPAPForExistingProject = null; // optional helper exported by drafts.js
let serverHelpers = {};

const STATE_VERSION = 1;
const POLL_TIMEOUT  = 25;          // long-poll seconds
const TAP_FILE      = '/etc/labs/drafts.tap'; // mode 0600, root-only

let TAP = null;                    // { token, bot: { id, username, first_name }, installed_at, installed_by_sap_prefix }
let telepathState = null;          // see schema in loadState()
let polling = false;
let pollOffset = 0;
let botMeRefreshTimer = null;

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

function statePath() {
  return path.join(DRAFTS_DIR, '.telepath.json');
}

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
      // tg_user_id (string) → { tg_username, first_name, bindings: [{tier, token, project_name?, bound_at}], notif_subscribed: true }
      users: {},
      // settings managed by SAP
      settings: {
        public_pap_distribution: false, // if true: any user can /claim a fresh PAP via bot
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
// Telegram HTTP client (no deps, pure node https)
// ─────────────────────────────────────────────────────────────
function tgApi(method, params = {}, opts = {}) {
  if (!TAP || !TAP.token) return Promise.reject(new Error('no_tap'));
  const body = JSON.stringify(params);
  const reqOpts = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TAP.token}/${method}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
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

// ─────────────────────────────────────────────────────────────
// WebApp initData verification (HMAC SHA-256)
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ─────────────────────────────────────────────────────────────
function verifyInitData(initDataRaw) {
  if (!initDataRaw || !TAP || !TAP.token) return null;
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TAP.token).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;
  // Reject if older than 24h
  const auth_date = Number(params.get('auth_date') || 0);
  if (!auth_date || (Date.now() / 1000 - auth_date) > 24 * 3600) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (e) {}
  return { user, auth_date, query_id: params.get('query_id') };
}

// ─────────────────────────────────────────────────────────────
// Token recognition
// ─────────────────────────────────────────────────────────────
function recognizeToken(text) {
  // Returns { tier, token, project? } or null.
  // Accepts:
  //   raw SAP hex (12-64 hex chars)
  //   pap_<hex> / aap_<hex>
  //   https://<host>/drafts/pass/drafts_(server|project|agent)_<n>_<hex>
  //   drafts_(server|project|agent)_<n>_<hex>
  if (!text) return null;
  text = String(text).trim();

  // URL form
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

  // pap_/aap_ prefix
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

  // Raw SAP
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
      bindings: [],
      notif_subscribed: true,
      created_at: now(),
    };
  } else {
    // refresh display info
    telepathState.users[id].tg_username = tgUser.username || telepathState.users[id].tg_username;
    telepathState.users[id].first_name = tgUser.first_name || telepathState.users[id].first_name;
  }
  return telepathState.users[id];
}

function bindToken(tg_user_id, recognized) {
  const user = telepathState.users[String(tg_user_id)];
  if (!user) return;
  // remove existing binding for the same token if any
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

function findUsersBoundToToken(token) {
  const out = [];
  for (const [id, u] of Object.entries(telepathState.users)) {
    if (u.bindings.some(b => b.token === token)) out.push(u);
  }
  return out;
}

function findUsersBoundToTier(tier) {
  const out = [];
  for (const [id, u] of Object.entries(telepathState.users)) {
    if (u.bindings.some(b => b.tier === tier)) out.push(u);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Bot UI helpers
// ─────────────────────────────────────────────────────────────
function webAppUrl(suffix) {
  return PUBLIC_BASE + '/telepath/app/' + suffix;
}

function tierBadge(tier) {
  return { sap: '🔑 SAP', pap: '📁 PAP', aap: '🤝 AAP' }[tier] || tier;
}

function welcomeText(user) {
  const name = user && user.first_name ? user.first_name : 'there';
  const host = (() => { try { return new URL(PUBLIC_BASE).hostname; } catch (e) { return 'this server'; } })();
  let text = `*Drafts Telepath*\nHi ${esc(name)}. This bot is connected to \`${host}\`.\n\n`;
  text += 'Send me a Drafts token or pass-link — I\'ll recognize it and open the matching dashboard right here.\n\n';
  text += '*Token formats accepted:*\n';
  text += '• `pap_xxxxx…` — project pass\n';
  text += '• `aap_xxxxx…` — agent pass\n';
  text += `• \`${PUBLIC_BASE}/drafts/pass/drafts_…\` — full pass link\n\n`;
  if (telepathState.settings.public_pap_distribution) {
    text += 'Or type /claim to get a fresh project of your own.\n\n';
  }
  text += '*Commands:* /help · /projects · /forget';
  return text;
}

function helpText() {
  let t = '*Telepath commands*\n\n';
  t += '/start — welcome\n';
  t += '/projects — list your linked projects\n';
  t += '/forget — drop a token binding\n';
  if (telepathState.settings.public_pap_distribution) t += '/claim — get a fresh project (open distribution is on)\n';
  t += '/notif on|off — toggle notifications\n';
  t += '/help — this message\n\n';
  t += 'Send any Drafts token or pass-link to bind it.';
  return t;
}

function projectsListText(user) {
  if (!user || user.bindings.length === 0) {
    return 'No bindings yet. Send me a token to get started.';
  }
  let t = '*Your linked passes:*\n\n';
  for (const b of user.bindings) {
    t += `${tierBadge(b.tier)}`;
    if (b.project_name) t += ` · \`${esc(b.project_name)}\``;
    t += ` · bound ${b.bound_at.slice(0,10)}\n`;
  }
  return t;
}

function dashboardKeyboardForBinding(binding) {
  // Returns inline_keyboard array opening WebApp for that binding
  let url, label;
  if (binding.tier === 'sap') {
    url = webAppUrl('sap');
    label = '🔑 Open server admin';
  } else if (binding.tier === 'pap') {
    url = webAppUrl('pap/' + binding.token);
    label = '📁 Open project ' + (binding.project_name || '');
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

  // Commands
  if (text.startsWith('/')) {
    const [cmdRaw] = text.split(/\s+/, 1);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    if (cmd === '/start')    return await sendStart(chatId, user);
    if (cmd === '/help')     return await sendHelp(chatId);
    if (cmd === '/projects') return await sendProjects(chatId, user);
    if (cmd === '/forget')   return await sendForgetMenu(chatId, user);
    if (cmd === '/claim')    return await handleClaim(chatId, user);
    if (cmd === '/notif') {
      const arg = text.split(/\s+/)[1];
      if (arg === 'off') { user.notif_subscribed = false; persistState(); return await tgApi('sendMessage',{chat_id:chatId,text:'Notifications off.'}); }
      if (arg === 'on')  { user.notif_subscribed = true;  persistState(); return await tgApi('sendMessage',{chat_id:chatId,text:'Notifications on.'}); }
      return await tgApi('sendMessage',{chat_id:chatId,text:'Usage: /notif on|off  (currently '+(user.notif_subscribed?'on':'off')+')'});
    }
    return await tgApi('sendMessage',{chat_id:chatId,text:'Unknown command. Try /help'});
  }

  // Token recognition
  const recog = recognizeToken(text);
  if (recog) {
    bindToken(msg.from.id, recog);
    let body = '✅ Recognized as ' + tierBadge(recog.tier);
    if (recog.project) body += ' for project `' + esc(recog.project.name) + '`';
    body += '.\n\nTap the button below to open the dashboard.';
    return await tgApi('sendMessage', {
      chat_id: chatId,
      text: body,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({
        tier: recog.tier, token: recog.token, project_name: recog.project?.name,
      }) },
    });
  }

  // Unrecognized text → gentle hint
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: 'I didn\'t recognize that as a Drafts token. Send me a `pap_…`, `aap_…`, or a full `/drafts/pass/…` link. Try /help for more.',
    parse_mode: 'Markdown',
  });
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || '';
  const user = ensureUser(cq.from);

  if (data.startsWith('forget:')) {
    const tok = data.slice(7);
    const ok = unbindToken(cq.from.id, tok);
    await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: ok ? 'Forgotten.' : 'Not found.' });
    if (ok) await tgApi('sendMessage', { chat_id: chatId, text: 'Binding removed.' });
    return;
  }
  await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
}

async function sendStart(chatId, user) {
  await tgApi('sendMessage', { chat_id: chatId, text: welcomeText(user), parse_mode: 'Markdown', disable_web_page_preview: true });
}
async function sendHelp(chatId) {
  await tgApi('sendMessage', { chat_id: chatId, text: helpText(), parse_mode: 'Markdown' });
}
async function sendProjects(chatId, user) {
  const text = projectsListText(user);
  const kb = (user?.bindings || []).slice(0, 8).flatMap(b => dashboardKeyboardForBinding(b));
  await tgApi('sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown',
    reply_markup: kb.length ? { inline_keyboard: kb } : undefined,
  });
}
async function sendForgetMenu(chatId, user) {
  if (!user || !user.bindings.length) {
    return await tgApi('sendMessage', { chat_id: chatId, text: 'Nothing to forget.' });
  }
  const kb = user.bindings.map(b => [{
    text: 'Forget ' + tierBadge(b.tier) + (b.project_name ? ' · ' + b.project_name : ''),
    callback_data: 'forget:' + b.token,
  }]);
  await tgApi('sendMessage', { chat_id: chatId, text: 'Pick a binding to forget:', reply_markup: { inline_keyboard: kb } });
}

async function handleClaim(chatId, user) {
  if (!telepathState.settings.public_pap_distribution) {
    return await tgApi('sendMessage', { chat_id: chatId, text: 'Open distribution is off on this server.' });
  }
  // Generate a project named claim_<random> owned by claimer
  const name = 'claim_' + crypto.randomBytes(3).toString('hex');
  if (!serverHelpers.createProject) return await tgApi('sendMessage',{chat_id:chatId,text:'Internal error: createProject not wired'});
  try {
    const res = await serverHelpers.createProject({ name, description: 'Claimed via Telepath by ' + (user.tg_username || user.first_name || user.tg_user_id) });
    bindToken(user.tg_user_id, { tier: 'pap', token: res.pap_token, project: { name } });
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '🎉 Project `' + esc(name) + '` is yours.\nLive: ' + res.live_url + '\n\nTap below to open the dashboard.',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: dashboardKeyboardForBinding({ tier: 'pap', token: res.pap_token, project_name: name }) },
    });
    notifySAPOwners(`🆕 Claim: \`${esc(name)}\` claimed by ${esc(user.tg_username || user.first_name || user.tg_user_id)}`);
  } catch (e) {
    await tgApi('sendMessage', { chat_id: chatId, text: 'Claim failed: ' + e.message });
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
        offset: pollOffset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message', 'callback_query'],
      }, { timeout: (POLL_TIMEOUT + 5) * 1000 });
      for (const upd of updates) {
        pollOffset = Math.max(pollOffset, upd.update_id + 1);
        await handleUpdate(upd);
      }
    } catch (e) {
      if (e.code === 401) {
        console.error('[telepath] bot token rejected (401). Stopping polling. Re-install via TAP.');
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

// ─────────────────────────────────────────────────────────────
// Notification dispatchers (called by drafts.js hooks)
// ─────────────────────────────────────────────────────────────
function notifySAPOwners(text) {
  if (!TAP) return;
  const subs = findUsersBoundToTier('sap').filter(u => u.notif_subscribed);
  for (const u of subs) {
    tgApi('sendMessage', { chat_id: u.tg_user_id, text, parse_mode: 'Markdown', disable_web_page_preview: true })
      .catch(e => console.error('[telepath] notify SAP failed:', e.message));
  }
}

function notifyPAPOwners(projectName, text) {
  if (!TAP) return;
  const subs = Object.values(telepathState.users).filter(u =>
    u.notif_subscribed && u.bindings.some(b => b.tier === 'pap' && b.project_name === projectName)
  );
  for (const u of subs) {
    tgApi('sendMessage', { chat_id: u.tg_user_id, text, parse_mode: 'Markdown', disable_web_page_preview: true })
      .catch(e => console.error('[telepath] notify PAP failed:', e.message));
  }
}

function onNewProject(project) {
  if (!telepathState.settings.notify_sap_on_new_project) return;
  notifySAPOwners(`🆕 New project: \`${esc(project.name)}\``);
}
function onNewAAPCreated(project, aap) {
  notifyPAPOwners(project.name, `🤝 New agent for \`${esc(project.name)}\`: ${esc(aap.name || aap.id)}`);
}
function onAAPMerged(project, aap, versionN) {
  if (!telepathState.settings.notify_pap_on_aap_merge) return;
  notifyPAPOwners(project.name, `✅ Agent ${esc(aap.name || aap.id)} merged into \`${esc(project.name)}\`. New version: v${versionN}`);
}
function onMainCommit(project, commit, versionN) {
  if (!telepathState.settings.notify_pap_on_main_commit) return;
  const msg = (commit?.summary?.changes || commit?.commit || '').toString().slice(0, 80);
  notifyPAPOwners(project.name, `📝 \`${esc(project.name)}\` v${versionN}: ${esc(msg || 'commit')}`);
}

// ─────────────────────────────────────────────────────────────
// HTTP routes for drafts.js to mount
// ─────────────────────────────────────────────────────────────
function mountRoutes(app) {
  // ──── TAP management (SAP only) ────────────────────────────
  app.get('/drafts/tap', requireSAP, (req, res) => {
    if (!TAP) return res.json({ ok: true, installed: false });
    res.json({
      ok: true, installed: true,
      bot: TAP.bot || null,
      installed_at: TAP.installed_at || null,
      polling,
    });
  });

  app.put('/drafts/tap', requireSAP, async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return res.status(400).json({ ok: false, error: 'invalid_token_format' });
    }
    // Try getMe with this token
    const probe = { token };
    const oldTAP = TAP;
    TAP = probe;
    try {
      const me = await tgApi('getMe');
      TAP = {
        token,
        bot: { id: me.id, username: me.username, first_name: me.first_name },
        installed_at: now(),
      };
      persistTAP();
      // (Re)start polling
      stopPolling();
      await sleep(500);
      pollLoop();
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
    const allowed = ['public_pap_distribution','notify_sap_on_new_project','notify_sap_on_new_pap','notify_pap_on_aap_merge','notify_pap_on_main_commit'];
    for (const k of allowed) if (k in req.body) telepathState.settings[k] = !!req.body[k];
    persistState();
    res.json({ ok: true, settings: telepathState.settings });
  });

  // ──── WebApp pages (initData-authed) ───────────────────────
  app.get('/telepath/app/sap',           (req, res) => res.type('html').send(renderWebAppShell('sap')));
  app.get('/telepath/app/pap/:token',    (req, res) => res.type('html').send(renderWebAppShell('pap', req.params.token)));
  app.get('/telepath/app/aap/:token',    (req, res) => res.type('html').send(renderWebAppShell('aap', req.params.token)));

  // ──── WebApp API (initData required) ───────────────────────
  app.post('/telepath/api/whoami', initDataAuth, (req, res) => {
    res.json({ ok: true, tg_user: req.tgUser });
  });

  app.get('/telepath/api/state/:tier/:token?', initDataAuth, (req, res) => {
    const tier = req.params.tier;
    const token = req.params.token;
    if (tier === 'sap') {
      // verify the user actually has SAP binding (defense in depth)
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
// WebApp shell HTML — minimal, mobile-first, dark, Telegram theme aware
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
.copy-btn { font-size:11px; padding:3px 8px; border-radius:5px; background:rgba(96,165,250,0.15); color:#60a5fa; border:none; cursor:pointer; font-family:inherit; margin-left:6px; }
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
    h += '<div class="card"><h3>Settings</h3>';
    h += '<label style="display:flex;align-items:center;gap:8px;padding:8px 0;"><input type="checkbox" id="ppd" '+(d.settings.public_pap_distribution?'checked':'')+'/> Public PAP distribution (/claim)</label>';
    h += '</div>';
    root.innerHTML = h;
    document.getElementById('createBtn').addEventListener('click', async () => {
      const name = document.getElementById('newName').value.trim();
      const description = document.getElementById('newDesc').value.trim();
      if (!name) { toast('Name required'); return; }
      try {
        const out = await api('POST', '/telepath/api/sap/projects', { name, description });
        toast('Created · binding added');
        setTimeout(load, 600);
      } catch (e) { toast('Failed: '+e.message); }
    });
    document.getElementById('ppd').addEventListener('change', async (ev) => {
      try { await api('PUT', '/drafts/tap/settings', {}); } catch (e) {}
      // Note: this endpoint requires SAP bearer, not initData — TODO unify; for now toggle is read-only display
      toast('Toggle PAP distribution via SAP page on website');
      ev.target.checked = d.settings.public_pap_distribution;
    });
  }

  function renderPAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">Project · '+esc(d.public_base.replace(/^https?:\\/\\//,''))+'</div>';
    h += '<div class="card"><h3>Live</h3>';
    h += '<a class="btn ghost" href="'+p.live_url+'" target="_blank">Open '+esc(p.live_url.replace(/^https?:\\/\\//,''))+' ↗</a>';
    h += '</div>';
    h += '<div class="card"><h3>Agents (AAP)</h3>';
    if (!p.aaps.length) h += '<div class="empty muted">No agents yet</div>';
    for (const a of p.aaps) {
      h += '<div class="proj-item"><div class="proj-name">'+esc(a.name||a.id)+(a.revoked?' (revoked)':'')+'</div>';
      h += '<div class="proj-meta">branch: '+esc(a.branch)+'</div></div>';
    }
    h += '<div style="margin-top:12px"><input id="aapName" placeholder="agent name (optional)" maxlength="60"/>';
    h += '<button class="btn" id="newAap">Generate AAP link</button></div>';
    h += '</div>';
    h += '<div class="card"><h3>Project info</h3>';
    h += '<div class="row"><span class="k">created</span><span class="v">'+esc(p.created_at.slice(0,10))+'</span></div>';
    if (p.github_repo) h += '<div class="row"><span class="k">github</span><span class="v">'+esc(p.github_repo)+'</span></div>';
    h += '<div class="row"><span class="k">description</span><span class="v">'+esc(p.description||'—')+'</span></div>';
    h += '</div>';
    root.innerHTML = h;
    document.getElementById('newAap').addEventListener('click', async () => {
      const name = document.getElementById('aapName').value.trim();
      try {
        const out = await api('POST', '/telepath/api/pap/aaps', { pap_token: TOKEN, name });
        const url = out.activation_url;
        copy(url);
        toast('Link copied — share it with the agent');
        setTimeout(load, 600);
      } catch (e) { toast('Failed: '+e.message); }
    });
  }

  function renderAAP(d) {
    const p = d.project;
    let h = '<h1>'+esc(p.name)+'</h1><div class="sub">Agent: '+esc(d.aap.name||d.aap.id)+'</div>';
    h += '<div class="card"><h3>Branch</h3>';
    h += '<div class="row"><span class="k">name</span><span class="v">'+esc(d.aap.branch)+'</span></div>';
    h += '<div class="row"><span class="k">project live</span><span class="v"><a href="'+p.live_url+'" target="_blank" style="color:#60a5fa">'+esc(p.live_url.replace(/^https?:\\/\\//,''))+'</a></span></div>';
    h += '</div>';
    h += '<div class="card"><h3>Working with this branch</h3><div class="muted">For now, use Claude in Chrome to edit files in your branch. The bot will notify the project owner when you commit.</div></div>';
    root.innerHTML = h;
  }

  load();
})();
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// init() — called by drafts.js at startup
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
    refreshBotMe().then(() => pollLoop());
    if (botMeRefreshTimer) clearInterval(botMeRefreshTimer);
    botMeRefreshTimer = setInterval(refreshBotMe, 6 * 3600 * 1000); // every 6h
  } else {
    console.log('[telepath] no TAP installed — bot inactive. Install via PUT /drafts/tap');
  }
}

export function mountTelepathRoutes(app) { mountRoutes(app); }

// Hooks (called by drafts.js when events happen)
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

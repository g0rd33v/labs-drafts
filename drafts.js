// drafts v0.8 — Three-tier access model + Telepath + Project Bots + Per-project analytics + SAP drafts-event notifications.
//
// v0.8 adds:
//   - SAP-event notifications (boot, version bump, schema migration, errors) via telepathHooks
//   - Persisted last_known_version in state for version-bump detection
//   - GitHub auto-sync setting per project (auto-pushes to GitHub on every commit)
//
// Public URL scheme:
//   /<n>/                     -> live
//   /<n>/<path>               -> file from live
//   /<n>/v/<N>/               -> snapshot of commit #N
//   /<n>/v/<N>/<path>         -> file from snapshot N
//   /drafts/pass/<token>         -> welcome (SAP/PAP/AAP)
//   /drafts/...                  -> API
//   /telepath/app/{sap|pap|aap}  -> Telegram WebApp dashboards
//
// Spec & registry: https://github.com/g0rd33v/drafts-protocol

import express from 'express';
import simpleGit from 'simple-git';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { buildRichContext } from "./rich-context.js";
import { initTelepath, mountTelepathRoutes, hooks as telepathHooks, getTelepathStatus } from "./telepath.js";
import { initProjectBots } from "./project-bots.js";
import { startDailySnapshotScheduler } from "./analytics.js";

const VERSION = '0.8';

// Config: try /etc/labs/drafts.env first (production), then ./drafts.env (dev), then legacy
const ENV_CANDIDATES = ['/etc/labs/drafts.env', './drafts.env', '/opt/drafts-receiver/.env'];
for (const p of ENV_CANDIDATES) { if (fs.existsSync(p)) { dotenv.config({ path: p }); break; } }

const PORT            = Number(process.env.PORT || 3100);
const SERVER_NUMBER   = Number(process.env.SERVER_NUMBER || 0);
let   SAP_TOKEN       = process.env.BEARER_TOKEN || process.env.SAP_TOKEN;
const DRAFTS_DIR      = process.env.DRAFTS_DIR || '/var/lib/drafts';
process.env.DRAFTS_DIR = DRAFTS_DIR;
const PUBLIC_BASE     = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE || (() => {
  console.error('FATAL: PUBLIC_BASE_URL must be set (e.g. https://drafts.example.com)');
  process.exit(1);
})();
const GITHUB_USER     = process.env.GITHUB_USER || '';
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN || '';
const STATE_PATH      = path.join(DRAFTS_DIR, '.state.json');
const CHROME_EXT_URL  = 'https://chromewebstore.google.com/detail/claude-for-chrome/fmpnliohjhemenmnlpbfagaolkdacoja';

const RESERVED_NAMES = new Set([
  'drafts', 'live', 'api', 'pass', 'v', 'version', 'versions',
  'health', 'whoami', 'projects', 'aaps', 'aap', 'pap', 'sap', 'tap',
  'static', 'assets', 'admin', 'www', '_', 'config', 'github',
  'upload', 'commit', 'promote', 'rollback', 'pending', 'merge',
  'files', 'file', 'history', 'about', 'gallery', 'docs', 'telepath',
]);

if (!SAP_TOKEN) {
  SAP_TOKEN = crypto.randomBytes(8).toString('hex');
  const sapFile = '/etc/labs/drafts.sap';
  try {
    fs.mkdirSync('/etc/labs', { recursive: true });
    fs.writeFileSync(sapFile, SAP_TOKEN + '\n', { mode: 0o600 });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  drafts: NEW SAP MINTED — SAVE THIS, ONLY SHOWN ONCE');
    console.log('  SAP token: ' + SAP_TOKEN);
    console.log('  Saved to: ' + sapFile + ' (mode 0600)');
    console.log('  Welcome:  ' + PUBLIC_BASE + '/drafts/pass/drafts_server_' + SERVER_NUMBER + '_' + SAP_TOKEN);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (e) {
    console.log('SAP minted (NOT persisted, save now): ' + SAP_TOKEN + ' — error: ' + e.message);
  }
}

let state = { projects: [], github_default: null };
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (!state.projects) state.projects = [];
    }
  } catch (e) {
    console.error('state load failed:', e.message);
    state = { projects: [], github_default: null };
  }
}
function saveState() {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
loadState();

// One-time migration: ensure every project.bot has webhook_url + webhook_log fields (v0.6 schema)
function migrateProjectBotsToV06() {
  let changed = 0;
  for (const p of state.projects) {
    if (p.bot && p.bot.token) {
      if (!('webhook_url' in p.bot)) { p.bot.webhook_url = null; changed++; }
      if (!Array.isArray(p.bot.webhook_log)) { p.bot.webhook_log = []; changed++; }
    }
  }
  if (changed > 0) {
    saveState();
    console.log(`[drafts] migrated ${changed} bot field(s) to v0.6 schema`);
    setTimeout(() => { try { telepathHooks.onSchemaMigration(`v0.6 bot schema: ${changed} field(s) added`); } catch (e) {} }, 5000);
  }
}
migrateProjectBotsToV06();

// v0.8 migration: ensure github_autosync field on each project (default false)
function migrateProjectsToV08() {
  let changed = 0;
  for (const p of state.projects) {
    if (!('github_autosync' in p)) { p.github_autosync = false; changed++; }
  }
  if (changed > 0) {
    saveState();
    console.log(`[drafts] migrated ${changed} project(s) to v0.8 schema (github_autosync default false)`);
    setTimeout(() => { try { telepathHooks.onSchemaMigration(`v0.8 schema: ${changed} project(s) got github_autosync field`); } catch (e) {} }, 5000);
  }
}
migrateProjectsToV08();

// v0.8: detect version change vs persisted last_known_version (drafts schedules notify after Telepath ready)
const previousVersion = state.last_known_version || null;
const isVersionBump = previousVersion && previousVersion !== VERSION;
const isFirstBoot = !previousVersion;
state.last_known_version = VERSION;
state.last_boot_at = new Date().toISOString();
saveState();

const TIER_BYTES = { sap: 8, pap: 6, aap: 5 };
const newToken   = (prefix) => prefix + '_' + crypto.randomBytes(TIER_BYTES[prefix] || 6).toString('hex');
const newId      = () => crypto.randomBytes(4).toString('hex');
const now        = () => new Date().toISOString();

function findProjectByName(name) { return state.projects.find(p => p.name === name) || null; }
function findProjectByPAP(token) { return state.projects.find(p => p.pap && p.pap.token === token && !p.pap.revoked) || null; }
function findProjectAndAAPByAAPToken(token) {
  for (const p of state.projects) {
    const a = (p.aaps || []).find(x => x.token === token && !x.revoked);
    if (a) return { project: p, aap: a };
  }
  return null;
}
function sanitizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}
function isReservedName(name) { return RESERVED_NAMES.has(name); }

function resolveGithubConfig(project) {
  if (project && project.github_config && project.github_config.token && project.github_config.user) {
    return { user: project.github_config.user, token: project.github_config.token, source: 'project' };
  }
  if (state.github_default && state.github_default.token && state.github_default.user) {
    return { user: state.github_default.user, token: state.github_default.token, source: 'server_default' };
  }
  if (GITHUB_TOKEN && GITHUB_USER) {
    return { user: GITHUB_USER, token: GITHUB_TOKEN, source: 'env' };
  }
  return null;
}

// Internal: push a project's main branch to GitHub (used by /github/sync and autosync)
async function _githubSyncProject(project) {
  if (!project.github_repo) throw new Error('project_not_linked_to_github');
  const gh = resolveGithubConfig(project);
  if (!gh) throw new Error('github_not_configured');
  const pp = await ensureProjectDirs(project.name);
  const git = simpleGit(pp.drafts);
  await switchToBranch(git, 'main');
  const remoteUrl = `https://${gh.user}:${gh.token}@github.com/${project.github_repo}.git`;
  const remotes = await git.getRemotes();
  if (!remotes.find(r => r.name === 'origin')) await git.addRemote('origin', remoteUrl);
  else await git.remote(['set-url', 'origin', remoteUrl]);
  await git.push(['-u', 'origin', 'main', '--force']);
  await git.remote(['set-url', 'origin', `https://github.com/${project.github_repo}.git`]);
  return { pushed_to: project.github_repo, config_source: gh.source };
}

async function _createProjectInternal({ name, description = '', github_repo = null, pap_name = null }) {
  name = sanitizeName(name);
  if (!name) throw new Error('invalid_name');
  if (isReservedName(name)) throw new Error('reserved_name');
  if (findProjectByName(name)) throw new Error('exists');
  const pap = { id: newId(), token: newToken('pap'), name: pap_name, created_at: now(), revoked: false };
  const proj = { name, description, github_repo, github_autosync: false, created_at: now(), pap, aaps: [] };
  state.projects.push(proj);
  saveState();
  await ensureProjectDirs(name);
  const papSecret = pap.token.replace(/^pap_/, '');
  const out = {
    project: name,
    pap_token: pap.token,
    pap_activation_url: `${PUBLIC_BASE}/drafts/pass/drafts_project_${SERVER_NUMBER}_${papSecret}`,
    live_url: `${PUBLIC_BASE}/${name}/`,
    raw: proj,
  };
  try { telepathHooks.onNewProject(proj); } catch (e) {}
  return out;
}

async function _createAAPInternal(project, { name = null }) {
  const aap = { id: newId(), token: newToken('aap'), name: (name || '').toString().slice(0, 60) || null, created_at: now(), revoked: false, branch: '' };
  aap.branch = `aap/${aap.id}`;
  project.aaps = project.aaps || [];
  project.aaps.push(aap);
  saveState();
  const aapSecret = aap.token.replace(/^aap_/, '');
  return {
    aap: { id: aap.id, name: aap.name, branch: aap.branch, created_at: aap.created_at, token: aap.token },
    activation_url: `${PUBLIC_BASE}/drafts/pass/drafts_agent_${SERVER_NUMBER}_${aapSecret}`,
  };
}

const RATE = {
  sap:  { perMinute: 120, perHour: 2000, perDay: 20000 },
  pap:  { perMinute: 60,  perHour: 600,  perDay: 5000 },
  aap:  { perMinute: 10,  perHour: 60,   perDay: 300 },
};
const hits = new Map();
function checkRate(tier, tokenId) {
  const limits = RATE[tier];
  if (!limits) return { ok: true };
  const nowMs = Date.now();
  const windows = [
    { bucket: 'm', ms: 60 * 1000,        max: limits.perMinute },
    { bucket: 'h', ms: 60 * 60 * 1000,   max: limits.perHour },
    { bucket: 'd', ms: 24*60*60*1000,    max: limits.perDay },
  ];
  for (const w of windows) {
    const key = `${tier}:${tokenId}:${w.bucket}`;
    const arr = hits.get(key) || [];
    const pruned = arr.filter(t => nowMs - t < w.ms);
    if (pruned.length >= w.max) {
      const oldest = pruned[0];
      const retryIn = Math.ceil((w.ms - (nowMs - oldest)) / 1000);
      return { ok: false, window: w.bucket, retryAfter: retryIn };
    }
    pruned.push(nowMs);
    hits.set(key, pruned);
  }
  return { ok: true };
}

function parseBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
function authSAP(req, res, next) {
  const tok = parseBearer(req);
  if (!tok || tok !== SAP_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const rl = checkRate('sap', 'root');
  if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
  req.tier = 'sap'; next();
}
function authPAPorSAP(req, res, next) {
  const tok = parseBearer(req);
  if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (tok === SAP_TOKEN) { req.tier = 'sap'; return next(); }
  const p = findProjectByPAP(tok);
  if (p) {
    const rl = checkRate('pap', p.pap.id);
    if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
    req.tier = 'pap'; req.project = p; return next();
  }
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}
function authAny(req, res, next) {
  const tok = parseBearer(req);
  if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (tok === SAP_TOKEN) { req.tier = 'sap'; return next(); }
  const p = findProjectByPAP(tok);
  if (p) {
    const rl = checkRate('pap', p.pap.id);
    if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
    req.tier = 'pap'; req.project = p; return next();
  }
  const aapHit = findProjectAndAAPByAAPToken(tok);
  if (aapHit) {
    const rl = checkRate('aap', aapHit.aap.id);
    if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
    req.tier = 'aap'; req.project = aapHit.project; req.aap = aapHit.aap; return next();
  }
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function projectPaths(name) {
  const root = path.join(DRAFTS_DIR, name);
  return {
    root,
    drafts: path.join(root, 'drafts'),
    live:   path.join(root, 'live'),
    versions: path.join(root, 'v'),
  };
}

async function ensureProjectDirs(name) {
  const pp = projectPaths(name);
  await fsp.mkdir(pp.drafts, { recursive: true });
  await fsp.mkdir(pp.live,   { recursive: true });
  await fsp.mkdir(pp.versions, { recursive: true });
  const git = simpleGit(pp.drafts);
  if (!fs.existsSync(path.join(pp.drafts, '.git'))) {
    await git.init();
    const hostname = new URL(PUBLIC_BASE).hostname;
    await git.addConfig('user.email', `drafts@${hostname}`, false, 'local');
    await git.addConfig('user.name',  'drafts', false, 'local');
    const readme = path.join(pp.drafts, '.drafts-init');
    await fsp.writeFile(readme, 'initialised ' + now() + '\n');
    await git.add('.drafts-init');
    await git.commit('init ' + name, { '--allow-empty': null });
    try { await git.branch(['-m', 'main']); } catch (e) {}
  }
  return pp;
}

async function switchToBranch(git, branch) {
  const branches = await git.branch();
  if (branches.all.includes(branch)) {
    await git.checkout(branch);
  } else {
    try { await git.checkout('main'); } catch (e) {}
    await git.checkoutLocalBranch(branch);
  }
}

async function materializeVersion(name) {
  const pp = projectPaths(name);
  let total;
  try {
    total = Number(execSync(`git -C "${pp.drafts}" rev-list --count main`).toString().trim());
  } catch (e) {
    return null;
  }
  const N = Math.max(1, total - 1);
  const dest = path.join(pp.versions, String(N));
  if (fs.existsSync(dest)) return N;
  const tmp = dest + '.tmp';
  try { execSync(`rm -rf "${tmp}"`); } catch (e) {}
  await fsp.mkdir(pp.versions, { recursive: true });
  execSync(`cp -a "${pp.drafts}/." "${tmp}"`);
  try { execSync(`rm -rf "${tmp}/.git" "${tmp}/.drafts-init"`); } catch (e) {}
  execSync(`mv "${tmp}" "${dest}"`);
  return N;
}

async function promoteToLive(name) {
  const pp = projectPaths(name);
  const tmp = pp.live + '.tmp';
  const old = pp.live + '.old';
  try { execSync(`rm -rf "${tmp}" "${old}"`); } catch (e) {}
  execSync(`cp -a "${pp.drafts}/." "${tmp}"`);
  try { execSync(`rm -rf "${tmp}/.git" "${tmp}/.drafts-init"`); } catch (e) {}
  try { execSync(`mv "${pp.live}" "${old}"`); } catch (e) {}
  execSync(`mv "${tmp}" "${pp.live}"`);
  try { execSync(`rm -rf "${old}"`); } catch (e) {}
}

async function listVersions(name) {
  const pp = projectPaths(name);
  if (!fs.existsSync(pp.versions)) return [];
  const dirs = fs.readdirSync(pp.versions, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
    .map(d => Number(d.name))
    .sort((a, b) => a - b);
  return dirs;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.pdf':  'application/pdf',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
};
function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function resolveSafe(root, rel) {
  const cleaned = rel.replace(/\.\.+/g, '').replace(/^\/+/, '');
  const full = path.resolve(root, cleaned);
  if (!full.startsWith(path.resolve(root))) return null;
  return full;
}

function serveStatic(rootDir, relPath, res) {
  const full = resolveSafe(rootDir, relPath);
  if (!full) return res.status(400).type('text/plain').send('bad path');
  if (!fs.existsSync(full)) return res.status(404).type('text/plain').send('not found');
  let target = full;
  let stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const idx = path.join(target, 'index.html');
    if (fs.existsSync(idx) && fs.statSync(idx).isFile()) {
      target = idx;
      stat = fs.statSync(target);
    } else {
      return res.status(404).type('text/plain').send('no index.html');
    }
  }
  res.set('Content-Type', mimeFor(target));
  res.set('Cache-Control', 'public, max-age=60');
  res.set('Last-Modified', stat.mtime.toUTCString());
  return fs.createReadStream(target).pipe(res);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health
app.get('/drafts/health', (req, res) => {
  const tp = getTelepathStatus();
  const projectBotsCount = state.projects.filter(p => p.bot && p.bot.token).length;
  const webhookBotsCount = state.projects.filter(p => p.bot && p.bot.token && p.bot.webhook_url).length;
  const analyticsEnabledCount = state.projects.filter(p => p.bot && p.bot.token && p.bot.analytics_enabled !== false).length;
  const githubAutosyncCount = state.projects.filter(p => p.github_autosync).length;
  res.json({
    ok: true,
    version: VERSION,
    protocol: 'drafts',
    server_number: SERVER_NUMBER,
    telepath: tp,
    project_bots: { total: projectBotsCount, in_webhook_mode: webhookBotsCount, analytics_enabled: analyticsEnabledCount },
    github_autosync_enabled: githubAutosyncCount,
    uptime_sec: Math.floor(process.uptime()),
  });
});

mountTelepathRoutes(app);

function renderPage({ tier, token, project, aap, versions = [] }) {
  const isSAP = tier === 'sap';
  const isPAP = tier === 'pap';
  const isAAP = tier === 'aap';

  const roleBadge = isSAP ? 'SAP — server' : isPAP ? `PAP — ${project.name}` : `AAP — ${project.name}`;
  const title     = isSAP ? 'drafts · server link' : isPAP ? `drafts · ${project.name} (project link)` : `drafts · ${project.name} (agent link)`;
  const apiBase   = PUBLIC_BASE + '/drafts';
  const liveUrl   = project ? `${PUBLIC_BASE}/${project.name}/` : null;
  const latestVersion = versions.length ? versions[versions.length - 1] : null;
  const latestVersionUrl = (project && latestVersion) ? `${PUBLIC_BASE}/${project.name}/v/${latestVersion}/` : null;

  const tierWord = tier === "pap" ? "project" : tier === "aap" ? "agent" : tier === "sap" ? "server" : tier;
  const cleanTok = token.replace(/^(pap|aap)_/, "");
  const portableId = `${PUBLIC_BASE}/drafts/pass/drafts_${tierWord}_${SERVER_NUMBER}_${cleanTok}`;

  const tpStatus = getTelepathStatus();

  const machine = {
    system: 'drafts',
    version: VERSION,
    tier,
    api_base: apiBase,
    auth: { header: 'Authorization', scheme: 'Bearer', token },
    portable_identifier: portableId,
    server_number: SERVER_NUMBER,
    registry_url: 'https://github.com/g0rd33v/drafts-protocol/blob/main/drafts-registry.json',
    public_gallery: PUBLIC_BASE + '/',
    telepath: tpStatus.installed ? { bot_username: tpStatus.bot?.username, polling: tpStatus.polling } : { installed: false },
    url_scheme: project ? {
      live: `${PUBLIC_BASE}/${project.name}/`,
      live_file: `${PUBLIC_BASE}/${project.name}/<path>`,
      version: `${PUBLIC_BASE}/${project.name}/v/<N>/`,
      version_file: `${PUBLIC_BASE}/${project.name}/v/<N>/<path>`,
      latest_version_number: latestVersion,
      total_versions: versions.length,
    } : null,
    what_this_link_is: isSAP
      ? 'SERVER API PASS for drafts. Root access. Treat this token as root; never share it in any output.'
      : isPAP
      ? `PROJECT API PASS for "${project.name}" on drafts. Live at ${PUBLIC_BASE}/${project.name}/. Each commit produces an immutable snapshot at /v/<N>/.`
      : `AGENT API PASS for "${project.name}". Changes land in your own branch; owner reviews and publishes.`,
    conversation_tone: { mode: 'friendly, builder-energy', emoji_policy: 'sparing', response_length: 'short' },
    on_first_load: { summary: project ? `Check ${apiBase}/project/info + files + history and greet based on state.` : 'Greet warmly, offer overview.' },
    transport: 'Try built-in HTTP tools first; on failure switch to Claude for Chrome silently.',
    capabilities: isSAP ? ['list_projects','create_project','delete_project','revoke_passes','configure_github_default','manage_telepath_bot']
      : isPAP ? ['build','publish','invite_aaps','merge','rollback_to_version','github_sync','github_autosync','attach_telegram_bot','set_bot_webhook_url','view_bot_analytics']
      : ['build_in_branch','read_live','read_history'],
    endpoints: isSAP ? [
      { method: 'GET', path: '/projects' },
      { method: 'POST', path: '/projects', body: '{name, description?, github_repo?}' },
      { method: 'DELETE', path: '/projects/:name' },
      { method: 'GET', path: '/tap' },
      { method: 'PUT', path: '/tap', body: '{token}' },
      { method: 'DELETE', path: '/tap' },
    ] : isPAP ? [
      { method: 'GET', path: '/project/info' },
      { method: 'GET', path: '/project/versions' },
      { method: 'POST', path: '/upload', body: '{filename, content}' },
      { method: 'POST', path: '/commit', body: '{message?}' },
      { method: 'POST', path: '/promote' },
      { method: 'POST', path: '/rollback', body: '{commit_or_version}' },
      { method: 'POST', path: '/aaps', body: '{name?}' },
      { method: 'POST', path: '/merge', body: '{aap_id}' },
    ] : [
      { method: 'POST', path: '/upload', body: '{filename, content}' },
      { method: 'POST', path: '/commit' },
      { method: 'GET', path: '/files' },
    ],
    branching: project ? {
      main: 'main',
      aap_format: 'aap/<id>',
      versioning: 'Every commit on main produces /<n>/v/<N>/. Immutable snapshots.',
    } : null,
  };

  const welcomeH1 = isSAP ? 'Server link' : project.name;
  const subline = isSAP
    ? 'Root access. Paste into Claude.'
    : isPAP
    ? `Your project. Live at ${PUBLIC_BASE}/${project.name}/. ${versions.length} versions.`
    : `Contributor link to ${project.name}. Your changes go to your own branch.`;

  let tapSection = '';
  if (isSAP) {
    tapSection = renderTapSection(tpStatus, token);
  }

  let html = '';
  html += '<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>';
  html += `<title>${title}</title><meta name="robots" content="noindex,nofollow"/>`;
  html += '<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#000;color:#f5f5f5;font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.6}';
  html += 'a{color:#60a5fa}.wrap{max-width:720px;margin:0 auto;padding:64px 28px}';
  html += 'h1{font-size:44px;font-weight:800;letter-spacing:-0.03em;margin-bottom:14px}';
  html += '.lead{font-size:17px;color:#a8a8a8;margin-bottom:28px}.badge{display:inline-block;padding:3px 10px;border-radius:4px;font-size:11px;border:1px solid rgba(255,255,255,0.07);color:#a8a8a8;margin-bottom:14px}';
  html += '.btn{display:inline-block;padding:11px 20px;border-radius:10px;background:#ea5a2e;color:#fff;text-decoration:none;font-weight:600;margin-right:10px;margin-top:14px}';
  html += '.meta{margin-top:28px;font-size:12px;color:#6a6a6a}.meta a{color:#a8a8a8}';
  html += '</style></head><body><div class="wrap">';
  html += `<span class="badge">${roleBadge}</span><h1>${welcomeH1}</h1><p class="lead">${subline}</p>`;
  html += buildRichContext({ tier, token, project, projectsDir: DRAFTS_DIR, publicBase: PUBLIC_BASE });
  html += tapSection;
  html += `<a class="btn" href="${CHROME_EXT_URL}" target="_blank">Install Claude for Chrome ↗</a>`;
  html += `<button class="btn" id="copyUrlBtn" type="button" data-portable="${portableId}" style="background:rgba(96,165,250,0.15);border:none;color:#93c5fd;cursor:pointer;font-family:inherit;font-size:14px">Copy link</button>`;
  if (project) {
    html += '<div class="meta">';
    html += `<a href="${liveUrl}" target="_blank">live ↗</a>`;
    if (latestVersionUrl) html += ` · <a href="${latestVersionUrl}" target="_blank">v${latestVersion} ↗</a>`;
    html += '</div>';
  }
  html += '<script>(function(){var b=document.getElementById("copyUrlBtn");if(!b)return;b.addEventListener("click",function(){navigator.clipboard.writeText(b.dataset.portable);b.textContent="Copied ✓";setTimeout(function(){b.textContent="Copy link"},1500);});})();</script>';
  html += '<script type="application/json" id="claude-instructions">' + JSON.stringify(machine, null, 2) + '</' + 'script>';
  html += '</div></body></html>';
  return html;
}

function renderTapSection(tpStatus, sapToken) {
  let inner;
  if (tpStatus.installed && tpStatus.bot) {
    inner = `
      <div style="font-size:13px;color:#a8a8a8;margin-bottom:8px">Connected as <strong style="color:#f5f5f5">@${tpStatus.bot.username}</strong> · polling: ${tpStatus.polling ? '<span style="color:#4ade80">on</span>' : '<span style="color:#ea5a2e">off</span>'}</div>
      <div style="font-size:12px;color:#6a6a6a;margin-bottom:14px">Open the bot in Telegram → send your SAP/PAP/AAP token → get a dashboard.</div>
      <button id="tapDisconnect" type="button" style="padding:8px 14px;border-radius:8px;background:transparent;border:1px solid rgba(234,90,46,0.4);color:#ea5a2e;font-weight:600;font-size:12px;cursor:pointer">Disconnect bot</button>
    `;
  } else {
    inner = `
      <div style="font-size:13px;color:#a8a8a8;margin-bottom:14px">Drafts Telepath isn't connected to a bot yet. Create a bot via <a href="https://t.me/BotFather" target="_blank" style="color:#60a5fa">@BotFather</a> on Telegram, then paste its API token below to bring this server's data into your DM.</div>
      <input id="tapTokenInput" type="password" placeholder="123456789:AA..." style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#000;color:#f5f5f5;font-family:ui-monospace,Menlo,monospace;font-size:13px;box-sizing:border-box;margin-bottom:10px"/>
      <button id="tapInstall" type="button" style="padding:10px 18px;border-radius:8px;background:#ea5a2e;border:none;color:#fff;font-weight:600;font-size:13px;cursor:pointer">Connect bot</button>
      <div id="tapStatus" style="margin-top:10px;font-size:12px;color:#6a6a6a"></div>
    `;
  }
  return `
    <div style="background:#0c0c0c;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:20px 22px;margin:28px 0;">
      <h3 style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#6a6a6a;margin:0 0 14px 0;">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${tpStatus.installed ? '#4ade80' : '#6a6a6a'};margin-right:8px;vertical-align:middle"></span>
        Telepath · Telegram bot
      </h3>
      ${inner}
    </div>
    <script>
    (function(){
      var sap = ${JSON.stringify(sapToken)};
      var hdr = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sap };
      var btnI = document.getElementById('tapInstall');
      if (btnI) {
        btnI.addEventListener('click', function() {
          var tok = (document.getElementById('tapTokenInput').value || '').trim();
          var status = document.getElementById('tapStatus');
          if (!/^\\d+:[A-Za-z0-9_-]{30,}$/.test(tok)) { status.textContent = 'Invalid token format. It should look like 1234567:AA...'; status.style.color='#ea5a2e'; return; }
          status.textContent = 'Verifying with Telegram...'; status.style.color='#a8a8a8';
          fetch('/drafts/tap', { method:'PUT', headers: hdr, body: JSON.stringify({ token: tok }) })
            .then(function(r){ return r.json(); })
            .then(function(j){
              if (j.ok) { status.textContent = 'Connected as @' + j.bot.username + '. Reload to see status.'; status.style.color='#4ade80'; setTimeout(function(){ location.reload(); }, 1500); }
              else { status.textContent = 'Failed: ' + (j.detail || j.error); status.style.color='#ea5a2e'; }
            })
            .catch(function(e){ status.textContent = 'Network error: ' + e.message; status.style.color='#ea5a2e'; });
        });
      }
      var btnD = document.getElementById('tapDisconnect');
      if (btnD) {
        btnD.addEventListener('click', function() {
          if (!confirm('Disconnect bot? Users will lose access until you reconnect.')) return;
          fetch('/drafts/tap', { method:'DELETE', headers: hdr })
            .then(function(){ location.reload(); });
        });
      }
    })();
    </script>
  `;
}

async function welcomeRoute(req, res) {
  let token = req.params.token || "";
  const portable = token.match(/^drafts_(server|project|agent)_(\d+)_([a-f0-9]+)$/i);
  if (portable) {
    const tierWord = portable[1].toLowerCase();
    const secret = portable[3];
    if (tierWord === "server") token = secret;
    else if (tierWord === "project") token = "pap_" + secret;
    else if (tierWord === "agent") token = "aap_" + secret;
  }
  let tier;
  if (token.startsWith("pap_")) tier = "pap";
  else if (token.startsWith("aap_")) tier = "aap";
  else if (/^[0-9a-f]{12,64}$/i.test(token)) tier = "sap";
  else return res.status(404).send("not found");

  if (tier === 'sap') {
    if (token !== SAP_TOKEN) return res.status(404).send('not found');
    return res.type('html').send(renderPage({ tier: 'sap', token }));
  }
  if (tier === 'pap') {
    const p = findProjectByPAP(token);
    if (!p) return res.status(404).send('not found');
    const versions = await listVersions(p.name);
    return res.type('html').send(renderPage({ tier: 'pap', token, project: p, versions }));
  }
  if (tier === 'aap') {
    const hit = findProjectAndAAPByAAPToken(token);
    if (!hit) return res.status(404).send('not found');
    const versions = await listVersions(hit.project.name);
    return res.type('html').send(renderPage({ tier: 'aap', token, project: hit.project, aap: hit.aap, versions }));
  }
}

app.get('/drafts/pass/:token', welcomeRoute);

app.get('/m/:token', (req, res) => {
  return res.status(410).type('html').send('<h1>This link has expired</h1><p>Drafts was upgraded. Ask the server owner for a fresh link.</p>');
});

app.get('/drafts/whoami', authAny, (req, res) => {
  if (req.tier === 'sap') return res.json({ ok: true, tier: 'sap', total_projects: state.projects.length });
  if (req.tier === 'pap') return res.json({ ok: true, tier: 'pap', project: req.project.name });
  return res.json({ ok: true, tier: 'aap', project: req.project.name, agent: req.aap.name || 'unnamed', branch: req.aap.branch });
});

app.get('/drafts/server/stats', authSAP, (req, res) => {
  res.json({
    ok: true, server_number: SERVER_NUMBER, total_projects: state.projects.length,
    github_default_configured: !!(state.github_default && state.github_default.token),
    telepath: getTelepathStatus(),
    projects: state.projects.map(p => ({
      name: p.name, created_at: p.created_at,
      aap_count: (p.aaps || []).filter(a => !a.revoked).length,
      bot_attached: !!(p.bot && p.bot.token),
      bot_mode: p.bot && p.bot.token ? (p.bot.webhook_url ? 'webhook' : 'default') : null,
      analytics_enabled: p.bot && p.bot.token ? (p.bot.analytics_enabled !== false) : null,
      github_autosync: !!p.github_autosync,
    })),
  });
});

app.get('/drafts/projects', authSAP, (req, res) => {
  res.json({
    ok: true,
    projects: state.projects.map(p => ({
      name: p.name, description: p.description, github_repo: p.github_repo, github_autosync: !!p.github_autosync,
      created_at: p.created_at, live_url: `${PUBLIC_BASE}/${p.name}/`,
      pap: p.pap ? { id: p.pap.id, revoked: p.pap.revoked, activation_url: `${PUBLIC_BASE}/drafts/pass/drafts_project_${SERVER_NUMBER}_${p.pap.token.replace(/^pap_/,'')}` } : null,
      aaps: (p.aaps || []).map(a => ({ id: a.id, name: a.name, revoked: a.revoked })),
      bot: p.bot ? {
        bot_username: p.bot.bot_username,
        subscriber_count: (p.bot.subscribers || []).length,
        last_synced_at: p.bot.last_synced_at,
        mode: p.bot.webhook_url ? 'webhook' : 'default',
        webhook_url: p.bot.webhook_url || null,
        analytics_enabled: p.bot.analytics_enabled !== false,
      } : null,
    })),
  });
});

app.post('/drafts/projects', authSAP, async (req, res) => {
  try {
    const out = await _createProjectInternal({
      name: req.body.name,
      description: req.body.description || '',
      github_repo: req.body.github_repo || null,
      pap_name: req.body.pap_name || null,
    });
    res.json({ ok: true, project: out.project, pap_activation_url: out.pap_activation_url, live_url: out.live_url });
  } catch (e) {
    const code = e.message === 'invalid_name' ? 400 : e.message === 'reserved_name' ? 400 : e.message === 'exists' ? 409 : 500;
    res.status(code).json({ ok: false, error: e.message });
  }
});

app.delete('/drafts/projects/:name', authSAP, async (req, res) => {
  const name = sanitizeName(req.params.name);
  const p = findProjectByName(name);
  if (!p) return res.status(404).json({ ok: false, error: 'not_found' });
  state.projects = state.projects.filter(x => x.name !== name);
  saveState();
  try { execSync(`rm -rf "${projectPaths(name).root}"`); } catch (e) {}
  res.json({ ok: true, deleted: name });
});

app.delete('/drafts/projects/:name/pap', authSAP, (req, res) => {
  const p = findProjectByName(sanitizeName(req.params.name));
  if (!p || !p.pap) return res.status(404).json({ ok: false, error: 'not_found' });
  p.pap.revoked = true; saveState();
  res.json({ ok: true, revoked: p.pap.id });
});

app.get('/drafts/project/info', authAny, (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  res.json({
    ok: true, project: p.name, description: p.description, github_repo: p.github_repo, github_autosync: !!p.github_autosync,
    created_at: p.created_at, live_url: `${PUBLIC_BASE}/${p.name}/`, viewer_tier: req.tier,
    bot_attached: !!(p.bot && p.bot.token),
    bot_username: p.bot?.bot_username || null,
    bot_mode: p.bot && p.bot.token ? (p.bot.webhook_url ? 'webhook' : 'default') : null,
    analytics_enabled: p.bot && p.bot.token ? (p.bot.analytics_enabled !== false) : null,
  });
});

app.get('/drafts/project/stats', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  try {
    const pp = await ensureProjectDirs(p.name);
    const git = simpleGit(pp.drafts);
    const branches = await git.branch();
    const log = await git.log({ maxCount: 10 });
    const liveFiles = fs.existsSync(pp.live) ? fs.readdirSync(pp.live).filter(f=>!f.startsWith('.')) : [];
    const versions = await listVersions(p.name);
    res.json({
      ok: true, project: p.name, live_url: `${PUBLIC_BASE}/${p.name}/`,
      aaps_active: (p.aaps || []).filter(a => !a.revoked).length,
      branches: branches.all,
      recent_commits: log.all.map(c => ({ hash: c.hash.slice(0,7), message: c.message, date: c.date })),
      live_files_count: liveFiles.length,
      versions: { count: versions.length, latest: versions[versions.length - 1] || null, all: versions },
      github_autosync: !!p.github_autosync,
      bot: p.bot ? {
        bot_username: p.bot.bot_username,
        subscribers: (p.bot.subscribers || []).length,
        last_synced_at: p.bot.last_synced_at,
        mode: p.bot.webhook_url ? 'webhook' : 'default',
        webhook_url: p.bot.webhook_url || null,
        webhook_log_count: (p.bot.webhook_log || []).length,
        analytics_enabled: p.bot.analytics_enabled !== false,
      } : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'stats_failed', detail: e.message });
  }
});

app.get('/drafts/project/versions', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const versions = await listVersions(p.name);
  let hashes = [];
  try { hashes = execSync(`git -C "${pp.drafts}" rev-list main --reverse`).toString().trim().split('\n').filter(Boolean); } catch (e) {}
  const out = [];
  for (const N of versions) {
    const hash = hashes[N];
    let msg = null, date = null;
    if (hash) {
      try {
        const line = execSync(`git -C "${pp.drafts}" show -s --format="%s|%aI" ${hash}`).toString().trim();
        const [m, d] = line.split('|'); msg = m; date = d;
      } catch (e) {}
    }
    out.push({ n: N, url: `${PUBLIC_BASE}/${p.name}/v/${N}/`, hash: hash ? hash.slice(0,7) : null, message: msg, date });
  }
  res.json({ ok: true, project: p.name, versions: out });
});

app.post('/drafts/aaps', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const out = await _createAAPInternal(p, { name: req.body.name });
  try { telepathHooks.onNewAAPCreated(p, out.aap); } catch (e) {}
  res.json({
    ok: true,
    aap: out.aap,
    activation_url: out.activation_url,
    email_draft_hint: { subject: `You're invited to "${p.name}" on drafts`, body: `Hey,\n\nYour link: ${out.activation_url}\n\nLive: ${PUBLIC_BASE}/${p.name}/\n\nCheers,\n` },
  });
});

app.get('/drafts/aaps', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branches = (await git.branch()).all;
  const aaps = await Promise.all((p.aaps || []).map(async (a) => {
    const br = `aap/${a.id}`;
    let pending = 0;
    if (branches.includes(br)) {
      try { const log = await git.log({ from: 'main', to: br }); pending = log.total; } catch (e) {}
    }
    const aapSecret = a.token.replace(/^aap_/, '');
    return { id: a.id, name: a.name, branch: br, revoked: a.revoked, created_at: a.created_at, activation_url: `${PUBLIC_BASE}/drafts/pass/drafts_agent_${SERVER_NUMBER}_${aapSecret}`, pending_commits: pending };
  }));
  res.json({ ok: true, project: p.name, aaps });
});

app.delete('/drafts/aaps/:id', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const a = (p.aaps || []).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: 'not_found' });
  a.revoked = true; saveState();
  res.json({ ok: true, revoked: a.id });
});

app.get('/drafts/pending', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branches = (await git.branch()).all.filter(b => b.startsWith('aap/'));
  const result = [];
  for (const br of branches) {
    const aapId = br.slice(4);
    const aap = (p.aaps || []).find(x => x.id === aapId);
    if (!aap || aap.revoked) continue;
    try {
      const log = await git.log({ from: 'main', to: br });
      if (log.total === 0) continue;
      result.push({ aap_id: aap.id, aap_name: aap.name, branch: br, commits: log.all.slice(0, 20).map(c => ({ hash: c.hash.slice(0,7), message: c.message, date: c.date })), total_pending: log.total });
    } catch (e) {}
  }
  res.json({ ok: true, project: p.name, pending: result });
});

app.post('/drafts/merge', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const aapId = req.body.aap_id;
  if (!aapId) return res.status(400).json({ ok: false, error: 'aap_id_required' });
  const aap = (p.aaps || []).find(x => x.id === aapId);
  if (!aap) return res.status(404).json({ ok: false, error: 'aap_not_found' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  try {
    await git.checkout('main');
    await git.merge([`aap/${aap.id}`, '--no-ff', '-m', `merge aap/${aap.name || aap.id}`]);
    const N = await materializeVersion(p.name);
    try { telepathHooks.onAAPMerged(p, aap, N); } catch (e) {}
    // v0.8 autosync
    if (p.github_autosync && p.github_repo) {
      _githubSyncProject(p).catch(e => console.error('[autosync after merge] failed:', e.message));
    }
    res.json({ ok: true, merged: aap.id, branch: `aap/${aap.id}`, version: N, version_url: `${PUBLIC_BASE}/${p.name}/v/${N}/` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'merge_failed', detail: e.message });
  }
});

app.post('/drafts/upload', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const filename = String(req.body.filename || '').replace(/^\/+/, '').replace(/\.\./g, '');
  if (!filename) return res.status(400).json({ ok: false, error: 'filename_required' });
  const where = req.body.where === 'live' && req.tier !== 'aap' ? 'live' : 'drafts';
  const pp = await ensureProjectDirs(p.name);
  const root = where === 'live' ? pp.live : pp.drafts;
  const git = simpleGit(pp.drafts);
  if (req.tier === 'aap') await switchToBranch(git, req.aap.branch);
  else await switchToBranch(git, 'main');
  const full = path.join(root, filename);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  if (req.body.content_b64) {
    await fsp.writeFile(full, Buffer.from(req.body.content_b64, 'base64'));
  } else {
    await fsp.writeFile(full, req.body.content || '');
  }
  res.json({ ok: true, path: filename, where, branch: req.tier === 'aap' ? req.aap.branch : (where === 'drafts' ? 'main' : null) });
});

app.post('/drafts/commit', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branch = req.tier === 'aap' ? req.aap.branch : 'main';
  await switchToBranch(git, branch);
  await git.add('.');
  try {
    const msg = (req.body.message || 'update').toString().slice(0, 200);
    const out = await git.commit(msg);
    let versionInfo = null;
    if (branch === 'main' && out.commit) {
      const N = await materializeVersion(p.name);
      versionInfo = { n: N, url: `${PUBLIC_BASE}/${p.name}/v/${N}/` };
      try { telepathHooks.onMainCommit(p, { commit: out.commit, summary: out.summary, message: msg }, N); } catch (e) {}
      // v0.8 autosync (fire and forget)
      if (p.github_autosync && p.github_repo) {
        _githubSyncProject(p).catch(e => console.error('[autosync after commit] failed:', e.message));
      }
    }
    res.json({ ok: true, branch, commit: out.commit, summary: out.summary, version: versionInfo });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'commit_failed', detail: e.message });
  }
});

app.get('/drafts/files', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const where = req.query.where === 'live' ? 'live' : 'drafts';
  const pp = await ensureProjectDirs(p.name);
  const root = where === 'live' ? pp.live : pp.drafts;
  if (where === 'drafts' && req.tier === 'aap') {
    const git = simpleGit(pp.drafts);
    try { await switchToBranch(git, req.aap.branch); } catch(e) {}
  }
  const walk = (dir, base='') => {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = path.posix.join(base, entry.name);
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(abs, rel));
      else { const st = fs.statSync(abs); out.push({ name: rel, size: st.size, mtime: st.mtime.toISOString() }); }
    }
    return out;
  };
  res.json({ ok: true, where, files: walk(root) });
});

app.get('/drafts/file', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const where = req.query.where === 'live' ? 'live' : 'drafts';
  const relPath = String(req.query.path || '').replace(/^\/+/, '').replace(/\.\./g, '');
  const pp = await ensureProjectDirs(p.name);
  if (where === 'drafts' && req.tier === 'aap') {
    const git = simpleGit(pp.drafts);
    try { await switchToBranch(git, req.aap.branch); } catch(e) {}
  }
  const full = path.join(where === 'live' ? pp.live : pp.drafts, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const content = fs.readFileSync(full, 'utf8');
    res.json({ ok: true, path: relPath, where, content });
  } catch (e) {
    const buf = fs.readFileSync(full);
    res.json({ ok: true, path: relPath, where, content_b64: buf.toString('base64') });
  }
});

app.delete('/drafts/file', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const where = req.query.where === 'live' && req.tier !== 'aap' ? 'live' : 'drafts';
  const relPath = String(req.query.path || '').replace(/^\/+/, '').replace(/\.\./g, '');
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  if (req.tier === 'aap') await switchToBranch(git, req.aap.branch);
  else await switchToBranch(git, 'main');
  const full = path.join(where === 'live' ? pp.live : pp.drafts, relPath);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'not_found' });
  fs.unlinkSync(full);
  res.json({ ok: true, deleted: relPath });
});

app.get('/drafts/history', authAny, async (req, res) => {
  const p = req.project;
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  const branch = req.tier === 'aap' ? req.aap.branch : 'main';
  try { await switchToBranch(git, branch); } catch(e) {}
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const log = await git.log({ maxCount: limit });
  res.json({ ok: true, branch, commits: log.all.map(c => ({ hash: c.hash.slice(0,7), full: c.hash, date: c.date, message: c.message })) });
});

app.post('/drafts/promote', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  try {
    await switchToBranch(git, 'main');
    await promoteToLive(p.name);
    res.json({ ok: true, live_url: `${PUBLIC_BASE}/${p.name}/` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'promote_failed', detail: e.message });
  }
});

app.post('/drafts/rollback', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const target = String(req.body.commit_or_version || req.body.commit || req.body.version || '');
  if (!target) return res.status(400).json({ ok: false, error: 'commit_or_version_required' });
  const pp = await ensureProjectDirs(p.name);
  const git = simpleGit(pp.drafts);
  try {
    await switchToBranch(git, 'main');
    let commitHash = target;
    if (/^\d+$/.test(target)) {
      const N = Number(target);
      const all = execSync(`git -C "${pp.drafts}" rev-list main --reverse`).toString().trim().split('\n');
      const c = all[N];
      if (!c) return res.status(404).json({ ok: false, error: 'version_not_found', detail: `version ${N} does not exist (have ${all.length - 1} versions)` });
      commitHash = c;
    }
    await git.reset(['--hard', commitHash]);
    try { await git.commit(`rollback to ${target}`, { '--allow-empty': null }); } catch (e) {}
    const total = Number(execSync(`git -C "${pp.drafts}" rev-list --count main`).toString().trim());
    const newN = Math.max(1, total - 1);
    try { execSync(`rm -rf "${path.join(pp.versions, String(newN))}"`); } catch (e) {}
    if (fs.existsSync(pp.versions)) {
      for (const dir of fs.readdirSync(pp.versions)) {
        if (/^\d+$/.test(dir) && Number(dir) > newN) {
          try { execSync(`rm -rf "${path.join(pp.versions, dir)}"`); } catch (e) {}
        }
      }
    }
    const N = await materializeVersion(p.name);
    res.json({ ok: true, reset_to: commitHash, new_version: N, version_url: `${PUBLIC_BASE}/${p.name}/v/${N}/` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'rollback_failed', detail: e.message });
  }
});

// GitHub config
app.get('/drafts/config/github', authSAP, (req, res) => {
  const cfg = state.github_default;
  if (!cfg || !cfg.token) return res.json({ ok: true, configured: false });
  res.json({ ok: true, configured: true, user: cfg.user, token_preview: cfg.token.slice(0, 4) + '...' + cfg.token.slice(-4) });
});
app.put('/drafts/config/github', authSAP, (req, res) => {
  const user = String(req.body.user || '').trim();
  const token = String(req.body.token || '').trim();
  if (!user || !token) return res.status(400).json({ ok: false, error: 'user_and_token_required' });
  state.github_default = { user, token };
  saveState();
  res.json({ ok: true, configured: true, user });
});
app.delete('/drafts/config/github', authSAP, (req, res) => {
  delete state.github_default; saveState();
  res.json({ ok: true, configured: false });
});
app.get('/drafts/projects/:name/config/github', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.params.name));
  if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
  const cfg = p.github_config;
  if (!cfg || !cfg.token) return res.json({ ok: true, configured: false });
  res.json({ ok: true, configured: true, user: cfg.user, token_preview: cfg.token.slice(0, 4) + '...' + cfg.token.slice(-4) });
});
app.put('/drafts/projects/:name/config/github', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.params.name));
  if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
  const user = String(req.body.user || '').trim();
  const token = String(req.body.token || '').trim();
  if (!user || !token) return res.status(400).json({ ok: false, error: 'user_and_token_required' });
  p.github_config = { user, token }; saveState();
  res.json({ ok: true, configured: true, user });
});
app.delete('/drafts/projects/:name/config/github', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.params.name));
  if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
  delete p.github_config; saveState();
  res.json({ ok: true, configured: false });
});

app.post('/drafts/github/sync', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.body.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  try {
    const out = await _githubSyncProject(p);
    res.json({ ok: true, ...out });
  } catch (e) {
    const status = (e.message === 'project_not_linked_to_github' || e.message === 'github_not_configured') ? 400 : 500;
    res.status(status).json({ ok: false, error: e.message });
  }
});

// v0.8: per-project github autosync toggle
app.put('/drafts/projects/:name/github_autosync', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.params.name));
  if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
  if (!p.github_repo) return res.status(400).json({ ok: false, error: 'project_not_linked_to_github' });
  const enabled = req.body.enabled !== false;
  p.github_autosync = !!enabled;
  saveState();
  res.json({ ok: true, github_autosync: p.github_autosync });
});

// v0.8: link/unlink github repo for a project (PAP can also do this — needs repo full name)
app.put('/drafts/projects/:name/github_repo', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.params.name));
  if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
  const repo = String(req.body.github_repo || '').trim();
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.status(400).json({ ok: false, error: 'bad_repo_format', detail: 'expected owner/repo' });
  p.github_repo = repo || null;
  if (!p.github_repo) p.github_autosync = false;
  saveState();
  res.json({ ok: true, github_repo: p.github_repo, github_autosync: !!p.github_autosync });
});

// Public project routes — must come AFTER all /drafts/* and /telepath/* routes

function isProjectName(slug) {
  if (!slug) return false;
  if (isReservedName(slug)) return false;
  if (!/^[a-z0-9_-]{1,40}$/.test(slug)) return false;
  return !!findProjectByName(slug);
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const url = req.path;
  if (url.startsWith('/drafts/') || url.startsWith('/m/') || url.startsWith('/telepath/')) return next();
  const m = url.match(/^\/([a-z0-9_-]+)(\/.*)?$/);
  if (!m) return next();
  const name = m[1];
  const rest = m[2] || '';
  if (!isProjectName(name)) return next();
  if (rest === '') return res.redirect(301, `/${name}/`);
  const pp = projectPaths(name);
  const vm = rest.match(/^\/v\/(\d+)(\/.*)?$/);
  if (vm) {
    const N = vm[1];
    const subRest = vm[2];
    const versionDir = path.join(pp.versions, N);
    if (!fs.existsSync(versionDir)) return res.status(404).type('text/plain').send('version not found');
    if (subRest === undefined) return res.redirect(301, `/${name}/v/${N}/`);
    return serveStatic(versionDir, subRest.replace(/^\/+/, ''), res);
  }
  if (!fs.existsSync(pp.live)) return res.status(404).type('text/plain').send('not yet promoted');
  return serveStatic(pp.live, rest.replace(/^\/+/, ''), res);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`drafts v${VERSION} listening on 127.0.0.1:${PORT}`);
  console.log(`  public_base: ${PUBLIC_BASE}`);
  console.log(`  server_number: ${SERVER_NUMBER}`);
  console.log(`  data_dir: ${DRAFTS_DIR}`);
  console.log(`  SAP welcome: ${PUBLIC_BASE}/drafts/pass/drafts_server_${SERVER_NUMBER}_${SAP_TOKEN.slice(0,8)}... (full token in /etc/labs/drafts.sap)`);

  initTelepath({
    draftsDir: DRAFTS_DIR,
    publicBase: PUBLIC_BASE,
    serverNumber: SERVER_NUMBER,
    getSAP: () => SAP_TOKEN,
    getDraftsState: () => state,
    saveDraftsState: saveState,
    findProjectByName,
    findProjectByPAP,
    findProjectAndAAPByAAPToken,
    ensureProjectDirs,
    listVersions,
    serverHelpers: {
      createProject: _createProjectInternal,
      createAAP: _createAAPInternal,
      githubSyncProject: _githubSyncProject,
    },
  });

  initProjectBots({
    publicBase: PUBLIC_BASE,
    getDraftsState: () => state,
    saveDraftsState: saveState,
    findProjectByName,
  });

  // Daily snapshot scheduler
  startDailySnapshotScheduler(() => state, DRAFTS_DIR);

  // v0.8: SAP boot/version-bump notifications (after 8s so Telepath has time to load polling+hooks)
  setTimeout(() => {
    try {
      const projectCount = state.projects.length;
      const botCount = state.projects.filter(p => p.bot && p.bot.token).length;
      const uptime = Math.floor(process.uptime());
      if (isVersionBump) {
        telepathHooks.onVersionBump(previousVersion, VERSION, { projectCount, botCount });
      } else if (isFirstBoot) {
        telepathHooks.onDraftsBoot(VERSION, { projectCount, botCount, uptime, firstBoot: true });
      } else {
        telepathHooks.onDraftsBoot(VERSION, { projectCount, botCount, uptime, firstBoot: false });
      }
    } catch (e) {
      console.error('[drafts] boot hook error:', e.message);
    }
  }, 8000);
});

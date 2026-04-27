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
import * as runtime from './runtime.js';
import { initProjectBots, projectBotsApi } from "./project-bots.js";
import { startDailySnapshotScheduler } from "./analytics.js";

const VERSION = '1.0.0';

// v0.9.4: detect telepath.js  when present, every project gets bot management automatically
const TELEPATH_AVAILABLE = (() => {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return fs.existsSync(path.join(here, 'telepath.js'));
  } catch (e) { return true; }
})();


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
    telepath_available: TELEPATH_AVAILABLE,
    runtime_capability: true,
    project_bots_capability: TELEPATH_AVAILABLE,
    telepath: tp,
    project_bots: { total: projectBotsCount, in_webhook_mode: webhookBotsCount, analytics_enabled: analyticsEnabledCount },
    github_autosync_enabled: githubAutosyncCount,
    uptime_sec: Math.floor(process.uptime()),
  });
});

mountTelepathRoutes(app);

// =================================================================
// drafts v0.9.5  buffer-style welcome pages (SAP/PAP/AAP)
// All UI in this block. Long-form, single-column, no modals.
// =================================================================

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(2) + ' MB';
}

function fmtDate(iso) {
  if (!iso) return '';
  try { const d = new Date(iso); return d.toISOString().slice(0,10); } catch (e) { return ''; }
}

// ---------- buffer-style design system (CSS) ----------
function bufferCSS() {
  return `<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;color:#f5f5f5;font-family:Inter,system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:#a8a8a8;text-decoration:underline;text-decoration-color:rgba(255,255,255,0.18);text-underline-offset:3px}
a:hover{color:#f5f5f5;text-decoration-color:rgba(255,255,255,0.5)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.92em;background:rgba(255,255,255,0.06);padding:1px 6px;border-radius:4px;color:#f5f5f5}
pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:14px 16px;color:#d4d4d4;overflow-x:auto;line-height:1.55;margin:8px 0}
.wrap{max-width:720px;margin:0 auto;padding:64px 28px 96px}
.eyebrow{display:flex;align-items:center;gap:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;letter-spacing:0.08em;text-transform:uppercase;color:#a8a8a8;margin-bottom:36px}
.eyebrow .dot{width:8px;height:8px;border-radius:50%;background:#ea5a2e;flex-shrink:0}
h1{font-size:54px;font-weight:700;letter-spacing:-0.035em;line-height:1.05;color:#f5f5f5;margin-bottom:24px}
.lead{font-size:17px;color:#a8a8a8;line-height:1.55;margin-bottom:0;max-width:620px}
.divider{border-top:1px solid rgba(255,255,255,0.07);margin:48px 0 32px}
.section{margin-top:32px}
.section h2{font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#f5f5f5;margin-bottom:18px}
.section h3{font-size:17px;font-weight:600;color:#f5f5f5;margin:24px 0 10px}
.section p{font-size:15px;color:#a8a8a8;line-height:1.65;margin-bottom:14px}
.section p strong{color:#f5f5f5;font-weight:600}
.section ul{margin:8px 0 14px 0;padding:0;list-style:none}
.section ul li{font-size:14.5px;color:#a8a8a8;line-height:1.6;padding-left:18px;position:relative;margin-bottom:6px}
.section ul li::before{content:'';position:absolute;left:0;color:#6a6a6a}
.steps{display:grid;grid-template-columns:1fr 1fr;gap:0;margin:24px 0}
@media(max-width:560px){.steps{grid-template-columns:1fr}}
.step{padding:20px 0 20px 0;padding-right:24px;border-right:1px solid rgba(255,255,255,0.07)}
.step:nth-child(2n){border-right:none;padding-left:24px;padding-right:0}
.step:nth-child(2n+1):last-child{border-right:none}
@media(max-width:560px){.step{border-right:none;border-bottom:1px solid rgba(255,255,255,0.07);padding:16px 0}.step:nth-child(2n){padding-left:0}.step:last-child{border-bottom:none}}
.step .num{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#ea5a2e;letter-spacing:0.06em;margin-bottom:8px;display:block}
.step .title{font-size:16px;font-weight:600;color:#f5f5f5;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.step .title svg{width:16px;height:16px;color:#ea5a2e;stroke-width:2}
.step .desc{font-size:14px;color:#a8a8a8;line-height:1.55}
.step .desc code{font-size:12.5px}
.steps-num{margin:24px 0;display:flex;flex-direction:column;gap:24px}
.steps-num .row{display:grid;grid-template-columns:36px 1fr;gap:16px;align-items:start}
.steps-num .num{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#ea5a2e;letter-spacing:0.06em;padding-top:5px}
.steps-num .ttl{font-size:16px;font-weight:600;color:#f5f5f5;margin-bottom:6px}
.steps-num .body{font-size:14.5px;color:#a8a8a8;line-height:1.6}
.steps-num .body code{font-size:12.5px}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}
.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 13px;border:1px solid rgba(255,255,255,0.12);border-radius:999px;font-size:13px;color:#d4d4d4;background:transparent}
.pill svg{width:14px;height:14px;color:#a8a8a8;stroke-width:1.8}
.stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid rgba(255,255,255,0.07);border-bottom:1px solid rgba(255,255,255,0.07);margin:24px 0;padding:18px 0}
.stats .stat{padding:0 18px;border-right:1px solid rgba(255,255,255,0.07)}
.stats .stat:last-child{border-right:none}
.stats .label{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#6a6a6a;margin-bottom:8px}
.stats .value{font-size:30px;font-weight:600;color:#f5f5f5;letter-spacing:-0.02em;line-height:1}
.tbl{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px}
.tbl th{text-align:left;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#6a6a6a;font-weight:500;padding:10px 8px;border-bottom:1px solid rgba(255,255,255,0.07)}
.tbl td{padding:14px 8px;border-bottom:1px solid rgba(255,255,255,0.04);color:#d4d4d4}
.tbl td.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}
.tbl td.muted{color:#6a6a6a}
.tbl tr:last-child td{border-bottom:none}
.tbl a{color:#a8a8a8}
.pill-state{display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-family:ui-monospace,Menlo,monospace;font-weight:500}
.pill-state.open{background:rgba(74,222,128,0.15);color:#4ade80}
.pill-state.draft{background:rgba(168,168,168,0.15);color:#a8a8a8}
.pill-state.muted{background:rgba(168,168,168,0.08);color:#6a6a6a}
.info-row{display:flex;gap:12px;align-items:flex-start;padding:14px 0;border-top:1px solid rgba(255,255,255,0.07);border-bottom:1px solid rgba(255,255,255,0.07);margin:24px 0}
.info-row svg{flex-shrink:0;width:18px;height:18px;color:#ea5a2e;margin-top:1px}
.info-row .text{font-size:14px;color:#a8a8a8;line-height:1.55}
.cta-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:28px 0}
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:500;text-decoration:none;border:1px solid rgba(255,255,255,0.12);color:#f5f5f5;background:transparent;cursor:pointer;font-family:inherit;transition:all 0.15s}
.btn:hover{border-color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.04)}
.btn.primary{background:#ea5a2e;border-color:#ea5a2e;color:#fff}
.btn.primary:hover{background:#d44a2a;border-color:#d44a2a}
details{margin:28px 0;border-top:1px solid rgba(255,255,255,0.07);padding-top:18px}
details > summary{cursor:pointer;font-size:14.5px;color:#a8a8a8;list-style:none;display:flex;align-items:center;gap:10px;font-weight:500}
details > summary::-webkit-details-marker{display:none}
details > summary::before{content:'';color:#6a6a6a;font-size:16px;display:inline-block;transition:transform 0.15s}
details[open] > summary::before{transform:rotate(90deg)}
details > summary:hover{color:#f5f5f5}
details .body{padding:18px 0 0 24px;font-size:14px;color:#a8a8a8;line-height:1.65}
details .body p{margin-bottom:10px}
footer{margin-top:64px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#6a6a6a;font-family:ui-monospace,Menlo,monospace}
footer a{color:#a8a8a8;text-decoration:none}
footer a:hover{color:#f5f5f5}
footer .right{display:flex;gap:8px;align-items:center}
footer .right span{color:#3a3a3a}
form.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0}
form.inline input[type=text],form.inline input[type=password]{flex:1;min-width:240px;background:#0a0a0a;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;color:#f5f5f5;font-family:ui-monospace,Menlo,monospace;font-size:13px}
form.inline input:focus{outline:none;border-color:rgba(234,90,46,0.5)}
.status-line{font-size:12.5px;color:#6a6a6a;font-family:ui-monospace,Menlo,monospace;margin-top:8px}
.status-line.ok{color:#4ade80}
.status-line.err{color:#f87171}
.kbd{font-family:ui-monospace,Menlo,monospace;font-size:11px;padding:2px 6px;border:1px solid rgba(255,255,255,0.18);border-radius:4px;color:#d4d4d4;background:#0a0a0a}
.toggle{display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px 0;font-size:14px;color:#d4d4d4}
.toggle input{accent-color:#ea5a2e}
.toggle .desc{color:#a8a8a8;font-size:13px;margin-top:2px}
.upload-area{display:block;width:100%;padding:18px;background:#0a0a0a;border:1px dashed rgba(255,255,255,0.18);border-radius:10px;color:#a8a8a8;font-family:inherit;font-size:13px;cursor:pointer;margin:10px 0;text-align:center}
.upload-area:hover{border-color:rgba(255,255,255,0.3);color:#f5f5f5}
textarea{width:100%;background:#0a0a0a;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:12px;color:#f5f5f5;font-family:inherit;font-size:14px;line-height:1.5;resize:vertical;min-height:80px}
textarea:focus{outline:none;border-color:rgba(234,90,46,0.5)}
</style>`;
}

// ---------- inline icons (small, stroke 2) ----------
const I = {
  arrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
  arrowUpRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
  arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>',
  command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></svg>',
};

// =================================================================
// Per-tier hero content
// =================================================================
function heroContent(tier, project, versions, publicBase) {
  if (tier === 'sap') {
    return {
      eyebrowText: 'DRAFTS  SERVER ROOT',
      h1: 'Root key to the drafts server.',
      lead: 'You hold the master key. From here you create projects, mint contributor links, attach a Telegram bot to anything, and watch the whole server in one pane. Everything below is also callable as JSON.',
    };
  }
  if (tier === 'pap') {
    const verCount = versions.length;
    const verWord = verCount === 1 ? 'version' : 'versions';
    return {
      eyebrowText: 'DRAFTS  ' + project.name.toUpperCase(),
      h1: project.description ? project.description : project.name + '  a project on drafts.',
      lead: 'Your project. Live at <a href="' + publicBase + '/' + project.name + '/" target="_blank">' + publicBase.replace(/^https?:\/\//,'') + '/' + project.name + '/</a>. ' + verCount + ' ' + verWord + ' published. Build, ship, invite contributors, attach a Telegram bot  all from this link.',
    };
  }
  // AAP
  return {
    eyebrowText: 'DRAFTS  ' + project.name.toUpperCase() + '  CONTRIBUTOR',
    h1: 'Your branch on ' + project.name + '.',
    lead: 'A contributor link. What you commit lands in your own branch  the project owner reviews and merges. The live site is at <a href="' + publicBase + '/' + project.name + '/" target="_blank">' + publicBase.replace(/^https?:\/\//,'') + '/' + project.name + '/</a>. Read it before you build.',
  };
}

// =================================================================
// Step blocks (numbered) per tier
// =================================================================
function stepsForTier(tier, project, apiBase) {
  if (tier === 'sap') {
    return [
      { title: 'Create a project', desc: 'A project gets its own slug, its own PAP link, its own live URL at /<slug>/, and its own git history.', code: 'POST ' + apiBase + '/projects {"name":"my-app","description":"..."}' },
      { title: 'Share the PAP', desc: 'The PAP activation URL is what your collaborators or agents open. Never share the SAP  it\'s root.' },
      { title: 'Attach Telepath', desc: 'One bot for the server. Get a token from <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, paste below.', code: 'PUT ' + apiBase + '/tap {"token":"..."}' },
      { title: 'Watch everything', desc: 'GET /server/stats summarizes projects, bots, GitHub config, autopilot jobs in one call.' },
    ];
  }
  if (tier === 'pap') {
    return [
      { title: 'Build', desc: 'Upload files into drafts. HTML, CSS, JS, images, audio, PDFs  anything. Each upload is a regular git tree change.', code: 'POST ' + apiBase + '/upload {"filename":"index.html","content":"..."}' },
      { title: 'Commit', desc: 'Every commit on main produces an immutable snapshot at /v/<N>/. Versions never get rewritten.', code: 'POST ' + apiBase + '/commit {"message":"..."}' },
      { title: 'Promote', desc: 'Publish drafts to live. The world can now see it at /<project>/. Roll back any time.', code: 'POST ' + apiBase + '/promote' },
      { title: 'Iterate', desc: 'Loop. Keep commits small and named. Use AAPs to bring contributors in without sharing the project key.' },
    ];
  }
  // AAP
  return [
    { title: 'Read live', desc: 'Open the live URL. Understand what\'s already there before you change anything.' },
    { title: 'Build in your branch', desc: 'Every upload and commit lands on your branch automatically. You can\'t affect main directly.', code: 'POST ' + apiBase + '/upload {"filename":"...","content":"..."}' },
    { title: 'Commit', desc: 'Make small, named commits. The owner sees them in /pending.', code: 'POST ' + apiBase + '/commit {"message":"..."}' },
    { title: 'Hand off', desc: 'Tell the owner you\'re done. They run /merge and your work flows into main + becomes a version.' },
  ];
}

function renderSteps(steps) {
  let html = '<div class="steps-num">';
  steps.forEach((s, i) => {
    const num = String(i + 1).padStart(2, '0');
    const codeHtml = s.code ? '<pre>' + esc(s.code) + '</pre>' : '';
    html += '<div class="row"><div class="num">' + num + '</div><div><div class="ttl">' + s.title + '</div><div class="body">' + s.desc + codeHtml + '</div></div></div>';
  });
  html += '</div>';
  return html;
}

// =================================================================
// Pills: "What you can do here" / "What you can build"
// =================================================================
function pillsForTier(tier) {
  if (tier === 'sap') {
    return [
      { ic: 'layers', t: 'create projects' },
      { ic: 'users', t: 'mint contributor passes' },
      { ic: 'bot', t: 'attach a master Telegram bot' },
      { ic: 'database', t: 'wire GitHub auto-sync' },
      { ic: 'globe', t: 'manage every live URL' },
      { ic: 'zap', t: 'queue autopilot jobs' },
      { ic: 'code', t: 'configure auto-update' },
    ];
  }
  if (tier === 'pap') {
    return [
      { ic: 'globe', t: 'landing pages' },
      { ic: 'image', t: 'image-rich pages' },
      { ic: 'code', t: 'PWAs and tools' },
      { ic: 'file', t: 'multi-page sites' },
      { ic: 'bot', t: 'a Telegram bot tied to the page' },
      { ic: 'send', t: 'broadcasts to subscribers' },
      { ic: 'users', t: 'collaborators' },
      { ic: 'layers', t: 'rollback-able versions' },
    ];
  }
  return [
    { ic: 'globe', t: 'static pages' },
    { ic: 'image', t: 'media' },
    { ic: 'code', t: 'small interactive widgets' },
    { ic: 'file', t: 'docs and copy edits' },
  ];
}

function renderPills(pills) {
  return '<div class="pills">' + pills.map(p => '<span class="pill">' + (I[p.ic] || '') + p.t + '</span>').join('') + '</div>';
}

// =================================================================
// Telepath section content (rich, embedded on PAP/SAP)
// =================================================================
function telepathSectionPAP(project, apiBase, publicBase) {
  const liveUrl = publicBase + '/' + project.name + '/';
  const botStatus = (project.bot && project.bot.token) ? 'attached' : 'unattached';
  const botUsername = project.bot && project.bot.bot_username ? '@' + project.bot.bot_username : '';
  const mode = project.bot && project.bot.token ? (project.bot.webhook_url ? 'webhook' : 'default') : null;

  let statusBlock;
  if (botStatus === 'attached') {
    statusBlock =
      '<div class="info-row">' + I.bot + '<div class="text">A Telegram bot is attached: <strong style="color:#4ade80">' + esc(botUsername) + '</strong> running in <strong>' + mode + '</strong> mode. Subscribers: ' + ((project.bot.subscribers||[]).length) + '. Last synced: ' + fmtDate(project.bot.last_synced_at) + '.</div></div>';
  } else {
    statusBlock =
      '<form class="inline" id="bot-attach-form" onsubmit="return false"><input type="password" id="bot-token-input" placeholder="1234567890:AA... (paste from @BotFather)"/><button class="btn primary" type="button" id="bot-attach-btn">Attach bot</button></form>' +
      '<div class="status-line" id="bot-attach-status">Need a bot first? Open <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, send <code>/newbot</code>, paste the token above.</div>';
  }

  const exampleBotJson = JSON.stringify({
    version: 'drafts.bot.v1',
    commands: [
      { command: 'start', description: 'Begin', reply: { text: '<b>Welcome to ' + project.name + '!</b>Tap below to open the app.', parse_mode: 'HTML', buttons: [[{ text: 'Open app', web_app_url: liveUrl }, { text: 'Help', callback_data: 'help' }]] } },
      { command: 'about', description: 'About', reply: { text: 'Built with drafts.' } },
    ],
    default_reply: { text: 'Send /start to see the menu.' },
    callbacks: { help: { text: 'Send /start for the menu.' } },
  }, null, 2);

  return `
<div class="divider"></div>
<div class="section">
  <h2>Telepath  a Telegram bot tied to this project</h2>
  <p>Telepath turns this project into a real Telegram bot. The bot's name, description, menu button, and commands all come from your live site  ship the page, the bot ships with it. Three modes, escalating in power:</p>

  ${statusBlock}

  <h3>Default mode  zero config</h3>
  <p>The moment you attach a bot it works. <code>/start</code> subscribes the user, <code>/stop</code> unsubscribes, and you can <strong>broadcast</strong> to all subscribers from a single API call. The bot's name, short and long descriptions are pulled from <code>&lt;title&gt;</code> and <code>&lt;meta name=description&gt;</code> on your live page. Its menu button opens <a href="${liveUrl}" target="_blank">${liveUrl}</a> as a Telegram WebApp.</p>

  <h3>bot.json mode  declarative bot, no code</h3>
  <p>Drop a <code>bot.json</code> file into your project root and commit. The bot reads it and becomes whatever you described  commands with rich HTML replies, inline-keyboard buttons (URL, callback, WebApp), and a callback dispatch table. Edit the file, promote, sync  the bot updates instantly. Cache busts on each sync; <code>setMyCommands</code> pushes the command list to Telegram automatically.</p>
  <pre>${esc(exampleBotJson)}</pre>
  <p>Each <code>buttons</code> row is an inline keyboard row. Buttons accept <code>url</code> for external links, <code>callback_data</code> for callback dispatch, and <code>web_app_url</code> to open a Telegram WebApp pointing at your live URL.</p>

  <h3>Webhook mode  you own the logic</h3>
  <p>Set <code>webhook_url</code> on the bot and drafts becomes a pipe. Every Telegram update is forwarded to your server with <code>X-Drafts-Project</code>, <code>X-Drafts-Update-Id</code>, <code>X-Drafts-Bot-Username</code> headers. Your server replies via the regular Telegram Bot API using your token. SSRF-safe (no localhost, no private IPs, no your-own-drafts-server). One automatic retry, last-20-deliveries log retained.</p>

  <h3>Analytics</h3>
  <p>Every update is recorded as JSONL metadata (no message bodies, no PII) and aggregated into daily snapshots. Toggle off if you don't want the data. Available across all three modes.</p>

  <h3>What you can build with this</h3>
  <ul>
    <li>A WebApp launcher  the menu button opens your live site fullscreen inside Telegram, every visitor automatically gets your <code>tg.initData</code> for auth.</li>
    <li>A subscription channel  users <code>/start</code> to subscribe, you broadcast new content the moment you commit + promote.</li>
    <li>A command-driven assistant  declare 8 commands in <code>bot.json</code>, each replies with HTML + inline buttons. No backend.</li>
    <li>A custom backend  webhook mode, full Bot API in your hands. Drafts handles polling, retries, logging.</li>
    <li>A multi-step flow  callbacks branch into other replies; chain them via <code>callback_data</code> keys.</li>
  </ul>

  <h3>Bot management API</h3>
  <p>All endpoints below take Bearer auth with this project's PAP token.</p>
  <pre>GET    ${apiBase}/project/bot                  status
PUT    ${apiBase}/project/bot                  attach  {token, webhook_url?}
DELETE ${apiBase}/project/bot                  disconnect
POST   ${apiBase}/project/bot/sync             re-sync profile + bust bot.json cache
PUT    ${apiBase}/project/bot/webhook          {url} or {url:null}
PUT    ${apiBase}/project/bot/analytics        {enabled:true|false}
POST   ${apiBase}/project/bot/broadcast        {html}</pre>
</div>`;
}

function telepathSectionSAP(tpStatus, apiBase) {
  const installed = tpStatus.installed && tpStatus.bot;
  let statusBlock;
  if (installed) {
    statusBlock = '<div class="info-row">' + I.bot + '<div class="text">Master bot connected: <strong style="color:#4ade80">@' + esc(tpStatus.bot.username) + '</strong>. Polling: <strong>' + (tpStatus.polling?'on':'off') + '</strong>. Open <a href="https://t.me/' + esc(tpStatus.bot.username) + '" target="_blank">@' + esc(tpStatus.bot.username) + '</a> in Telegram, send <code>/start</code> to begin. Inside the bot, <code>/projects</code> lists everything on this server.</div></div>' +
      '<form class="inline" onsubmit="return false"><button class="btn" type="button" id="tap-revoke-btn">Revoke master bot</button></form>';
  } else {
    statusBlock =
      '<form class="inline" id="tap-form" onsubmit="return false"><input type="password" id="tap-token-input" placeholder="1234567890:AA... (paste from @BotFather)"/><button class="btn primary" type="button" id="tap-install-btn">Connect master bot</button></form>' +
      '<div class="status-line" id="tap-status">Need a bot first? Open <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, send <code>/newbot</code>, paste the token above.</div>';
  }
  return `
<div class="divider"></div>
<div class="section">
  <h2>Telepath  the master Telegram bot</h2>
  <p>One bot per server. From any Telegram client  phone, desktop, voice notes  you list projects, push files, promote builds, mint AAPs, view stats, all in DM. The master bot is separate from per-project bots: this one is yours, the per-project ones serve users.</p>
  ${statusBlock}

  <h3>What the master bot does</h3>
  <ul>
    <li><code>/projects</code>  list every project on the server with live URLs and version count.</li>
    <li><code>/sites</code>  BotFather-style menu for managing per-project bots.</li>
    <li>Voice notes  send a voice note describing a change, the bot turns it into a commit message and pushes via the relevant PAP.</li>
    <li>File drops  forward a file to the bot, pick the project, it lands in drafts.</li>
    <li>Notifications  server boot, version bumps, schema migrations, AAP merges, drafts errors all show up here.</li>
  </ul>

  <h3>What you can build on top of Telepath</h3>
  <ul>
    <li>A mobile-first dev console  ship from any device that can open Telegram.</li>
    <li>A team status feed  add the bot to a group chat, every promote notifies the room.</li>
    <li>Voice-driven content updates  dictate a paragraph, it lands as a commit.</li>
    <li>An on-call channel  errors and version bumps DM you immediately.</li>
  </ul>
</div>`;
}

// =================================================================
// Stats grid + recent versions table (PAP)
// =================================================================
function statsBlock(project, versions) {
  const verCount = versions.length;
  const aapCount = (project.aaps || []).filter(a => !a.revoked).length;
  const botMode = project.bot && project.bot.token ? (project.bot.webhook_url ? 'webhook' : 'default') : 'none';
  return `<div class="stats">
    <div class="stat"><div class="label">Versions</div><div class="value">${verCount}</div></div>
    <div class="stat"><div class="label">Contributors</div><div class="value">${aapCount}</div></div>
    <div class="stat"><div class="label">Bot mode</div><div class="value" style="font-size:18px;font-family:ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:0.05em">${botMode}</div></div>
  </div>`;
}

// =================================================================
// Server stats (SAP)  projects table
// =================================================================
function projectsTable(state, publicBase) {
  if (!state.projects || !state.projects.length) {
    return '<p style="color:#6a6a6a;font-size:14px;padding:24px 0">No projects yet. Create the first one with <code>POST /drafts/projects</code>.</p>';
  }
  let html = '<table class="tbl"><thead><tr><th>Name</th><th>Versions</th><th>Bot</th><th>Live</th></tr></thead><tbody>';
  for (const p of state.projects) {
    const verCount = p.versions_count || 0;
    const bot = p.bot && p.bot.token ? (p.bot.webhook_url ? 'webhook' : 'default') : '';
    const liveUrl = publicBase + '/' + p.name + '/';
    html += '<tr><td class="mono">' + esc(p.name) + '</td><td class="muted mono">' + verCount + '</td><td class="muted mono">' + bot + '</td><td><a href="' + liveUrl + '" target="_blank">view</a></td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

function serverStatsBlock(state) {
  const total = state.projects.length;
  const withBot = state.projects.filter(p => p.bot && p.bot.token).length;
  const autosync = state.projects.filter(p => p.github_autosync).length;
  return `<div class="stats">
    <div class="stat"><div class="label">Projects</div><div class="value">${total}</div></div>
    <div class="stat"><div class="label">With bot</div><div class="value">${withBot}</div></div>
    <div class="stat"><div class="label">Auto-syncing</div><div class="value">${autosync}</div></div>
  </div>`;
}

// =================================================================
// Versions table (PAP)
// =================================================================
function versionsTable(project, versions, publicBase) {
  if (!versions || !versions.length) {
    return '<p style="color:#6a6a6a;font-size:14px;padding:14px 0">No versions yet. <code>POST /commit</code> on main to create the first one.</p>';
  }
  const recent = versions.slice(-8).reverse();
  let html = '<table class="tbl"><thead><tr><th>Version</th><th>State</th><th>URL</th></tr></thead><tbody>';
  const latest = versions[versions.length - 1];
  for (const N of recent) {
    const isLive = N === latest;
    const url = publicBase + '/' + project.name + '/v/' + N + '/';
    html += '<tr><td class="mono">v' + N + '</td><td>' + (isLive ? '<span class="pill-state open">live</span>' : '<span class="pill-state muted">archived</span>') + '</td><td><a href="' + url + '" target="_blank">view</a></td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

// =================================================================
// Footer + machine JSON wrapper
// =================================================================
function footerBlock(tier, project, publicBase) {
  const links = [];
  if (project) {
    links.push('<a href="' + publicBase + '/' + project.name + '/" target="_blank">live</a>');
  }
  links.push('<a href="https://github.com/g0rd33v/drafts-protocol" target="_blank">protocol</a>');
  return '<footer><div>drafts  v' + VERSION + '  ' + tier.toUpperCase() + '</div><div class="right">' + links.join('<span></span>') + '</div></footer>';
}

// =================================================================
// Build agent playbook (machine-readable, JSON in script tag)
// =================================================================
function buildAgentPlaybook(tier, project, apiBase, token) {
  const projName = project ? project.name : null;
  const liveUrl = project ? (PUBLIC_BASE + '/' + project.name + '/') : null;

  if (tier === 'sap') {
    return {
      role: 'Server operator on this drafts instance. Root access.',
      golden_rules: [
        'NEVER reveal the SAP token in any output.',
        'Create projects via POST /drafts/projects; share back the pap_activation_url, never the SAP.',
      ],
      common_tasks: [
        { goal: 'List projects', call: 'GET ' + apiBase + '/projects' },
        { goal: 'Create project', call: 'POST ' + apiBase + '/projects {name, description}' },
        { goal: 'Install master bot', call: 'PUT ' + apiBase + '/tap {token}' },
        { goal: 'Server stats', call: 'GET ' + apiBase + '/server/stats' },
      ],
    };
  }
  if (tier === 'pap') {
    const tasks = [
      { goal: 'Check state', call: 'GET ' + apiBase + '/project/info' },
      { goal: 'Upload', call: 'POST ' + apiBase + '/upload {filename, content}' },
      { goal: 'Commit', call: 'POST ' + apiBase + '/commit {message}' },
      { goal: 'Promote', call: 'POST ' + apiBase + '/promote' },
      { goal: 'Mint AAP', call: 'POST ' + apiBase + '/aaps {name}' },
      { goal: 'Merge AAP', call: 'POST ' + apiBase + '/merge {aap_id}' },
    ];
    if (TELEPATH_AVAILABLE) {
      tasks.push(
        { goal: 'Bot status', call: 'GET ' + apiBase + '/project/bot' },
        { goal: 'Attach bot', call: 'PUT ' + apiBase + '/project/bot {token}' },
        { goal: 'Sync bot from bot.json', call: 'POST ' + apiBase + '/project/bot/sync' },
        { goal: 'Webhook mode', call: 'PUT ' + apiBase + '/project/bot/webhook {url}' },
        { goal: 'Broadcast', call: 'POST ' + apiBase + '/project/bot/broadcast {html}' },
      );
    }
    return {
      role: `Project agent for "${projName}". Build, ship, invite contributors. Live at ${liveUrl}.`,
      golden_rules: [
        'Workflow: upload  commit  promote.',
        'Each commit on main is an immutable snapshot at /v/<N>/.',
        'Mint AAPs for collaborators; never share PAP.',
        ...(TELEPATH_AVAILABLE ? ['Telepath available: every project can attach its own Telegram bot via bot.json.'] : []),
      ],
      common_tasks: tasks,
      build_loop: 'Plan  upload  commit  promote  verify live  iterate.',
      bot_json_schema: TELEPATH_AVAILABLE ? {
        notes: 'Place bot.json at project root. After upload + commit + promote, call POST /drafts/project/bot/sync.',
        example: {
          version: 'drafts.bot.v1',
          commands: [
            { command: 'start', description: 'Begin', reply: { text: '<b>Welcome!</b>', parse_mode: 'HTML', buttons: [[{ text: 'Open', web_app_url: liveUrl }]] } },
          ],
          default_reply: { text: 'Send /start.' },
          callbacks: {},
        },
      } : null,
    };
  }
  return {
    role: `Contributor agent on "${projName}". Work in your own branch.`,
    golden_rules: [
      'All your commits go to your branch automatically.',
      'Owner runs /merge to bring your work into main.',
    ],
    common_tasks: [
      { goal: 'Read live', call: 'GET ' + liveUrl },
      { goal: 'Upload', call: 'POST ' + apiBase + '/upload {filename, content}' },
      { goal: 'Commit', call: 'POST ' + apiBase + '/commit {message}' },
      { goal: 'See your history', call: 'GET ' + apiBase + '/history' },
    ],
    handoff: 'When done, tell the owner. They run /merge.',
  };
}

// Stub for old call site (renderTapSection used to render its own panel inline)
function renderTapSection() { return ''; }
function renderAgentPlaybookHTML() { return ''; }

// =================================================================
// Main renderPage  buffer-style, single column, long-form
// =================================================================
function renderPage({ tier, token, project, aap, versions = [] }) {
  const isSAP = tier === 'sap';
  const isPAP = tier === 'pap';
  const isAAP = tier === 'aap';
  const apiBase = PUBLIC_BASE + '/drafts';
  const tierWord = isPAP ? 'project' : isAAP ? 'agent' : 'server';
  const cleanTok = token.replace(/^(pap|aap)_/, '');
  const portableId = `${PUBLIC_BASE}/drafts/pass/drafts_${tierWord}_${SERVER_NUMBER}_${cleanTok}`;
  const tpStatus = getTelepathStatus();
  const playbook = buildAgentPlaybook(tier, project, apiBase, token);
  const hero = heroContent(tier, project, versions, PUBLIC_BASE);
  const steps = stepsForTier(tier, project, apiBase);
  const pills = pillsForTier(tier);

  const machine = {
    system: 'drafts',
    version: VERSION,
    tier,
    api_base: apiBase,
    auth: { header: 'Authorization', scheme: 'Bearer', token },
    portable_identifier: portableId,
    server_number: SERVER_NUMBER,
    telepath: tpStatus.installed ? { bot_username: tpStatus.bot && tpStatus.bot.username, polling: tpStatus.polling } : { installed: false },
    telepath_available: TELEPATH_AVAILABLE,
    runtime_capability: true,
    url_scheme: project ? {
      live: `${PUBLIC_BASE}/${project.name}/`,
      version: `${PUBLIC_BASE}/${project.name}/v/<N>/`,
      total_versions: versions.length,
    } : null,
    agent_playbook: playbook,
    system: 'drafts',
    protocol: 'drafts',
    protocol_version: '0.2',
    capabilities: ['static', 'media', 'git', 'github-sync', 'runtime'],
  };

  const title = isSAP ? 'drafts  server' : isPAP ? 'drafts  ' + project.name : 'drafts  ' + project.name + '  contributor';

  let html = '<!doctype html><html lang="en"><head><meta charset="utf-8"/>';
  html += '<meta name="viewport" content="width=device-width,initial-scale=1"/>';
  html += '<title>' + esc(title) + '</title>';
  html += '<meta name="robots" content="noindex,nofollow"/>';
  html += '<link rel="preconnect" href="https://fonts.googleapis.com"/>';
  html += '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>';
  html += '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>';
  html += bufferCSS();
  html += '</head><body><div class="wrap">';

  // Hero
  html += '<div class="eyebrow"><span class="dot"></span><span>' + esc(hero.eyebrowText) + '</span></div>';
  html += '<h1>' + hero.h1 + '</h1>';
  html += '<p class="lead">' + hero.lead + '</p>';

  // Numbered steps
  html += '<div class="divider"></div>';
  html += '<div class="section">';
  html += '<h2>' + (isSAP ? 'How to use this server link' : isPAP ? 'How to ship from this link' : 'How to contribute') + '</h2>';
  html += renderSteps(steps);
  html += '</div>';

  // What you can build/do (pills)
  html += '<div class="section">';
  html += '<h2>' + (isSAP ? 'What you can do here' : isPAP ? 'What you can build here' : 'What you can do in your branch') + '</h2>';
  html += renderPills(pills);
  html += '</div>';

  // Stats
  if (isPAP) {
    html += '<div class="section">';
    html += '<h2>Project state</h2>';
    html += statsBlock(project, versions);
    html += versionsTable(project, versions, PUBLIC_BASE);
    html += '</div>';
  } else if (isSAP) {
    html += '<div class="section">';
    html += '<h2>Server state</h2>';
    const projsForTable = state.projects.map(p => ({ name: p.name, bot: p.bot, github_autosync: p.github_autosync, versions_count: 0 }));
    html += serverStatsBlock({ projects: state.projects });
    html += projectsTable({ projects: state.projects }, PUBLIC_BASE);
    html += '</div>';
  } else if (isAAP) {
    html += '<div class="section">';
    html += '<h2>Where you stand</h2>';
    html += '<div class="stats"><div class="stat"><div class="label">Branch</div><div class="value" style="font-size:18px;font-family:ui-monospace,Menlo,monospace">' + esc(aap.branch) + '</div></div><div class="stat"><div class="label">Live versions</div><div class="value">' + versions.length + '</div></div><div class="stat"><div class="label">Status</div><div class="value" style="font-size:18px">draft</div></div></div>';
    html += '<p>Live URL is read-only for you: <a href="' + PUBLIC_BASE + '/' + project.name + '/" target="_blank">' + PUBLIC_BASE.replace(/^https?:\/\//,'') + '/' + project.name + '/</a></p>';
    html += '</div>';
  }

  // Telepath section (PAP and SAP get the rich version; AAP doesn't)
  if (isPAP) {
    html += telepathSectionPAP(project, apiBase, PUBLIC_BASE);
  } else if (isSAP) {
    html += telepathSectionSAP(tpStatus, apiBase);
  }

  // Human upload (PAP and AAP)
  if (isPAP || isAAP) {
    html += '<div class="divider"></div>';
    html += '<div class="section"><h2>Upload files from your computer</h2>';
    html += '<p>Pick any files  HTML, images, PDFs, audio, code. They land in <code>drafts</code>. ' + (isPAP ? 'Tick Promote to publish to live in one shot.' : 'Files commit to your branch automatically; the owner reviews + merges.') + '</p>';
    html += '<input type="file" id="v95-files" multiple class="upload-area"/>';
    html += '<label class="toggle"><input type="checkbox" id="v95-commit" checked/> Commit after upload</label>';
    if (isPAP) html += '<label class="toggle"><input type="checkbox" id="v95-promote"/> Promote to live</label>';
    html += '<div class="cta-row"><button class="btn primary" id="v95-up">Upload</button></div>';
    html += '<div class="status-line" id="v95-status"></div>';
    html += '</div>';
  }

  // Autopilot (PAP and AAP)
  if (isPAP || isAAP) {
    html += '<div class="section"><h2>Autopilot</h2>';
    html += '<p>Describe what you want. Autopilot drafts it, your Claude for Chrome agent tests in a real browser, fixes whatever broke, repeats until green. No babysitting.</p>';
    html += '<textarea id="v95-ap-goal" placeholder="e.g. landing page for a vintage typewriter shop  hero, gallery, contact form, mobile-first"></textarea>';
    html += '<label class="toggle"><input type="checkbox" id="v95-ap-loop" checked/> Run as loop until tests pass</label>';
    html += '<div class="cta-row"><button class="btn primary" id="v95-ap-start">Start autopilot</button></div>';
    html += '<div class="status-line" id="v95-ap-status"></div>';
    html += '</div>';
  }

  // CTA + portable link
  html += '<div class="divider"></div>';
  html += '<div class="section"><h2>Open this link in Claude</h2>';
  html += '<p>Two ways to put this page in front of Claude:</p>';
  html += '<div class="steps-num"><div class="row"><div class="num">A</div><div><div class="ttl">Claude for Chrome <span class="pill-state open" style="margin-left:6px">recommended</span></div><div class="body">Install the <a href="' + CHROME_EXT_URL + '" target="_blank">extension</a>, open this URL in the side panel. Claude reads everything below  prose, JSON, state  and starts acting as the ' + tier.toUpperCase() + ' agent.</div></div></div>';
  html += '<div class="row"><div class="num">B</div><div><div class="ttl">Any Claude chat</div><div class="body">Paste the URL into claude.ai web, Desktop, or any client. Same context picked up.</div></div></div></div>';
  html += '<div class="cta-row"><a class="btn primary" href="' + CHROME_EXT_URL + '" target="_blank">Install Chrome extension ' + I.arrowUpRight + '</a><button class="btn" id="v95-copy" type="button" data-portable="' + esc(portableId) + '">Copy this link</button></div>';
  html += '</div>';

  // Developers (collapsed)
  html += '<details><summary>For developers  endpoints, auth, rate limits</summary><div class="body">';
  html += '<p>Authenticate every API call with <code>Authorization: Bearer ' + (isSAP ? '&lt;sap&gt;' : isPAP ? '&lt;pap&gt;' : '&lt;aap&gt;') + '</code>. Rate limits: ' + (isSAP ? '120/min, 2000/hr, 20000/day' : isPAP ? '60/min, 600/hr, 5000/day' : '10/min, 60/hr, 300/day') + '. All endpoints under <code>' + apiBase + '/</code>. URL scheme: <code>/&lt;project&gt;/</code> = live, <code>/&lt;project&gt;/v/&lt;N&gt;/</code> = immutable snapshot. Spec: <a href="https://github.com/g0rd33v/drafts-protocol" target="_blank">github.com/g0rd33v/drafts-protocol</a>.</p>';
  html += '<p>The full machine-readable instruction set for AI agents is below in <code>&lt;script id="claude-instructions"&gt;</code>.</p>';
  html += '</div></details>';

  html += footerBlock(tier, project, PUBLIC_BASE);

  // machine JSON
  html += '<script type="application/json" id="claude-instructions">' + JSON.stringify(machine, null, 2) + '</' + 'script>';

  // Client JS
  html += '<script>(function(){';
  html += 'var T=' + JSON.stringify(token) + ',API=' + JSON.stringify(apiBase) + ',SAP=' + JSON.stringify(isSAP ? token : '') + ';';
  html += 'function st(id,m,k){var e=document.getElementById(id);if(!e)return;e.textContent=m||"";e.className="status-line"+(k?" "+k:"")}';
  html += 'var cb=document.getElementById("v95-copy");if(cb)cb.addEventListener("click",function(){navigator.clipboard.writeText(cb.dataset.portable);cb.textContent="Copied ";setTimeout(function(){cb.textContent="Copy this link"},1500)});';
  // Bot attach (PAP)
  html += 'var ba=document.getElementById("bot-attach-btn");if(ba)ba.addEventListener("click",function(){var tk=document.getElementById("bot-token-input").value.trim();if(!tk){st("bot-attach-status","token required","err");return}st("bot-attach-status","attaching...");fetch(API+"/project/bot",{method:"PUT",headers:{"Authorization":"Bearer "+T,"Content-Type":"application/json"},body:JSON.stringify({token:tk})}).then(function(r){return r.json()}).then(function(d){if(d.ok){st("bot-attach-status","attached: @"+(d.bot&&d.bot.bot_username),"ok");setTimeout(function(){location.reload()},900)}else st("bot-attach-status","error: "+(d.detail||d.error),"err")})});';
  // TAP install (SAP)
  html += 'var ti=document.getElementById("tap-install-btn");if(ti)ti.addEventListener("click",function(){var tk=document.getElementById("tap-token-input").value.trim();if(!/^\\d+:[A-Za-z0-9_-]{30,}$/.test(tk)){st("tap-status","invalid token format","err");return}st("tap-status","verifying...");fetch(API+"/tap",{method:"PUT",headers:{"Authorization":"Bearer "+T,"Content-Type":"application/json"},body:JSON.stringify({token:tk})}).then(function(r){return r.json()}).then(function(j){if(j.ok){st("tap-status","connected as @"+j.bot.username,"ok");setTimeout(function(){location.reload()},1200)}else st("tap-status","failed: "+(j.detail||j.error),"err")})});';
  html += 'var tr=document.getElementById("tap-revoke-btn");if(tr)tr.addEventListener("click",function(){if(!confirm("Revoke master bot?"))return;fetch(API+"/tap",{method:"DELETE",headers:{"Authorization":"Bearer "+T}}).then(function(){location.reload()})});';
  // Upload
  html += 'var up=document.getElementById("v95-up");if(up)up.addEventListener("click",async function(){var fi=document.getElementById("v95-files");var files=fi.files;if(!files||!files.length){st("v95-status","pick at least one file","err");return}var doCommit=document.getElementById("v95-commit").checked;var pEl=document.getElementById("v95-promote");var doPromote=pEl&&pEl.checked;st("v95-status","uploading 0/"+files.length+"...");for(var i=0;i<files.length;i++){var f=files[i];try{var b64=await new Promise(function(res,rej){var r=new FileReader();r.onload=function(){res(r.result.split(",")[1])};r.onerror=function(){rej(r.error)};r.readAsDataURL(f)});var rsp=await fetch(API+"/upload",{method:"POST",headers:{"Authorization":"Bearer "+T,"Content-Type":"application/json"},body:JSON.stringify({filename:f.name,content_b64:b64})});var jd=await rsp.json();if(!jd.ok){st("v95-status","failed on "+f.name+": "+jd.error,"err");return}st("v95-status","uploaded "+(i+1)+"/"+files.length+": "+f.name)}catch(e){st("v95-status","error: "+e.message,"err");return}}if(doCommit){var cr=await fetch(API+"/commit",{method:"POST",headers:{"Authorization":"Bearer "+T,"Content-Type":"application/json"},body:JSON.stringify({message:"upload: "+files.length+" file(s)"})}).then(function(r){return r.json()});if(!cr.ok){st("v95-status","commit failed: "+cr.error,"err");return}}if(doPromote){var pr=await fetch(API+"/promote",{method:"POST",headers:{"Authorization":"Bearer "+T,"Content-Type":"application/json"},body:JSON.stringify({})}).then(function(r){return r.json()});if(!pr.ok){st("v95-status","promote failed: "+pr.error,"err");return}st("v95-status","uploaded + committed + promoted ","ok")}else if(doCommit){st("v95-status","uploaded + committed ","ok")}else{st("v95-status","uploaded ","ok")}fi.value=""});';
  // Autopilot
  html += 'var ap=document.getElementById("v95-ap-start");if(ap)ap.addEventListener("click",function(){var g=document.getElementById("v95-ap-goal").value.trim();if(!g){st("v95-ap-status","goal required","err");return}fetch(API+"/autopilot",{method:"POST",headers:{"Authorization":"Bearer "+T,"Content-Type":"application/json"},body:JSON.stringify({goal:g,loop:document.getElementById("v95-ap-loop").checked})}).then(function(r){return r.json()}).then(function(d){if(d.ok)st("v95-ap-status","job "+d.job_id+" queued. Open in Claude for Chrome to run.","ok");else st("v95-ap-status","err: "+d.error,"err")})});';
  html += '})();</script>';

  html += '</div></body></html>';
  return html;
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


// v0.9.4: Project bot management endpoints (gated on TELEPATH_AVAILABLE)
function requireBotCapability(req, res) {
  if (!TELEPATH_AVAILABLE) {
    res.status(501).json({ ok: false, error: 'bot_capability_unavailable', detail: 'telepath.js not present on this server' });
    return false;
  }
  return true;
}

app.get('/drafts/project/bot', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!requireBotCapability(req, res)) return;
  res.json({ ok: true, project: p.name, bot: projectBotsApi.getBotStatus(p) });
});

app.put('/drafts/project/bot', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!requireBotCapability(req, res)) return;
  const tk = String(req.body.token || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(tk)) {
    return res.status(400).json({ ok: false, error: 'invalid_bot_token_format' });
  }
  try {
    const out = await projectBotsApi.installBot(p, tk, { webhook_url: req.body.webhook_url || null });
    res.json({ ok: true, project: p.name, bot: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'install_failed', detail: e.message });
  }
});

app.delete('/drafts/project/bot', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!requireBotCapability(req, res)) return;
  const out = await projectBotsApi.unlinkBot(p, { notify_subscribers: !!(req.body && req.body.notify_subscribers) });
  res.json({ ok: true, project: p.name, ...out });
});

app.post('/drafts/project/bot/sync', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!requireBotCapability(req, res)) return;
  try {
    const out = await projectBotsApi.syncBot(p, (req.body && req.body.broadcast_html) || null);
    res.json({ ok: true, project: p.name, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'sync_failed', detail: e.message });
  }
});

app.put('/drafts/project/bot/webhook', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!requireBotCapability(req, res)) return;
  try {
    const url = req.body && Object.prototype.hasOwnProperty.call(req.body, 'url') ? req.body.url : null;
    const out = await projectBotsApi.setWebhookUrl(p, url);
    res.json({ ok: true, project: p.name, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'webhook_failed', detail: e.message });
  }
});

app.put('/drafts/project/bot/analytics', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!requireBotCapability(req, res)) return;
  try {
    const out = projectBotsApi.setAnalyticsEnabled(p, !!(req.body && req.body.enabled));
    res.json({ ok: true, project: p.name, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/drafts/project/bot/broadcast', authPAPorSAP, async (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  if (!requireBotCapability(req, res)) return;
  if (!p.bot || !p.bot.token) return res.status(400).json({ ok: false, error: 'no_bot_attached' });
  if (p.bot.webhook_url) return res.status(400).json({ ok: false, error: 'broadcast_unavailable_in_webhook_mode' });
  const html = String((req.body && req.body.html) || '').trim();
  if (!html) return res.status(400).json({ ok: false, error: 'html_required' });
  const out = await projectBotsApi.broadcast(p, html);
  res.json({ ok: true, project: p.name, ...out });
});

// v1.0: runtime logs (PAP/SAP only) — read the per-project bot.js log ring buffer
app.get('/drafts/project/bot/logs', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 200));
  const data = runtime.getLogs(p.name, limit);
  res.json({ ok: true, project: p.name, ...data });
});

app.delete('/drafts/project/bot/logs', authPAPorSAP, (req, res) => {
  const p = req.project || findProjectByName(sanitizeName(req.query.project || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
  runtime.clearLogs(p.name);
  res.json({ ok: true, cleared: true });
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


//
// v0.9: Auto-update + Autopilot endpoints
//

app.get('/drafts/autoupdate', authSAP, (req, res) => {
  const cfg = state.autoupdate || { drafts: false, telepath: false };
  res.json({ ok: true, drafts: !!cfg.drafts, telepath: !!cfg.telepath });
});

app.put('/drafts/autoupdate', authSAP, (req, res) => {
  state.autoupdate = {
    drafts: !!req.body.drafts,
    telepath: !!req.body.telepath,
    updated_at: now(),
  };
  saveState();
  res.json({ ok: true, drafts: state.autoupdate.drafts, telepath: state.autoupdate.telepath });
});

// Autopilot job queue (in-memory; agent picks up via GET /drafts/autopilot/jobs)
state.autopilot = state.autopilot || { jobs: [] };
if (!state.autopilot.jobs) state.autopilot.jobs = [];

app.post('/drafts/autopilot', authPAPorSAP, (req, res) => {
  const goal = String(req.body.goal || '').trim();
  if (!goal) return res.status(400).json({ ok: false, error: 'goal_required' });
  const job = {
    id: newId(),
    project: req.project ? req.project.name : null,
    goal: goal.slice(0, 2000),
    loop: req.body.loop !== false,
    created_at: now(),
    status: 'queued',
    iterations: [],
  };
  state.autopilot.jobs.push(job);
  if (state.autopilot.jobs.length > 200) state.autopilot.jobs = state.autopilot.jobs.slice(-200);
  saveState();
  res.json({ ok: true, job_id: job.id, project: job.project });
});

app.get('/drafts/autopilot/jobs', authAny, (req, res) => {
  const jobs = state.autopilot.jobs.filter(j => req.tier === 'sap' || (req.project && j.project === req.project.name));
  res.json({ ok: true, jobs: jobs.slice(-50) });
});

app.post('/drafts/autopilot/:id/iterate', authPAPorSAP, (req, res) => {
  const j = state.autopilot.jobs.find(x => x.id === req.params.id);
  if (!j) return res.status(404).json({ ok: false, error: 'job_not_found' });
  j.iterations.push({
    at: now(),
    test_result: req.body.test_result || null,
    fix_applied: req.body.fix_applied || null,
    notes: (req.body.notes || '').slice(0, 1000),
  });
  if (req.body.done) j.status = 'done';
  else j.status = 'running';
  saveState();
  res.json({ ok: true, status: j.status, iteration: j.iterations.length });
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

// runtime.js  drafts v1.0 per-project Telegram bot runtime
//
// Activated when a project's live/ directory contains bot.js. drafts loads
// it via dynamic import, executes its default export `handler(update, ctx)`
// for every Telegram update, and named exports for cron entries.
//
// ctx surface:
//   ctx.kv             per-project SQLite KV (get/set/del/list/incr) with TTL
//   ctx.send           Telegram Bot API helper (token hidden)
//   ctx.log            ring-buffer logger; readable via /drafts/project/bot/logs
//   ctx.project        project name
//   ctx.user_id        best-effort tg user id from update
//   ctx.bot_username   bot username
//   ctx.now            ISO timestamp
//
// Sandbox: code runs in a Node vm Context with whitelisted globals
// (URL, URLSearchParams, fetch, console, JSON, TextEncoder/TextDecoder,
// crypto.randomUUID, Buffer). No fs, child_process, net, http, process,
// require, dynamic import. Each invocation has a 5s wallclock timeout via
// Promise.race. KV size capped at 10 MiB per project.
//
// This is a first-pass sandbox: it stops accidents and casual probes,
// not a determined attacker. Hardening (isolated-vm, CPU quotas, memory
// quotas, fork-per-call) is queued for v1.1.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';

const RUNTIME_TIMEOUT_MS = 5000;
const KV_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB per project
const KV_MAX_KEY_LEN = 512;
const KV_MAX_VALUE_BYTES = 1024 * 1024; // 1 MiB per value
const LOG_RING_SIZE = 1000;

const DRAFTS_DIR = process.env.DRAFTS_DIR || '/var/lib/drafts';

// projectName -> { module, mtime, ctx, kv, logs, importErr }
const registry = new Map();

// 
// KV (per-project SQLite)
// 
function openKv(projectName) {
  const dir = path.join(DRAFTS_DIR, projectName, 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'kv.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v BLOB NOT NULL,
      expires_at INTEGER,
      bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kv_prefix ON kv(k);
    CREATE INDEX IF NOT EXISTS idx_kv_expiry ON kv(expires_at) WHERE expires_at IS NOT NULL;
  `);
  const stmts = {
    get: db.prepare('SELECT v, expires_at FROM kv WHERE k = ?'),
    set: db.prepare('INSERT OR REPLACE INTO kv(k, v, expires_at, bytes) VALUES (?, ?, ?, ?)'),
    del: db.prepare('DELETE FROM kv WHERE k = ?'),
    list: db.prepare('SELECT k, v, expires_at FROM kv WHERE k LIKE ? ORDER BY k LIMIT 1000'),
    delExpired: db.prepare('DELETE FROM kv WHERE k = ? AND expires_at IS NOT NULL AND expires_at <= ?'),
    sumBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM kv'),
  };

  function checkKey(k) {
    if (typeof k !== 'string' || !k.length) throw new Error('kv: key must be non-empty string');
    if (k.length > KV_MAX_KEY_LEN) throw new Error('kv: key too long');
  }
  function maybeExpired(row, k) {
    if (!row) return null;
    if (row.expires_at && row.expires_at <= Date.now()) {
      stmts.del.run(k);
      return null;
    }
    return row;
  }
  function decodeValue(blob) {
    try { return JSON.parse(blob.toString('utf8')); } catch (e) { return null; }
  }

  return {
    async get(k) {
      checkKey(k);
      const row = maybeExpired(stmts.get.get(k), k);
      return row ? decodeValue(row.v) : null;
    },
    async set(k, v, opts = {}) {
      checkKey(k);
      const json = JSON.stringify(v);
      if (json === undefined) throw new Error('kv: value not JSON-serializable');
      const buf = Buffer.from(json, 'utf8');
      if (buf.length > KV_MAX_VALUE_BYTES) throw new Error('kv: value exceeds 1 MiB');
      const expiresAt = (opts && opts.ttl) ? Date.now() + (opts.ttl * 1000) : null;
      const total = stmts.sumBytes.get().total + buf.length;
      if (total > KV_MAX_BYTES) throw new Error('kv: project storage quota exceeded (10 MiB)');
      stmts.set.run(k, buf, expiresAt, buf.length);
      return true;
    },
    async del(k) {
      checkKey(k);
      return stmts.del.run(k).changes > 0;
    },
    async list(prefix) {
      if (typeof prefix !== 'string') prefix = '';
      const like = prefix.replace(/[%_]/g, ch => '\\' + ch) + '%';
      const rows = stmts.list.all(like);
      const now = Date.now();
      const out = [];
      for (const row of rows) {
        if (row.expires_at && row.expires_at <= now) { stmts.del.run(row.k); continue; }
        out.push({ key: row.k, value: decodeValue(row.v) });
      }
      return out;
    },
    async incr(k, by = 1) {
      checkKey(k);
      const row = maybeExpired(stmts.get.get(k), k);
      const cur = row ? Number(decodeValue(row.v)) || 0 : 0;
      const next = cur + (Number(by) || 1);
      const buf = Buffer.from(JSON.stringify(next), 'utf8');
      stmts.set.run(k, buf, row ? row.expires_at : null, buf.length);
      return next;
    },
    _internal: { db, stmts },
  };
}

// 
// Logs (in-memory ring per project)
// 
function makeLogger() {
  const ring = [];
  function push(level, args) {
    const line = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ').slice(0, 2000);
    ring.push({ at: new Date().toISOString(), level, line });
    if (ring.length > LOG_RING_SIZE) ring.splice(0, ring.length - LOG_RING_SIZE);
  }
  return {
    log:   (...a) => push('info',  a),
    info:  (...a) => push('info',  a),
    warn:  (...a) => push('warn',  a),
    error: (...a) => push('error', a),
    read:  (limit) => ring.slice(-(limit || 200)),
    clear: () => ring.length = 0,
  };
}

// 
// Telegram helper (ctx.send)  token never exposed to user code
// 
function makeSend(getToken) {
  async function api(method, params = {}) {
    const token = getToken();
    if (!token) throw new Error('send: no bot token');
    const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = new Error('telegram_api: ' + (data.description || 'unknown'));
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }
  return {
    api,
    message:        (chat_id, text, opts = {}) => api('sendMessage',         { chat_id, text, parse_mode: opts.parse_mode || 'HTML', ...opts }),
    editMessage:    (chat_id, message_id, text, opts = {}) => api('editMessageText', { chat_id, message_id, text, parse_mode: opts.parse_mode || 'HTML', ...opts }),
    answerCallback: (callback_query_id, text, opts = {}) => api('answerCallbackQuery', { callback_query_id, text, ...opts }),
  };
}

// 
// Sandbox  vm.Context with whitelisted globals
// 
function safeGlobals(logger) {
  return {
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Buffer,
    console: {
      log:   (...a) => logger.log(...a),
      info:  (...a) => logger.info(...a),
      warn:  (...a) => logger.warn(...a),
      error: (...a) => logger.error(...a),
    },
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      getRandomValues: (arr) => crypto.getRandomValues(arr),
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
}

async function loadProjectModule(projectName, logger) {
  const livePath = path.join(DRAFTS_DIR, projectName, 'live', 'bot.js');
  if (!fs.existsSync(livePath)) return { module: null, mtime: null };
  const stat = fs.statSync(livePath);
  const src = fs.readFileSync(livePath, 'utf8');

  // Wrap user code in an async IIFE that returns its exports.
  // Forbid require/dynamic import at the simple textual level (defense in depth;
  // the sandbox doesn't expose them anyway).
  if (/\brequire\s*\(/.test(src)) throw new Error('bot.js: require() is not available; use ES module exports');

  // Transform `export default async function handler` etc. into a return statement.
  // Strategy: collect named exports and default export, return them.
  let transformed = src;
  const namedExports = [];
  let defaultExport = null;

  // export default async function NAME (...) { ... }
  transformed = transformed.replace(
    /\bexport\s+default\s+(async\s+)?function\s*(\w*)\s*\(/g,
    (_, asyncKw = '', name) => { defaultExport = name || '__default__'; return (asyncKw || '') + 'function ' + (name || '__default__') + '('; }
  );
  // export default <expr>
  transformed = transformed.replace(
    /\bexport\s+default\s+/g,
    'const __default__ = '
  );
  if (!defaultExport) defaultExport = '__default__';

  // export async function NAME (...)
  transformed = transformed.replace(
    /\bexport\s+(async\s+)?function\s+(\w+)\s*\(/g,
    (_, asyncKw = '', name) => { namedExports.push(name); return (asyncKw || '') + 'function ' + name + '('; }
  );
  // export const NAME = ...
  transformed = transformed.replace(
    /\bexport\s+const\s+(\w+)/g,
    (_, name) => { namedExports.push(name); return 'const ' + name; }
  );
  // export { a, b, c }
  transformed = transformed.replace(
    /\bexport\s*\{([^}]+)\}/g,
    (_, list) => { for (const n of list.split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) namedExports.push(n); return ''; }
  );

  const exportsList = [
    'default: ' + defaultExport,
    ...namedExports.map(n => n + ': ' + n),
  ].join(', ');
  const wrapped = '(async () => {\n' + transformed + '\nreturn { ' + exportsList + ' };\n})()';

  const ctx = vm.createContext(safeGlobals(logger), { name: 'drafts:' + projectName });
  const script = new vm.Script(wrapped, { filename: 'bot.js', timeout: 1000 });
  const promise = script.runInContext(ctx, { timeout: 1000 });
  const module = await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('bot.js load timeout')), 3000)),
  ]);
  return { module, mtime: stat.mtimeMs, sandboxCtx: ctx };
}

// 
// Public API
// 
export function hasBotJs(projectName) {
  const livePath = path.join(DRAFTS_DIR, projectName, 'live', 'bot.js');
  return fs.existsSync(livePath);
}

export async function ensureLoaded(projectName) {
  if (!hasBotJs(projectName)) {
    if (registry.has(projectName)) registry.delete(projectName);
    return null;
  }
  const livePath = path.join(DRAFTS_DIR, projectName, 'live', 'bot.js');
  const stat = fs.statSync(livePath);
  const cached = registry.get(projectName);
  if (cached && cached.mtime === stat.mtimeMs && !cached.importErr) return cached;

  const logger = (cached && cached.logs) || makeLogger();
  const kv = (cached && cached.kv) || openKv(projectName);
  try {
    const { module } = await loadProjectModule(projectName, logger);
    const entry = { module, mtime: stat.mtimeMs, kv, logs: logger, importErr: null };
    registry.set(projectName, entry);
    logger.info('[runtime] loaded bot.js (mtime ' + new Date(stat.mtimeMs).toISOString() + ')');
    return entry;
  } catch (e) {
    const entry = { module: null, mtime: stat.mtimeMs, kv, logs: logger, importErr: e.message };
    registry.set(projectName, entry);
    logger.error('[runtime] bot.js failed to load:', e.message);
    return entry;
  }
}

function extractUserId(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.message && update.message.from) return update.message.from.id;
  if (update.callback_query && update.callback_query.from) return update.callback_query.from.id;
  if (update.edited_message && update.edited_message.from) return update.edited_message.from.id;
  return null;
}

export async function handleUpdate(project, update) {
  const entry = await ensureLoaded(project.name);
  if (!entry) return { handled: false, reason: 'no_bot_js' };
  if (!entry.module || typeof entry.module.default !== 'function') {
    entry.logs.error('[runtime] no default export or default is not a function');
    return { handled: false, reason: 'no_default_export', error: entry.importErr };
  }
  const ctx = {
    kv: entry.kv,
    send: makeSend(() => project.bot && project.bot.token),
    log: (...a) => entry.logs.info(...a),
    project: project.name,
    user_id: extractUserId(update),
    bot_username: project.bot && project.bot.bot_username,
    now: new Date().toISOString(),
  };
  try {
    await Promise.race([
      Promise.resolve(entry.module.default(update, ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('handler timeout (' + RUNTIME_TIMEOUT_MS + 'ms)')), RUNTIME_TIMEOUT_MS)),
    ]);
    return { handled: true };
  } catch (e) {
    entry.logs.error('[runtime] handler threw:', e.message);
    return { handled: true, error: e.message };
  }
}

export async function handleCron(project, handlerName) {
  const entry = await ensureLoaded(project.name);
  if (!entry || !entry.module) return { handled: false, reason: 'no_bot_js' };
  const fn = entry.module[handlerName];
  if (typeof fn !== 'function') {
    entry.logs.warn('[runtime] cron handler not found:', handlerName);
    return { handled: false, reason: 'no_handler' };
  }
  const ctx = {
    kv: entry.kv,
    send: makeSend(() => project.bot && project.bot.token),
    log: (...a) => entry.logs.info(...a),
    project: project.name,
    user_id: null,
    bot_username: project.bot && project.bot.bot_username,
    now: new Date().toISOString(),
    cron: handlerName,
  };
  try {
    await Promise.race([
      Promise.resolve(fn(ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cron handler timeout')), RUNTIME_TIMEOUT_MS)),
    ]);
    return { handled: true };
  } catch (e) {
    entry.logs.error('[runtime] cron handler ' + handlerName + ' threw:', e.message);
    return { handled: true, error: e.message };
  }
}

export function getLogs(projectName, limit) {
  const entry = registry.get(projectName);
  if (!entry) return { lines: [], present: false };
  return {
    lines: entry.logs.read(limit),
    present: true,
    has_module: !!entry.module,
    import_error: entry.importErr || null,
    bot_js_mtime: entry.mtime ? new Date(entry.mtime).toISOString() : null,
  };
}

export function clearLogs(projectName) {
  const entry = registry.get(projectName);
  if (entry) entry.logs.clear();
}

export function unloadProject(projectName) {
  const entry = registry.get(projectName);
  if (entry && entry.kv && entry.kv._internal && entry.kv._internal.db) {
    try { entry.kv._internal.db.close(); } catch (e) {}
  }
  registry.delete(projectName);
}

export function getRuntimeStatus() {
  const out = [];
  for (const [name, entry] of registry) {
    out.push({ project: name, has_module: !!entry.module, import_error: entry.importErr, log_lines: entry.logs.read(0).length });
  }
  return out;
}

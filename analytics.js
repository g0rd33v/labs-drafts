// analytics.js v0.7 — Per-project Telegram bot analytics.
//
// Records every Telegram update touching a project's bot to disk:
//   - .analytics.jsonl              append-only event log (one event per line)
//   - .analytics-summary.json       rolling aggregates, updated on every event
//   - .analytics-daily/<date>.json  midnight UTC snapshots of the summary
//   - .analytics-archive-<ts>.jsonl when the live log exceeds MAX_BYTES_BEFORE_ROTATE
//
// Privacy: NO raw message text or media is recorded. Only metadata
// (length, type, language, country guess derived from language_code).
//
// Owner-only: served via WebApp endpoints with PAP initData auth.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

// ─────────────────────────────────────────────────────────────
// Limits / config
// ─────────────────────────────────────────────────────────────
const MAX_USERS_IN_SUMMARY = 10000;        // hard cap on by_user keys
const MAX_BYTES_BEFORE_ROTATE = 50 * 1024 * 1024; // 50MB
const SUMMARY_DAILY_KEEP_DAYS = 60;        // keep this many daily snapshots

// language_code → country guess (best effort, ~80% accurate by aggregate)
const LANG_TO_COUNTRY_GUESS = {
  'ru': 'RU', 'uk': 'UA', 'be': 'BY', 'kk': 'KZ', 'ky': 'KG', 'uz': 'UZ', 'tg': 'TJ',
  'en': 'US', 'en-us': 'US', 'en-gb': 'GB', 'en-au': 'AU', 'en-ca': 'CA', 'en-in': 'IN',
  'es': 'ES', 'es-mx': 'MX', 'es-ar': 'AR', 'pt': 'PT', 'pt-br': 'BR',
  'de': 'DE', 'fr': 'FR', 'it': 'IT', 'nl': 'NL', 'pl': 'PL', 'cs': 'CZ', 'sk': 'SK',
  'hu': 'HU', 'ro': 'RO', 'bg': 'BG', 'sr': 'RS', 'hr': 'HR', 'sl': 'SI', 'el': 'GR',
  'tr': 'TR', 'ar': 'SA', 'fa': 'IR', 'he': 'IL', 'hi': 'IN', 'bn': 'BD', 'ta': 'IN',
  'th': 'TH', 'vi': 'VN', 'id': 'ID', 'ms': 'MY', 'tl': 'PH', 'ko': 'KR',
  'ja': 'JP', 'zh': 'CN', 'zh-cn': 'CN', 'zh-tw': 'TW', 'zh-hk': 'HK',
  'sv': 'SE', 'no': 'NO', 'nb': 'NO', 'da': 'DK', 'fi': 'FI', 'is': 'IS', 'et': 'EE',
  'lv': 'LV', 'lt': 'LT', 'ka': 'GE', 'hy': 'AM', 'az': 'AZ', 'mn': 'MN',
  'sw': 'KE', 'am': 'ET', 'zu': 'ZA', 'af': 'ZA',
  'ca': 'ES', 'eu': 'ES', 'gl': 'ES',
};

function guessCountry(langCode) {
  if (!langCode) return null;
  const k = String(langCode).toLowerCase();
  if (LANG_TO_COUNTRY_GUESS[k]) return LANG_TO_COUNTRY_GUESS[k];
  const base = k.split('-')[0];
  return LANG_TO_COUNTRY_GUESS[base] || null;
}

// ─────────────────────────────────────────────────────────────
// File paths
// ─────────────────────────────────────────────────────────────
function logPath(projectName, draftsDir) {
  return path.join(draftsDir, projectName, '.analytics.jsonl');
}
function summaryPath(projectName, draftsDir) {
  return path.join(draftsDir, projectName, '.analytics-summary.json');
}
function dailyDir(projectName, draftsDir) {
  return path.join(draftsDir, projectName, '.analytics-daily');
}
function dailyPath(projectName, draftsDir, date) {
  return path.join(dailyDir(projectName, draftsDir), date + '.json');
}

// ─────────────────────────────────────────────────────────────
// Summary skeleton + load/save
// ─────────────────────────────────────────────────────────────
function emptySummary() {
  return {
    version: 1,
    started_at: new Date().toISOString(),
    last_event_at: null,
    events_total: 0,
    by_type: {},               // update type -> count
    by_message_type: {},       // text/photo/voice/etc -> count
    by_chat_type: {},          // private/group/supergroup/channel -> count
    by_language: {},           // language_code -> count
    by_country_guess: {},      // ISO2 -> count
    by_hour_utc: Array(24).fill(0),
    by_dow_utc: Array(7).fill(0),  // 0=Sun, 6=Sat
    by_day: {},                // YYYY-MM-DD -> count, last 60 days only
    users_total: 0,
    users_premium: 0,
    users_active_7d: 0,        // recomputed on demand
    users_active_30d: 0,
    by_user: {},               // tg_user_id -> { first_seen, last_seen, events, premium, lang, name, username }
    subscribed: 0,             // /start or my_chat_member member-status
    unsubscribed: 0,           // my_chat_member kicked/left
    payments_count: 0,
    payments_revenue: {},      // currency -> total minor units
  };
}

function loadSummary(projectName, draftsDir) {
  const p = summaryPath(projectName, draftsDir);
  if (!fs.existsSync(p)) return emptySummary();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // backfill any missing fields against empty skeleton
    const skeleton = emptySummary();
    return { ...skeleton, ...raw,
      by_hour_utc: Array.isArray(raw.by_hour_utc) && raw.by_hour_utc.length === 24 ? raw.by_hour_utc : skeleton.by_hour_utc,
      by_dow_utc: Array.isArray(raw.by_dow_utc) && raw.by_dow_utc.length === 7 ? raw.by_dow_utc : skeleton.by_dow_utc,
      by_day: raw.by_day || {},
      by_user: raw.by_user || {},
      payments_revenue: raw.payments_revenue || {},
    };
  } catch (e) {
    console.error('[analytics] failed to load summary for ' + projectName + ':', e.message);
    return emptySummary();
  }
}

function saveSummary(projectName, draftsDir, summary) {
  const p = summaryPath(projectName, draftsDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(summary));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error('[analytics] failed to save summary for ' + projectName + ':', e.message);
  }
}

// In-memory cache so we don't re-read the summary on every event (high write rate)
const summaryCache = new Map();  // projectName -> summary object

function getCached(projectName, draftsDir) {
  if (!summaryCache.has(projectName)) {
    summaryCache.set(projectName, loadSummary(projectName, draftsDir));
  }
  return summaryCache.get(projectName);
}

// ─────────────────────────────────────────────────────────────
// Log rotation
// ─────────────────────────────────────────────────────────────
function rotateIfNeeded(projectName, draftsDir) {
  const lp = logPath(projectName, draftsDir);
  if (!fs.existsSync(lp)) return false;
  try {
    const stat = fs.statSync(lp);
    if (stat.size < MAX_BYTES_BEFORE_ROTATE) return false;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = path.join(path.dirname(lp), '.analytics-archive-' + ts + '.jsonl');
    fs.renameSync(lp, archive);
    console.log('[analytics] rotated log for ' + projectName + ' -> ' + path.basename(archive));
    return true;
  } catch (e) {
    console.error('[analytics] rotate failed for ' + projectName + ':', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Update -> event projection
// ─────────────────────────────────────────────────────────────
function inferUpdateType(upd) {
  if (upd.message) return 'message';
  if (upd.edited_message) return 'edited_message';
  if (upd.channel_post) return 'channel_post';
  if (upd.edited_channel_post) return 'edited_channel_post';
  if (upd.callback_query) return 'callback_query';
  if (upd.inline_query) return 'inline_query';
  if (upd.chosen_inline_result) return 'chosen_inline_result';
  if (upd.shipping_query) return 'shipping_query';
  if (upd.pre_checkout_query) return 'pre_checkout_query';
  if (upd.poll) return 'poll';
  if (upd.poll_answer) return 'poll_answer';
  if (upd.my_chat_member) return 'my_chat_member';
  if (upd.chat_member) return 'chat_member';
  if (upd.chat_join_request) return 'chat_join_request';
  return 'unknown';
}

function inferMessageType(msg) {
  if (!msg) return null;
  if (msg.text) return 'text';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.video_note) return 'video_note';
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.document) return 'document';
  if (msg.sticker) return 'sticker';
  if (msg.animation) return 'animation';
  if (msg.location) return 'location';
  if (msg.contact) return 'contact';
  if (msg.poll) return 'poll';
  if (msg.dice) return 'dice';
  if (msg.successful_payment) return 'successful_payment';
  if (msg.new_chat_members) return 'new_chat_members';
  if (msg.left_chat_member) return 'left_chat_member';
  return 'other';
}

function extractUser(upd) {
  // Pull tg user from any plausible position
  return upd.message?.from
      || upd.edited_message?.from
      || upd.callback_query?.from
      || upd.inline_query?.from
      || upd.chosen_inline_result?.from
      || upd.shipping_query?.from
      || upd.pre_checkout_query?.from
      || upd.poll_answer?.user
      || upd.my_chat_member?.from
      || upd.chat_member?.from
      || upd.chat_join_request?.from
      || null;
}

function extractChat(upd) {
  return upd.message?.chat
      || upd.edited_message?.chat
      || upd.channel_post?.chat
      || upd.callback_query?.message?.chat
      || upd.my_chat_member?.chat
      || upd.chat_member?.chat
      || upd.chat_join_request?.chat
      || null;
}

function buildEvent(upd) {
  const at = new Date().toISOString();
  const updateType = inferUpdateType(upd);
  const tgUser = extractUser(upd);
  const chat = extractChat(upd);
  const ev = {
    update_id: upd.update_id || null,
    type: updateType,
    at,
  };
  if (tgUser) {
    ev.user = {
      id: tgUser.id,
      username: tgUser.username || null,
      first_name: tgUser.first_name || null,
      last_name: tgUser.last_name || null,
      is_premium: !!tgUser.is_premium,
      is_bot: !!tgUser.is_bot,
      language_code: tgUser.language_code || null,
    };
    ev.country_guess = guessCountry(tgUser.language_code);
  }
  if (chat) {
    ev.chat = { id: chat.id, type: chat.type };
  }

  // Type-specific extras
  if (updateType === 'message' || updateType === 'edited_message' || updateType === 'channel_post') {
    const msg = upd.message || upd.edited_message || upd.channel_post;
    ev.message_type = inferMessageType(msg);
    if (msg.text) {
      ev.text_length = msg.text.length;
      // command detection (only the command token itself, no args)
      const m = msg.text.match(/^\/([a-zA-Z0-9_]+)/);
      if (m) ev.command = '/' + m[1].toLowerCase();
    }
    if (msg.has_media_spoiler) ev.has_media_spoiler = true;
    if (msg.forward_origin) ev.is_forward = true;
    if (msg.successful_payment) {
      ev.payment = {
        currency: msg.successful_payment.currency,
        total_amount: msg.successful_payment.total_amount,
        invoice_payload: (msg.successful_payment.invoice_payload || '').slice(0, 80),
      };
    }
  } else if (updateType === 'callback_query') {
    ev.callback_data = (upd.callback_query.data || '').slice(0, 80);
  } else if (updateType === 'inline_query') {
    ev.inline_query_length = (upd.inline_query.query || '').length;
  } else if (updateType === 'my_chat_member') {
    ev.member_old_status = upd.my_chat_member.old_chat_member?.status || null;
    ev.member_new_status = upd.my_chat_member.new_chat_member?.status || null;
  } else if (updateType === 'pre_checkout_query') {
    ev.payment = {
      currency: upd.pre_checkout_query.currency,
      total_amount: upd.pre_checkout_query.total_amount,
    };
  }

  return ev;
}

// ─────────────────────────────────────────────────────────────
// Apply event to summary
// ─────────────────────────────────────────────────────────────
function inc(obj, key, by = 1) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + by;
}

function applyEventToSummary(s, ev) {
  s.events_total += 1;
  s.last_event_at = ev.at;
  inc(s.by_type, ev.type);
  if (ev.message_type) inc(s.by_message_type, ev.message_type);
  if (ev.chat?.type) inc(s.by_chat_type, ev.chat.type);
  if (ev.user?.language_code) inc(s.by_language, ev.user.language_code);
  if (ev.country_guess) inc(s.by_country_guess, ev.country_guess);

  const d = new Date(ev.at);
  s.by_hour_utc[d.getUTCHours()] += 1;
  s.by_dow_utc[d.getUTCDay()] += 1;
  const dayKey = d.toISOString().slice(0, 10);
  inc(s.by_day, dayKey);
  // Trim by_day to last 60 keys
  const days = Object.keys(s.by_day).sort();
  if (days.length > 60) {
    for (const k of days.slice(0, days.length - 60)) delete s.by_day[k];
  }

  // user dimension
  if (ev.user && !ev.user.is_bot) {
    const uid = String(ev.user.id);
    let urec = s.by_user[uid];
    if (!urec) {
      // hard cap protection
      if (Object.keys(s.by_user).length >= MAX_USERS_IN_SUMMARY) {
        // already at cap: skip adding new users to by_user but still count totals
      } else {
        urec = { first_seen: ev.at, last_seen: ev.at, events: 0, premium: ev.user.is_premium, lang: ev.user.language_code || null, country: ev.country_guess || null, name: ev.user.first_name || null, username: ev.user.username || null };
        s.by_user[uid] = urec;
        s.users_total += 1;
        if (ev.user.is_premium) s.users_premium += 1;
      }
    }
    if (urec) {
      urec.last_seen = ev.at;
      urec.events += 1;
      // refresh fields that may have changed (username, premium status)
      if (ev.user.username) urec.username = ev.user.username;
      if (ev.user.first_name) urec.name = ev.user.first_name;
      const wasPremium = urec.premium;
      urec.premium = ev.user.is_premium;
      if (!wasPremium && ev.user.is_premium) s.users_premium += 1;
      if (wasPremium && !ev.user.is_premium) s.users_premium -= 1;
    }
  }

  // subscribe / unsubscribe via my_chat_member
  if (ev.type === 'my_chat_member') {
    const oldS = ev.member_old_status;
    const newS = ev.member_new_status;
    const isMember = (st) => st === 'member' || st === 'creator' || st === 'administrator' || st === 'restricted';
    if (!isMember(oldS) && isMember(newS)) s.subscribed += 1;
    if (isMember(oldS) && !isMember(newS)) s.unsubscribed += 1;
  }
  // Also count /start as a subscribe signal
  if (ev.command === '/start') s.subscribed += 1;

  // payments
  if (ev.payment && ev.type === 'message' && ev.message_type === 'successful_payment') {
    s.payments_count += 1;
    inc(s.payments_revenue, ev.payment.currency, ev.payment.total_amount || 0);
  }
}

function refreshLiveActivityCounts(s) {
  const now = Date.now();
  const sevenAgo = now - 7 * 24 * 3600 * 1000;
  const thirtyAgo = now - 30 * 24 * 3600 * 1000;
  let a7 = 0, a30 = 0;
  for (const u of Object.values(s.by_user)) {
    const t = new Date(u.last_seen).getTime();
    if (t >= sevenAgo) a7 += 1;
    if (t >= thirtyAgo) a30 += 1;
  }
  s.users_active_7d = a7;
  s.users_active_30d = a30;
}

// ─────────────────────────────────────────────────────────────
// Public: record an update
// ─────────────────────────────────────────────────────────────
export function recordUpdate(projectName, draftsDir, upd) {
  if (!projectName || !draftsDir || !upd) return;
  try {
    const ev = buildEvent(upd);
    // Append to JSONL
    rotateIfNeeded(projectName, draftsDir);
    const lp = logPath(projectName, draftsDir);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.appendFileSync(lp, JSON.stringify(ev) + '\n');
    // Update summary cache + persist
    const s = getCached(projectName, draftsDir);
    applyEventToSummary(s, ev);
    saveSummary(projectName, draftsDir, s);
  } catch (e) {
    console.error('[analytics] record failed for ' + projectName + ':', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Public: read summary for the dashboard (lightweight projection)
// ─────────────────────────────────────────────────────────────
export function getSummary(projectName, draftsDir) {
  const s = getCached(projectName, draftsDir);
  refreshLiveActivityCounts(s);

  // Build top lists (don't return the whole by_user / by_language map)
  const topLanguages = Object.entries(s.by_language).sort((a,b) => b[1]-a[1]).slice(0, 10).map(([k,v]) => ({ code: k, count: v }));
  const topCountries = Object.entries(s.by_country_guess).sort((a,b) => b[1]-a[1]).slice(0, 15).map(([k,v]) => ({ code: k, count: v }));
  const topMessageTypes = Object.entries(s.by_message_type).sort((a,b) => b[1]-a[1]).map(([k,v]) => ({ type: k, count: v }));
  // recent users (last 20 by last_seen)
  const users = Object.entries(s.by_user)
    .map(([id, u]) => ({ id, ...u }))
    .sort((a,b) => new Date(b.last_seen) - new Date(a.last_seen))
    .slice(0, 20)
    .map(u => ({
      id: u.id, name: u.name, username: u.username,
      premium: u.premium, lang: u.lang, country: u.country,
      events: u.events, first_seen: u.first_seen, last_seen: u.last_seen,
    }));

  // last 30 days time series
  const sortedDays = Object.keys(s.by_day).sort();
  const last30 = sortedDays.slice(-30).map(d => ({ date: d, count: s.by_day[d] }));

  return {
    started_at: s.started_at,
    last_event_at: s.last_event_at,
    events_total: s.events_total,
    users_total: s.users_total,
    users_premium: s.users_premium,
    users_active_7d: s.users_active_7d,
    users_active_30d: s.users_active_30d,
    subscribed: s.subscribed,
    unsubscribed: s.unsubscribed,
    payments_count: s.payments_count,
    payments_revenue: s.payments_revenue,
    by_type: s.by_type,
    by_chat_type: s.by_chat_type,
    by_hour_utc: s.by_hour_utc,
    by_dow_utc: s.by_dow_utc,
    last_30_days: last30,
    top_languages: topLanguages,
    top_countries: topCountries,
    top_message_types: topMessageTypes,
    recent_users: users,
  };
}

// ─────────────────────────────────────────────────────────────
// Public: stream raw log file
// ─────────────────────────────────────────────────────────────
export function getLogStream(projectName, draftsDir) {
  const lp = logPath(projectName, draftsDir);
  if (!fs.existsSync(lp)) return null;
  return fs.createReadStream(lp);
}

export function getLogStats(projectName, draftsDir) {
  const lp = logPath(projectName, draftsDir);
  if (!fs.existsSync(lp)) return { exists: false, size: 0 };
  const stat = fs.statSync(lp);
  return { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
}

export function getSummaryRaw(projectName, draftsDir) {
  return getCached(projectName, draftsDir);
}

export function listArchives(projectName, draftsDir) {
  const dir = path.join(draftsDir, projectName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('.analytics-archive-') && f.endsWith('.jsonl'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a,b) => b.mtime.localeCompare(a.mtime));
}

export function getArchiveStream(projectName, draftsDir, filename) {
  if (!filename || !filename.startsWith('.analytics-archive-') || !filename.endsWith('.jsonl')) return null;
  // sanitize: no path traversal
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  const fp = path.join(draftsDir, projectName, filename);
  if (!fs.existsSync(fp)) return null;
  return fs.createReadStream(fp);
}

// ─────────────────────────────────────────────────────────────
// Public: wipe analytics for a project (owner-triggered reset)
// ─────────────────────────────────────────────────────────────
export function wipeAnalytics(projectName, draftsDir) {
  const dir = path.join(draftsDir, projectName);
  let removed = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('.analytics'))) {
    try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); removed += 1; } catch (e) {}
  }
  summaryCache.delete(projectName);
  return { removed };
}

// ─────────────────────────────────────────────────────────────
// Daily snapshot scheduler (runs once a day at midnight UTC)
// ─────────────────────────────────────────────────────────────
let snapshotTimer = null;

function takeDailySnapshot(getDraftsState, draftsDir) {
  try {
    const state = getDraftsState();
    const date = new Date(Date.now() - 1000).toISOString().slice(0, 10); // yesterday's date in UTC
    for (const project of state.projects) {
      if (!project.bot || !project.bot.token) continue;
      const s = getCached(project.name, draftsDir);
      refreshLiveActivityCounts(s);
      const dpath = dailyPath(project.name, draftsDir, date);
      try {
        fs.mkdirSync(path.dirname(dpath), { recursive: true });
        fs.writeFileSync(dpath, JSON.stringify(s));
      } catch (e) {
        console.error('[analytics] daily snapshot write failed for ' + project.name + ':', e.message);
      }
      // prune old snapshots
      try {
        const dir = dailyDir(project.name, draftsDir);
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
          if (files.length > SUMMARY_DAILY_KEEP_DAYS) {
            for (const f of files.slice(0, files.length - SUMMARY_DAILY_KEEP_DAYS)) {
              try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }
    console.log('[analytics] daily snapshots written for ' + date);
  } catch (e) {
    console.error('[analytics] daily snapshot loop failed:', e.message);
  }
}

export function startDailySnapshotScheduler(getDraftsState, draftsDir) {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  // Compute ms until next 00:05 UTC (a few minutes after midnight to be safe)
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0, 0));
  const ms = next.getTime() - now.getTime();
  snapshotTimer = setTimeout(() => {
    takeDailySnapshot(getDraftsState, draftsDir);
    // schedule recurring 24h interval
    setInterval(() => takeDailySnapshot(getDraftsState, draftsDir), 24 * 3600 * 1000);
  }, ms);
  console.log('[analytics] daily snapshot scheduled in ' + Math.round(ms/3600/1000) + 'h');
}

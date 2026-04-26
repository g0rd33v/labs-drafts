// analytics.js — Per-project bot analytics (v0.7).
//
// For every Telegram update flowing through a project bot, we record a small
// privacy-respecting event line into a JSONL file inside the project dir.
// We also maintain a rolling summary aggregate that the WebApp displays.
//
// Files (per project, under DRAFTS_DIR/<project>/):
//   .analytics.jsonl              append-only event log (one JSON per line)
//   .analytics-summary.json       rolling aggregates, updated on every event
//   .analytics-daily/<date>.json  midnight-UTC snapshots of the summary
//   .analytics-archive-<ts>.jsonl rotated logs when .jsonl > MAX_BYTES
//
// What we record (NEVER raw message text, only metadata):
//   - update_id, type, at (ISO)
//   - tg_user_id, username, first/last name, is_premium, is_bot, language_code
//   - chat_id, chat_type
//   - message subtype (text/voice/photo/...) + text length
//   - callback_data, inline query
//   - payment fields (amount, currency)
//   - my_chat_member transitions (subscribe/unsubscribe events)
//
// What the WebApp can show:
//   - total events, unique users, premium %, DAU last 7d & 30d
//   - top languages, top chat types
//   - hourly distribution
//   - per-message-type breakdown
//   - first_seen / last_seen per user (in summary.users)
//
// Owner can download both files via authenticated WebApp endpoints.

import fs from 'fs';
import path from 'path';

const SUMMARY_VERSION = 1;
const MAX_BYTES_BEFORE_ROTATE = 50 * 1024 * 1024; // 50 MB
const MAX_USERS_IN_SUMMARY = 10000; // cap users dict to prevent memory bloat
const MAX_TOP_N = 20;

// language_code → likely country (rough mapping for "geo guess")
// Telegram only gives interface language. This is approximate but useful.
const LANG_TO_COUNTRY_GUESS = {
  ru: 'RU', uk: 'UA', be: 'BY', kk: 'KZ', ky: 'KG', uz: 'UZ', tg: 'TJ',
  en: 'US/UK/other', es: 'ES/LATAM', pt: 'BR/PT', fr: 'FR', de: 'DE',
  it: 'IT', pl: 'PL', nl: 'NL', sv: 'SE', no: 'NO', fi: 'FI', da: 'DK',
  tr: 'TR', ar: 'SA/AE/EG', fa: 'IR', he: 'IL', ja: 'JP', ko: 'KR',
  zh: 'CN/TW/HK', vi: 'VN', th: 'TH', id: 'ID', hi: 'IN', bn: 'BD/IN',
  ur: 'PK', el: 'GR', cs: 'CZ', sk: 'SK', hu: 'HU', ro: 'RO', bg: 'BG',
  sr: 'RS', hr: 'HR', sl: 'SI', et: 'EE', lv: 'LV', lt: 'LT', az: 'AZ',
  hy: 'AM', ka: 'GE', mn: 'MN', ms: 'MY', tl: 'PH', sw: 'KE/TZ',
};

function paths(projectName, draftsDir) {
  const base = path.join(draftsDir || '/var/lib/drafts', projectName);
  return {
    base,
    log: path.join(base, '.analytics.jsonl'),
    summary: path.join(base, '.analytics-summary.json'),
    dailyDir: path.join(base, '.analytics-daily'),
  };
}

function emptySummary() {
  return {
    version: SUMMARY_VERSION,
    created_at: new Date().toISOString(),
    updated_at: null,
    events_total: 0,
    by_type: {},                  // update_type → count
    by_message_type: {},          // text/voice/photo/... → count
    by_chat_type: {},             // private/group/supergroup/channel → count
    by_language: {},              // ru/en/es/... → count of distinct users
    by_country_guess: {},         // RU/US/... → count of distinct users
    by_hour_utc: Array(24).fill(0),
    by_dow_utc: Array(7).fill(0), // 0 = Sunday
    by_day: {},                   // YYYY-MM-DD → events count (last 60 days kept)
    users_total: 0,
    users_premium: 0,
    users_active_7d: 0,           // computed lazily during read; refreshed on write
    users_active_30d: 0,
    subscribed: 0,                // tracked from my_chat_member
    unsubscribed: 0,
    payments_total_count: 0,
    payments_total_amount_by_currency: {}, // { XTR: 123, USD: 456 }
    last_event_at: null,
    last_user_id: null,
    users: {},                    // { tg_user_id: { first_seen_at, last_seen_at, language, is_premium, country_guess, events_count } }
  };
}

function loadSummary(projectName, draftsDir) {
  const p = paths(projectName, draftsDir);
  try {
    if (fs.existsSync(p.summary)) {
      const raw = JSON.parse(fs.readFileSync(p.summary, 'utf8'));
      // Forward-compat: ensure all fields exist
      const blank = emptySummary();
      return { ...blank, ...raw,
        by_type: { ...blank.by_type, ...(raw.by_type || {}) },
        by_message_type: { ...blank.by_message_type, ...(raw.by_message_type || {}) },
        by_chat_type: { ...blank.by_chat_type, ...(raw.by_chat_type || {}) },
        by_language: { ...blank.by_language, ...(raw.by_language || {}) },
        by_country_guess: { ...blank.by_country_guess, ...(raw.by_country_guess || {}) },
        by_hour_utc: raw.by_hour_utc || blank.by_hour_utc,
        by_dow_utc: raw.by_dow_utc || blank.by_dow_utc,
        by_day: raw.by_day || {},
        users: raw.users || {},
        payments_total_amount_by_currency: raw.payments_total_amount_by_currency || {},
      };
    }
  } catch (e) {
    console.error('[analytics:' + projectName + '] summary load failed:', e.message);
  }
  return emptySummary();
}

function saveSummary(projectName, draftsDir, summary) {
  const p = paths(projectName, draftsDir);
  const tmp = p.summary + '.tmp';
  try {
    fs.mkdirSync(p.base, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(summary));
    fs.renameSync(tmp, p.summary);
  } catch (e) {
    console.error('[analytics:' + projectName + '] summary save failed:', e.message);
  }
}

function rotateIfNeeded(projectName, draftsDir) {
  const p = paths(projectName, draftsDir);
  try {
    if (!fs.existsSync(p.log)) return;
    const stat = fs.statSync(p.log);
    if (stat.size < MAX_BYTES_BEFORE_ROTATE) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = path.join(p.base, `.analytics-archive-${ts}.jsonl`);
    fs.renameSync(p.log, archive);
    console.log('[analytics:' + projectName + '] rotated log → ' + archive);
  } catch (e) {
    console.error('[analytics:' + projectName + '] rotate failed:', e.message);
  }
}

// Extract message subtype from message object
function inferMessageType(msg) {
  if (!msg) return null;
  if (msg.text) return 'text';
  if (msg.photo) return 'photo';
  if (msg.video) return 'video';
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.document) return 'document';
  if (msg.sticker) return 'sticker';
  if (msg.animation) return 'animation';
  if (msg.video_note) return 'video_note';
  if (msg.location) return 'location';
  if (msg.contact) return 'contact';
  if (msg.poll) return 'poll';
  if (msg.dice) return 'dice';
  if (msg.story) return 'story';
  if (msg.successful_payment) return 'successful_payment';
  return 'other';
}

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
  if (upd.poll) return 'poll_update';
  if (upd.poll_answer) return 'poll_answer';
  if (upd.my_chat_member) return 'my_chat_member';
  if (upd.chat_member) return 'chat_member';
  if (upd.chat_join_request) return 'chat_join_request';
  return 'unknown';
}

// Build a compact event from a Telegram update
function buildEvent(upd) {
  const updateType = inferUpdateType(upd);
  const at = new Date().toISOString();
  const evt = {
    at,
    update_id: upd.update_id,
    type: updateType,
  };

  // Find the "from" user across update types
  const fromObj =
    upd.message?.from ||
    upd.edited_message?.from ||
    upd.callback_query?.from ||
    upd.inline_query?.from ||
    upd.chosen_inline_result?.from ||
    upd.shipping_query?.from ||
    upd.pre_checkout_query?.from ||
    upd.poll_answer?.user ||
    upd.my_chat_member?.from ||
    upd.chat_member?.from ||
    upd.chat_join_request?.from ||
    upd.channel_post?.from ||
    null;

  if (fromObj) {
    evt.user = {
      id: fromObj.id,
      username: fromObj.username || null,
      first_name: fromObj.first_name || null,
      last_name: fromObj.last_name || null,
      is_premium: !!fromObj.is_premium,
      is_bot: !!fromObj.is_bot,
      language_code: fromObj.language_code || null,
    };
    evt.country_guess = LANG_TO_COUNTRY_GUESS[fromObj.language_code] || null;
  }

  // Chat info
  const chatObj =
    upd.message?.chat ||
    upd.edited_message?.chat ||
    upd.callback_query?.message?.chat ||
    upd.channel_post?.chat ||
    upd.my_chat_member?.chat ||
    upd.chat_member?.chat ||
    upd.chat_join_request?.chat ||
    null;
  if (chatObj) {
    evt.chat = { id: chatObj.id, type: chatObj.type };
  }

  // Per-type details
  if (upd.message) {
    const m = upd.message;
    evt.message_type = inferMessageType(m);
    if (m.text) evt.text_length = m.text.length;
    if (m.caption) evt.caption_length = m.caption.length;
    if (m.forward_origin) evt.forward_origin_type = m.forward_origin.type;
    if (m.reply_to_message) evt.is_reply = true;
    if (m.entities && m.entities.length) {
      evt.entity_types = [...new Set(m.entities.map(e => e.type))];
    }
    if (m.via_bot) evt.via_bot = m.via_bot.username;
    if (m.successful_payment) {
      evt.payment = {
        amount: m.successful_payment.total_amount,
        currency: m.successful_payment.currency,
        payload: m.successful_payment.invoice_payload || null,
      };
    }
    // Detect /command
    if (m.text && m.text.startsWith('/')) {
      evt.command = m.text.split(/[\s@]/)[0].slice(0, 32).toLowerCase();
    }
  }
  if (upd.callback_query) {
    evt.callback_data = (upd.callback_query.data || '').slice(0, 128);
  }
  if (upd.inline_query) {
    evt.inline_query_length = (upd.inline_query.query || '').length;
  }
  if (upd.my_chat_member) {
    const newStatus = upd.my_chat_member.new_chat_member?.status;
    const oldStatus = upd.my_chat_member.old_chat_member?.status;
    evt.member_status = { from: oldStatus, to: newStatus };
  }
  if (upd.pre_checkout_query) {
    evt.pre_checkout = {
      amount: upd.pre_checkout_query.total_amount,
      currency: upd.pre_checkout_query.currency,
    };
  }

  return evt;
}

// Update aggregates from a single event
function applyEventToSummary(summary, evt) {
  summary.events_total++;
  summary.last_event_at = evt.at;

  summary.by_type[evt.type] = (summary.by_type[evt.type] || 0) + 1;

  if (evt.message_type) {
    summary.by_message_type[evt.message_type] = (summary.by_message_type[evt.message_type] || 0) + 1;
  }
  if (evt.chat?.type) {
    summary.by_chat_type[evt.chat.type] = (summary.by_chat_type[evt.chat.type] || 0) + 1;
  }

  // Time buckets (UTC)
  const d = new Date(evt.at);
  summary.by_hour_utc[d.getUTCHours()]++;
  summary.by_dow_utc[d.getUTCDay()]++;
  const dayKey = evt.at.slice(0, 10);
  summary.by_day[dayKey] = (summary.by_day[dayKey] || 0) + 1;

  // Cap by_day to last 60 days to avoid unbounded growth
  const dayKeys = Object.keys(summary.by_day).sort();
  if (dayKeys.length > 60) {
    for (const k of dayKeys.slice(0, dayKeys.length - 60)) delete summary.by_day[k];
  }

  // User tracking
  if (evt.user && !evt.user.is_bot) {
    summary.last_user_id = evt.user.id;
    const uid = String(evt.user.id);
    let u = summary.users[uid];
    if (!u) {
      u = {
        first_seen_at: evt.at,
        last_seen_at: evt.at,
        username: evt.user.username,
        first_name: evt.user.first_name,
        is_premium: evt.user.is_premium,
        language: evt.user.language_code,
        country_guess: evt.country_guess,
        events_count: 0,
        is_subscribed: null, // set by my_chat_member
      };
      summary.users[uid] = u;
      summary.users_total++;
      if (evt.user.is_premium) summary.users_premium++;
      if (evt.user.language_code) {
        summary.by_language[evt.user.language_code] = (summary.by_language[evt.user.language_code] || 0) + 1;
      }
      if (evt.country_guess) {
        summary.by_country_guess[evt.country_guess] = (summary.by_country_guess[evt.country_guess] || 0) + 1;
      }
    } else {
      // Update changing fields
      u.last_seen_at = evt.at;
      u.username = evt.user.username || u.username;
      u.first_name = evt.user.first_name || u.first_name;
      // Premium can switch off/on between sessions; track latest
      if (u.is_premium !== evt.user.is_premium) {
        if (evt.user.is_premium) summary.users_premium++;
        else summary.users_premium = Math.max(0, summary.users_premium - 1);
        u.is_premium = evt.user.is_premium;
      }
    }
    u.events_count++;

    // Cap users dict so summary file doesn't explode
    if (Object.keys(summary.users).length > MAX_USERS_IN_SUMMARY) {
      // Drop the oldest-last-seen entries
      const sorted = Object.entries(summary.users)
        .sort((a, b) => (a[1].last_seen_at || '').localeCompare(b[1].last_seen_at || ''));
      const drop = sorted.slice(0, sorted.length - MAX_USERS_IN_SUMMARY);
      for (const [id] of drop) delete summary.users[id];
    }
  }

  // my_chat_member → subscribe/unsubscribe tracking
  if (evt.type === 'my_chat_member' && evt.user) {
    const to = evt.member_status?.to;
    const uid = String(evt.user.id);
    const u = summary.users[uid];
    if (to === 'member' || to === 'creator' || to === 'administrator') {
      if (u && u.is_subscribed !== true) summary.subscribed++;
      if (u) u.is_subscribed = true;
    } else if (to === 'kicked' || to === 'left' || to === 'banned') {
      if (u && u.is_subscribed === true) summary.unsubscribed++;
      if (u) u.is_subscribed = false;
    }
  }

  // Payments
  if (evt.payment) {
    summary.payments_total_count++;
    const cur = evt.payment.currency;
    summary.payments_total_amount_by_currency[cur] =
      (summary.payments_total_amount_by_currency[cur] || 0) + (evt.payment.amount || 0);
  }

  summary.updated_at = evt.at;
}

// Recompute live DAU based on summary.users.last_seen_at — cheap (just iterates users)
function refreshLiveActivityCounts(summary) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  let dau7 = 0, dau30 = 0;
  for (const u of Object.values(summary.users)) {
    if (!u.last_seen_at) continue;
    const t = new Date(u.last_seen_at).getTime();
    if (now - t < 7 * day) dau7++;
    if (now - t < 30 * day) dau30++;
  }
  summary.users_active_7d = dau7;
  summary.users_active_30d = dau30;
}

// Append event to JSONL log + update summary
export function recordUpdate(projectName, draftsDir, upd) {
  try {
    const p = paths(projectName, draftsDir);
    fs.mkdirSync(p.base, { recursive: true });
    rotateIfNeeded(projectName, draftsDir);

    const evt = buildEvent(upd);

    // Append event line
    fs.appendFileSync(p.log, JSON.stringify(evt) + '\n');

    // Update summary
    const summary = loadSummary(projectName, draftsDir);
    applyEventToSummary(summary, evt);
    refreshLiveActivityCounts(summary);
    saveSummary(projectName, draftsDir, summary);
  } catch (e) {
    console.error('[analytics:' + projectName + '] recordUpdate failed:', e.message);
  }
}

// Daily snapshot — call from a midnight UTC timer
export function takeDailySnapshot(projectName, draftsDir) {
  try {
    const p = paths(projectName, draftsDir);
    if (!fs.existsSync(p.summary)) return;
    fs.mkdirSync(p.dailyDir, { recursive: true });
    const summary = JSON.parse(fs.readFileSync(p.summary, 'utf8'));
    refreshLiveActivityCounts(summary);
    const dateKey = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(p.dailyDir, dateKey + '.json'), JSON.stringify(summary));
  } catch (e) {
    console.error('[analytics:' + projectName + '] daily snapshot failed:', e.message);
  }
}

// Read the summary for the WebApp dashboard (with live DAU recomputed)
export function getSummary(projectName, draftsDir) {
  const summary = loadSummary(projectName, draftsDir);
  refreshLiveActivityCounts(summary);
  // Return a trimmed version — drop full users dict, keep only top N samples
  const topLanguages = Object.entries(summary.by_language)
    .sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_N);
  const topCountries = Object.entries(summary.by_country_guess)
    .sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_N);
  return {
    events_total: summary.events_total,
    users_total: summary.users_total,
    users_premium: summary.users_premium,
    premium_pct: summary.users_total > 0 ? Math.round((summary.users_premium / summary.users_total) * 100) : 0,
    users_active_7d: summary.users_active_7d,
    users_active_30d: summary.users_active_30d,
    subscribed: summary.subscribed,
    unsubscribed: summary.unsubscribed,
    payments_total_count: summary.payments_total_count,
    payments_total_amount_by_currency: summary.payments_total_amount_by_currency,
    by_type: summary.by_type,
    by_message_type: summary.by_message_type,
    by_chat_type: summary.by_chat_type,
    top_languages: topLanguages,
    top_countries: topCountries,
    by_hour_utc: summary.by_hour_utc,
    by_dow_utc: summary.by_dow_utc,
    by_day: summary.by_day,
    last_event_at: summary.last_event_at,
    updated_at: summary.updated_at,
    created_at: summary.created_at,
  };
}

// Stream the JSONL file as plain text
export function getLogStream(projectName, draftsDir) {
  const p = paths(projectName, draftsDir);
  if (!fs.existsSync(p.log)) return null;
  return fs.createReadStream(p.log);
}

export function getLogStats(projectName, draftsDir) {
  const p = paths(projectName, draftsDir);
  if (!fs.existsSync(p.log)) return { exists: false };
  const stat = fs.statSync(p.log);
  return { exists: true, size_bytes: stat.size, mtime: stat.mtime.toISOString() };
}

export function getSummaryRaw(projectName, draftsDir) {
  const p = paths(projectName, draftsDir);
  if (!fs.existsSync(p.summary)) return null;
  return fs.createReadStream(p.summary);
}

// List archived logs (after rotation)
export function listArchives(projectName, draftsDir) {
  const p = paths(projectName, draftsDir);
  if (!fs.existsSync(p.base)) return [];
  return fs.readdirSync(p.base)
    .filter(f => f.startsWith('.analytics-archive-') && f.endsWith('.jsonl'))
    .map(f => {
      const full = path.join(p.base, f);
      const st = fs.statSync(full);
      return { name: f, size_bytes: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function getArchiveStream(projectName, draftsDir, archiveName) {
  if (!/^\.analytics-archive-[A-Za-z0-9-]+\.jsonl$/.test(archiveName)) return null;
  const p = paths(projectName, draftsDir);
  const full = path.join(p.base, archiveName);
  if (!fs.existsSync(full)) return null;
  return fs.createReadStream(full);
}

// Wipe analytics — owner-initiated reset
export function wipeAnalytics(projectName, draftsDir) {
  const p = paths(projectName, draftsDir);
  let removed = [];
  try {
    if (fs.existsSync(p.log)) { fs.unlinkSync(p.log); removed.push('log'); }
    if (fs.existsSync(p.summary)) { fs.unlinkSync(p.summary); removed.push('summary'); }
    if (fs.existsSync(p.dailyDir)) {
      for (const f of fs.readdirSync(p.dailyDir)) fs.unlinkSync(path.join(p.dailyDir, f));
      fs.rmdirSync(p.dailyDir);
      removed.push('daily');
    }
    // Archives kept by default — separate wipe-archives flag if needed later
  } catch (e) {
    console.error('[analytics:' + projectName + '] wipe failed:', e.message);
  }
  return { removed };
}

// Init: schedule a midnight-UTC daily snapshot for all bots in state
let dailyTimer = null;
export function startDailySnapshotScheduler(getDraftsState, draftsDir) {
  if (dailyTimer) clearInterval(dailyTimer);
  // Every 60 minutes: check if we're in the first hour of UTC day; if so, snapshot once
  let lastSnapshotDay = null;
  dailyTimer = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== 0) return;
    if (day === lastSnapshotDay) return;
    lastSnapshotDay = day;
    const state = getDraftsState();
    let n = 0;
    for (const p of state.projects) {
      if (p.bot && p.bot.token) {
        takeDailySnapshot(p.name, draftsDir);
        n++;
      }
    }
    if (n > 0) console.log(`[analytics] daily snapshot taken for ${n} project(s) — ${day}`);
  }, 60 * 60 * 1000); // every hour
}

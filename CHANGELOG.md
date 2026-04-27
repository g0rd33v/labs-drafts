# Changelog

All notable changes to the drafts protocol and reference implementation.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [SemVer](https://semver.org/).

## [1.0.0] — 2026-04-27

### Reference implementation

- **`runtime` capability shipped — per-project Telegram bot runtime.** Projects can now drop a `bot.js` into their `live/` folder and drafts executes it in a sandboxed Node `vm` context for every Telegram update routed to that project's bot. This is the v2.0-roadmapped `runtime` capability, brought forward to v1.0 of the reference implementation. The protocol document still lists `runtime` as v2+; the reference is ahead of the spec on this point until §5.1 is reconciled.
  - **Entrypoint:** `bot.js` at project live root, ESM `export default async function handler(update, ctx)` plus optional named exports for cron handlers.
  - **`ctx.kv`** — per-project SQLite-backed key-value store at `/var/lib/drafts/<project>/runtime/kv.sqlite` (WAL mode). API: `get(k)`, `set(k, v, {ttl?})`, `del(k)`, `list(prefix)`, `incr(k)`. Limits: 10 MiB/project, 1 MiB/value, 512 char/key. Lazy TTL expiry on read.
  - **`ctx.send`** — Telegram Bot API helper. Methods: `message(chat_id, text, opts)`, `editMessage(chat_id, message_id, text, opts)`, `answerCallback(callback_query_id, text?)`, `api(method, params)`. Token captured in closure via getter — never reaches user code.
  - **`ctx.log(line)`** — writes to a per-project ring buffer (1000 lines). Readable via `GET /drafts/project/bot/logs?limit=N` (PAP or SAP).
  - **Cron handlers** — `cron.json` schedules now invoke named exports of `bot.js` directly when present (no webhook round-trip). Falls back to webhook POST when `bot.js` is absent.
  - **Sandbox** — Node `vm.createContext` with whitelisted globals: `URL`, `fetch`, `Headers`, `JSON`, `Math`, `Date`, `Map`, `Set`, `Promise`, `Buffer`, `console` (proxied to logger), `crypto.randomUUID`, `setTimeout`, `clearTimeout`. NO `fs`, `child_process`, `net`, `http`, `process`, `require`, dynamic `import`. Each invocation is wrapped in `Promise.race` with a 5-second wall-clock timeout. **First-pass sandbox; not isolated-vm.** Stops accidents and casual probes. Hardening to isolated-vm queued for v1.1.
  - **Hot reload** — `bot.js` is re-evaluated when its mtime changes. No restart required.
  - **Dispatch order:** `bot.js` (if present and importable) → `bot.json` (templated commands) → fallback no-op.
- **`/drafts/health` and machine JSON** now declare `runtime_capability: true` and add `"runtime"` to the `capabilities` array per SPEC §5.1.
- **New endpoint:** `GET /drafts/project/bot/logs?limit=<n>&project=<name>` (SAP) or with PAP. Returns `{ok, project, lines:[{at,level,line}], present, has_module, import_error, bot_js_mtime}`.
- **New endpoint:** `DELETE /drafts/project/bot/logs?project=<name>` clears the ring buffer.
- **`better-sqlite3@^12`** added as runtime dependency. Native bindings build on `npm install`; ARM64 (Graviton3) and x86_64 both pre-built.
- **`cron.json` schema unchanged** from v0.9.6: `[{schedule:"*/N * * * *"|"* * * * *", handler:"<name>"}]`. Schedules align to wall-clock minute boundary on startup.

### Protocol drift note

SPEC.md §5.1 still lists `runtime` as `reserved, v2+`. The reference implementation now implements it. Operators of conformant servers MAY ship `runtime` early following the surface documented here; full protocol-level codification is queued for drafts/0.3 alongside the §3 reconciliation already noted in 0.2.1.

## [0.9.6] — 2026-04-27

### Reference implementation

- **`cron.json` minute scheduler** for webhook-mode project bots. Drop `[{"schedule":"*/1 * * * *","handler":"tick"}]` in `live/`, drafts POSTs `{drafts_cron:<handler>, ts}` to the project's `webhook_url` once per matching minute, with header `X-Drafts-Cron-Handler: <handler>`. Schedules supported: `"* * * * *"` and `"*/N * * * *"` (1 ≤ N ≤ 59). Wall-clock-aligned.
- Cache busted on `POST /drafts/project/bot/sync` and `unlink`.

## [0.2.1] — 2026-04-25

### Reference implementation

- **One-command installer** (`install.sh`) — fresh Ubuntu 22.04+ VPS to a working drafts server in ~3 minutes. Installs nginx, certbot, Node.js 20, pm2, configures all of it, issues HTTPS, prints the SAP token once.
- **GitHub config via runtime API** — replaced env-only `GITHUB_USER`/`GITHUB_TOKEN` with two new endpoint pairs:
  - `GET/PUT/DELETE /drafts/config/github` — server-default config (SAP only)
  - `GET/PUT/DELETE /drafts/projects/:name/config/github` — per-project override (PAP or SAP)
  - Sync resolves config in order: project override → server default → env fallback
- **SAP auto-mints on first run** if no `BEARER_TOKEN` env var is set. Token is saved to `/etc/labs/drafts.sap` (mode 0600) and printed to stdout once.
- **Filename rename:** `app.js` → `drafts.js`. The published file name now matches the protocol name.
- **Server registry endpoint removed** — `GET /drafts/registry.json` no longer exists. The federation registry lives at [`drafts-registry.json`](drafts-registry.json) in this repository, served via GitHub raw.
- **Configurable paths** — `DRAFTS_DIR` defaults to `/var/lib/drafts` (was hardcoded `/var/www/beta.labs.vc/drafts`); env file searched at `/etc/labs/drafts.env`, `./drafts.env`, then legacy `/opt/drafts-receiver/.env`.
- **Server number embedded in welcome URLs** — all minted URLs now use `${SERVER_NUMBER}` instead of hardcoded `0`. Server number is local-only; claim a federation number via PR.
- **Welcome banner cleaned** — startup logs print as `drafts v0.2`, dropping the legacy `drafts-receiver v2.0` framing.

### Documentation (post-installer sweep)

- **`REFERENCE_IMPLEMENTATION.md`** — updated to drafts.js + pm2; dropped stale Redis claim; documented new GitHub-config-via-API surface.
- **`docs/PROTOCOL.md`** — registry now points at GitHub-hosted file (per-server endpoint removed); documented server `0` as both reference and local-default.
- **`docs/SPEC.md`** — §6.1 federation registry rewritten for GitHub hosting; new §3.7 documents GitHub-config-via-API; §1, §6.2 document server `0` dual purpose; §8.1 upgrade-path notes the registry endpoint removal; editorial note added at top describing the §3 implementation drift to be reconciled in 0.3.
- **`docs/REGISTRY.md`** — full rewrite for the GitHub-hosted registry flow, drafts/0.2, current install path, server `0` semantics.

### Known divergence (not blocking)

The reference implementation `drafts.js` does not yet match the API surface that SPEC.md §3 describes (`POST /drafts/upload` with `filename` body vs spec'd `PUT /drafts/api/files/<project>/<path>`; no `POST /drafts/api/rotate` endpoint exists yet). Third parties building against drafts/0.2 today should treat the reference implementation's welcome-page machine JSON as the source of truth for endpoint paths. Reconciliation is queued for 0.3 — either by aligning the reference to the spec, or by updating §3 to match what ships.

## [0.2] — 2026-04-24

### Protocol (breaking)

- Token lengths shortened to 16/12/10 hex (server/project/agent) — previously 64/48/48
- Canonical welcome URL is now `/drafts/pass/<portable_token>` accepting the full `drafts_<tier>_<n>_<secret>` form as a path segment
- Token tier words changed from `sap`/`pap`/`aap` to `server`/`project`/`agent` (human-readable)
- Machine JSON now carries `protocol` and `protocol_version` fields
- Registry schema adds `capabilities` and `pricing` fields per server

### Protocol (additive)

- `POST /drafts/api/merge/<project>` — merge agent branch into main
- `POST /drafts/api/rotate` — rotate compromised pass
- Capability vocabulary introduced (§5.1 of SPEC): static, media, git, github-sync, plus reserved sql, vector, runtime, llm, gpu, video-gen
- Recommended per-IP rate limits on `/drafts/pass/*` (30/min, 100/day) and `/drafts/api/*` (60/min) in addition to per-token limits
- Design thesis (§0 of SPEC): quantized 7B local model as conformance target

### Documentation

- [POSITIONING.md](docs/POSITIONING.md) — where drafts fits vs Bolt, Vercel, E2B, Val.town; defensibility analysis
- [ROADMAP.md](docs/ROADMAP.md) — versions 1.0, 1.1, 2.0, plus capability-as-credential and skills-marketplace research tracks

### Reference implementation

- GitHub bidirectional mirror for projects opting in (post-commit autopush + 5-min cron pull-back)
- Rich welcome pages with inline SVG, capability cards, project state (git history, branches, contributors)
- Legacy URL formats removed (`/s/<token>`, `/p/<token>`, `/a/<token>`, `drafts_0_<token>`, `drafts_sap_0_`, etc.)
- Unified landing at `beta.labs.vc/` lists all projects on the reference server with site/github/telegram link vocabulary

### Upgrade path

0.2 is NOT wire-compatible with 0.1. See [SPEC.md §8.1](docs/SPEC.md). 0.1 servers SHOULD migrate within 90 days.

---

## [0.1] — 2026-04-23

Initial experimental release.

### Protocol

- Three-tier access model (server / project / agent)
- Portable token format
- Canonical welcome URL namespace
- Minimal HTTP API (create project, write file, promote)
- Federated registry with integer server IDs
- Machine-readable JSON embedded in welcome pages

### Reference implementation

- Node.js / Express receiver
- nginx reverse proxy with Let's Encrypt TLS
- Redis rate limiting per token
- Per-project git history with atomic promote
- Optional GitHub mirror sync

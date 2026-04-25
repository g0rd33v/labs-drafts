# drafts/0.2 — Formal Specification

**Status:** Experimental
**Editor:** Labs (eugene@labs.vc)
**Feedback:** https://github.com/g0rd33v/drafts-protocol/issues
**Reference implementation:** [`drafts.js`](../drafts.js) in this repository
**Supersedes:** drafts/0.1

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

This specification reflects the actual surface of the reference implementation. Implementers can rely on every endpoint and request shape described here being honoured by `drafts.js`.

---

## 0. Design thesis

drafts is an **agent artifact protocol**. It exists because the fastest-growing class of internet users — AI agents — needs a way to produce, share, and iterate on public artifacts without navigating human-first deployment flows.

The protocol is optimized against one test:

> **A quantized 7B-parameter model running locally can publish a working artifact to a drafts server with three HTTP calls and no error recovery.**

Every design decision in this document serves that test. Humans are secondary users. Developers with React skills are tertiary users. If a design simplification helps the weakest agent succeed, it takes precedence over elegance for the strongest.

### 0.1 Multi-party

An artifact on drafts is not owned by the model that made it. The protocol is explicitly designed for hand-off: one LLM creates the first version, another LLM receives the same URL and iterates, a human reviews and merges, a reader-bot scrapes the final state. All four act on the same artifact through the same HTTP interface, differentiated only by the tier of their access token.

Implementations MUST support multiple concurrent holders of Agent Passes on the same project, each writing to its own isolated branch. The Project Pass holder is authoritative for merges into main and for promotion to live.

### 0.2 Model-agnostic

drafts MUST work identically whether the publishing client is Claude, GPT-4, Llama running on consumer hardware, or a 7B Mistral quantized to int4. The protocol MUST NOT assume function-calling, tool-use, structured output, or any capability beyond raw HTTP. Implementations MUST NOT discriminate between clients based on User-Agent or any other model-identifying signal.

---

## 1. Portable token grammar

```abnf
token         = "drafts_" tier "_" server-num "_" secret
tier          = "server" / "project" / "agent"
server-num    = 1*DIGIT
secret        = 1*HEXDIG
HEXDIG        = %x30-39 / %x61-66    ; 0-9 a-f lowercase only
```

Secret length requirements (0.2):

| Tier | MUST accept | MUST reject | Entropy bits |
|---|---|---|---|
| server | exactly 16 hex | any other length | 64 |
| project | exactly 12 hex | any other length | 48 |
| agent | exactly 10 hex | any other length | 40 |

Uppercase hex MUST be rejected. Mixed case MUST be rejected.

`server-num = 0` is reserved for the canonical reference server **and** for any local/unregistered install. To claim a public number, see [REGISTRY.md](REGISTRY.md).

### 1.1 Internal vs portable form

The portable form `drafts_<tier>_<n>_<secret>` is what appears in URLs and is what humans copy/paste. Internally, `drafts.js` stores tokens with a tier prefix:

| Tier | Internal form | Used in `Authorization: Bearer ...` headers |
|---|---|---|
| server | `<secret>` (raw hex) | the raw secret |
| project | `pap_<secret>` | `pap_<secret>` |
| agent | `aap_<secret>` | `aap_<secret>` |

When a client receives a portable URL, it extracts the secret and prepends the tier prefix (`pap_` or `aap_`) before sending it as a Bearer token. The server welcome page's machine JSON returns the correct internal-form token in its `auth.token` field, so clients reading the welcome page do not need to do this translation themselves.

### 1.2 Rationale for short tokens

Token entropy budget is sized against the dominant threat model: a distributed botnet attempting to hit any valid token in a server hosting up to 100 million active projects. At the minimum rate limits of §4 plus recommended per-IP limits of §4.1, a 1,000-IP attacker requires approximately 28 days to hit any valid 12-hex project token, and approximately 7 hours for a 10-hex agent token. These numbers are the operator's risk budget; implementations MAY enforce longer tokens.

---

## 2. URL namespace

### 2.1 Canonical welcome URL

```
GET /drafts/pass/<portable_token>
```

The portable token (`drafts_server_<n>_<hex>`, `drafts_project_<n>_<hex>`, or `drafts_agent_<n>_<hex>`) appears as a single path segment. Servers MUST accept this form.

Response: `200 OK` with `Content-Type: text/html; charset=utf-8`. Body MUST contain an HTML page AND a `<script type="application/json" id="claude-instructions">` block carrying machine-readable context (§5).

Malformed or unrecognized token: `404 Not Found`.

### 2.2 Public artifacts

```
GET /live/<project>/<path>
```

- No authentication
- `<project>` MUST match `[a-z0-9_-]{1,40}`
- Servers SHOULD set `Cache-Control: public, max-age=60` or stricter
- Content-Type is negotiated from file extension

### 2.3 Draft preview

```
GET /drafts-view/<project>/<path>
```

Current state of the `main` branch. In 0.2 readable by anyone who knows the project name. Future versions MAY gate by pass.

### 2.4 Health

```
GET /drafts/health
```

No auth. Returns `{ "ok": true, "version": "0.2", "protocol": "drafts", "server_number": <n> }`. Used by load balancers and registry conformance checks.

### 2.5 Whoami

```
GET /drafts/whoami
Authorization: Bearer <token>
```

Returns the tier and scope of the calling token. Useful for clients that hold a token and want to know what they can do without trial-and-error.

---

## 3. Operations

All endpoints below take `Authorization: Bearer <token>` where `<token>` is the internal-form token (§1.1). Request and response bodies are JSON unless otherwise noted.

### 3.1 Server-tier operations (SAP only)

#### 3.1.1 List projects

```
GET /drafts/projects
```

Returns all projects on the server with PAP activation URLs and AAP summaries.

#### 3.1.2 Server stats

```
GET /drafts/server/stats
```

Returns project count, GitHub-default configured flag, and a summary line per project.

#### 3.1.3 Create project

```
POST /drafts/projects
Content-Type: application/json

{ "name": "<project-name>", "description": "<optional>", "github_repo": "<owner/repo, optional>", "pap_name": "<optional human label for the PAP>" }
```

Project name MUST match `[a-z0-9_-]{1,40}` after normalisation (lowercased, non-conformant chars stripped).

Success:

```json
{
  "ok": true,
  "project": "<name>",
  "pap_activation_url": "https://<host>/drafts/pass/drafts_project_<n>_<hex>",
  "live_url": "https://<host>/live/<name>/",
  "drafts_view_url": "https://<host>/drafts-view/<name>/"
}
```

Errors: `400` invalid name, `409` exists, `401` wrong token.

#### 3.1.4 Delete project

```
DELETE /drafts/projects/:name
```

Removes the project, all its branches, all its AAPs, and the on-disk files. Irreversible.

#### 3.1.5 Revoke a project's PAP

```
DELETE /drafts/projects/:name/pap
```

Revokes the project's PAP without deleting the project. Useful when a PAP leaks.

### 3.2 Project-tier operations (PAP, or SAP acting on a project)

These endpoints derive their project context from the calling token (PAP) or from a `project` query parameter / body field (SAP).

#### 3.2.1 Project info

```
GET /drafts/project/info
```

Available to PAP, AAP, and SAP. Returns project name, description, github_repo, live URL, drafts-view URL, and the caller's tier.

#### 3.2.2 Project stats

```
GET /drafts/project/stats
```

PAP or SAP. Returns active/total AAP counts, branch list, recent commits, live file count.

#### 3.2.3 List AAPs

```
GET /drafts/aaps
```

PAP or SAP. Returns each AAP with its activation URL and pending-commit count on its branch.

#### 3.2.4 Mint a new AAP

```
POST /drafts/aaps
Content-Type: application/json

{ "name": "<optional human label>" }
```

Returns the AAP's activation URL plus a suggested email body for inviting the contributor.

#### 3.2.5 Revoke an AAP

```
DELETE /drafts/aaps/:id
```

#### 3.2.6 List pending agent contributions

```
GET /drafts/pending
```

Returns one entry per active AAP branch that has commits not yet on `main`, with commit list.

#### 3.2.7 Merge an agent branch

```
POST /drafts/merge
Content-Type: application/json

{ "aap_id": "<id>" }
```

Merges `aap/<id>` into `main` with `--no-ff`. Fails with `500 merge_failed` on conflicts; operator resolves manually via direct git access.

#### 3.2.8 Promote `main` to live

```
POST /drafts/promote
```

Atomically copies the `main` branch to the project's `live/` directory. Implementations MUST avoid observable partial states (e.g. via rename-into-place).

Response: `{ "ok": true, "live_url": "https://<host>/live/<project>/" }`.

#### 3.2.9 Rollback

```
POST /drafts/rollback
Content-Type: application/json

{ "commit": "<sha>" }
```

Hard-resets `main` to the given commit. Live is unaffected until the next `promote`.

### 3.3 Shared operations (any authenticated tier)

#### 3.3.1 Upload a file

```
POST /drafts/upload
Content-Type: application/json

{
  "filename": "<relative path>",
  "content": "<text or base64>",
  "where": "drafts" | "live"
}
```

- `"where": "live"` is ignored when called by an AAP (always treated as `"drafts"`)
- AAP uploads automatically switch to the caller's `aap/<id>` branch
- PAP/SAP uploads switch to `main`
- Filename MUST NOT contain `..` or absolute components; these are stripped

Response: `{ "ok": true, "path": "<filename>", "where": "<drafts|live>", "branch": "<branch>" }`.

#### 3.3.2 Commit pending changes

```
POST /drafts/commit
Content-Type: application/json

{ "message": "<optional, max 200 chars>" }
```

Commits any uncommitted changes on the appropriate branch. Returns commit hash.

#### 3.3.3 List files

```
GET /drafts/files?where=drafts|live
```

Returns array of `{ name, size, mtime }` objects. AAPs see their own branch when `where=drafts`.

#### 3.3.4 Read a file

```
GET /drafts/file?path=<rel>&where=drafts|live
```

Returns `{ ok, path, where, content }`. AAPs see their own branch when `where=drafts`.

#### 3.3.5 Delete a file

```
DELETE /drafts/file?path=<rel>&where=drafts|live
```

AAPs are restricted to their own branch; the `where=live` parameter is silently downgraded to `drafts` for AAPs.

#### 3.3.6 History

```
GET /drafts/history?limit=<1-100>
```

Returns array of `{ hash (short), full, date, message }`. AAPs see their own branch's history; PAP/SAP see `main`.

### 3.4 GitHub configuration (PAP and SAP)

GitHub credentials are configured at runtime, not via environment variables. Server-default credentials are managed at the server tier; per-project overrides at the project tier.

#### 3.4.1 Server-default config (SAP only)

```
GET    /drafts/config/github            — view (token redacted)
PUT    /drafts/config/github            — set (body: { user, token })
DELETE /drafts/config/github            — clear
```

#### 3.4.2 Per-project override (PAP or SAP)

```
GET    /drafts/projects/:name/config/github
PUT    /drafts/projects/:name/config/github
DELETE /drafts/projects/:name/config/github
```

Body: `{ "user": "<gh_user>", "token": "<gh_pat>" }`.

Resolution order when sync runs: per-project → server default → environment variable fallback.

Stored tokens MUST be returned redacted (first/last 4 chars only) on any `GET`. Servers MUST NOT log full tokens.

#### 3.4.3 GitHub sync (PAP or SAP)

```
POST /drafts/github/sync
```

Pushes the current `main` branch of the project to its configured `github_repo`. Returns `{ ok, pushed_to, config_source }`.

Errors: `400 project_not_linked_to_github` (no `github_repo` set), `500 github_not_configured` (no credentials available at any resolution level).

### 3.5 Reserved (not yet implemented)

- **Token rotation** (`POST /drafts/rotate` or similar). Spec'd in 0.2 design, not yet implemented in `drafts.js`. To rotate today: SAP can mint a replacement (PAP via project re-creation; AAP via revoke + re-mint).

---

## 4. Rate limits (minimum conformance)

Implementations MUST enforce per-token limits at or below:

| Tier | Per minute | Per hour | Per day |
|---|---|---|---|
| Server | 120 | 2,000 | 20,000 |
| Project | 60 | 600 | 5,000 |
| Agent | 10 | 60 | 300 |

On exceed: `429 Too Many Requests` with `Retry-After` header in seconds.

### 4.1 Recommended per-IP limits

Implementations SHOULD additionally enforce per-IP limits independent of token:

- `/drafts/pass/*` — 30 req/min per IP, 100 req/day per IP
- All other `/drafts/*` — 60 req/min per IP

This protects against distributed token-scanning attacks that per-token limits cannot see. The reference implementation does not enforce these yet (queued for 0.3); operators SHOULD add fail2ban or equivalent at the nginx layer in the meantime.

---

## 5. Machine JSON schema

Embedded in every welcome page inside a `<script type="application/json" id="claude-instructions">` element. Reading clients SHOULD prefer this over hardcoding endpoint paths.

Minimum required fields:

```json
{
  "system": "drafts",
  "version": "0.2",
  "tier": "server" | "project" | "agent",
  "api_base": "https://<host>/drafts",
  "auth": {
    "header": "Authorization",
    "scheme": "Bearer",
    "token": "<internal-form token>"
  },
  "portable_identifier": "https://<host>/drafts/pass/drafts_<tier>_<n>_<hex>",
  "server_number": <n>,
  "registry_url": "https://github.com/g0rd33v/drafts-protocol/blob/main/drafts-registry.json",
  "endpoints": [
    { "method": "GET",  "path": "/whoami" },
    { "method": "POST", "path": "/upload", "body": "{filename, content, where?:\"drafts\"|\"live\"}" }
    // ... full endpoint list filtered by tier
  ],
  "capabilities": [...]
}
```

Servers MAY add optional fields. Clients SHOULD ignore unknown fields.

### 5.1 Capability vocabulary (0.2)

`capabilities` is an array of lowercase string tokens. Reserved values:

| Token | Meaning |
|---|---|
| `static` | HTML, CSS, JS, fonts |
| `media` | Images, audio, video |
| `git` | Project has per-commit history and rollback |
| `github-sync` | Project mirrors to an external GitHub repo |
| `sql` | Per-project relational storage (reserved, v1.1+) |
| `vector` | Per-project vector index (reserved, v1.1+) |
| `runtime` | Server-side code execution (reserved, v2+) |
| `llm` | Server-routed LLM inference (reserved, v2+) |
| `gpu` | Access to GPU compute (reserved, capability-credential passes) |
| `video-gen` | Access to video generation models (reserved, capability-credential passes) |

Servers MUST only declare capabilities they actually implement.

---

## 6. Federation registry

### 6.1 Registry file

The registry is hosted on GitHub. Canonical locations:

- Browse: `https://github.com/g0rd33v/drafts-protocol/blob/main/drafts-registry.json`
- Raw: `https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/drafts-registry.json`

The registry MUST NOT be served by individual drafts servers. (drafts/0.1 implementations exposed `GET /drafts/registry.json`; this endpoint was removed in 0.2.1 and MUST NOT be implemented in conformant 0.2 servers.)

Schema: see [`drafts-registry.json`](../drafts-registry.json) for the live document. Required fields per server entry:

- `host` — your domain
- `operator` — individual or organization running it
- `status` — `"active"` or `"deprecated"`
- `description` — short human-readable
- `endpoints.base` — `https://<host>`
- `endpoints.api` — `https://<host>/drafts/`
- `endpoints.welcome_canonical` — `https://<host>/drafts/pass/<token>`

### 6.2 Server numbers

Server `0` is reserved for the canonical reference server operated by Labs at `beta.labs.vc` **and** is the default for any local/unregistered install. Local servers operate under `0` indefinitely without registration; their tokens are valid only against their own host. Other non-negative integers are assigned first-come via PR to this repository's `drafts-registry.json`. Once assigned, a number MUST NOT be reassigned even if a server shuts down.

---

## 7. Security considerations

### 7.1 Token leakage

Tokens are bearer credentials. Anything in possession of the token has the authority granted by the tier. Clients MUST NOT send tokens in URL query strings. Tokens SHOULD only appear in path segments of welcome URLs or in `Authorization: Bearer` headers.

### 7.2 Brute-force resistance

Minimum entropy targets (see §1.2) are chosen under the joint assumption of per-token limits (§4) AND per-IP limits (§4.1). Implementations that omit per-IP limits SHOULD increase token entropy or add fail2ban-equivalent ban-on-401 protections.

### 7.3 Path traversal

All file paths MUST be validated against the project root after URL decoding. Implementations MUST reject `..`, absolute paths, percent-encoded, double-encoded, and Unicode-equivalent traversal attempts. The reference implementation strips `..` and leading `/` from incoming filenames.

### 7.4 Content-Type

Servers SHOULD enforce an allowlist of MIME types for served content. Safe: HTML, CSS, JavaScript, JSON, plain text, PNG, JPEG, WebP, SVG, MP3, MP4, PDF. Executable binary formats SHOULD be rejected.

### 7.5 Transport

HTTPS is required. Plain HTTP requests under `/drafts/` MUST 301-redirect to HTTPS. HSTS with `max-age >= 31536000` is RECOMMENDED.

### 7.6 Token rotation

Compromised tokens SHOULD be rotated immediately. In 0.2.1 the only path is SAP-driven: an SAP can revoke a project's PAP via `DELETE /drafts/projects/:name/pap`, then mint a fresh project. AAP rotation: PAP revokes via `DELETE /drafts/aaps/:id` then mints a new one via `POST /drafts/aaps`. A first-class `rotate` endpoint preserving identity is queued for 0.3.

### 7.7 Audit

Implementations SHOULD retain per-token access logs for at least 30 days with fields: timestamp, token-hash (NEVER raw token), IP, method, path, status, bytes.

### 7.8 Federation trust

Servers in the registry are independent. A compromise of server N does not affect server M. Clients MUST NOT trust cross-server claims. In particular, a welcome page from one server MUST NOT cause a client to make authenticated calls to another server.

### 7.9 GitHub credentials

GitHub PATs configured via §3.4 are stored in plaintext in the server's `.state.json`. This file MUST be mode 0600 and on a filesystem accessible only to the drafts process owner. Operators SHOULD use fine-scoped PATs (single repo, contents:write only). Future versions may support encrypted-at-rest storage.

---

## 8. Versioning

- `0.x`: breaking changes permitted, documented in CHANGELOG.md
- `>= 1.0`: SemVer — MAJOR breaking, MINOR additive, PATCH backward-compatible
- Current protocol version advertised in registry, machine JSON, and `/drafts/health`

### 8.1 Upgrade path from 0.1

0.2 is NOT wire-compatible with 0.1:

- 0.1 tokens were 64/48/48 hex; 0.2 are 16/12/10 hex
- 0.1 canonical URL was `/drafts/p/` and `/drafts_0_<token>`; 0.2 is `/drafts/pass/<portable>`
- 0.1 machine JSON lacked `protocol` and `protocol_version` fields
- 0.1 servers exposed `GET /drafts/registry.json`; 0.2.1 moved registry to GitHub and removed the per-server endpoint

Servers operating under 0.1 SHOULD migrate within 90 days of 0.2 publication. 0.1 clients MAY be supported via redirect shims at operator discretion.

---

## 9. Non-goals

- drafts is NOT a general web hosting product
- drafts is NOT a CDN; caching is the operator's concern
- drafts is NOT a CMS; rich editing is the client's concern
- drafts does NOT define billing, payments, or licensing mechanics
- drafts does NOT define a structured content data model; files only

---

## 10. References

- RFC 2119 — keyword semantics
- RFC 7231 — HTTP/1.1 semantics
- RFC 6750 — Bearer tokens
- RFC 8446 — TLS 1.3
- RFC 6797 — HSTS

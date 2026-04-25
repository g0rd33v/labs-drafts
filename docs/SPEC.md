# drafts/0.2 — Formal Specification

**Status:** Experimental
**Editor:** Labs (eugene@labs.vc)
**Feedback:** https://github.com/g0rd33v/drafts-protocol/issues
**Supersedes:** drafts/0.1

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

> **Editorial note (v0.2.1):** Sections §3.1–§3.6 describe the protocol surface as designed. The current reference implementation (`drafts.js` in this repository) ships an alternative request shape for several operations (`POST /drafts/upload` with `filename` in body instead of `PUT /drafts/api/files/<project>/<path>`, etc.) and does not yet implement `POST /drafts/api/rotate`. This will be reconciled in 0.3 — either by aligning the reference implementation to this spec, or by updating §3 to match the implemented surface. Third parties building against drafts/0.2 today should use the operations shipped by the reference implementation (`drafts.js`); the welcome page's machine JSON is the source of truth for endpoint paths.

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

### 1.1 Rationale for short tokens

Token entropy budget is sized against the dominant threat model: a distributed botnet attempting to hit any valid token in a server hosting up to 100 million active projects. At the minimum rate limits of §4 plus recommended per-IP limits of §7.2, a 1,000-IP attacker requires approximately 28 days to hit any valid 12-hex project token, and approximately 7 hours for a 10-hex agent token. These numbers are the operator's risk budget; implementations MAY enforce longer tokens and SHOULD rotate compromised tokens immediately (§7.6).

---

## 2. URL namespace

### 2.1 Canonical welcome URL

```
GET /drafts/pass/<portable_token>
```

The portable token appears as a single path segment in URL-encoded form. Servers MUST accept the full portable form and MUST NOT require the secret alone.

Response: `200 OK` with `Content-Type: text/html; charset=utf-8`. Body MUST contain an HTML page AND a `<script type="application/json" id="drafts-machine-context">` block with the schema of §5.

Malformed or unrecognized token: `404 Not Found`.

### 2.2 Public artifacts

```
GET /live/<project>/<path>
```

- No authentication
- `<project>` MUST match `[a-z][a-z0-9-]{0,62}`
- Servers SHOULD set `Cache-Control: public, max-age=60` or stricter
- Content-Type is negotiated from file extension

### 2.3 Draft preview

```
GET /drafts-view/<project>/<path>
```

Current draft state. In 0.2 readable by anyone who knows the project name. Future versions MAY gate by pass.

### 2.4 API

```
<method> /drafts/api/<operation>
Authorization: Bearer <secret>
```

`<secret>` is the hex portion of the portable token (substring after the last underscore).

---

## 3. Operations

### 3.1 Create project (server tier)

```
POST /drafts/projects
Authorization: Bearer <server_secret>
Content-Type: application/json

{ "name": "<project-name>", "description": "<optional>", "github_repo": "<optional>" }
```

Success:

```json
{
  "ok": true,
  "project": "<n>",
  "pap_activation_url": "https://<host>/drafts/pass/drafts_project_<n>_<hex>",
  "live_url": "https://<host>/live/<n>/",
  "drafts_view_url": "https://<host>/drafts-view/<n>/"
}
```

Errors: `400` invalid name, `409` exists, `401` wrong token.

### 3.2 Write file (project or agent tier)

```
PUT /drafts/api/files/<project>/<path>
Authorization: Bearer <secret>
Content-Type: <mime>

<body>
```

- Project tier writes to `main` branch
- Agent tier writes to `aap/<agent_id>/` branch (isolated)
- `<path>` MUST NOT contain `..`, `//`, or absolute components
- Percent-encoded traversal attempts MUST be rejected after decoding
- Maximum body size: 20 MB (MUST be enforced)

Success: `200 OK` (update) or `201 Created` (new) with `{ "ok": true, "commit": "<sha>" }`.

### 3.3 Promote (project tier)

```
POST /drafts/api/promote/<project>
Authorization: Bearer <project_secret>
```

Atomic: partial states MUST NOT be observable to public requests. Implementations SHOULD use symlink swap or rename-directory techniques.

Response: `{ "ok": true, "live_url": "https://<host>/live/<project>/" }`.

### 3.4 Merge agent branch (project tier)

```
POST /drafts/api/merge/<project>
Authorization: Bearer <project_secret>
Content-Type: application/json

{ "agent_id": "<id>" }
```

Merges `aap/<agent_id>/` into `main`. Fails with `409` on conflicts; operator resolves manually.

### 3.5 Rotate pass (owner of that pass tier)

```
POST /drafts/api/rotate
Authorization: Bearer <secret>
```

Generates a new secret of the same tier, invalidates old one immediately, returns new portable URL.

### 3.6 Optional operations

Implementations MAY provide: list files, diff, rollback, delete. Formal definitions deferred to 0.3.

### 3.7 GitHub configuration (added in v0.2.1)

Reference implementations supporting the `github-sync` capability MUST expose configuration via runtime API rather than environment variables only. Server-default credentials are managed at the server tier; per-project overrides at the project tier:

```
GET /drafts/config/github
PUT /drafts/config/github
DELETE /drafts/config/github
   — Requires server tier auth. Body: {"user": "<gh_user>", "token": "<gh_pat>"}.

GET /drafts/projects/<project>/config/github
PUT /drafts/projects/<project>/config/github
DELETE /drafts/projects/<project>/config/github
   — Requires project or server tier auth. Same body shape.
```

Resolution order when sync is invoked: per-project override → server default → environment fallback. Stored tokens MUST be returned redacted (first/last 4 chars only) on `GET`.

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
- `/drafts/api/*` — 60 req/min per IP

This protects against distributed token-scanning attacks that per-token limits cannot see.

---

## 5. Machine JSON schema

Embedded in every welcome page:

```html
<script type="application/json" id="drafts-machine-context">
{
  "protocol": "drafts",
  "protocol_version": "0.2",
  "server_number": 0,
  "server_name": "Labs Reference Server",
  "tier": "project",
  "project_name": "<string|null>",
  "portable_identifier": "https://<host>/drafts/pass/drafts_<tier>_<n>_<hex>",
  "token": "<secret>",
  "api_base": "https://<host>/drafts/api",
  "endpoints": {
    "files": "https://<host>/drafts/api/files/<project>/<path>",
    "promote": "https://<host>/drafts/api/promote/<project>",
    "merge": "https://<host>/drafts/api/merge/<project>",
    "rotate": "https://<host>/drafts/api/rotate",
    "projects": "https://<host>/drafts/projects"
  },
  "capabilities": ["static", "media", "git", "github-sync"],
  "rate_limits": { "per_minute": 60, "per_hour": 600, "per_day": 5000 },
  "registry_url": "https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/drafts-registry.json"
}
</script>
```

Clients SHOULD ignore unknown fields. Servers MAY add optional fields.

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

The registry MUST NOT be served by individual drafts servers. (drafts/0.1 and pre-0.2.1 implementations exposed `GET /drafts/registry.json`; this endpoint was removed in 0.2.1 and MUST NOT be implemented in conformant 0.2 servers.)

Schema:

```json
{
  "protocol": "drafts",
  "protocol_version": "0.2",
  "updated_at": "<ISO 8601>",
  "servers": {
    "<n>": {
      "name": "<string>",
      "operator": "<string>",
      "base_url": "https://<host>",
      "contact": "<email|url>",
      "status": "active" | "deprecated",
      "endpoints": {
        "welcome": "https://<host>/drafts/pass/<token>",
        "api": "https://<host>/drafts/api"
      },
      "token_format": {
        "server_hex_length": 16,
        "project_hex_length": 12,
        "agent_hex_length": 10
      },
      "capabilities": ["static", "media", "git", "github-sync"],
      "pricing": { "currency": "USD", "period": "year", "tiers": [
        { "label": "static", "price": 10 },
        { "label": "interactive", "price": 20 },
        { "label": "ai-app", "price": 30 }
      ] }
    }
  }
}
```

### 6.2 Server numbers

Server `0` is reserved for the reference server operated by Labs **and** is the default for any local/unregistered install. Local servers operate under `0` indefinitely without registration; their tokens are valid only against their own host. Other non-negative integers are assigned first-come via PR to this repository's `drafts-registry.json`. Once assigned, a number MUST NOT be reassigned even if a server shuts down.

### 6.3 Pricing field

`pricing` is informational. It advertises what the server charges publishing clients (including agents making autonomous purchasing decisions). The protocol does NOT standardize billing mechanics; each server defines its own payment flow out-of-band.

The reference server's pricing is designed for agent-native micro-procurement: annual (not monthly) billing, three tiers corresponding to capability needs, all under $50/year.

---

## 7. Security considerations

### 7.1 Token leakage

Tokens are bearer credentials. Anything in possession of the token has the authority granted by the tier. Clients MUST NOT send tokens in URL query strings. Tokens SHOULD only appear in path segments of welcome URLs or in `Authorization: Bearer` headers.

### 7.2 Brute-force resistance

Minimum entropy targets (see §1.1) are chosen under the joint assumption of per-token limits (§4) AND per-IP limits (§4.1). Implementations that omit per-IP limits SHOULD increase token entropy or add fail2ban-equivalent ban-on-401 protections.

### 7.3 Path traversal

All file paths MUST be validated against the project root after URL decoding. Implementations MUST reject `..`, absolute paths, percent-encoded, double-encoded, and Unicode-equivalent traversal attempts.

### 7.4 Content-Type

Servers SHOULD enforce an allowlist of MIME types. Safe: HTML, CSS, JavaScript, JSON, plain text, PNG, JPEG, WebP, MP3, MP4. Executable binary formats SHOULD be rejected.

### 7.5 Transport

HTTPS is required. Plain HTTP requests under `/drafts/` MUST 301-redirect to HTTPS. HSTS with `max-age >= 31536000` is RECOMMENDED.

### 7.6 Rotation

Compromised passes MUST be rotatable (§3.5). Old-token invalidation MUST be immediate. No grace period for the old secret.

### 7.7 Audit

Implementations SHOULD retain per-token access logs for at least 30 days with fields: timestamp, token-hash, IP, method, path, status, bytes.

### 7.8 Federation trust

Servers in the registry are independent. A compromise of server N does not affect server M. Clients MUST NOT trust cross-server claims. In particular, a welcome page from one server MUST NOT cause a client to make authenticated calls to another server.

---

## 8. Versioning

- `0.x`: breaking changes permitted, documented in CHANGELOG.md
- `>= 1.0`: SemVer — MAJOR breaking, MINOR additive, PATCH backward-compatible
- Current protocol version advertised in registry and machine JSON

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

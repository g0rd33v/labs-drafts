# The drafts protocol

**Version:** 0.2 (experimental)
**Status:** Breaking changes possible before 1.0
**Formal spec:** [SPEC.md](SPEC.md)

---

## What drafts is

drafts is a federated protocol for publishing small digital artifacts to public URLs using portable bearer tokens. It targets AI agents as the primary class of user, with humans as secondary users.

The protocol is designed against one test:

> **A quantized 7B-parameter model running locally can publish a working artifact with three HTTP calls and no error recovery.**

A drafts **server** hosts **projects**. Each project has exactly one **Project Pass** granting owner control. Owners issue **Agent Passes** to contributors. One **Server Pass** exists per server and grants administrative authority.

The pass is the identity. No accounts, no registration, no authentication beyond token presentation.

---

## Three tiers of authority

| Tier | Portable form | Entropy | Authority |
|---|---|---|---|
| **Server** | \`drafts_server_<n>_<16hex>\` | 64 bits | Create/delete projects, mint passes, all project operations |
| **Project** | \`drafts_project_<n>_<12hex>\` | 48 bits | Edit drafts, promote to live, mint agent passes, set GitHub mirror, rotate own pass |
| **Agent** | \`drafts_agent_<n>_<10hex>\` | 40 bits | Write to own branch only. Cannot promote. Cannot mint |

\`<n>\` is the server number from the federation registry. \`0\` is reserved for the reference server operated by Labs.

Wire-format secrets MUST use lowercase hex. Length is normative.

---

## URL namespace

### Welcome (discovery)

\`\`\`
https://<host>/drafts/pass/<portable_token>
\`\`\`

Returns an HTML page with an embedded machine-readable JSON block carrying endpoint URLs, tier, capabilities, and rate limits. Agents parse the JSON. Humans read the page.

### Public artifacts

\`\`\`
https://<host>/live/<project>/<path>
\`\`\`

No authentication. Cacheable. Where published output lives.

### Draft preview

\`\`\`
https://<host>/drafts-view/<project>/<path>
\`\`\`

Current draft state. In 0.2 readable by anyone who knows the project name; future versions may gate by pass.

### API

\`\`\`
https://<host>/drafts/api/<operation>
Authorization: Bearer <secret>
\`\`\`

All state-changing operations.

---

## Minimal publishing flow

Three HTTP calls. Any HTTP-capable agent can comply.

**1. Discover.** GET the welcome URL. Parse the machine JSON for \`endpoints.files\` and \`endpoints.promote\`.

**2. Write.** \`PUT /drafts/api/files/<project>/<path>\` with body = file content and header \`Authorization: Bearer <secret>\`.

**3. Promote.** \`POST /drafts/api/promote/<project>\` with same header. The drafts tree is copied atomically to \`live/\`.

The output is now public at \`https://<host>/live/<project>/<path>\`.

---

## Federation

Servers are independent. A pass from server A is meaningless on server B. Federation lives in the registry:

\`\`\`
https://beta.labs.vc/drafts/registry.json
\`\`\`

Each server has a non-negative integer ID. To join, open a pull request adding your server entry. See [REGISTRY.md](REGISTRY.md).

---

## Capabilities

Servers advertise what they support via the \`capabilities\` array in the machine JSON and registry. 0.2 vocabulary:

| Token | Meaning |
|---|---|
| \`static\` | HTML, CSS, JS, fonts |
| \`media\` | Images, audio, video |
| \`git\` | Per-commit history and rollback |
| \`github-sync\` | Project mirrors to an external GitHub repo |
| \`sql\` | Per-project relational storage (reserved, 1.1+) |
| \`vector\` | Per-project vector index (reserved, 1.1+) |
| \`runtime\` | Server-side code execution (reserved, 2.0+) |
| \`llm\` | Server-routed LLM inference (reserved, 2.0+) |
| \`gpu\` | GPU compute access (reserved, capability-credential passes) |
| \`video-gen\` | Video generation (reserved, capability-credential passes) |

Servers MUST only declare capabilities they actually implement.

---

## Conformance

An implementation is **drafts/0.2-conformant** if it:

1. Accepts portable tokens matching the grammar of [SPEC.md §1](SPEC.md)
2. Serves welcome pages at \`/drafts/pass/<token>\` with both HTML and embedded machine JSON ([SPEC.md §5](SPEC.md))
3. Implements the three minimum operations (files PUT, promote POST, project creation POST) with Bearer auth ([SPEC.md §3](SPEC.md))
4. Publishes a registry entry matching the canonical schema ([SPEC.md §6](SPEC.md))
5. Enforces at least the minimum per-token rate limits ([SPEC.md §4](SPEC.md))

Non-conformant servers should use a different protocol name.

---

## Non-goals

- drafts is not a general web hosting product
- drafts is not a CDN — caching is the operator's concern
- drafts is not a CMS — rich editing is the client's concern
- drafts does not define billing, payments, or licensing
- drafts does not define a structured content data model; files only

---

For the full normative specification, see [SPEC.md](SPEC.md).
For positioning against adjacent products, see [POSITIONING.md](POSITIONING.md).
For version plans, see [ROADMAP.md](ROADMAP.md).

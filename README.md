# drafts

> **The publishing protocol for AI-generated artifacts.**
> One URL. Any agent. Public the moment it exists.

[![Protocol](https://img.shields.io/badge/protocol-drafts%2F0.2-blue)](docs/SPEC.md)
[![Reference server](https://img.shields.io/badge/reference-beta.labs.vc-brightgreen)](https://beta.labs.vc/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

**drafts** is an open protocol for publishing small digital artifacts — static pages, PWAs, AI-powered apps — to public URLs using nothing but a portable access token. No accounts. No credit cards. No framework lock-in.

\`\`\`
drafts_server_0_91e52304063d5440     full server control
drafts_project_0_a30aca1fe85b        project owner
drafts_agent_0_b7fabf75b3            contributor, isolated branch
\`\`\`

Any capability that can issue three HTTP requests can publish.

---

## The design test

> **A quantized 7B-parameter model running locally can publish a working artifact with three HTTP calls and no error recovery.**

Every design decision in this repository is measured against that test. Agents are the primary class of user. Humans are secondary. The less intelligent the client, the more valuable drafts becomes.

---

## Why it exists

AI agents produce outputs that want to live at a URL — a research deliverable, a daily-updating dashboard, a curated list, an interactive explainer. Today those outputs either get trapped inside a chat session or require the agent to complete a developer-targeted deploy flow (Vercel, Netlify, GitHub Pages) built for humans with billing credentials.

drafts removes every decision the agent shouldn't have to make. The token is the identity. The identity is stateless. The output is immediately public.

---

## Specification

| Document | Purpose |
|---|---|
| [PROTOCOL.md](docs/PROTOCOL.md) | Protocol overview |
| [SPEC.md](docs/SPEC.md) | Formal specification with RFC 2119 conformance |
| [POSITIONING.md](docs/POSITIONING.md) | Where drafts fits vs Bolt, Vercel, E2B, Val.town |
| [ROADMAP.md](docs/ROADMAP.md) | Versions 1.0, 1.1, 2.0 plus research tracks |
| [REGISTRY.md](docs/REGISTRY.md) | How to register your own drafts server |
| [INSTALL.md](docs/INSTALL.md) | Run a conformant server |

Protocol version: **drafts/0.2** — experimental. Breaking changes possible before 1.0.

---

## Pricing model (reference server)

Designed for agent-native micro-procurement — annual, not monthly:

| Tier | Price | What you get |
|---|---|---|
| **Static** | $10 / year | HTML, CSS, JS, media, git, GitHub mirror |
| **Interactive** | $20 / year | adds per-project SQL + vector storage (1.1) |
| **AI app** | $30 / year | adds server-routed LLM inference, auth primitives (2.0) |

The reference server's pricing is informational. Other servers in the federation may price differently; the protocol does not standardize billing.

Capability-bundled passes (GPU, video generation, RAG) are sold separately and priced higher — see [ROADMAP.md](docs/ROADMAP.md).

---

## Reference implementation

This repository contains the reference drafts server, operated by [Labs](https://labs.vc) as federation member \`0\` at:

**https://beta.labs.vc/drafts/**

Stack: Node.js 18+ (Express 4), nginx 1.24 (TLS via Let's Encrypt), Redis (rate-limit state), SQLite + per-project git repos (project registry).

See [REFERENCE_IMPLEMENTATION.md](REFERENCE_IMPLEMENTATION.md) for operational detail.

---

## Quick start

### Use the reference server

Ask the operator of beta.labs.vc for a Project Pass. Paste its welcome URL into Claude for Chrome. Tell Claude what to build.

### Run your own

\`\`\`bash
git clone https://github.com/g0rd33v/drafts-protocol.git
cd drafts-protocol
npm install
cp .env.example .env
# set BEARER_TOKEN (16-hex), PUBLIC_BASE, paths
node app.js
\`\`\`

Register with the federation by opening a pull request adding your server entry to [\`registry.json\`](registry.json). See [REGISTRY.md](docs/REGISTRY.md).

---

## Minimal publishing flow

Three HTTP calls:

\`\`\`
1. GET  https://<host>/drafts/pass/<portable_token>
   (parse machine JSON, read endpoints)

2. PUT  https://<host>/drafts/api/files/<project>/<path>
   Authorization: Bearer <secret>
   Body: <file content>

3. POST https://<host>/drafts/api/promote/<project>
   Authorization: Bearer <secret>
\`\`\`

Output is now public at \`https://<host>/live/<project>/<path>\`.

---

## Status

| Capability | 0.2 | 1.1 | 2.0 |
|---|---|---|---|
| Static HTML, CSS, JS, media | ✓ | ✓ | ✓ |
| Per-project git with rollback | ✓ | ✓ | ✓ |
| Multi-contributor branch isolation | ✓ | ✓ | ✓ |
| HTTPS with Let's Encrypt | ✓ | ✓ | ✓ |
| Per-tier rate limits | ✓ | ✓ | ✓ |
| GitHub bidirectional mirror | ✓ | ✓ | ✓ |
| Public federation registry | ✓ | ✓ | ✓ |
| Capability vocabulary | ✓ | ✓ | ✓ |
| Token rotation endpoint | ✓ | ✓ | ✓ |
| Agent-branch merge endpoint | ✓ | ✓ | ✓ |
| Per-project SQL storage | — | ✓ | ✓ |
| Per-project vector storage | — | ✓ | ✓ |
| Server-side runtime | — | — | ✓ |
| Server-routed LLM inference | — | — | ✓ |
| End-user auth primitives | — | — | ✓ |

See [ROADMAP.md](docs/ROADMAP.md) for capability-as-credential research, skills-as-a-service marketplace, and other research tracks.

---

## Defensibility

drafts has a defensibility story separate from feature parity with larger platforms. See [POSITIONING.md](docs/POSITIONING.md) for the full analysis:

- **Open protocol, federated registry** — no single vendor can close the ecosystem
- **Model-agnostic** — explicit support for Llama, Mistral, Qwen, quantized local models
- **Agent-native pricing** — annual micro-pricing designed for autonomous agent procurement, not human consumers
- **Capability-as-credential** — upgrade paths for GPU, video-gen, RAG that contradict major-lab product strategy

---

## Community

- **Discussion & proposals** — [GitHub Issues](https://github.com/g0rd33v/drafts-protocol/issues)
- **Operator contact** — eugene@labs.vc
- **Changelog** — [CHANGELOG.md](CHANGELOG.md)

---

## License

[MIT](LICENSE). Contributions require agreement to the [Code of Conduct](CODE_OF_CONDUCT.md).

# drafts

> **An agent artifact protocol.**
> Think Google Docs, but for the agent era.

[![Protocol](https://img.shields.io/badge/protocol-drafts%2F0.2-blue)](docs/SPEC.md)
[![Reference server](https://img.shields.io/badge/reference-beta.labs.vc-brightgreen)](https://beta.labs.vc/)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

AI artifacts today are dead ends. Static one-shots — generated, downloaded, stuck. A third party can't extend them. They don't interact. They can't be forked, remixed, or reused. The next conversation forgets they exist.

**drafts** makes them living. Every artifact becomes a continuously updatable, openly readable, interactively usable, forkable thing — shared by many agents and many humans through a single token-based access model. LLMs create. Other agents extend. Humans tweak. Readers consume.

```
drafts_server_0_<16hex>      full server control
drafts_project_0_<12hex>     project owner
drafts_agent_0_<10hex>       contributor, isolated branch
```

Any capability that can issue three HTTP requests can participate.

---

## Run your own drafts server in one command

On a fresh Ubuntu 22.04+ VPS with a domain pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/install.sh \
  | bash -s drafts.example.com admin@example.com
```

That's it. The script installs nginx, certbot, Node.js 20, pm2, clones this repo, configures everything, issues HTTPS, mints your SAP token, and prints it once. ~3 minutes. Then you create your first project with one curl, hand the returned link to anyone, and they paste it into Claude for Chrome to start building.

See [docs/INSTALL.md](docs/INSTALL.md) for prerequisites, troubleshooting, and the manual install path.

---

## The hand-off

The feature most people underestimate. An artifact made in one LLM can be picked up by another.

You create a landing page in Claude. The result lives at a drafts URL. You paste the link into GPT-5: *"improve the pricing logic, make it punchier."* GPT-5 reads the current state of the artifact through the URL, writes changes on its own branch, commits. You review the diff. You merge it, or discard it, or hand the link to a third agent for a copy pass.

When you're done, the same link is what a human collaborator opens in a browser. What a reader-bot scrapes for downstream use. What a search agent indexes. What the next team forks to start their own version.

What used to take a stack of hosting, CMS, collaboration suite, and APIs collapses into one protocol.

---

## The design test

> **A quantized 7-billion-parameter model running locally on consumer hardware can publish a working artifact to drafts with three HTTP calls and no error recovery.**

Every design decision in this repository is measured against that test. Agents are the primary class of user. Humans are secondary. The less intelligent the client, the more drafts is designed to help it succeed.

---

## Specification

| Document | Purpose |
|---|---|
| [PROTOCOL.md](docs/PROTOCOL.md) | Protocol overview |
| [SPEC.md](docs/SPEC.md) | Formal specification with RFC 2119 conformance |
| [POSITIONING.md](docs/POSITIONING.md) | Where drafts fits vs Bolt, Vercel, E2B, Val.town |
| [ROADMAP.md](docs/ROADMAP.md) | Versions 1.0, 1.1, 2.0, plus research tracks |
| [REGISTRY.md](docs/REGISTRY.md) | How to register your own drafts server |
| [INSTALL.md](docs/INSTALL.md) | Run a conformant server |

Protocol version: **drafts/0.2** — experimental. Breaking changes possible before 1.0.

---

## Pricing model (reference server)

Designed for agent-native micro-procurement — annual, not monthly:

| Tier | Price | What you get |
|---|---|---|
| **Static** | $10 / year | HTML, CSS, JS, media, git, GitHub mirror |
| **Interactive** | $20 / year | adds per-project SQL + vector storage (v1.1) |
| **AI app** | $30 / year | adds server-routed LLM inference, auth primitives (v2.0) |

The reference server's pricing is informational. Other servers in the federation may price differently. The protocol does not standardize billing.

Capability-bundled passes (GPU, video-gen, RAG) are sold separately and priced higher — see [ROADMAP.md](docs/ROADMAP.md).

---

## Reference implementation

This repository contains the reference drafts server, operated by [Labs](https://labs.vc) as federation member `0` at:

**https://beta.labs.vc/drafts/**

Stack: Node.js 18+ (Express 4), nginx 1.24 (TLS via Let's Encrypt), per-project git repos.

See [REFERENCE_IMPLEMENTATION.md](REFERENCE_IMPLEMENTATION.md) for operational detail.

---

## Quick start

### Use the reference server

Contact eugene@labs.vc for a Project Pass. Paste its welcome URL into Claude for Chrome. Tell Claude what to build. Once the first version is live, hand the same URL to another LLM and see what happens.

### Run your own

```bash
curl -fsSL https://raw.githubusercontent.com/g0rd33v/drafts-protocol/main/install.sh \
  | bash -s drafts.example.com admin@example.com
```

Or manually:

```bash
git clone https://github.com/g0rd33v/drafts-protocol.git /opt/drafts
cd /opt/drafts
npm install
cp .env.example /etc/labs/drafts.env
# edit /etc/labs/drafts.env — at minimum set PUBLIC_BASE_URL
node drafts.js
```

Register your server with the federation by opening a PR adding your entry to [`drafts-registry.json`](drafts-registry.json). See [REGISTRY.md](docs/REGISTRY.md).

---

## Minimum protocol

Three HTTP calls:

```
1. GET  https://<host>/drafts/pass/<portable_token>
   (parse machine JSON, read endpoints)

2. POST https://<host>/drafts/upload
   Authorization: Bearer <secret>
   Body: {"filename":"index.html","content":"..."}

3. POST https://<host>/drafts/promote
   Authorization: Bearer <secret>
```

Output is now public at `https://<host>/live/<project>/`.

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
| GitHub config via SAP/PAP API | ✓ | ✓ | ✓ |
| Public federation registry | ✓ | ✓ | ✓ |
| One-command installer | ✓ | ✓ | ✓ |
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

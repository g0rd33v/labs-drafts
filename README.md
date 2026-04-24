# Drafts

> **The publishing layer for AI-generated artifacts.** Turn any conversation with an AI agent into a live, persistent, public URL — with no signup, no code, no friction.

Drafts is a protocol + reference server for letting AI agents (and humans) publish websites, pages, PWAs, and AI-powered apps to public URLs using nothing but a passable link as their identity.

Live reference server: **https://beta.labs.vc/**

---

## The core idea

AI agents increasingly produce outputs that want to live at a URL — a research report, a curated list, an interactive dashboard, a daily price tracker, a shareable artifact. Today these outputs either get stuck inside a chat session, or require the agent to navigate a developer-targeted deploy flow (Vercel, Netlify, GitHub Pages) that assumes a human with a credit card.

Drafts removes that friction. An agent gets a URL-shaped token. It hits two HTTP endpoints. The output is live at a public URL. No accounts, no payments, no onboarding.

---

## Three tiers of access

Every project has three access levels, each represented by a self-describing portable identifier:

| Tier | Format | Capabilities |
|---|---|---|
| **Server** | `drafts_server_0_<16hex>` | Full admin on one Drafts server — create/delete projects, mint passes |
| **Project** | `drafts_project_0_<12hex>` | Full control over one project — edit drafts, promote to live, invite contributors |
| **Agent** | `drafts_agent_0_<10hex>` | Contributor access — edit in an isolated branch; owner merges to main |

Canonical URL format: `https://<server>/drafts/pass/drafts_<tier>_<server_num>_<secret>`

The server number lets you federate: server 0 is the canonical registry at beta.labs.vc; anyone can run their own Drafts server under a different number and register it in the public registry.

---

## Current capabilities

- Static HTML, CSS, JS, media assets (images, audio, video)
- Git versioning with rollback per project
- Multi-contributor via Agent passes writing to isolated branches
- Public `/live/<project>/` URLs with HTTPS
- Optional GitHub sync (push/pull mirror with commit history)
- Rate limits per tier (Server 120/min, Project 60/min, Agent 10/min)
- Automatic deploy on commit: `drafts/` → `live/`

---

## Roadmap

- **v1.1** — per-project SQL + vector storage
- **v2** — backend runtime, auth primitives, multi-LLM routing via OpenRouter
- **Future** — one-command self-host, paid capability-bundled tokens (GPU, video-gen, specialized models)

---

## Architecture

```
                      ┌────────────────┐
                      │   nginx:443    │ SSL + routing
                      └────────┬───────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
         /drafts/pass/*   /drafts/api/*     /live/*
                │              │              │
        ┌───────▼──────────────▼──────┐  ┌────▼────────────────┐
        │   Node receiver (app.js)    │  │  Static file server  │
        │   Welcome pages + API       │  │  /var/www/html/live  │
        │   Port 3100                 │  │                      │
        └────────┬────────────────────┘  └──────────▲───────────┘
                 │                                  │
        ┌────────▼─────────┐           ┌────────────┴──────────┐
        │  state.json      │           │  drafts/<project>/    │
        │  (project list)  │           │    drafts/  (git)     │
        │  Redis (rates)   │           │    live/    (deployed)│
        └──────────────────┘           └───────────────────────┘
```

---

## Installation

See [docs/INSTALL.md](docs/INSTALL.md) for full server setup.

Quick: Node 18+, nginx, Redis, SQLite or Postgres, Let's Encrypt cert.

```bash
git clone https://github.com/g0rd33v/drafts-protocol.git
cd labs-drafts
npm install
cp .env.example .env  # edit values
node app.js
```

---

## Protocol spec

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the formal spec of the portable identifier, URL structure, HTTP API, and registry model.

---

## Registry

The public registry at `https://beta.labs.vc/drafts/registry.json` lists all known Drafts servers. Server number 0 is the canonical Labs reference server. To register your own server, open a PR on this repo adding your server details to the registry.

---

## License

MIT (see [LICENSE](LICENSE))

---

## Contributing

This is an early-stage protocol under active development. Issues, questions, and protocol-spec feedback welcome via GitHub issues.

The reference server at beta.labs.vc is operated by [Labs](https://labs.vc) — a bootstrapped venture studio.

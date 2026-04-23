# drafts

**Build and publish, just by talking.**

Drafts turns any Claude conversation into a workspace where you ship real websites, progressive web apps, and AI tools. No registration. No coding. No vibe coding. Just vibe.

Live at **[beta.labs.vc](https://beta.labs.vc/drafts/)**.

---

## What it is

A lightweight server that sits between Claude and the public web. You get a personal link. You drop it into the Claude for Chrome extension sidebar. Claude reads the page, parses embedded machine-readable instructions, takes on the right level of access automatically, and is ready to build.

Then you talk.

> "Make me a landing page for a running club."
> "Add a signup form."
> "Make the header feel more like Apple."
> "Publish."

Minutes later — sometimes seconds — it is live at a public URL.

---

## What you need

1. **Anthropic Claude**, any plan (Free works), logged in in Chrome
2. **[Claude for Chrome extension](https://chromewebstore.google.com/detail/claude-for-chrome/fmpnliohjhemenmnlpbfagaolkdacoja)**
3. **A drafts link** — your personal project link, no signup

That is the entire stack.

---

## What it does today

- **Unlimited projects.** Websites, PWAs, AI-powered tools — anything that lives at a URL.
- **Public URLs out of the box.** Every project lives at a clean address the moment you publish.
- **Stunning output.** Claude generates production-quality HTML, CSS, JS — fast, adaptive, mobile-ready. Full interactivity, animations, forms, third-party embeds.
- **Git-versioned.** Every change tracked. Rollback is one sentence away.
- **Two zones per project.** A `drafts/` working zone for iteration; a `live/` zone for the public version. Atomic promote when you are ready.
- **Collaboration by link.** Invite unlimited contributors — each one gets their own isolated branch. You review and merge. No shared passwords, no Figma invites, no GitHub permissions.
- **Optional GitHub sync.** Push to your own repo when you want to deploy elsewhere too.
- **Zero registration.** Your Claude login is your entire identity.

---

## Coming soon

- **Databases.** SQL for user data. Vector storage for knowledge bases. Host real apps with real users.
- **Multi-LLM.** Use any model while building, or let your visitors pick theirs. Claude, GPT, open-source — whatever fits.
- **Your own Drafts server.** One-command install on any VPS.
- **Deployment bridges.** Beyond GitHub — to wherever you want your code and projects to live.

---

## How it works under the hood

Three-tier access model, based on magic links:

| Tier | URL | Who | Scope |
|---|---|---|---|
| **SAP** (Server API Pass) | `/s/<token>` | Server operator | Root. Create/delete any project, mint PAPs. One per server. |
| **PAP** (Project API Pass) | `/p/<token>` | Project owner | One project. Mint AAPs, merge, publish, rollback. |
| **AAP** (Agent API Pass) | `/a/<token>` | Contributor or AI agent | One project. Writes to an isolated `aap/<id>` branch. Owner reviews and merges. |

Each link opens to a welcome page containing a machine-readable instruction block. Claude reads this on first load and knows instantly:

- What tier it is operating at
- Which endpoints are available
- How to interpret natural language user intent
- How to verify work after publishing
- How to fall back gracefully across transports

No UI dashboards. No control panels. All control plane flows through Claude chat.

---

## Stack

- **Node 18** + **Express** + **simple-git**
- **nginx** for TLS, static serving, and reverse proxy
- **pm2** for process management
- **Git** for versioning (local repos per project, optional GitHub mirror)
- **Let's Encrypt** for SSL
- **Flat JSON state** at `.state.json` — no database required

---

## Rate limits

Hardcoded, Claude Code style. Tier-based sliding windows:

| Tier | per minute | per hour | per day |
|---|---|---|---|
| SAP | 120 | 2,000 | 20,000 |
| PAP | 60 | 600 | 5,000 |
| AAP | 10 | 60 | 300 |

Over-limit requests get `HTTP 429` with `Retry-After`.

---

## Status

**v0.3 — live in beta** at [beta.labs.vc](https://beta.labs.vc/drafts/).

---

## License

MIT.

---

*Part of [labs.vc](https://labs.vc). Built in the open.*

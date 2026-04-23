# drafts

**Build and publish, just by talking.**

Drafts turns any Claude conversation into a workspace where you ship real websites, progressive web apps, and AI tools. No registration. No coding. No vibe coding. Just vibe.

Live at **[beta.labs.vc](https://beta.labs.vc/drafts/)** — the canonical server (`drafts_0`).

---

## What it is

A lightweight server that sits between Claude and the public web. You get a personal portable link. You drop it into the Claude for Chrome extension sidebar. Claude reads the page, parses embedded machine-readable instructions, takes on the right level of access automatically, and is ready to build.

Then you talk.

> "Make me a landing page for a running club."
> "Add a signup form."
> "Make the header feel more like Apple."
> "Publish."

Minutes later — sometimes seconds — it is live at a public URL.

---

## The portable link format

Every Drafts link follows one pattern:

```
drafts_<server_number>_<token>
```

Three parts, readable at a glance:

- **`drafts`** — the protocol. Always.
- **`<server_number>`** — which Drafts server hosts this project. `0` is the canonical server at [beta.labs.vc](https://beta.labs.vc). Other operators run 1, 2, 3… declared in the public registry.
- **`<token>`** — the access credential. Its prefix reveals the tier automatically: `pap_` = project owner, `aap_` = contributor, otherwise = server root.

Example links:

```
drafts_0_<64hex>                 → SAP (server root)
drafts_0_pap_<48hex>             → PAP (project owner)
drafts_0_aap_<48hex>             → AAP (contributor)
```

One link tells any Claude everything it needs: which server, which tier, which project. No lookups required.

### The registry

Drafts maintains a public registry at [**beta.labs.vc/drafts/registry.json**](https://beta.labs.vc/drafts/registry.json) listing every registered Drafts server. Want to run your own instance and claim a number? Open a PR against this repository — the registry is owned and maintained by Drafts itself.

---

## What you need

1. **Anthropic Claude**, any plan (Free works), logged in in Chrome
2. **[Claude for Chrome extension](https://chromewebstore.google.com/detail/claude-for-chrome/fmpnliohjhemenmnlpbfagaolkdacoja)**
3. **A drafts link** — your personal `drafts_0_…` identifier

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

- **Databases.** SQL for user data. Vector storage for knowledge bases.
- **Multi-LLM.** Use any model while building, or let your visitors pick theirs.
- **Self-hosted Drafts.** One-command install on any VPS. Claim a number in the registry.
- **Deployment bridges.** Beyond GitHub — to wherever your code lives.

---

## Three-tier access model

Drafts uses a simple hierarchy based on the portable link format:

| Tier | Link format | Who | Scope |
|---|---|---|---|
| **SAP** — Server API Pass | `drafts_<N>_<64hex>` | Server operator | Root. Create/delete any project, mint PAPs. One per server. |
| **PAP** — Project API Pass | `drafts_<N>_pap_<48hex>` | Project owner | One project. Mint AAPs, merge contributions, publish, rollback. |
| **AAP** — Agent API Pass | `drafts_<N>_aap_<48hex>` | Contributor or AI agent | One project. Writes to an isolated `aap/<id>` branch. Owner reviews and merges. |

Each link opens to a welcome page containing a machine-readable instruction block. Claude reads this on first load and knows instantly:

- What tier it is operating at
- Which server it is speaking to
- Which endpoints are available
- How to interpret natural language user intent
- How to verify work after publishing

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

**v0.3 — live in beta** at [beta.labs.vc](https://beta.labs.vc/drafts/). Canonical server is `drafts_0`.

---

## License

MIT.

---

*Part of [labs.vc](https://labs.vc). Built in the open.*

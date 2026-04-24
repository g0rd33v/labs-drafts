# Roadmap

drafts is under active development. This document describes the intended trajectory. Dates are aspirational.

---

## 0.2 — shipped April 2026

Core protocol with three-tier passes, canonical welcome URL, portable token format, federation registry, GitHub sync. Reference server operating at beta.labs.vc as federation member 0.

---

## 1.0 — target Q3 2026

Protocol stability. Breaking changes after 1.0 require MAJOR version bumps and deprecation windows.

- Formal conformance test suite
- Reference client libraries (Python, JavaScript, shell one-liner)
- Federation registry with at least three independently operated servers
- Operator cookbook (docs for running a server responsibly)
- Protocol governance document (how proposals become specs)

---

## 1.1 — target Q4 2026

Per-project storage primitives. Expands drafts from static files to light dynamic content without a full backend.

- **\`sql\` capability** — per-project SQLite or Postgres namespace, scoped to project pass
- **\`vector\` capability** — per-project vector index (Pinecone-compatible API)
- API operations: \`PUT /drafts/api/sql/<project>\`, \`PUT /drafts/api/vector/<project>\`
- Reference server integration via OpenRouter-proxied embedding calls
- Migration path for static-only projects: opt-in per-project

Use case: an agent publishes a "daily real estate tracker" that fetches prices, stores history, and serves an interactive page — all at one URL, one pass.

---

## 2.0 — target 2027

Server-side runtime. This is the break from "static hosting plus storage" to "functional runtime." MAJOR version bump.

- **\`runtime\` capability** — edge-style function execution per project
- **\`llm\` capability** — server-routed inference via OpenRouter with cost pass-through
- **\`auth\` primitives** — project-scoped user sessions (for end-users, distinct from passes)
- One-command self-host installer: \`curl ... | sh\` producing a conformant server on a fresh Ubuntu VPS
- Bridge connectors to Vercel, Netlify, Cloudflare Pages for projects that outgrow drafts

Use case: an agent publishes a full AI-powered app (chat interface, RAG, LLM-generated responses) without touching any other service.

---

## Research track — capability-as-credential

Running in parallel with the 1.x/2.x line. The premise: some publishing needs require compute a base pass cannot deliver. Instead of forcing the agent to procure that compute separately, the pass itself carries the entitlement.

### Capability-bundled passes

- **GPU-pass** — same project semantics, but files placed in a \`/gpu/\` path execute against attached GPU compute
- **Video-gen pass** — project has a pre-attached video-generation endpoint for text-to-video output
- **RAG pass** — project starts with an embedded retrieval system and a chosen LLM routed at inference time
- **Multi-LLM pass** — project has routed access to Claude, GPT-4, Llama, Mistral through OpenRouter with budget caps

Commercial model: these are priced higher ($50–$500/year depending on compute) and sold via out-of-band purchase flows that mint passes. The agent presents a pass; the server grants the capability. No infrastructure decisions by the agent.

### Skills-as-a-service marketplace

Agents rent pre-configured capabilities from a catalog:

- Summarize document (RAG + LLM)
- Generate landing page from description
- Transcribe audio
- Draw SVG from spec
- Query domain-specific knowledge base

Each skill has a pass format. The agent uses the pass like any other credential: three HTTP calls, output published to its own artifacts.

---

## Research track — federation maturity

- Public conformance badge for registered servers
- Inter-server referrer patterns (e.g. "this agent's pass is at server N"; a client at server M can render a welcome that points back)
- Registry operator rotation (currently Labs.vc operates number 0 and merges PRs; long-term this becomes a multi-party trust structure)
- Dispute resolution for claimed server numbers, name squatting, abuse

---

## What will NOT be built

These have been considered and rejected:

- **Visual drag-and-drop editor.** Out of scope. drafts publishes what its clients produce.
- **Built-in analytics.** Clients add analytics themselves via script tags, like any web platform.
- **Multi-tenant user management.** A project has one owner (the PAP). Complex RBAC belongs on developer platforms.
- **Native payment processing.** Each server runs its own commerce. The protocol does not define billing.
- **Built-in CDN.** Clients add CDN in front themselves, like Cloudflare.

---

## How to influence the roadmap

File an issue. Protocol proposals with the \`spec\` label are read first. Production use cases with real constraints get weight.

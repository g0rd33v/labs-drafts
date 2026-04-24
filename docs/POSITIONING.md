# Positioning

**drafts** is an **agent artifact protocol** — Google Docs for the agent era.

This document explains what that framing means, where it sits in the AI-outputs pipeline, and why it is not something a major lab will casually replicate.

---

## The pipeline drafts lives in

Every AI-generated thing today travels the same four steps:

1. **Input.** A human or an agent asks an LLM to do something.
2. **Output.** The LLM produces the result.
3. **Artifact.** The result takes a shape — a page, a PWA, a report, an AI-powered app, a dashboard.
4. **Use.** Other agents, readers, humans consume it, request edits, iterate, fork.

drafts covers steps **3 and 4**. Explicitly.

- Step 1 is chat-product territory (Claude, ChatGPT, Grok). Not ours.
- Step 2 is the LLM. Not ours.
- Step 3 is where the artifact comes into public existence. drafts defines this.
- Step 4 is where the artifact is used, extended, remixed, handed off. drafts defines this too.

Today, step 3 either doesn't happen (the artifact dies in chat) or requires a developer-targeted deploy flow. Step 4 is broken for everyone — artifacts can't be edited by a third party, can't be forked, can't be updated in real time.

drafts fixes both, as one protocol, with one identity model (the pass).

---

## What makes the category

Four properties define the drafts category. A product missing any of them is not in the same category.

1. **Agent-primary.** Built for the weakest agent that can issue HTTP. Humans are welcome but secondary.
2. **Model-agnostic.** Claude, GPT, Llama, Mistral, Qwen, a 7B int4 model on a laptop — all equally first-class. No function-calling, structured-output, or tool-use assumptions.
3. **Multi-party by construction.** An artifact expects multiple contributors through tier-based passes. One creates. Others extend. Humans review. Readers consume.
4. **URL as the identity.** The workspace is the link itself. No account, no dashboard, no project settings UI required.

All four together are rare. Most of the adjacent products satisfy one or two.

---

## How drafts differs from adjacent products

### vs Bolt.new, Lovable, v0, Replit Agent

These are **AI-first developer environments**. A human prompts; the tool generates an app; the human reviews and iterates. Pricing is ~$20/month designed around a human as buyer. Sign-up is assumed. A second agent cannot pick up a Bolt artifact and extend it without the original user's session.

drafts inverts the audience. Agent-first, human-secondary. Annual pricing designed for autonomous procurement. No sign-up ever. Hand-off between agents is the headline feature.

### vs E2B, Daytona, Modal, Browserbase

These provide **sandboxes** — ephemeral compute environments that execute agent code. When the agent is done, the sandbox is destroyed. State does not persist to a URL.

drafts is the opposite: **persistent, shared, public artifact** with a stable URL from day zero. Sandboxes and drafts sit at opposite ends of the agent workflow — sandboxes run code; drafts holds what comes out.

### vs Val.town

The closest kin: serverless functions via chat. Val.town targets developer-enthusiasts writing short JS. drafts targets any agent publishing any static-or-interactive artifact regardless of language, with multi-contributor flow built in.

### vs Vercel, Netlify, Render, Fly.io, Cloudflare Pages

These are **developer platforms** with agent-friendly APIs bolted on. Every onboarding step is a point at which an edge agent fails. drafts removes every step that assumes a human.

### vs GitHub Pages, Neocities

Both are closer to drafts philosophically — free, simple, public — but require accounts, and don't support multi-party editing on a shared artifact. drafts has no accounts; the pass IS the account.

### vs Claude Artifacts, ChatGPT Canvas, Gemini Artifacts

These are **features inside a chat product**. An artifact lives inside the vendor's UI. It cannot be edited by another vendor's model. It cannot be handed to a human collaborator without exporting and breaking the chain. It cannot be forked by anyone outside that chat.

drafts externalizes the artifact. The same URL is accessible to Claude, GPT, Llama, any human, any reader-bot. The hand-off between different LLMs through the same link is the capability none of the chat-product artifact features can provide.

---

## Who drafts is for

**Primary:** AI agents with limited navigation capability. The less intelligent the client, the more valuable drafts becomes. The design target is the weakest agent that can still produce a useful artifact.

**Secondary:** Humans who want to ship small things fast via conversation — landing pages, one-offs, demos, internal tools — and let other people iterate on them.

**Tertiary:** Developers who want a simple protocol to build agent libraries and client tools against.

**Not for:** Teams needing CI/CD, staging environments, access roles, review workflows, compliance certifications. That is developer-platform territory and drafts does not compete there.

---

## Defensibility

### Against Anthropic or OpenAI shipping "Artifacts with persistent URLs"

drafts' durable advantages:

1. **Open protocol, federated registry.** A single vendor cannot close it. If one server disappears, the registry points to others.
2. **Model-agnostic.** Explicitly supports Llama, Mistral, Qwen, quantized local models. Major labs will not optimize for their competitors' models.
3. **Capability-as-credential** (see ROADMAP). Upgraded passes bundle pre-configured GPU, video generation, or RAG. This product shape contradicts major-lab chat strategy; they will not build it.
4. **Agent-native pricing.** Annual micro-pricing optimized for autonomous agent procurement. Monthly pricing optimized for human consumers is structurally different.

### Against developer platforms adding agent features

drafts' durable advantages:

1. **No signup.** Every signup flow is a defect for edge agents. Platforms cannot remove signup without restructuring their business model.
2. **Protocol-first.** The spec and registry, not a SaaS dashboard, is the product. Platforms are the opposite.
3. **Multi-party built in.** Adding tier-based passes to an existing deploy platform breaks its account model.

---

## Category framing

If the category needs a single phrase:

> **Agent artifact protocol.**

If two phrases work better:

> **For agents: living artifacts. For humans: Google Docs for AI outputs.**

If a single slogan:

> **One artifact. Many hands.**

---

## Non-positioning

drafts will not position as:

- A cheaper Vercel
- A simpler Netlify
- An AI website builder for non-technical humans
- A CMS alternative
- A developer productivity tool

Any of these framings attracts the wrong users and distorts the product.

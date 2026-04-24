# Positioning

**drafts** occupies a category that does not yet have a standard name.

---

## The category

AI-native publishing. The intersection of three rising currents:

1. Agents produce outputs at volume that humans cannot manually deploy
2. Outputs increasingly want a URL, not a chat session
3. Every existing deploy service is built for humans with credit cards

drafts is the first protocol explicitly designed for the publishing end of an agent workflow.

---

## How drafts differs from adjacent products

### vs Bolt.new, Lovable, v0, Replit Agent

These are **AI-first developer environments**. A human prompts; the tool generates an app; the human reviews and iterates. Pricing is ~$20/month designed around a human as buyer. Sign-up is assumed.

drafts inverts the audience: **agent-first, human-secondary**. Pricing is ~$10–$30 per year (annual, not monthly) designed for agent-autonomous procurement. No sign-up ever. The output is public by default; iteration happens post-publication.

### vs E2B, Daytona, Modal, Browserbase

These provide **sandboxes** — ephemeral compute environments that execute agent code. When the agent is done, the sandbox is destroyed. State does not persist to a URL.

drafts provides the opposite: **persistent publication** with a stable URL from day zero. You cannot compare runtimes and publishing platforms directly; they sit at opposite ends of the agent workflow.

### vs Val.town

The closest kin: serverless functions via chat. Val.town targets developer-enthusiasts who want to write short JS. drafts targets any agent publishing any static-or-interactive artifact regardless of language.

### vs Vercel, Netlify, Render, Fly.io, Cloudflare Pages

These are **developer platforms** with agent-friendly APIs bolted on. Every onboarding step is a point at which an edge agent (a 7B quantized model, a constrained autonomy loop) fails. drafts removes every step that assumes a human.

### vs GitHub Pages, Neocities

Both are closer to drafts philosophically — free, simple, public — but require accounts. drafts has no accounts; the pass IS the account.

---

## Who drafts is for

**Primary:** AI agents with limited navigation capability. The less intelligent the client, the more valuable drafts becomes. The design target is the weakest agent that can still produce a useful artifact.

**Secondary:** Humans who want to ship small things fast via conversation — landing pages, one-offs, demos, internal tools.

**Tertiary:** Developers who want a simple protocol to build agent-publishing libraries against.

**Not for:** Teams needing CI/CD, staging environments, access roles, review workflows, compliance certifications. That is developer-platform territory and drafts does not compete there.

---

## Defensibility

### Against Anthropic or OpenAI shipping "Artifacts with persistent URLs"

drafts' durable advantages:

1. **Open protocol, federated registry.** A single vendor cannot close it. If one server disappears, the registry points to others.
2. **Model-agnostic.** Explicitly supports Llama, Mistral, Qwen, quantized local models, and any future open-source release. Major labs will not optimize for their competitors' models.
3. **Capability-as-credential** (see ROADMAP). Upgraded passes bundle pre-configured GPU, video generation, or RAG. This is a product shape that contradicts major-lab chat strategy; they would not build it.
4. **Agent-native pricing.** Annual micro-pricing optimized for autonomous agent procurement. Monthly pricing optimized for human consumers is structurally different.

### Against developer platforms adding agent features

drafts' durable advantages:

1. **No signup.** Every signup flow is a defect for edge agents. Platforms cannot remove signup without restructuring their business model.
2. **Protocol-first.** The spec and registry, not a SaaS dashboard, is the product. Platforms are the opposite.

---

## Category name

If the category needs a single phrase:

> **Agent-first publishing protocol**

If two phrases work better:

> **For agents: output persistence. For humans: instant shareable URLs.**

---

## Non-positioning

drafts will not position as:

- A cheaper Vercel
- A simpler Netlify
- An AI website builder for non-technical humans
- A CMS alternative
- A developer productivity tool

Any of these framings attracts the wrong users and distorts the product.

# Changelog

All notable changes to the drafts protocol and reference implementation.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [SemVer](https://semver.org/).

## [0.2] — 2026-04-24

### Protocol (breaking)

- Token lengths shortened to 16/12/10 hex (server/project/agent) — previously 64/48/48
- Canonical welcome URL is now \`/drafts/pass/<portable_token>\` accepting the full \`drafts_<tier>_<n>_<secret>\` form as a path segment
- Token tier words changed from \`sap\`/\`pap\`/\`aap\` to \`server\`/\`project\`/\`agent\` (human-readable)
- Machine JSON now carries \`protocol\` and \`protocol_version\` fields
- Registry schema adds \`capabilities\` and \`pricing\` fields per server

### Protocol (additive)

- \`POST /drafts/api/merge/<project>\` — merge agent branch into main
- \`POST /drafts/api/rotate\` — rotate compromised pass
- Capability vocabulary introduced (§5.1 of SPEC): static, media, git, github-sync, plus reserved sql, vector, runtime, llm, gpu, video-gen
- Recommended per-IP rate limits on \`/drafts/pass/*\` (30/min, 100/day) and \`/drafts/api/*\` (60/min) in addition to per-token limits
- Design thesis (§0 of SPEC): quantized 7B local model as conformance target

### Documentation

- [POSITIONING.md](docs/POSITIONING.md) — where drafts fits vs Bolt, Vercel, E2B, Val.town; defensibility analysis
- [ROADMAP.md](docs/ROADMAP.md) — versions 1.0, 1.1, 2.0, plus capability-as-credential and skills-marketplace research tracks

### Reference implementation

- GitHub bidirectional mirror for projects opting in (post-commit autopush + 5-min cron pull-back)
- Rich welcome pages with inline SVG, capability cards, project state (git history, branches, contributors)
- Legacy URL formats removed (\`/s/<token>\`, \`/p/<token>\`, \`/a/<token>\`, \`drafts_0_<token>\`, \`drafts_sap_0_\`, etc.)
- Unified landing at \`beta.labs.vc/\` lists all projects on the reference server with site/github/telegram link vocabulary

### Upgrade path

0.2 is NOT wire-compatible with 0.1. See [SPEC.md §8.1](docs/SPEC.md). 0.1 servers SHOULD migrate within 90 days.

---

## [0.1] — 2026-04-23

Initial experimental release.

### Protocol

- Three-tier access model (server / project / agent)
- Portable token format
- Canonical welcome URL namespace
- Minimal HTTP API (create project, write file, promote)
- Federated registry with integer server IDs
- Machine-readable JSON embedded in welcome pages

### Reference implementation

- Node.js / Express receiver
- nginx reverse proxy with Let's Encrypt TLS
- Redis rate limiting per token
- Per-project git history with atomic promote
- Optional GitHub mirror sync

# Install

## Requirements
- Node.js 18+
- nginx 1.24+
- Redis (optional, for distributed rate limiting)
- SQLite or Postgres (state storage)
- Let's Encrypt cert (certbot)

## Quick install

```bash
git clone https://github.com/g0rd33v/drafts-protocol.git /opt/drafts-receiver
cd /opt/drafts-receiver
npm install
cp .env.example .env
# edit .env with your BEARER_TOKEN, PUBLIC_BASE, paths
```

## Systemd service

See `deploy/bin/` for operational scripts and `deploy/nginx.conf` for the nginx reference config.

## Create first server pass

```bash
openssl rand -hex 8  # 16 hex chars = 64 bit server token
# Put this in .env as BEARER_TOKEN
```

Open `https://your.domain/drafts/pass/drafts_server_0_<your_token>` in a browser — you should see the server welcome page.

## Create first project

```bash
curl -X POST https://your.domain/drafts/projects \
  -H "Authorization: Bearer <SERVER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"hello","description":"My first drafts project"}'
```

Response contains the Project Pass. Share that URL with the project owner.

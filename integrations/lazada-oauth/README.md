# Lazada OAuth local adapter

This isolated Node.js service keeps the Commerce Ops main server unchanged and
binds only to `127.0.0.1:8977`. Cloudflare Tunnel supplies the public HTTPS
edge; no inbound firewall port is required.

The adapter supports three Lazada applications and multiple stores per app.
OAuth state, authorization codes, and tokens are always associated with an
`app_id`. Store tokens use `(app_id, shop_id)` as the SQLite primary key, so a
new authorization cannot overwrite another store.

## Routes

- `GET /health` — service and app-count health check.
- `GET /lazada/apps` — non-secret app configuration and store counts.
- `GET /lazada/apps/:appId/auth` — creates a one-time state and redirects to Lazada.
- `GET /lazada/apps/:appId/callback` — validates app-bound state and receives `code`.
- `POST /lazada/apps/:appId/token` — exchanges a pending code and saves that store.
- `GET /lazada/status` — backward-compatible App 1 status plus aggregate counts.
- `GET /lazada/manager` — localhost-only centralized store/token metadata page.
- `GET /lazada/stores` — localhost-only metadata API; token values are omitted.

The original App 1 routes remain available:

- `/lazada/auth`
- `/lazada/callback`
- `/lazada/token`

## Callback URLs

Each Lazada app may technically register the same callback, but this adapter
uses distinct paths so the returned code is unambiguously matched with the
correct App Key and App Secret:

```text
App 1: https://PUBLIC_HOST/lazada/callback
App 2: https://PUBLIC_HOST/lazada/apps/app-2/callback
App 3: https://PUBLIC_HOST/lazada/apps/app-3/callback
```

The `redirect_uri` sent with each App Key must exactly match that app's Callback
URL in Lazada Open Platform.

## Configuration and storage

App 1 continues to use `LAZADA_APP_KEY`, `LAZADA_APP_SECRET`, and
`LAZADA_CALLBACK_URL`. App 2 and App 3 use the numbered variables documented in
`.env.example`.

On first startup the service generates `LAZADA_TOKEN_ENCRYPTION_KEY` in the
Git-ignored `.env`. SQLite stores AES-256-GCM encrypted tokens in
`lazada_store_tokens`. To preserve the local-development secret policy, a
per-store `.env` mirror is also written using names such as:

```text
LAZADA_STORE_APP_2_TH1ABC_ACCESS_TOKEN
LAZADA_STORE_APP_2_TH1ABC_REFRESH_TOKEN
LAZADA_STORE_APP_2_TH1ABC_EXPIRE_TIME
```

Never print, commit, or share `.env`, the encryption key, or token values.

## Local commands

```powershell
npm run start:lazada-oauth
Invoke-RestMethod http://127.0.0.1:8977/health
Start-Process http://127.0.0.1:8977/lazada/manager
```

For a free development tunnel, set `CLOUDFLARE_TUNNEL_MODE=quick` and run:

```powershell
npm run start:lazada-tunnel
```

The runner records the assigned `trycloudflare.com` host and all three callback
paths in `.env` and `storage/lazada-quick-tunnel.json`. Restart the OAuth service
after a new Quick Tunnel host is assigned. Because Quick Tunnel hosts change on
restart, all three Lazada app Callback URL settings must then be updated.

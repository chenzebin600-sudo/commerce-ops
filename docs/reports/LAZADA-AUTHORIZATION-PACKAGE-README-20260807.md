# Lazada Authorization Package

This branch packages the reusable Lazada OAuth and Platform Connector implementation for
Commerce Ops. The GitHub repository is public, so the committed authorization inventory is an
aggregate-only manifest.

## Included

- Multi-application OAuth routes for Apps 1-3.
- Centralized encrypted authorization storage and shop/token metadata management.
- Lazada Connector, Commerce API Gateway, request audit, automatic access-token refresh, and
  fail-closed provider writes.
- Order, order-item, product, inventory, and guarded ReadyToShip capabilities.
- A configuration template containing environment-variable names and non-sensitive examples.
- Automated tests and architecture documentation.
- A sanitized snapshot showing 40 active shop authorizations split across Apps 1 and 2.

## Deliberately excluded

The branch contains no `.env`, App Secret, access token, refresh token, token encryption key,
OAuth code/state, encrypted SQLite database, live Cloudflare hostname/token, shop identity,
seller identity, customer data, or order data. Encrypted tokens are also excluded because a
public Git repository is not an approved backup or secret-distribution channel.

## Restore or deploy

1. Copy `integrations/lazada-oauth/lazada.env.example` variable names into the deployment's
   secret environment.
2. Supply each Lazada App Key and App Secret through that secret environment.
3. Generate a new local token-encryption key and keep it in the same secret environment.
4. Start the OAuth service and authorize each whitelisted shop through Lazada OAuth.
5. Verify `/lazada/status`, `/lazada/manager`, and `/api/platform/status` without printing token
   values.
6. Keep `COMMERCE_PLATFORM_WRITES_ENABLED=false` until a separately reviewed execution enables a
   narrowly scoped provider write.

Moving existing live authorizations to another machine requires an approved encrypted backup of
both the local authorization database and its encryption key through a private secret-management
channel. GitHub branches, including private branches in this public repository, must not be used
for that transfer.

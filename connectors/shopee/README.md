# Shopee Connector

Shopee uses the same Commerce Platform Gateway contract as Lazada, but its
credential ownership is delegated to the company Mac mini relay. Commerce Ops
never needs `partner_id`, `partner_key`, `access_token`, or `refresh_token` for
business reads.

## Runtime flow

```text
Business module / Agent
  -> CommercePlatformGatewayService
  -> ShopeeConnector (normalized contract)
  -> ShopeeRelayClient (fixed read-only operation map)
  -> POST /api/shopee/call with method=GET
  -> Shopee Open Platform
```

The relay itself accepts provider write paths. This connector deliberately does
not: callers provide a semantic operation such as `get_order_list`, and the
client selects one of six fixed provider paths. It never accepts `api_path`,
`method`, or `body` from a business request.

Enabled Gateway capabilities:

- `get_shop`
- `get_orders` and cursor pagination (maximum 15-day query window)
- `get_order_items` with a PII-minimized detail field list
- `get_products` (maximum 20 products per page)
- `get_inventory`
- `get_finance_transactions`, implemented as the official Payment API
  `generate_income_report` → `get_income_report` XLSX flow. The
  downloaded XLSX URL must use an allowlisted Shopee HTTPS host and is bounded
  to 64 MiB before country-specific parsing.

Income-statement access is separately controlled by the Shopee application and
shop authorization. A healthy `get_shop` call does not prove that Payment API
report generation is enabled. Profit calculation therefore fails closed and
keeps manual XLSX import available when the relay or provider denies the report.

Shopee write capabilities and authorization/token endpoints are not registered.
The Gateway global write switch remains an additional fail-closed control.

## Configuration

Copy `connectors/shopee/shopee.env.example` into the repository's untracked
`.env.local` and provide values through your approved secret channel. Never
commit a real API key.

`SHOPEE_RELAY_*` is preferred. During migration, the relay resolver also accepts
the legacy `SHOPEE_TOKEN_SERVICE_*` variable names because both services share
the same internal base URL and API key.

## Optional authorization inventory sync

`node scripts/sync-shopee-tokens.mjs` previews the employee's visible shops and
binding state. Add `--apply` only when an encrypted local authorization cache is
explicitly required. The business connector does not read that cache; the Mac
mini remains the only refresh-token owner.

## Shared API endpoints

Use the provider-neutral Gateway routes, for example:

```text
GET /api/platform/shop?platform=shopee&shop_id=<shop_id>
GET /api/platform/orders?platform=shopee&shop_id=<shop_id>&created_after=<ISO>&limit=20
GET /api/platform/order-items?platform=shopee&shop_id=<shop_id>&order_id=<order_sn>
GET /api/platform/products?platform=shopee&shop_id=<shop_id>&limit=20&offset=0
GET /api/platform/inventory?platform=shopee&shop_id=<shop_id>&limit=20&offset=0
GET /api/platform/finance-transactions?platform=shopee&shop_id=<shop_id>&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
```

Other modules and Agent tools must use these routes or the Gateway service, not
the internal relay directly.

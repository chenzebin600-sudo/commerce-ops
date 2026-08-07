# Commerce Platform Connector Layer

This directory is the only code layer allowed to communicate with marketplace and ERP APIs.
Business modules and AI Agents call `CommercePlatformGatewayService`; they do not construct a
Lazada, Shopee, TikTok Shop, or Mabang client directly.

## Layout

- `base/`: connector contract, capabilities, registry, and safe errors.
- `persistence/`: platform/shop/authorization/request-log control plane.
- `security/`: authenticated encryption for access and refresh tokens.
- `lazada/`: direct OAuth connector with local signing, shop, orders, products, and inventory.
- `shopee/`: delegated company-relay connector with fixed read-only shop, order, product, and inventory operations.
- `tiktok/`, `mabang/`: reserved extension seams with implementation checklists.
- `runtime.mjs`: application composition root. It is the only place that binds environment
  application credentials to a concrete connector factory.

## Connector contract

Concrete connectors extend `BaseConnector` and declare supported capabilities:

- `authenticate`
- `refresh_token`
- `get_shop`
- `get_orders`
- `get_order_items`
- `ready_to_ship`
- `get_products`
- `update_product`
- `get_inventory`
- `update_inventory`

Provider payloads must be normalized before returning. Tokens and app secrets must never appear
in returned records, API logs, exceptions intended for clients, or Agent contexts.

## Adding a platform

1. Implement a connector below `connectors/<platform>/`.
2. Normalize provider models to the Gateway result shapes.
3. Register one factory in `connectors/runtime.mjs`; resolve secrets there from `.env` only.
4. Add contract, encryption, retry, rate-limit, audit, and fail-closed write tests.
5. Enable the seeded platform status only after read-only production validation.

Authorization ownership can be either `required` (the Gateway loads encrypted local credentials,
as Lazada does) or `delegated` (an internal credential broker signs upstream requests, as Shopee
does). Delegated connectors must expose semantic operations through fixed allowlists and must not
accept arbitrary provider paths or HTTP methods from callers.

Do not add provider SDK imports to business modules or Agent code. Agent Tool Registry entries
must declare `external_access: "gateway_only"` and execute the Gateway service.

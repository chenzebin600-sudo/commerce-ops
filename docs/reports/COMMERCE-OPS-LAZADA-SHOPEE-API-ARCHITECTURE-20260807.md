# Commerce Ops Lazada + Shopee API Architecture

Date: 2026-08-07

## Outcome

Lazada and Shopee now share one provider-neutral Commerce Platform Gateway and
normalized shop, order, product, and inventory contracts. Their authorization
implementations intentionally differ:

| Concern | Lazada | Shopee |
|---|---|---|
| Credential ownership | Commerce Ops encrypted store | Company Mac mini relay |
| Provider signing | Local Lazada connector | Relay |
| Gateway authorization mode | `required` | `delegated` |
| Access/refresh token available to business code | No | No |
| Read capabilities | Shop, orders, order items, products, inventory | Shop, orders, order items, products, inventory |
| Write capabilities | Implemented but globally gated | Not registered |

```text
                         +-----------------------+
Business modules/Agents -> Commerce API Gateway |
                         +----------+------------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
            LazadaConnector                     ShopeeConnector
            local signing                       fixed read map
                  |                                   |
            Lazada Open API                    Company relay
                                                      |
                                                Shopee Open API
```

## Shopee safety boundary

The internal relay accepts arbitrary Shopee API paths and currently permits
write calls. Commerce Ops therefore adds a stricter boundary:

1. The relay client accepts only semantic operation names.
2. Six audited provider paths are compiled into the client.
3. Every upstream provider method is forced to `GET`.
4. Authorization and token paths cannot be selected.
5. Shopee does not advertise any write capability, even if the global Gateway
   write switch is enabled.
6. Relay and provider errors are classified without reflecting API keys or raw
   credential-bearing responses.

The allowed provider paths are shop information, order list, order detail,
item list, item base information, and model list.

## Authorization behavior

Lazada continues to load encrypted credentials from the connector repository
and refresh a credential group when needed. Shopee uses delegated authorization:
the Gateway resolves the shop and records an audit entry but never loads or
decrypts a local Shopee token. A shop not bound at the relay returns the relay's
not-bound result.

The optional token inventory synchronizer remains available for binding audits
and controlled migration. It is not on the Shopee business-data request path.

## Validation evidence

- 19 focused connector/Gateway tests passed.
- The Shopee relay was validated through the Commerce Platform Gateway against
  one active shop in each available country: TH, PH, MY, SG, TW, and VN.
- Vinco MALL read validation returned one recent order, two products with ten
  normalized SKUs, and four inventory records from a one-product inventory page.
- Runtime write mode was false, and no Shopee provider write request was made.
- Current organization inventory contains 56 visible Shopee shops: 42 bound and
  14 unbound. Unbound shops remain visible but return a not-bound error until the
  company relay completes authorization.

## Collaborator setup

1. Check out the shared feature branch.
2. Configure Lazada secrets using `integrations/lazada-oauth/lazada.env.example`.
3. Configure Shopee relay secrets using `connectors/shopee/shopee.env.example`.
4. Obtain all real keys through the approved internal secret channel. Never put
   them in Git, screenshots, chat, query strings, or logs.
5. Start Commerce Ops and confirm `/api/platform/status` lists both connectors.
6. Access marketplace data through `/api/platform/*` or registered Agent tools.

The branch contains code, tests, and sanitized examples only. It deliberately
does not contain application secrets, provider tokens, local SQLite databases,
backups, or real internal API keys.

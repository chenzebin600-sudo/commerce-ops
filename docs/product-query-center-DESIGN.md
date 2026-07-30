# DESIGN.md: 产品查询中台

## Source

- URL: https://impurity-doorway-elm.ngrok-free.dev/
- Capture date: 2026-07-20
- Evidence: live HTML/CSS/JavaScript, desktop/mobile screenshots, interactive detail-drawer walkthrough

## Reference Screenshot

![Full-page screenshot of 产品查询中台](../.firecrawl/product-center-actual.png)

Use this screenshot as the visual source of truth for layout, hierarchy, density, and feel.

## Design Summary

A restrained, data-dense operations console. It uses an off-white canvas, white bordered panels, dark teal actions, compact typography, small radii, subtle shadows, status pills, and a wide server-paginated table. Decorative imagery is absent; product thumbnails and operational status carry the visual hierarchy.

## Design Tokens

### Colors

```css
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --line: #e1e5ea;
  --line-strong: #c9d1da;
  --text: #1f2933;
  --muted: #667085;
  --soft: #8a94a3;
  --accent: #176b5b;
  --accent-dark: #0f4f43;
  --accent-soft: #e8f4f1;
  --danger: #b42318;
  --warning: #b54708;
  --shadow: 0 14px 34px rgba(15, 23, 42, 0.07);
}
```

### Typography

- Stack: `Inter, "SF Pro Display", "Segoe UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif`
- Body: 14px
- Page title: 30px / 1.15 / weight 760
- Modal title: 20px; drawer title: 22px
- Labels, column headers, badges, metadata: 12px
- SKU and operational labels use heavier 720-780 weights

### Spacing And Layout

- Main container: `min(1480px, 100% - 40px)`; 34px top padding
- Common gaps: 7, 8, 10, 12, 14, 16, 18, 24px
- Inputs/buttons: 42px high, 6px radius
- Panels: 8px radius, 1px border, subtle shadow
- Search panel: six-column grid on desktop, one column below 900px
- Table: minimum 1080px desktop; minimum 980px below 900px; horizontal overflow
- Detail drawer: maximum 520px; slides from right in 200ms
- Modal: 760px default; image viewer 1080px; editor 1120px

## Components

- Top bar with eyebrow, title, three ghost import actions, and health-status pill
- Search panel with SKU, name, country, tag, primary search, and ghost reset
- Summary row with result range and page-size selector
- Sticky-header table with 62px product thumbnails
- Product cells with SKU, title, and two-line muted specification
- Status pills for hot/normal and generated/manual/skipped/failed/pending AI states
- Two-column action grid with 32px compact buttons
- Right-side detail drawer with hero image, facts, specifications, selling points, scenarios, and sticky actions
- Native modal dialogs for imports, product editing, image management, and dark image viewing
- Centered previous/next pagination

## Page Patterns

1. Header and service state
2. Query conditions
3. Result summary and page size
4. Wide product table
5. Pagination
6. Contextual overlays: detail drawer first, dialogs for deeper tasks

On mobile, controls stack vertically but the data table deliberately remains wide and scrollable. For a mobile-first derivative, replace each table row with a product card instead of shrinking the columns.

## Content Style

- Functional and concise Chinese labels
- English eyebrow used only as a small product identifier
- Status copy describes both state and infrastructure availability
- Import dialogs explain the expected files and return audit-like counters and failure samples
- AI content is structured as one point or scenario per line

## Agent Build Instructions

1. Use semantic HTML, native dialog elements, CSS Grid/Flexbox, and a small JavaScript state object.
2. Keep the canvas quiet and the information density high; do not add gradients, large illustrations, glass effects, or oversized cards.
3. Reuse the exact tokens above and keep radii at 6-8px except for status pills.
4. Render untrusted product content with `textContent`, not interpolated `innerHTML`.
5. Load countries and health independently, then request the first product page.
6. Open the detail drawer immediately with row data and refresh it asynchronously with the detail endpoint.
7. Preserve server-side pagination, explicit loading/empty/error states, and disabled pagination boundaries.
8. Use the desktop screenshot for hierarchy and density; treat mobile horizontal table scrolling as a known compromise.

## Rerun Inputs

```yaml
workflow: firecrawl-website-design-clone
source_url: https://impurity-doorway-elm.ngrok-free.dev/
target_stack: vanilla-html-css-js
output: docs/product-query-center-DESIGN.md
```

# Design

## Overview
An internal ecommerce operations suite with a left navigation shell and dense analytical workspaces. The design serves repeated daily use: calm surfaces, strong hierarchy, compact controls, and readable tables.

## Design Tokens

### Color
- Background: cool near-white operational canvas.
- Surface: white primary cards and panels.
- Surface alternate: cool tinted sidebar/tool surfaces.
- Ink: high-contrast navy slate for all body text.
- Muted: darker blue-gray for secondary text, still AA on light surfaces.
- Primary: deep teal for main actions and selected states.
- Secondary: blue for navigation links, secondary actions, and analytical emphasis.
- Success, warning, danger: semantic colors only.

### Typography
- Font stack: system UI with Chinese fallbacks.
- Product UI scale: compact fixed sizes, no fluid heading scale.
- Headings: 16-28px, bold, balanced.
- Labels and table headers: 12-14px, strong weight.
- Body and table cells: 14-15px.

### Shape
- Panels/cards: 8-10px radius.
- Inputs/buttons: 8px radius.
- Image thumbnails: 6px radius.
- Avoid oversized rounded cards.

### Spacing
- Page padding: 24-28px desktop, 16px mobile.
- Panel padding: 16-20px.
- Control gaps: 10-14px.
- Section gaps: 16-20px.

## Components
- Left sidebar navigation with clear active state.
- Panels for functional areas, not nested decorative cards.
- Dense form grids that collapse to one column on mobile.
- Scrollable tables with sticky-looking header treatment and row hover.
- Modal overlay for long-running extraction/verification states.
- Iframe container for the Lazada ad analysis sub-app.

## Interaction
- Buttons have default, hover, focus, disabled states.
- Inputs have visible focus rings.
- Data rows use subtle hover states.
- Motion is limited to short transitions for state feedback.

## Implementation Notes
- Use restrained product register styling.
- Prefer consistency between the main app and embedded ad analyzer.
- Avoid heavy drop shadows on bordered elements.

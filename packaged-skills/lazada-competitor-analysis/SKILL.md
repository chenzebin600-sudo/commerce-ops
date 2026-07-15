---
name: lazada-competitor-analysis
description: Extract Lazada product page data and produce competitor comparisons for product titles, shop names, main images, image links, ratings, review counts, matched SKU price advantages, Product Details advantages, main-image click-through analysis, and actionable listing recommendations. Use when the user provides Lazada product links and asks for product extraction, competitor analysis, SKU price comparison, product detail comparison, main-image analysis, listing optimization, or image display/download for Lazada pages.
---

# Lazada Competitor Analysis

Use this skill to compare a user's Lazada product page with one or more competitor Lazada product pages.

## Workflow

1. Open or reuse a visible Chrome session with remote debugging.
   - Lazada often blocks normal scraping with captcha.
   - If blocked, ask the user to complete captcha/login in the visible browser, then continue using the same session.
2. Extract each product using `scripts/extract_lazada_compare.mjs` when possible.
   - The script reads `window.__moduleData__` from the rendered page.
   - It skips video posters and uses the first real gallery image after the video as the main image.
   - It downloads main images to a local output folder so they can be displayed with absolute local paths.
3. Compare products in this order:
   - Link title
   - Shop name
   - Main image and main image link
   - Rating, with advantage marked
   - Review count, with advantage marked
   - Horizontally matched SKU price comparison
   - Product Details differences and advantage
   - Main image click-through analysis when requested
   - Conclusion and recommendations
4. For main image analysis, apply the ecommerce main-image framework:
   - What does the buyer understand in the first second?
   - Is the product visually clear enough for a Lazada thumbnail?
   - What concrete reason makes the buyer click?
   - How is the main image different from competitor images?
   - What exact changes should the next version make?

## Data Rules

- Keep the original main image URL and also display a local downloaded image when available.
- For Lazada gallery images, do not treat the first video poster as the main image. Use the first `type: "img"` entry after the video.
- For main-image analysis, use the real Lazada main image selected by the gallery rule above, not the video poster.
- If only image URLs and structured product data are available, label visual judgments as inferred. Do not claim pixel-level inspection unless image files or screenshots were actually inspected.
- Do not include sales volume unless the user explicitly requests it.
- For SKU names, remove property prefixes such as `Display Size:` and return clean buyer-facing names, for example `15.6''Touchable 75Hz`.
- Use sale price for price comparisons. Include original price and discount when useful.
- For Product Details, use `fields.specifications[skuId].features` from `window.__moduleData__`.
- If a field is unavailable, write `not shown` instead of guessing.

## SKU Matching Heuristics

Match SKU rows before comparing price:

- Normalize inch notation: `15.6''`, `15.6-inch`, and `15.6 inch` are equivalent.
- Match touchscreen/touched/touchable as one class.
- Match standard/non-touch as one class.
- Match resolution tokens such as `1080p`, `1200p`, and refresh-rate tokens such as `60hz`, `75hz`, `120hz`.
- Prefer exact size + touch class + resolution matches.
- If two SKUs are close but not identical, say what differs before marking the advantage.
- Mark price advantage only when the comparable SKU class is clear.

## Product Details Advantage Rules

- Mark the side with clearer, more specific, and buyer-relevant specs as advantaged.
- Treat concrete values as better than vague values, for example `3ms` beats `Info Unavailable`.
- Treat connection fields such as `USB-C`, `Mini HDMI`, `Type C`, and warranty/return fields as conversion-relevant.
- Do not over-credit keyword stuffing. If a field lists many unrelated display technologies, mention that it may look noisy.

## Main Image Analysis Rules

Treat the main image as a click entry, not artwork. Every recommendation must be concrete enough for a designer or image-generation prompt.

Analyze:

- Product and user judgment: product type, target user, usage scenario, pain points, purchase concerns, strongest click reason.
- First-second information: visual focus, product clarity, main selling point, information load, thumbnail readability.
- Click reason: pain-point solution, result promise, trust proof, scenario identification, price/value, bundle/convenience.
- Composition structure: big product + one-line selling point, product + trust labels, pain scene + solution, before/after, multi-SKU/bundle, or scenario + result.
- Competitor comparison: first visual focus, main selling point, product clarity, trust elements, scenario identification, differentiation.
- Next-version checklist: must change, nice to improve, keep, and A/B test directions.
- Reusable template: suitable category, audience, selling-point formula, structure, headline rule, label rule, trust elements, test directions.
- Optional score: product recognition, product clarity, selling-point specificity, information hierarchy, trust proof, competitor differentiation, actionability.

## Output Shape

Use concise Chinese output unless the user asks otherwise:

1. Link title
2. Shop name
3. Main image
4. Main image link
5. Rating comparison
6. Review count comparison
7. Matched SKU price comparison, with advantage labels
8. Product Details differences and advantage labels
9. Main image analysis when requested:
   - Product and user judgment
   - First-second information diagnosis
   - Click reason and short headline options
   - Composition recommendation
   - Competitor main-image comparison
   - Next-version revision checklist
   - Reusable product template
   - Optional score
10. Conclusion and recommendations

For local images, use absolute filesystem paths in Markdown image tags.

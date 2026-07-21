import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { groupPublicationChecks } from "../public/product-center-page.mjs";

const html = () => fs.readFile("public/index.html", "utf8");
const ui = () => fs.readFile("public/product-center-page.mjs", "utf8");
const css = () => fs.readFile("public/styles.css", "utf8");

const workflowIds = [
  "workflowProductFacts", "workflowListingStrategy", "workflowProductCopy",
  "workflowImageAssets", "workflowCommerceLogistics", "workflowPublicationChecks",
];
const legacyModuleIds = [
  "workbenchProductInfo", "workbenchListingTarget", "workbenchPositioning", "workbenchTitle", "workbenchSubtitle",
  "workbenchDescription", "workbenchAi", "workbenchVariants", "workbenchMedia", "workbenchAiImages",
  "workbenchLogistics", "workbenchAttributes", "workbenchValidation",
];

test("01 page exposes the six-step listing flow", async () => {
  const source = await html();
  for (const id of workflowIds) assert.match(source, new RegExp(`id=["']${id}["']`));
  assert.equal([...source.matchAll(/data-workbench-section/g)].length, 6);
});

test("02 all thirteen existing business modules remain present", async () => {
  const source = await html();
  for (const id of legacyModuleIds) assert.match(source, new RegExp(`id=["']${id}["']`));
});

test("03 workflow navigation scrolls to the matching step instead of switching tabs", async () => {
  const [markup, source] = await Promise.all([html(), ui()]);
  for (const id of workflowIds) assert.match(markup, new RegExp(`data-workbench-anchor=["']${id}["']`));
  assert.match(source, /scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.doesNotMatch(markup, /data-product-edit-tab/);
});

test("04 workflow states use the frozen status vocabulary", async () => {
  const source = await ui();
  for (const status of ["not_started", "incomplete", "ready", "generating", "generated", "manually_modified", "stale", "completed", "blocked"]) assert.match(source, new RegExp(`${status}:`));
});

test("05 secondary product facts are collapsed by default", async () => {
  const source = await html();
  assert.match(source, /<details id="productExtendedFacts" class="workbench-disclosure">/);
  assert.doesNotMatch(source, /<details id="productExtendedFacts"[^>]+open/);
  assert.match(source, /展开全部产品信息/);
});

test("06 listing strategy has one unified primary AI entry", async () => {
  const source = await html();
  assert.match(source, /id="generateListingStrategyBtn"[^>]+data-generate-ai-types="target_audience,product_positioning,content_style,usage_scenarios"/);
});

test("07 complete product copy can be generated from one entry", async () => {
  const source = await html();
  assert.match(source, /id="generateListingCopyBtn"[^>]+data-generate-ai-types="listing_title,listing_subtitle,listing_description,selling_points,usage_scenarios"/);
});

test("08 per-field regeneration remains available as secondary actions", async () => {
  const source = await html();
  for (const type of ["listing_title", "listing_subtitle", "listing_description", "selling_points,usage_scenarios"]) assert.match(source, new RegExp(`data-generate-ai-types=["']${type}["']`));
  assert.match(source, /workbench-secondary-actions/);
});

test("09 AI history remains in a separate dialog", async () => {
  const source = await html();
  const workbenchEnd = source.indexOf("</dialog>", source.indexOf('id="productEditDialog"'));
  const historyStart = source.indexOf('id="productAiHistoryDialog"');
  assert.ok(historyStart > workbenchEnd);
});

test("10 upstream changes mark adopted downstream content stale", async () => {
  const source = await ui();
  assert.match(source, /function markAiContextStale\(\)/);
  assert.match(source, /state\.aiContextStale = listingStaleSignature\(\) !== state\.aiContextBaseline/);
  assert.match(source, /listingAiStaleScope/);
});

test("11 affected regeneration previews scope and preserves manual content", async () => {
  const source = await ui();
  assert.match(source, /function previewAndRegenerateAffectedContent\(\)/);
  assert.match(source, /当前已采用内容和人工修改会保留/);
  assert.match(source, /defaultView\?\.confirm/);
});

test("12 image planning depends on strategy, copy and non-stale context", async () => {
  const source = await ui();
  assert.match(source, /function imagePlanPrerequisites\(\)/);
  assert.match(source, /strategyIsReady\(\) && copyIsReady\(\) && !state\.aiContextStale/);
});

test("13 publication checks are grouped and can locate exact fields", () => {
  const groups = groupPublicationChecks([
    { code: "TITLE_REQUIRED" }, { code: "PRIMARY_IMAGE_REQUIRED" }, { code: "PRICE_REQUIRED" }, { code: "UNKNOWN" },
  ]);
  assert.deepEqual(groups.map((group) => group.key), ["product_copy", "image_assets", "commerce_logistics", "publication_checks"]);
});

test("14 every workflow step exposes exactly one primary operation", async () => {
  const source = await html();
  assert.equal([...source.matchAll(/class="workflow-primary-action"/g)].length, 6);
  for (const id of ["confirmProductFactsBtn", "generateListingStrategyBtn", "generateListingCopyBtn", "generateImagePlanBtn", "saveCommerceInfoBtn", "runPublicationChecksBtn"]) assert.match(source, new RegExp(`id=["']${id}["']`));
});

test("15 mobile workbench suppresses page-level horizontal overflow", async () => {
  const source = await css();
  assert.match(source, /@media \(max-width: 700px\)[\s\S]*?\.workbench-scroll \{ overflow-x: hidden; \}/);
  assert.match(source, /\.workbench-navigation[\s\S]*?overflow-x: auto/);
});

test("16 listing UI still cannot mutate product package source rows", async () => {
  const sources = await Promise.all([
    "lib/product-center/product-ai-content-service.mjs", "lib/product-center/product-listing-service.mjs",
    "lib/data/repositories/product-ai-content-repository.mjs", "lib/data/repositories/product-listing-repository.mjs",
  ].map((file) => fs.readFile(file, "utf8")));
  assert.doesNotMatch(sources.join("\n"), /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:app\.)?product_package_rows/i);
});

test("17 current listing, AI history and image task APIs remain wired", async () => {
  const source = await ui();
  for (const route of ["/listing-drafts", "/ai/listing/generate", "/ai/contents", "/ai/images/tasks"]) assert.match(source, new RegExp(route.replaceAll("/", "\\/")));
});

test("18 information architecture refactor does not introduce migration 013", async () => {
  const files = await fs.readdir("migrations");
  assert.equal(files.some((name) => /^013_/.test(name)), false);
});

test("19 mainline workflow files do not include growth radar work", async () => {
  const source = `${await html()}\n${await ui()}\n${await css()}`;
  assert.doesNotMatch(source, /growth[-_ ]radar|增长雷达/i);
});

test("20 workflow steps can collapse without removing their content", async () => {
  const [markup, styles, source] = await Promise.all([html(), css(), ui()]);
  assert.equal([...markup.matchAll(/data-toggle-workflow-step=/g)].length, 6);
  assert.match(styles, /\.workflow-step\.collapsed > :not\(\.workflow-step-header\)/);
  assert.match(source, /classList\.toggle\("collapsed"\)/);
});

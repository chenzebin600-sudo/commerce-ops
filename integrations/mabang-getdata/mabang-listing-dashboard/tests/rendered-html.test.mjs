import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Mabang listing dashboard shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-CN"/i);
  assert.match(html, /<title>马帮刊登工作台<\/title>/i);
  assert.match(html, /多店铺刊登控制台/);
  assert.match(html, /实时接口|等待连接/);
  assert.match(html, /可预览并同步/);
  assert.match(html, /Shopee \/ TikTok Shop：已接入 SKU 替换与规格值修改/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);

  const stylesheetHrefs = Array.from(
    html.matchAll(
      /<link[^>]+rel="stylesheet"[^>]+href="(?<href>\/assets\/[^"]+\.css)"/gi,
    ),
    (match) => match.groups?.href,
  ).filter(Boolean);
  assert.ok(
    stylesheetHrefs.length > 0,
    "rendered HTML should reference a stylesheet",
  );
  await Promise.all(
    stylesheetHrefs.map((href) =>
      access(new URL(`../dist/client${href}`, import.meta.url)),
    ),
  );
});

test("keeps a sanitized listing snapshot as an offline fallback", async () => {
  const snapshot = JSON.parse(
    await readFile(
      new URL("../public/listings-index.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(snapshot.meta.source, "马帮 ERP 刊登");
  assert.equal(snapshot.meta.mode, "只读快照");
  assert.equal(snapshot.meta.platform_count, 3);
  assert.equal(snapshot.meta.shop_count, 0);
  assert.equal(snapshot.meta.listing_count, 0);
  assert.deepEqual(
    snapshot.platforms.map((platform) => platform.name),
    ["Lazada", "Shopee", "TikTokShop"],
  );
  const files = Object.values(snapshot.data_files)
    .flatMap((platformFiles) => Object.values(platformFiles))
    .flat();
  const chunks = await Promise.all(
    files.map(async (file) =>
      JSON.parse(
        await readFile(
          new URL(`../public${file}`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  );
  assert.equal(chunks.flat().length, 0);
  await access(new URL("../public/og.png", import.meta.url));
});

test("keeps the manual bulk-edit workflow alongside AI commands", async () => {
  const source = await readFile(
    new URL("../app/components/ListingDashboard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /手动批量修改/);
  assert.match(source, /手动批量变更/);
  assert.match(source, /selectAllFilteredResults/);
  assert.match(source, /const generatePreview = async/);
  assert.match(source, /\/batch\/preview/);
  assert.equal(
    source.match(/<BatchPreviewPanel/g)?.length,
    2,
    "AI and manual workflows should each keep their preview panel",
  );
  assert.equal(
    source.match(/key=\{preview\.preview_token\}/g)?.length,
    2,
    "both preview panels must wait for preview data before mounting",
  );
});

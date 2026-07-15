#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const urls = [];
let outDir = path.resolve("lazada-images");
let port = 9222;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--url") urls.push(args[++i]);
  else if (arg === "--out-dir") outDir = path.resolve(args[++i]);
  else if (arg === "--port") port = Number(args[++i]);
}

if (!urls.length) {
  console.error("Usage: node extract_lazada_compare.mjs --url <lazada-url> [--url <url>] [--out-dir lazada-images] [--port 9222]");
  process.exit(2);
}

async function getPageTarget() {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  return list.find((t) => t.type === "page" && (t.url || "").includes("lazada")) ||
    list.find((t) => t.type === "page") ||
    list[0];
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const callId = ++id;
        ws.send(JSON.stringify({ id: callId, method, params }));
        return new Promise((res) => pending.set(callId, res));
      },
      close() {
        ws.close();
      },
    });
    ws.onerror = reject;
  });
}

function extractInPage() {
  const f = window.__moduleData__?.data?.root?.fields || {};
  const abs = (url) => (url ? (url.startsWith("//") ? `https:${url}` : url) : null);
  const galleries = f.skuGalleries?.["0"] || f.skuGalleries?.[f.primaryKey?.skuId] || [];
  const firstImageAfterVideo = galleries.find((g) => g.type === "img" && (g.src || g.poster));
  const mainImage =
    abs(firstImageAfterVideo?.src || firstImageAfterVideo?.poster) ||
    document.querySelector(".gallery-preview-panel-v2__image")?.currentSrc ||
    document.querySelector('meta[property="og:image"]')?.content ||
    null;

  const propValueName = {};
  for (const prop of f.productOption?.skuBase?.properties || []) {
    for (const val of prop.values || []) propValueName[`${prop.pid}:${val.vid}`] = val.name;
  }

  const skus = (f.productOption?.skuBase?.skus || []).map((sku) => {
    const info = f.skuInfos?.[sku.skuId] || (f.skuInfos?.[0]?.skuId === sku.skuId ? f.skuInfos[0] : null) || {};
    const names = (sku.propPath || "").split(";").map((p) => propValueName[p]).filter(Boolean);
    return {
      skuId: sku.skuId,
      name: names.join(" / ") || propValueName[sku.propPath] || sku.propPath || sku.innerSkuId || "not shown",
      salePrice: info.price?.salePrice?.text || null,
      salePriceValue: info.price?.salePrice?.value ?? null,
      originalPrice: info.price?.originalPrice?.text || null,
      discount: info.price?.discount || null,
    };
  });

  const specObj =
    f.specifications?.[f.primaryKey?.skuId] ||
    f.specifications?.[skus[0]?.skuId] ||
    Object.values(f.specifications || {})[0] ||
    {};

  const text = document.body?.innerText || "";
  return {
    url: location.href,
    title: f.product?.title || document.querySelector("h1")?.innerText || document.title || "not shown",
    shopName: f.seller?.name || "not shown",
    mainImage,
    skus,
    rating: f.review?.averageRating ?? f.product?.rating?.score ?? null,
    reviewCount: f.review?.reviews ?? f.review?.contentedNum ?? f.product?.rating?.total ?? null,
    productDetails: specObj.features || specObj || {},
    blocked: /We need to check if you are a robot|reCAPTCHA|_____tmd_____\/punish/i.test(text + location.href),
    moduleReady: Boolean(window.__moduleData__),
  };
}

async function waitForProduct(cdp, timeoutMs = 45000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const out = await cdp.send("Runtime.evaluate", {
      expression: `(${extractInPage.toString()})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    last = out.result?.result?.value || null;
    if (last?.moduleReady && !last?.blocked && last.title) return last;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last;
}

function safeName(index, product) {
  const label = product.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${index + 1}-${label || "lazada"}-main.jpg`;
}

async function downloadImage(url, filePath) {
  if (!url) return null;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://www.lazada.com.ph/",
    },
  });
  if (!response.ok) throw new Error(`Image download failed ${response.status}: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(filePath, bytes);
  return filePath;
}

const target = await getPageTarget();
if (!target) throw new Error(`No Chrome target found on port ${port}`);

await mkdir(outDir, { recursive: true });
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const results = [];
for (const [index, url] of urls.entries()) {
  await cdp.send("Page.navigate", { url });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const product = await waitForProduct(cdp);
  if (product?.mainImage) {
    const localPath = path.join(outDir, safeName(index, product));
    try {
      product.localMainImage = await downloadImage(product.mainImage, localPath);
    } catch (error) {
      product.localMainImageError = error.message;
    }
  }
  results.push(product);
}

cdp.close();
console.log(JSON.stringify(results, null, 2));

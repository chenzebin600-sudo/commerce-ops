import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(".");
const baseUrl = process.env.A2_BASE_URL || "http://127.0.0.1:3193";
const pageUrl = `${baseUrl}/#growth-radar`;
const screenshotDir = path.resolve(process.env.G1B_SCREENSHOT_DIR || "docs/screenshots/growth-radar-g1b");
const orderFixture = path.resolve(process.env.G1B_ORDER_FIXTURE || "storage/development/validation-fixtures/growth-radar-orders-synthetic.xlsx");
const inventoryFixture = path.resolve(process.env.G1B_INVENTORY_FIXTURE || "storage/development/validation-fixtures/growth-radar-inventory-synthetic.xlsx");
const chromeProfile = path.resolve("storage/development/cdp-growth-radar-profile");
const expectedOrigin = new URL(baseUrl).origin;

function findChrome() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForFile(filename, timeout = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (fs.existsSync(filename)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${path.basename(filename)}`);
}

class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.responses = [];
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Network.responseReceived") {
        const response = message.params.response;
        if (response.url.includes("/api/growth-radar/")) this.responses.push({ url: response.url, status: response.status });
      }
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime evaluation failed");
    return result.result.value;
  }

  async waitFor(expression, description, timeout = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      try {
        if (await this.evaluate(expression)) return;
      } catch {}
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`);
    assert(clicked, `Unable to click ${selector}`);
  }

  async setFile(selector, filename) {
    const { root } = await this.send("DOM.getDocument", { depth: 1, pierce: true });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert(nodeId, `File input not found: ${selector}`);
    await this.send("DOM.setFileInputFiles", { nodeId, files: [filename] });
  }

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 600,
      screenWidth: width,
      screenHeight: height,
    });
    await sleep(250);
  }

  async capture(filename, { width, height, focusSelector = null, dialogExpected = false }) {
    await this.setViewport(width, height);
    await this.evaluate(`(() => {
      const target = ${focusSelector ? `document.querySelector(${JSON.stringify(focusSelector)})` : "null"};
      if (target) {
        target.scrollIntoView({ block: "start", inline: "nearest" });
        if (innerWidth <= 600 && !document.querySelector('#grActionDialog[open]')) {
          const stickyNavigationHeight = document.querySelector('.sidebar')?.getBoundingClientRect().height || 0;
          window.scrollBy(0, -(stickyNavigationHeight + 8));
        }
      }
      else window.scrollTo(0, 0);
    })()`);
    await sleep(300);
    const validation = await this.evaluate(`(() => {
      const mainText = document.querySelector('#page-growth-radar')?.innerText || '';
      const dialog = document.querySelector('#grActionDialog[open]');
      const dialogBox = dialog?.getBoundingClientRect();
      return {
        href: location.href,
        origin: location.origin,
        root: Boolean(document.querySelector('#growthRadarRoot')),
        titleMarker: document.body.innerText.includes('确定性货盘增长雷达'),
        workspaceMarker: mainText.includes('数据范围与来源管理'),
        fixtureBanner: mainText.includes('测试/验收数据') && mainText.includes('真实马帮订单/库存样本尚未执行'),
        forbiddenPage: /(?:^|\\n)(?:登录|404|not found|error page)(?:$|\\n)/i.test(mainText.slice(0, 500)),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        tableBounds: Array.from(document.querySelectorAll('.gr-table-wrap')).map((node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
        }),
        dialogOpen: Boolean(dialog),
        dialogContained: !dialogBox || (dialogBox.left >= -1 && dialogBox.right <= innerWidth + 1 && dialogBox.top >= -1 && dialogBox.bottom <= innerHeight + 1),
      };
    })()`);
    assert(validation.origin === expectedOrigin, `${filename}: unexpected origin ${validation.origin}`);
    assert(validation.href !== "about:blank", `${filename}: about:blank is forbidden`);
    assert(validation.root && validation.titleMarker && validation.workspaceMarker, `${filename}: Growth Radar runtime markers missing`);
    assert(validation.fixtureBanner, `${filename}: validation fixture banner missing`);
    assert(!validation.forbiddenPage, `${filename}: forbidden login/error/404 state detected`);
    assert(validation.documentWidth <= validation.viewportWidth + 1, `${filename}: page-level horizontal overflow ${validation.documentWidth}/${validation.viewportWidth}`);
    assert(validation.tableBounds.every((box) => box.left >= -1 && box.right <= validation.viewportWidth + 1), `${filename}: table overflow escaped its container ${JSON.stringify(validation.tableBounds)}`);
    assert(validation.dialogOpen === dialogExpected, `${filename}: dialog state mismatch`);
    assert(validation.dialogContained, `${filename}: dialog is outside viewport bounds`);
    const screenshot = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(path.join(screenshotDir, filename), Buffer.from(screenshot.data, "base64"));
    return validation;
  }

  close() {
    this.socket?.close();
  }
}

async function main() {
  assert(expectedOrigin === "http://127.0.0.1:3193", `Refusing non-A2 origin: ${expectedOrigin}`);
  assert(fs.existsSync(orderFixture), `Order fixture missing: ${orderFixture}`);
  assert(fs.existsSync(inventoryFixture), `Inventory fixture missing: ${inventoryFixture}`);
  assert(orderFixture.startsWith(path.join(projectRoot, "storage", "development")), "Order fixture must stay in isolated development storage");
  assert(inventoryFixture.startsWith(path.join(projectRoot, "storage", "development")), "Inventory fixture must stay in isolated development storage");
  const chrome = findChrome();
  assert(chrome, "System Chrome or Edge was not found");

  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.mkdirSync(chromeProfile, { recursive: true });
  const portFile = path.join(chromeProfile, "DevToolsActivePort");
  if (fs.existsSync(portFile)) fs.unlinkSync(portFile);

  const browser = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${chromeProfile}`,
    "--no-first-run",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-background-networking",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  let cdp;
  try {
    await waitForFile(portFile);
    const [port] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const target = targets.find((item) => item.type === "page");
    assert(target?.webSocketDebuggerUrl, "CDP page target unavailable");
    cdp = new CdpSession(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("DOM.enable");
    await cdp.setViewport(1440, 900);
    await cdp.send("Page.navigate", { url: pageUrl });
    await cdp.waitFor(
      `Boolean(document.querySelector('#growthRadarRoot [data-gr-view="overview"]')) && document.querySelector('.gr-validation-banner')?.innerText.includes('测试/验收数据')`,
      "Growth Radar G1B runtime shell",
    );
    await cdp.evaluate(`(() => {
      const style = document.createElement('style');
      style.dataset.validationCapture = 'true';
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
      document.head.append(style);
    })()`);

    const directApi = await cdp.evaluate(`(async () => {
      const response = await fetch('/api/growth-radar/summary');
      return { url: response.url, status: response.status, keys: Object.keys(await response.json()) };
    })()`);
    assert(directApi.url === `${expectedOrigin}/api/growth-radar/summary`, `Unexpected API URL: ${directApi.url}`);
    assert(directApi.status === 200 && directApi.keys.includes("summary"), "Growth Radar summary API failed");

    const captures = [];
    const capturePair = async (number, slug, options = {}) => {
      const desktopName = `desktop-${String(number).padStart(2, "0")}-${slug}.png`;
      const mobileName = `mobile-${String(number).padStart(2, "0")}-${slug}.png`;
      captures.push({ filename: desktopName, ...(await cdp.capture(desktopName, { width: 1440, height: 900, ...options })) });
      captures.push({ filename: mobileName, ...(await cdp.capture(mobileName, { width: 430, height: 932, ...options })) });
    };

    const switchView = async (view, readyExpression) => {
      await cdp.click(`[data-gr-view="${view}"]`);
      await cdp.waitFor(readyExpression, `${view} view`);
    };
    const acknowledge = async (domain) => {
      const changed = await cdp.evaluate(`(() => {
        const input = document.querySelector('[data-gr-scope-ack="${domain}"]');
        if (!input || input.disabled) return false;
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      assert(changed, `Unable to acknowledge ${domain} scope`);
      await cdp.waitFor(`!document.querySelector('[data-gr-apply="${domain}"]').disabled`, `${domain} apply gate`);
    };
    const confirmCurrentDialog = async (resultExpression) => {
      await cdp.click('#grActionDialog[open] button[type="submit"]');
      await cdp.waitFor(`!document.querySelector('#grActionDialog[open]') && (${resultExpression})`, "application result", 60_000);
    };

    await switchView("orders", `Boolean(document.querySelector('#gr-orders-file'))`);
    await cdp.setFile("#gr-orders-file", orderFixture);
    await cdp.click('[data-gr-preview="orders"]');
    await cdp.waitFor(`Boolean(document.querySelector('.gr-preview-result')) && document.querySelector('.gr-preview-result').innerText.includes('PREVIEW_READY')`, "order preview", 60_000);
    const orderSafety = await cdp.evaluate(`(() => ({
      text: document.querySelector('.gr-preview-result')?.innerText || '',
      blocking: Array.from(document.querySelectorAll('.gr-preview-issues article')).filter((item) => item.innerText.includes('阻断应用')).length,
    }))()`);
    assert(orderSafety.blocking === 0, "Synthetic order fixture unexpectedly produced a blocker");
    assert(!/customer@example|=HYPERLINK|storage[\\/]development/i.test(orderSafety.text), "Order preview exposed unsafe source content");
    await acknowledge("orders");
    await cdp.click('[data-gr-apply="orders"]');
    await cdp.waitFor(`document.querySelector('#grActionDialog[open] #grDialogTitle')?.innerText === '确认应用预览数据'`, "order application confirmation dialog");
    await capturePair(9, "apply-confirmation", { focusSelector: "#grActionDialog", dialogExpected: true });
    await confirmCurrentDialog(`Boolean(document.querySelector('.gr-application-result'))`);

    await switchView("inventory", `Boolean(document.querySelector('#gr-inventory-file'))`);
    await cdp.setFile("#gr-inventory-file", inventoryFixture);
    await cdp.click('[data-gr-preview="inventory"]');
    await cdp.waitFor(`Boolean(document.querySelector('.gr-preview-result')) && document.querySelector('.gr-preview-result').innerText.includes('PREVIEW_READY')`, "inventory preview", 60_000);
    const inventoryBlockers = await cdp.evaluate(`Array.from(document.querySelectorAll('.gr-preview-issues article')).filter((item) => item.innerText.includes('阻断应用')).length`);
    assert(inventoryBlockers === 0, "Synthetic inventory fixture unexpectedly produced a blocker");
    await capturePair(6, "inventory-preview", { focusSelector: ".gr-preview-result" });
    await acknowledge("inventory");
    await cdp.click('[data-gr-apply="inventory"]');
    await cdp.waitFor(`document.querySelector('#grActionDialog[open] #grDialogTitle')?.innerText === '确认应用预览数据'`, "inventory application confirmation dialog");
    await confirmCurrentDialog(`Boolean(document.querySelector('.gr-application-result'))`);

    await switchView("overview", `document.querySelector('#growthRadarView')?.innerText.includes('数据概览')`);
    await capturePair(1, "overview", { focusSelector: "#growthRadarView" });

    await switchView("shops", `Boolean(document.querySelector('[data-gr-shop-detail]'))`);
    await capturePair(2, "shops-list", { focusSelector: "#growthRadarView" });
    await cdp.click('[data-gr-shop-detail]');
    await cdp.waitFor(`Boolean(document.querySelector('#grActionDialog[open] .gr-detail-grid'))`, "shop confirmation detail");
    await capturePair(3, "shop-detail", { focusSelector: "#grActionDialog", dialogExpected: true });
    await cdp.click('#grActionDialog[open] [data-gr-dialog-close]');
    await cdp.waitFor(`!document.querySelector('#grActionDialog[open]')`, "shop dialog close");

    await switchView("batches", `document.querySelector('#growthRadarView')?.innerText.includes('来源批次')`);
    await capturePair(4, "source-batches", { focusSelector: "#growthRadarView" });

    await switchView("orders", `Boolean(document.querySelector('#gr-orders-file')) && Boolean(document.querySelector('.gr-preview-result'))`);
    await capturePair(5, "order-preview", { focusSelector: ".gr-preview-result" });

    await switchView("quality", `document.querySelector('#growthRadarView')?.innerText.includes('数据质量问题')`);
    await capturePair(7, "data-quality", { focusSelector: "#growthRadarView" });

    await switchView("semantics", `document.querySelector('#growthRadarView')?.innerText.includes('数据语义与可用状态')`);
    await capturePair(8, "data-semantics", { focusSelector: "#growthRadarView" });

    await switchView("applications", `document.querySelector('#growthRadarView')?.innerText.includes('应用记录')`);
    await capturePair(10, "application-result", { focusSelector: "#growthRadarView" });

    const uniqueFiles = new Set(captures.map((item) => item.filename));
    assert(captures.length === 20 && uniqueFiles.size === 20, `Expected 20 screenshots, got ${captures.length}`);
    const apiResponses = cdp.responses.filter((item) => item.status === 200);
    assert(apiResponses.length > 0, "No successful Growth Radar API response was observed in Chrome");
    assert(apiResponses.every((item) => new URL(item.url).origin === expectedOrigin), "A Growth Radar API response came from another origin");
    const report = {
      method: "system Chrome headless via native Chrome DevTools Protocol",
      pageUrl,
      verifiedOrigin: expectedOrigin,
      directApi,
      successfulGrowthRadarApiResponses: apiResponses.length,
      fixtureMode: "synthetic redacted validation fixture; no real Mabang sample",
      screenshotCount: captures.length,
      desktopCount: captures.filter((item) => item.filename.startsWith("desktop-")).length,
      mobileCount: captures.filter((item) => item.filename.startsWith("mobile-")).length,
      files: captures.map((item) => item.filename).sort(),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp?.close();
    browser.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

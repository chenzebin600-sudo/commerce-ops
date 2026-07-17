import assert from "node:assert/strict";
import test from "node:test";
import { createChromeNavigationGuard } from "../lib/security/chrome-navigation.mjs";
import {
  NETWORK_ERROR_CODES,
  createNetworkPolicy,
} from "../lib/security/network-policy.mjs";

class MockCdp {
  constructor(onSend = () => {}) {
    this.calls = [];
    this.listeners = new Map();
    this.onSend = onSend;
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  emit(method, params) {
    for (const listener of this.listeners.get(method) || []) listener(params);
  }

  async send(method, params = {}) {
    this.calls.push({ method, params });
    await this.onSend(method, params, this);
    if (method === "Page.getFrameTree") {
      return { result: { frameTree: { frame: { id: "main", url: "about:blank" } } } };
    }
    return method === "Page.navigate" ? { result: { frameId: "main" } } : { result: {} };
  }
}

function navigationPolicy(dnsLookup = async () => [{ address: "8.8.8.8", family: 4 }]) {
  return createNetworkPolicy({
    name: "chrome test",
    allowedHosts: ["shopee.co.th", "lazada.com.ph", "mabangerp.com"],
    dnsLookup,
  });
}

function emitSuccessfulNavigation(cdp, url) {
  queueMicrotask(() => {
    cdp.emit("Fetch.requestPaused", {
      requestId: "request-1",
      resourceType: "Document",
      request: { url },
    });
    cdp.emit("Page.frameNavigated", {
      frame: { id: "main", url },
    });
  });
}

test("Chrome guard permits a valid allowlisted main-document navigation", async () => {
  const url = "https://seller.shopee.co.th/portal";
  const cdp = new MockCdp(async (method) => {
    if (method === "Page.navigate") emitSuccessfulNavigation(cdp, url);
  });
  const guard = await createChromeNavigationGuard({ cdp, policy: navigationPolicy(), timeoutMs: 200 });
  try {
    const result = await guard.navigate(url);
    assert.equal(result.url, url);
    assert.equal(cdp.calls.some(({ method, params }) => method === "Fetch.enable"
      && params.patterns?.[0]?.resourceType === "Document"), true);
    assert.equal(cdp.calls.some(({ method }) => method === "Fetch.continueRequest"), true);
  } finally {
    await guard.dispose();
  }
});

test("Chrome guard rejects an initial non-allowlisted destination before Page.navigate", async () => {
  const cdp = new MockCdp();
  const guard = await createChromeNavigationGuard({ cdp, policy: navigationPolicy(), timeoutMs: 100 });
  try {
    await assert.rejects(
      () => guard.navigate("https://shopee.co.th.attacker.com/"),
      { code: NETWORK_ERROR_CODES.HOST_NOT_ALLOWED },
    );
    assert.equal(cdp.calls.some(({ method }) => method === "Page.navigate"), false);
  } finally {
    await guard.dispose();
  }
});

test("Chrome guard blocks a redirect from an allowed host to a private address", async () => {
  const startUrl = "https://shopee.co.th/product/1";
  const cdp = new MockCdp(async (method) => {
    if (method !== "Page.navigate") return;
    queueMicrotask(() => {
      cdp.emit("Fetch.requestPaused", {
        requestId: "request-1",
        resourceType: "Document",
        request: { url: startUrl },
      });
      cdp.emit("Fetch.requestPaused", {
        requestId: "request-2",
        redirectedRequestId: "request-1",
        resourceType: "Document",
        request: { url: "http://192.168.1.10/admin" },
      });
    });
  });
  const guard = await createChromeNavigationGuard({ cdp, policy: navigationPolicy(), timeoutMs: 200 });
  try {
    await assert.rejects(() => guard.navigate(startUrl), { code: NETWORK_ERROR_CODES.REDIRECT_BLOCKED });
    assert.equal(cdp.calls.some(({ method }) => method === "Fetch.failRequest"), true);
  } finally {
    await guard.dispose();
  }
});

test("Chrome guard blocks a redirect to a non-allowlisted domain", async () => {
  const startUrl = "https://lazada.com.ph/products/item.html";
  const cdp = new MockCdp(async (method) => {
    if (method !== "Page.navigate") return;
    queueMicrotask(() => {
      cdp.emit("Fetch.requestPaused", {
        requestId: "request-1",
        resourceType: "Document",
        request: { url: startUrl },
      });
      cdp.emit("Fetch.requestPaused", {
        requestId: "request-2",
        redirectedRequestId: "request-1",
        resourceType: "Document",
        request: { url: "https://example.org/redirect" },
      });
    });
  });
  const guard = await createChromeNavigationGuard({ cdp, policy: navigationPolicy(), timeoutMs: 200 });
  try {
    await assert.rejects(() => guard.navigate(startUrl), { code: NETWORK_ERROR_CODES.REDIRECT_BLOCKED });
  } finally {
    await guard.dispose();
  }
});

test("Chrome guard contains an early committed-frame rejection until Page.navigate returns", async () => {
  const startUrl = "https://lazada.com.ph/products/item.html";
  const cdp = new MockCdp(async (method) => {
    if (method !== "Page.navigate") return;
    cdp.emit("Page.frameNavigated", {
      frame: { id: "main", url: "chrome-error://chromewebdata/" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const guard = await createChromeNavigationGuard({ cdp, policy: navigationPolicy(), timeoutMs: 200 });
  try {
    await assert.rejects(() => guard.navigate(startUrl), { code: NETWORK_ERROR_CODES.REDIRECT_BLOCKED });
  } finally {
    await guard.dispose();
  }
});

test("Chrome guard resolves again before the document request and blocks DNS rebinding", async () => {
  let lookups = 0;
  const policy = navigationPolicy(async () => {
    lookups += 1;
    return lookups === 1
      ? [{ address: "8.8.8.8", family: 4 }]
      : [{ address: "10.0.0.7", family: 4 }];
  });
  const url = "https://shopee.co.th/product/1";
  const cdp = new MockCdp(async (method) => {
    if (method === "Page.navigate") {
      queueMicrotask(() => cdp.emit("Fetch.requestPaused", {
        requestId: "request-1",
        resourceType: "Document",
        request: { url },
      }));
    }
  });
  const guard = await createChromeNavigationGuard({ cdp, policy, timeoutMs: 200 });
  try {
    await assert.rejects(() => guard.navigate(url), { code: NETWORK_ERROR_CODES.PRIVATE_NETWORK_BLOCKED });
    assert.equal(lookups, 2);
  } finally {
    await guard.dispose();
  }
});

test("Chrome guard ignores third-party iframe navigation without weakening top-level checks", async () => {
  const url = "https://shopee.co.th/product/1";
  const cdp = new MockCdp(async (method) => {
    if (method !== "Page.navigate") return;
    queueMicrotask(() => {
      cdp.emit("Fetch.requestPaused", {
        requestId: "script-1",
        resourceType: "Script",
        request: { url: "https://static.example.org/app.js" },
      });
      cdp.emit("Fetch.requestPaused", {
        requestId: "frame-1",
        frameId: "child-frame",
        resourceType: "Document",
        request: { url: "http://127.0.0.1/frame" },
      });
      cdp.emit("Page.frameNavigated", {
        frame: { id: "child-frame", parentId: "main", url: "https://fls.doubleclick.net/activity" },
      });
      cdp.emit("Page.frameNavigated", {
        frame: { id: "main", url },
      });
    });
  });
  const guard = await createChromeNavigationGuard({ cdp, policy: navigationPolicy(), timeoutMs: 200 });
  try {
    await assert.doesNotReject(() => guard.navigate(url));
    assert.equal(cdp.calls.some(({ method, params }) => method === "Fetch.continueRequest" && params.requestId === "script-1"), true);
    assert.equal(cdp.calls.some(({ method, params }) => method === "Fetch.continueRequest" && params.requestId === "frame-1"), true);
  } finally {
    await guard.dispose();
  }
});

test("Chrome guard enforces a redirect limit and navigation timeout", async () => {
  const startUrl = "https://shopee.co.th/product/1";
  const cdp = new MockCdp(async (method) => {
    if (method !== "Page.navigate") return;
    queueMicrotask(() => {
      cdp.emit("Fetch.requestPaused", { requestId: "r1", resourceType: "Document", request: { url: startUrl } });
      cdp.emit("Fetch.requestPaused", { requestId: "r2", redirectedRequestId: "r1", resourceType: "Document", request: { url: startUrl } });
      cdp.emit("Fetch.requestPaused", { requestId: "r3", redirectedRequestId: "r2", resourceType: "Document", request: { url: startUrl } });
    });
  });
  const guard = await createChromeNavigationGuard({ cdp, policy: navigationPolicy(), timeoutMs: 200, maxRedirects: 1 });
  try {
    await assert.rejects(() => guard.navigate(startUrl), { code: NETWORK_ERROR_CODES.REDIRECT_BLOCKED });
  } finally {
    await guard.dispose();
  }

  const timeoutCdp = new MockCdp();
  const timeoutGuard = await createChromeNavigationGuard({ cdp: timeoutCdp, policy: navigationPolicy(), timeoutMs: 20 });
  try {
    await assert.rejects(() => timeoutGuard.navigate(startUrl), { code: NETWORK_ERROR_CODES.NAVIGATION_TIMEOUT });
  } finally {
    await timeoutGuard.dispose();
  }
});

test("Chrome guard counts redirects reported through Network events", async () => {
  const startUrl = "https://shopee.co.th/product/1";
  const cdp = new MockCdp(async (method) => {
    if (method !== "Page.navigate") return;
    queueMicrotask(() => {
      cdp.emit("Fetch.requestPaused", {
        requestId: "fetch-1",
        networkId: "network-1",
        resourceType: "Document",
        request: { url: startUrl },
      });
      cdp.emit("Network.requestWillBeSent", {
        requestId: "network-1",
        type: "Document",
        redirectResponse: { status: 302 },
      });
      cdp.emit("Fetch.requestPaused", {
        requestId: "fetch-2",
        networkId: "network-1",
        resourceType: "Document",
        request: { url: startUrl },
      });
    });
  });
  const guard = await createChromeNavigationGuard({
    cdp,
    policy: navigationPolicy(),
    timeoutMs: 200,
    maxRedirects: 0,
  });
  try {
    await assert.rejects(() => guard.navigate(startUrl), { code: NETWORK_ERROR_CODES.REDIRECT_BLOCKED });
  } finally {
    await guard.dispose();
  }
});

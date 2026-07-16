import test from "node:test";
import assert from "node:assert/strict";
import {
  AD_FRAME_AUTH,
  AD_FRAME_CLEAR,
  AD_FRAME_READY,
  AD_FRAME_SESSION_EXPIRED,
  createAdFrameBridge,
} from "../public/ad-frame-bridge.mjs";

const ORIGIN = "http://office-host:3101";
const TEST_TOKEN = "temporary-parent-frame-token";

function fixture(authContext = { token: TEST_TOKEN, localCompatibilityMode: false }) {
  const listeners = new Map();
  const posted = [];
  const frameWindow = {
    postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); },
  };
  const windowObject = {
    location: { origin: ORIGIN },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const frame = { contentWindow: frameWindow };
  let expired = 0;
  const bridge = createAdFrameBridge({
    windowObject,
    frame,
    getAuthContext: () => authContext,
    onSessionExpired: () => { expired += 1; },
  });
  return {
    bridge,
    posted,
    frameWindow,
    send(event) { listeners.get("message")?.(event); },
    expired: () => expired,
  };
}

test("advertising iframe handshake uses the exact current page origin", () => {
  const f = fixture();
  f.send({ origin: ORIGIN, source: f.frameWindow, data: { type: AD_FRAME_READY } });
  assert.deepEqual(f.posted, [{
    message: { type: AD_FRAME_AUTH, token: TEST_TOKEN, localCompatibilityMode: false },
    targetOrigin: ORIGIN,
  }]);
  assert.equal(JSON.stringify(f.posted).includes('"*"'), false);
});

test("advertising iframe handshake rejects an incorrect origin", () => {
  const f = fixture();
  f.send({ origin: "http://attacker.invalid", source: f.frameWindow, data: { type: AD_FRAME_READY } });
  assert.equal(f.posted.length, 0);
});

test("advertising iframe handshake rejects an incorrect source window", () => {
  const f = fixture();
  f.send({ origin: ORIGIN, source: {}, data: { type: AD_FRAME_READY } });
  assert.equal(f.posted.length, 0);
});

test("advertising iframe handshake rejects wrong types and extra message fields", () => {
  const f = fixture();
  f.send({ origin: ORIGIN, source: f.frameWindow, data: { type: "wrong" } });
  f.send({ origin: ORIGIN, source: f.frameWindow, data: { type: AD_FRAME_READY, token: "injected" } });
  assert.equal(f.posted.length, 0);
});

test("local compatibility mode can initialize the iframe without exposing a token", () => {
  const f = fixture({ token: "", localCompatibilityMode: true });
  f.send({ origin: ORIGIN, source: f.frameWindow, data: { type: AD_FRAME_READY } });
  assert.deepEqual(f.posted[0], {
    message: { type: AD_FRAME_AUTH, token: "", localCompatibilityMode: true },
    targetOrigin: ORIGIN,
  });
});

test("logout clears iframe memory and a valid expiry message locks the parent", () => {
  const f = fixture();
  f.bridge.clear();
  assert.deepEqual(f.posted[0], { message: { type: AD_FRAME_CLEAR }, targetOrigin: ORIGIN });

  f.send({ origin: ORIGIN, source: f.frameWindow, data: { type: AD_FRAME_SESSION_EXPIRED } });
  assert.equal(f.expired(), 1);
  f.send({ origin: "http://attacker.invalid", source: f.frameWindow, data: { type: AD_FRAME_SESSION_EXPIRED } });
  assert.equal(f.expired(), 1);
});

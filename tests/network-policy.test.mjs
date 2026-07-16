import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM,
  NETWORK_ERROR_CODES,
  createNetworkPolicy,
  hostnameMatchesAllowedHost,
  isBlockedIpAddress,
  resolveAllowedHosts,
} from "../lib/security/network-policy.mjs";

const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];

function policyWith(dnsLookup = publicDns) {
  return createNetworkPolicy({
    name: "test",
    allowedHosts: ["shopee.co.th", "lazada.com.ph", "img.example.com"],
    dnsLookup,
  });
}

test("network policy rejects loopback, private, link-local and metadata IP targets", async () => {
  const policy = policyWith();
  const blocked = [
    "http://localhost/",
    "http://127.0.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
  ];
  for (const url of blocked) await assert.rejects(() => policy.validateUrl(url));
});

test("default Chrome policy permits only the current platform domain families", async () => {
  const allowedHosts = Object.values(DEFAULT_CHROME_ALLOWED_HOSTS_BY_PLATFORM).flat();
  const policy = createNetworkPolicy({
    name: "default Chrome",
    allowedHosts,
    dnsLookup: publicDns,
  });
  for (const url of [
    "https://www.lazada.com.ph/products/example-i1.html",
    "https://seller.shopee.co.th/portal",
    "https://shop.tiktok.com/ph/pdp/example/123",
    "https://900445.private.mabangerp.com/index.php",
  ]) {
    await assert.doesNotReject(() => policy.validateUrl(url));
  }
  await assert.rejects(
    () => policy.validateUrl("https://shop.tiktok.com.attacker.example/"),
    { code: NETWORK_ERROR_CODES.HOST_NOT_ALLOWED },
  );
});

test("network policy rejects non-HTTP protocols and URL credentials", async () => {
  const policy = policyWith();
  for (const url of [
    "file:///etc/passwd",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "ftp://shopee.co.th/file",
    "blob:https://shopee.co.th/id",
    "chrome://settings/",
    "chrome-extension://abc/index.html",
    "about:blank",
  ]) {
    await assert.rejects(() => policy.validateUrl(url), { code: NETWORK_ERROR_CODES.PROTOCOL_NOT_ALLOWED });
  }
  await assert.rejects(
    () => policy.validateUrl("https://user:password@shopee.co.th/product"),
    { code: NETWORK_ERROR_CODES.URL_INVALID },
  );
});

test("hostname matching requires an exact host boundary", async () => {
  const policy = policyWith();
  assert.equal(hostnameMatchesAllowedHost("shopee.co.th", "shopee.co.th"), true);
  assert.equal(hostnameMatchesAllowedHost("seller.shopee.co.th", "shopee.co.th"), true);
  assert.equal(hostnameMatchesAllowedHost("shopee.co.th.attacker.com", "shopee.co.th"), false);
  assert.equal(hostnameMatchesAllowedHost("fake-shopee.co.th", "shopee.co.th"), false);
  await assert.doesNotReject(() => policy.validateUrl("https://shopee.co.th/product/1"));
  await assert.doesNotReject(() => policy.validateUrl("https://seller.shopee.co.th/portal"));
  await assert.rejects(
    () => policy.validateUrl("https://shopee.co.th.attacker.com/"),
    { code: NETWORK_ERROR_CODES.HOST_NOT_ALLOWED },
  );
});

test("DNS validation rejects a private result and a mixed public/private result", async () => {
  const privatePolicy = policyWith(async () => [{ address: "10.0.0.8", family: 4 }]);
  await assert.rejects(
    () => privatePolicy.validateUrl("https://shopee.co.th/"),
    { code: NETWORK_ERROR_CODES.PRIVATE_NETWORK_BLOCKED },
  );

  const mixedPolicy = policyWith(async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "192.168.1.20", family: 4 },
  ]);
  await assert.rejects(
    () => mixedPolicy.validateUrl("https://shopee.co.th/"),
    { code: NETWORK_ERROR_CODES.PRIVATE_NETWORK_BLOCKED },
  );
});

test("DNS validation rejects IPv6 local ranges and IPv4-mapped private addresses", async () => {
  assert.equal(isBlockedIpAddress("fe80::1"), true);
  assert.equal(isBlockedIpAddress("fc00::1"), true);
  assert.equal(isBlockedIpAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("2606:4700:4700::1111"), false);

  const policy = policyWith(async () => [{ address: "::ffff:192.168.1.2", family: 6 }]);
  await assert.rejects(
    () => policy.validateUrl("https://shopee.co.th/"),
    { code: NETWORK_ERROR_CODES.PRIVATE_NETWORK_BLOCKED },
  );
});

test("DNS errors are returned as a bounded resolution failure", async () => {
  const policy = policyWith(async () => {
    const error = new Error("resolver detail that must not escape");
    error.code = "ENOTFOUND";
    throw error;
  });
  await assert.rejects(
    () => policy.validateUrl("https://shopee.co.th/"),
    (error) => error.code === NETWORK_ERROR_CODES.DNS_RESOLUTION_FAILED
      && !error.message.includes("resolver detail"),
  );
});

test("allowed-host extensions reject wildcards, URLs, IPs and broad public suffixes", () => {
  assert.deepEqual(
    resolveAllowedHosts(["shopee.co.th"], "images.example.com", "TEST_ALLOWED_HOSTS"),
    ["images.example.com", "shopee.co.th"],
  );
  for (const value of ["*", "*.example.com", "https://example.com", "127.0.0.1", "com", "co.th"]) {
    assert.throws(() => resolveAllowedHosts([], value, "TEST_ALLOWED_HOSTS"));
  }
});

test("network policy source does not use includes for domain security decisions", () => {
  const source = readFileSync(new URL("../lib/security/network-policy.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.includes\s*\(/);
  assert.match(source, /candidate === allowed \|\| candidate\.endsWith\(`\.\$\{allowed\}`\)/);
});

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  IMAGE_PROXY_ERROR_CODES,
  createPinnedLookup,
  createSecureImageFetcher,
} from "../lib/security/image-proxy.mjs";
import {
  NETWORK_ERROR_CODES,
  createNetworkPolicy,
} from "../lib/security/network-policy.mjs";

function mockResponse(statusCode, headers = {}, chunks = []) {
  const body = Readable.from(chunks);
  return {
    statusCode,
    headers,
    body,
    destroy(error) {
      body.destroy(error);
    },
  };
}

function imagePolicy(dnsLookup = async () => [{ address: "8.8.8.8", family: 4 }]) {
  return createNetworkPolicy({
    name: "image test",
    allowedHosts: ["img.example.com", "cdn.example.com"],
    dnsLookup,
  });
}

test("image proxy allows JPEG, PNG and WebP and passes only vetted DNS addresses", async () => {
  for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
    let requestOptions;
    const fetchImage = createSecureImageFetcher({
      policy: imagePolicy(),
      requestImpl: async (options) => {
        requestOptions = options;
        return mockResponse(200, { "content-type": contentType }, [Buffer.from("image")]);
      },
    });
    const result = await fetchImage("https://img.example.com/product/file");
    assert.equal(result.contentType, contentType);
    assert.equal(result.bytes.toString(), "image");
    assert.deepEqual(requestOptions.addresses, [{ address: "8.8.8.8", family: 4 }]);
    assert.equal(requestOptions.headers.authorization, undefined);
    assert.equal(requestOptions.headers.cookie, undefined);
  }
});

test("pinned image lookup returns only the addresses already approved by policy", async () => {
  const lookup = createPinnedLookup([
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  const all = await new Promise((resolve, reject) => {
    lookup("img.example.com", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(all, [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
});

test("image proxy rejects HTML, JSON, SVG, arbitrary binary and missing Content-Type", async () => {
  for (const contentType of ["text/html", "application/json", "image/svg+xml", "application/octet-stream", ""]) {
    const fetchImage = createSecureImageFetcher({
      policy: imagePolicy(),
      requestImpl: async () => mockResponse(200, contentType ? { "content-type": contentType } : {}, [Buffer.from("not-image")]),
    });
    await assert.rejects(
      () => fetchImage("https://img.example.com/product/file"),
      { code: IMAGE_PROXY_ERROR_CODES.CONTENT_TYPE_NOT_ALLOWED },
    );
  }
});

test("image proxy rejects declared and streamed responses above the size limit", async () => {
  const declared = createSecureImageFetcher({
    policy: imagePolicy(),
    maxBytes: 4,
    requestImpl: async () => mockResponse(200, {
      "content-type": "image/png",
      "content-length": "5",
    }, [Buffer.from("12345")]),
  });
  await assert.rejects(() => declared("https://img.example.com/file"), {
    code: IMAGE_PROXY_ERROR_CODES.RESPONSE_TOO_LARGE,
  });

  const streamed = createSecureImageFetcher({
    policy: imagePolicy(),
    maxBytes: 4,
    requestImpl: async () => mockResponse(200, { "content-type": "image/png" }, [Buffer.from("12"), Buffer.from("345")]),
  });
  await assert.rejects(() => streamed("https://img.example.com/file"), {
    code: IMAGE_PROXY_ERROR_CODES.RESPONSE_TOO_LARGE,
  });
});

test("image proxy manually follows a validated redirect", async () => {
  const requested = [];
  const responses = [
    mockResponse(302, { location: "https://cdn.example.com/final.png" }),
    mockResponse(200, { "content-type": "image/png" }, [Buffer.from("png")]),
  ];
  const fetchImage = createSecureImageFetcher({
    policy: imagePolicy(),
    requestImpl: async ({ url }) => {
      requested.push(url.href);
      return responses.shift();
    },
  });
  const result = await fetchImage("https://img.example.com/start");
  assert.equal(result.redirectCount, 1);
  assert.deepEqual(requested, ["https://img.example.com/start", "https://cdn.example.com/final.png"]);
});

test("image proxy rejects excessive redirects", async () => {
  const fetchImage = createSecureImageFetcher({
    policy: imagePolicy(),
    maxRedirects: 1,
    requestImpl: async ({ url }) => mockResponse(302, {
      location: url.hostname === "img.example.com"
        ? "https://cdn.example.com/second"
        : "https://img.example.com/third",
    }),
  });
  await assert.rejects(() => fetchImage("https://img.example.com/first"), {
    code: IMAGE_PROXY_ERROR_CODES.REDIRECT_LIMIT,
  });
});

test("image proxy rejects redirects to private networks before issuing the next request", async () => {
  let requests = 0;
  const fetchImage = createSecureImageFetcher({
    policy: imagePolicy(),
    requestImpl: async () => {
      requests += 1;
      return mockResponse(302, { location: "http://169.254.169.254/latest/meta-data/" });
    },
  });
  await assert.rejects(() => fetchImage("https://img.example.com/start"), {
    code: NETWORK_ERROR_CODES.REDIRECT_BLOCKED,
  });
  assert.equal(requests, 1);
});

test("image proxy resolves every redirect target and rejects a DNS rebind", async () => {
  let dnsCalls = 0;
  const policy = imagePolicy(async () => {
    dnsCalls += 1;
    return dnsCalls === 1
      ? [{ address: "8.8.8.8", family: 4 }]
      : [{ address: "10.0.0.9", family: 4 }];
  });
  const fetchImage = createSecureImageFetcher({
    policy,
    requestImpl: async () => mockResponse(302, { location: "https://cdn.example.com/final" }),
  });
  await assert.rejects(() => fetchImage("https://img.example.com/start"), {
    code: NETWORK_ERROR_CODES.REDIRECT_BLOCKED,
  });
  assert.equal(dnsCalls, 2);
});

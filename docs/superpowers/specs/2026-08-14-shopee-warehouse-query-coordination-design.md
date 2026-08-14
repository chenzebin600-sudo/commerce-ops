# Shopee Warehouse Query Coordination Design

## Problem

The warehouse relay permits one active query per credential owner. Two concurrent price previews currently issue independent `/api/data/query` requests; the second receives HTTP 429, retries once after ten seconds, and then surfaces `WAREHOUSE_UNAVAILABLE` as “Warehouse price validation blocked the preview”.

## Design

`WarehouseControlPriceClient` owns query coordination for its process. Calls with the same canonical country, category, ordered normalized SKU set, and requested watermark share one in-flight scan. Calls with different scopes keep their own scan but serialize only their outbound `/api/data/query` operations through one instance-level queue. `/api/data/me` verification remains independent.

Completed scans are not cached by the coordinator. Every waiter receives the shared rows and watermark with its own `requestId` and scope evidence. Rejections and blocked results always clear the in-flight entry so a later manual retry performs a fresh read. Queue release happens in `finally`, including transport errors and aborts.

## Safety and Bounds

- No Shopee write endpoint is involved.
- Existing 60-second per-request timeout, response-size cap, pagination cap, and watermark pinning remain unchanged.
- Coordination is instance-local and holds only active scan promises plus one queue tail.
- Exact per-SKU reads remain sequential inside a scan.

## Verification

Tests use deferred real client calls at the fetch boundary. They prove identical concurrent scans make one relay request and preserve caller-specific evidence; different scans never overlap their relay fetches; a failed shared scan is removed and a subsequent retry calls the relay again.

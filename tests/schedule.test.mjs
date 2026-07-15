import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createDingtalkSignature, sendDingtalkMessage, signedDingtalkWebhook } from "../lib/mabang-scheduler/dingtalk.mjs";
import { nextRunAt, paymentDateRange, retentionExpiresAt } from "../lib/mabang-scheduler/schedule.mjs";
import { normalizeTaskFilters } from "../lib/mabang-scheduler/fields.mjs";
import { scheduledExportFilename } from "../lib/mabang-scheduler/executor.mjs";

test("daily next run uses the task timezone", () => {
  const result = nextRunAt({ scheduleType: "daily", scheduleConfig: { hour: 8, minute: 30 }, timezone: "Asia/Shanghai" }, new Date("2026-07-14T00:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-14T00:30:00.000Z");
});

test("weekly schedule supports multiple weekdays", () => {
  const result = nextRunAt({ scheduleType: "weekly", scheduleConfig: { weekdays: [1, 4], hour: 9, minute: 0 }, timezone: "Asia/Shanghai" }, new Date("2026-07-14T02:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-16T01:00:00.000Z");
});

test("monthly day 31 falls back to February month end", () => {
  const result = nextRunAt({ scheduleType: "monthly", scheduleConfig: { day: 31, monthEndFallback: true, hour: 9, minute: 0 }, timezone: "Asia/Shanghai" }, new Date("2027-02-01T00:00:00Z"));
  assert.equal(result.toISOString(), "2027-02-28T01:00:00.000Z");
});

test("leap year February supports day 29", () => {
  const result = nextRunAt({ scheduleType: "monthly", scheduleConfig: { day: 29, monthEndFallback: true, hour: 9, minute: 0 }, timezone: "Asia/Shanghai" }, new Date("2028-02-01T00:00:00Z"));
  assert.equal(result.toISOString(), "2028-02-29T01:00:00.000Z");
});

test("monthly last day is calculated per month", () => {
  const result = nextRunAt({ scheduleType: "monthly", scheduleConfig: { day: "last", hour: 18, minute: 5 }, timezone: "Asia/Shanghai" }, new Date("2026-04-01T00:00:00Z"));
  assert.equal(result.toISOString(), "2026-04-30T10:05:00.000Z");
});

test("timezone conversion handles a non-Asia timezone", () => {
  const result = nextRunAt({ scheduleType: "daily", scheduleConfig: { hour: 9, minute: 0 }, timezone: "America/New_York" }, new Date("2026-07-14T12:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-14T13:00:00.000Z");
});

test("dynamic payment date presets are correct", () => {
  const execution = new Date("2026-07-14T01:00:00Z");
  assert.deepEqual(paymentDateRange("yesterday", {}, execution, "Asia/Shanghai"), { startDate: "2026-07-13", endDate: "2026-07-13" });
  assert.deepEqual(paymentDateRange("previous_week", {}, execution, "Asia/Shanghai"), { startDate: "2026-07-06", endDate: "2026-07-12" });
  assert.deepEqual(paymentDateRange("previous_month", {}, execution, "Asia/Shanghai"), { startDate: "2026-06-01", endDate: "2026-06-30" });
});

test("relative payment range uses execution-local date", () => {
  assert.deepEqual(paymentDateRange("relative", { startDaysAgo: 7, endDaysAgo: 1 }, new Date("2026-07-14T01:00:00Z"), "Asia/Shanghai"), { startDate: "2026-07-07", endDate: "2026-07-13" });
});

test("multi-value filters keep stable field ids", () => {
  const result = normalizeTaskFilters([
    { fieldId: "uq172", operator: "equals", values: ["兰双满"] },
    { fieldId: "uq135", operator: "equals", values: ["TIXX PH", "TIXX Official Store PH"] },
  ]);
  assert.deepEqual(result.map((item) => item.fieldId), ["uq172", "uq135"]);
  assert.equal(result[1].values.length, 2);
});

test("DingTalk signing uses timestamp newline secret HMAC", () => {
  const secret = "SEC-test";
  const timestamp = 1720917000000;
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  assert.equal(createDingtalkSignature(secret, timestamp), expected);
  const signed = new URL(signedDingtalkWebhook("https://oapi.dingtalk.com/robot/send?access_token=test", secret, timestamp));
  assert.equal(signed.searchParams.get("timestamp"), String(timestamp));
  assert.equal(signed.searchParams.get("sign"), expected);
});

test("DingTalk mock notification succeeds without a real group", async () => {
  let payload;
  const fetchImpl = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await sendDingtalkMessage({
    webhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=mock",
    title: "Mock",
    markdown: "### Mock",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(payload.msgtype, "markdown");
});

test("filename sanitization removes illegal characters and uses task timezone", () => {
  const filename = scheduledExportFilename('菲律宾:兰/双*满?"订单', "2026-07-13", "2026-07-13", new Date("2026-07-14T00:30:00Z"), "Asia/Shanghai");
  assert.equal(filename.includes(":"), false);
  assert.equal(filename.includes("/"), false);
  assert.match(filename, /20260714_083000\.xlsx$/);
});

test("inventory export filename identifies a point-in-time stock snapshot", () => {
  const filename = scheduledExportFilename("菲律宾每日库存", null, null, new Date("2026-07-14T00:30:00Z"), "Asia/Shanghai", "inventory_export");
  assert.equal(filename, "马帮库存_菲律宾每日库存_20260714_083000.xlsx");
});

test("retention expiry supports fixed days and forever", () => {
  const base = new Date("2026-07-14T00:00:00Z");
  assert.equal(retentionExpiresAt(30, base).toISOString(), "2026-08-13T00:00:00.000Z");
  assert.equal(retentionExpiresAt("forever", base), null);
});

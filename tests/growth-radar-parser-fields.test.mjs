import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";

const root = path.resolve(".");
const python = resolvePythonRuntime({ appRoot: root, requiredModules: ["openpyxl"] });

test("order parser derives a deterministic CNY header amount without confirming line amount", async (t) => {
  if (!python.ok) return t.skip("openpyxl runtime unavailable");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "growth-radar-parser-order-amount-"));
  const workbookPath = path.join(directory, "orders.xlsx");
  try {
    const create = [
      "from openpyxl import Workbook",
      "import sys",
      "wb=Workbook(); ws=wb.active; ws.title='订单明细'",
      "ws.append(['订单编号','店铺名','平台','订单状态','SKU','商品数量','订单核算金额（人民币）','订单核算金额（原始货币）','汇率（原始货币）','商品总金额','原始商品总金额','优惠金额（原始货币）'])",
      "ws.append(['ORDER-CNY','Shop A','Lazada','已发货','SKU-1',1,108,20,5,30,120,12.5])",
      "ws.append(['ORDER-FX','Shop A','Lazada','已发货','SKU-2',2,None,20.25,5.2,40,200,0])",
      "ws.append(['ORDER-MISSING-RATE','Shop A','Lazada','已发货','SKU-3',1,None,20.25,None,50,300,None])",
      "ws.append(['ORDER-ZERO-RATE','Shop A','Lazada','已发货','SKU-4',1,None,20.25,0,60,400,40])",
      "wb.save(sys.argv[1])",
    ].join(";");
    const created = spawnSync(python.executable, ["-c", create, workbookPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(created.status, 0, created.stderr);

    const parsed = spawnSync(python.executable, [
      path.join(root, "scripts", "growth-radar-parser.py"),
      workbookPath,
      "--domain",
      "order",
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout);
    assert.deepEqual(result.rows.map((row) => ({
      orderCurrency: row.normalized.orderCurrency,
      orderAmount: row.normalized.orderAmount,
      orderAmountSourceField: row.normalized.orderAmountSourceField,
      originalProductAmountLocal: row.normalized.originalProductAmountLocal,
      discountAmountLocal: row.normalized.discountAmountLocal,
      lineAmount: row.normalized.lineAmount,
      lineAmountStatus: row.normalized.lineAmountStatus,
    })), [
      {
        orderCurrency: "CNY",
        orderAmount: 108,
        orderAmountSourceField: "订单核算金额（人民币）",
        originalProductAmountLocal: "120",
        discountAmountLocal: "12.5",
        lineAmount: 30,
        lineAmountStatus: "unconfirmed",
      },
      {
        orderCurrency: "CNY",
        orderAmount: 105.3,
        orderAmountSourceField: "订单核算金额（原始货币）×汇率（原始货币）",
        originalProductAmountLocal: "200",
        discountAmountLocal: "0",
        lineAmount: 40,
        lineAmountStatus: "unconfirmed",
      },
      {
        orderCurrency: null,
        orderAmount: null,
        orderAmountSourceField: null,
        originalProductAmountLocal: "300",
        discountAmountLocal: null,
        lineAmount: 50,
        lineAmountStatus: "unconfirmed",
      },
      {
        orderCurrency: null,
        orderAmount: null,
        orderAmountSourceField: null,
        originalProductAmountLocal: "400",
        discountAmountLocal: "40",
        lineAmount: 60,
        lineAmountStatus: "unconfirmed",
      },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("inventory parser keeps pending and transfer-pending shipment quantities separate", async (t) => {
  if (!python.ok) return t.skip("openpyxl runtime unavailable");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "growth-radar-parser-fields-"));
  const workbookPath = path.join(directory, "inventory.xlsx");
  try {
    const create = [
      "from openpyxl import Workbook",
      "import sys",
      "wb=Workbook(); ws=wb.active; ws.title='库存明细'",
      "ws.append(['库存SKU编号','仓库','未发货量','分仓调拨未发货量','当前可售天数'])",
      "ws.append(['SKU-1','WH-A',3,7,12])",
      "ws.append(['SKU-2','WH-B',None,9,8])",
      "wb.save(sys.argv[1])",
    ].join(";");
    const created = spawnSync(python.executable, ["-c", create, workbookPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(created.status, 0, created.stderr);

    const parsed = spawnSync(python.executable, [
      path.join(root, "scripts", "growth-radar-parser.py"),
      workbookPath,
      "--domain",
      "inventory",
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout);
    assert.deepEqual(result.rows.map((row) => ({
      pending: row.normalized.pendingShipmentQuantity,
      transferPending: row.normalized.transferPendingShipmentQuantity,
      days: row.normalized.daysOfSupply,
      daysStatus: row.normalized.daysOfSupplyStatus,
    })), [
      { pending: 3, transferPending: 7, days: 12, daysStatus: "confirmed" },
      { pending: null, transferPending: 9, days: 8, daysStatus: "confirmed" },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

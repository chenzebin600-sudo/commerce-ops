---
name: mabang-export-orders
description: Export complete Mabang ERP order-line details for a payment-time date or range into XLSX, CSV, or JSON. Use when Codex needs to download 马帮订单信息/订单明细, reproduce the existing Mabang order-export workflow, generate a local order file, troubleshoot missing export-template fields, or automate a read-only order export without writing data back to WPS or Mabang.
---

# Mabang Export Orders

Export Mabang order details with the bundled read-only Python command. Query all order statuses by payment time, collect platform order IDs, run the configured Mabang export template in batches, normalize the result, and save a local file.

## Workflow

1. Resolve the requested payment-time scope.
   - Use `--date YYYY-MM-DD` for one calendar day.
   - Use both `--paid-start` and `--paid-end` for a range.
   - Omit all date arguments only when yesterday is the intended default.
2. Confirm credentials without exposing them.
   - Read the account from `MABANG_USERNAME` or `--username`.
   - Read the password only from `MABANG_PASSWORD` or the interactive hidden prompt.
   - Never place a password in a command argument, generated file, response, log, or Skill source.
3. Confirm the output path and format.
   - Prefer `.xlsx` for operations users, `.csv` for import pipelines, and `.json` for programmatic inspection.
   - Treat the order file as sensitive because it can contain names, addresses, and phone numbers.
4. Run `scripts/export_mabang_orders.py`.
5. Verify the final JSON summary and the output file.
   - Require `success: true`.
   - Report the payment range, order count, detail-row count, and absolute output path.
   - When zero orders are found, keep the valid header-only output and report zero rows plainly.
   - If the query exceeds `--max-pages`, raise the limit and rerun; never accept a partial export.

## Run

Use the current Python environment when `requests`, `pandas`, and `openpyxl` are already installed. Otherwise create or use an isolated environment and install `scripts/requirements.txt`.

PowerShell example:

```powershell
$env:MABANG_USERNAME = "<account>"
$env:MABANG_PASSWORD = "<password>"
python "<skill-dir>\scripts\export_mabang_orders.py" `
  --date "2026-07-30" `
  --output "C:\Exports\mabang-orders-20260730.xlsx"
```

Range example:

```powershell
python "<skill-dir>\scripts\export_mabang_orders.py" `
  --paid-start "2026-07-01 00:00:00" `
  --paid-end "2026-07-30 23:59:59" `
  --output "C:\Exports\mabang-orders-202607.xlsx"
```

Run `python "<skill-dir>\scripts\export_mabang_orders.py" --help` for tuning flags. Keep the default worker counts unless the user explicitly needs performance tuning; aggressive concurrency can trigger throttling.

## Tenant Configuration

Use the bundled defaults for the source environment. For another Mabang tenant or export template, set:

- `MABANG_BASE_URL` to the tenant login site.
- `MABANG_PRIVATE_URL` to the private export service.
- `MABANG_EXPORT_TEMPLATE_ID` to an export template containing the required fields.

Prefer environment variables over repeated command flags for stable configuration. Require HTTPS endpoints.

## Data and Safety Rules

- Treat this as a read/export workflow. Do not add order updates, fulfillment actions, deletes, or WPS writes.
- Preserve one row per exported product line. Do not merge common order fields or collapse multi-SKU orders.
- Preserve numeric zero as zero; do not convert a missing required amount to zero without the existing full-evidence rule.
- Keep the bundled spreadsheet formula-injection guard enabled for XLSX and CSV.
- Do not print cookies, request payloads, passwords, raw customer data, or full traceback unless the user explicitly requests debug output.
- Do not commit exported order files or credentials to source control.

## Diagnose Failures

Read [references/export-contract.md](references/export-contract.md) when fields are missing, an export template changes, amount validation fails, login requires verification, or a tenant endpoint must be changed.

If authentication requires CAPTCHA or manual verification, stop and tell the user that this command cannot bypass it. Do not weaken authentication controls.

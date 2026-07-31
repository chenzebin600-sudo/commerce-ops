---
name: mabang-export-inventory
description: Export the complete current Mabang ERP inventory-query snapshot into XLSX, CSV, or JSON with official Excel batching and row-count verification. Use when Codex needs to download 马帮库存信息/库存查询数据, create a current inventory snapshot, reproduce the existing Mabang inventory export workflow, troubleshoot missing inventory fields, or automate a read-only stock export without writing data back to WPS or Mabang.
---

# Mabang Export Inventory

Export the current Mabang `商品 > 库存查询` result with the bundled read-only Python command. Initialize the default all-inventory search, obtain the displayed record count and stock summary, download official Excel batches, normalize fields, verify completeness, and save a local file.

## Workflow

1. Confirm that the user wants the current inventory snapshot.
   - Do not apply a date range; this source represents current inventory-query state.
   - Use the default unfiltered search to include all visible warehouses and SKUs.
2. Confirm credentials without exposing them.
   - Read the account from `MABANG_USERNAME` or `--username`.
   - Read the password only from `MABANG_PASSWORD` or the interactive hidden prompt.
   - Never place a password in a command argument, generated file, response, log, or Skill source.
3. Confirm the output path and format.
   - Prefer `.xlsx` for operations users, `.csv` for import pipelines, and `.json` for programmatic inspection.
   - Treat inventory, cost, supplier-facing names, and product remarks as sensitive operational data.
4. Run `scripts/export_mabang_inventory.py`.
5. Verify the final JSON summary and output file.
   - Require `success: true`.
   - Require `source_rows` to equal `rows`.
   - Report the row count, stock summary timestamp when present, and absolute output path.
   - When zero rows are found, preserve the valid header-only output.

## Run

Use the current Python environment when `requests`, `pandas`, and `openpyxl` are installed. Otherwise create or use an isolated environment and install `scripts/requirements.txt`.

PowerShell example:

```powershell
$credential = Get-Credential -UserName "<account>" -Message "请输入马帮账号密码"
$env:MABANG_USERNAME = $credential.UserName
$env:MABANG_PASSWORD = $credential.GetNetworkCredential().Password
python "<skill-dir>\scripts\export_mabang_inventory.py" `
  --output "C:\Exports\mabang-inventory.xlsx"
```

Run `python "<skill-dir>\scripts\export_mabang_inventory.py" --help` to view configuration flags.

## Tenant Configuration

Use the bundled source-environment defaults. For another Mabang tenant, set:

- `MABANG_BASE_URL` to the tenant login site.
- `MABANG_PRIVATE_URL` to the private inventory export service.

Prefer environment variables over repeated command flags for stable configuration. Require HTTPS endpoints.

## Data and Safety Rules

- Treat this as a read/export workflow. Do not add stock updates, warehouse transfers, deletes, or WPS writes.
- Export the complete result in official batches of at most 10,000 rows.
- Fail when the displayed record count and parsed Excel row count differ; never accept a partial inventory snapshot.
- Keep `销量(7/28/42)` as the source string unless the user separately requests derived columns.
- Preserve missing values as blank and numeric zero as zero.
- Keep the bundled spreadsheet formula-injection guard enabled for XLSX and CSV.
- Do not print cookies, request payloads, passwords, raw inventory rows, or full traceback unless the user explicitly requests debug output.
- Do not commit exported inventory files or credentials to source control.

## Diagnose Failures

Read [references/export-contract.md](references/export-contract.md) when fields are missing, counts disagree, login requires verification, the inventory iframe changes, or a tenant endpoint must be changed.

If authentication requires CAPTCHA or manual verification, stop and tell the user that this command cannot bypass it. Do not weaken authentication controls.

$ErrorActionPreference = "Stop"

if (-not $env:MABANG_USERNAME) {
    $env:MABANG_USERNAME = Read-Host "Mabang username"
}

if (-not $env:MABANG_PASSWORD) {
    $securePassword = Read-Host "Mabang password" -AsSecureString
    $env:MABANG_PASSWORD = [System.Net.NetworkCredential]::new("", $securePassword).Password
}

if (-not $env:MABANG_LOCAL_TOKEN) {
    $env:MABANG_LOCAL_TOKEN = Read-Host "Service token (at least 20 characters; must match the WPS script)"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptDir

$venvPython = Join-Path $scriptDir ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "First run: creating an isolated Python environment..."
    python -m venv .venv
    & $venvPython -m pip install -r .\requirements-local.txt
}

& $venvPython .\mabang_local_service.py

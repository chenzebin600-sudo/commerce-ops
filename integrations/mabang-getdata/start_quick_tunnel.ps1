$ErrorActionPreference = "Stop"

$command = Get-Command cloudflared -ErrorAction SilentlyContinue
$cloudflared = $null

if ($command) {
    $cloudflared = $command.Source
}

if (-not $cloudflared) {
    $programFilesRoots = @(
        ${env:ProgramFiles(x86)},
        $env:ProgramFiles
    ) | Where-Object { $_ }
    $cloudflared = $programFilesRoots |
        ForEach-Object { Join-Path $_ "cloudflared\cloudflared.exe" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $cloudflared)) {
    throw "cloudflared.exe was not found. Please install Cloudflare Tunnel first."
}

Write-Host "Creating a temporary HTTPS address..."
Write-Host "Copy the https://xxxx.trycloudflare.com address into LOCAL_SERVICE_URL in the WPS script."
Write-Host "Keep this window open. The temporary address changes after restart."

& $cloudflared tunnel --url http://127.0.0.1:8765

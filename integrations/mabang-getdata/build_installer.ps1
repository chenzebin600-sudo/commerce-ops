$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$DistDir = Join-Path $ProjectRoot "dist"
$BuildDir = Join-Path $ProjectRoot "build"
$InstallerDir = Join-Path $DistDir "installer"

function Remove-ProjectDirectory([string]$Path) {
    $FullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $FullPath.StartsWith($ProjectRoot + [System.IO.Path]::DirectorySeparatorChar)) {
        throw "Refusing to remove a directory outside the project: $FullPath"
    }
    if (Test-Path -LiteralPath $FullPath) {
        Remove-Item -LiteralPath $FullPath -Recurse -Force
    }
}

function Invoke-PyInstallerBuild(
    [string]$SpecPath,
    [string]$OutputName,
    [string]$WorkName
) {
    for ($Attempt = 1; $Attempt -le 2; $Attempt++) {
        python -m PyInstaller --noconfirm --clean $SpecPath
        if ($LASTEXITCODE -eq 0) {
            return
        }

        if ($Attempt -eq 1) {
            Write-Host "Build was temporarily blocked. Retrying once..."
            $OutputPath = Join-Path $DistDir $OutputName
            if (Test-Path -LiteralPath $OutputPath) {
                Remove-Item -LiteralPath $OutputPath -Force
            }
            Remove-ProjectDirectory (Join-Path $BuildDir $WorkName)
            Start-Sleep -Seconds 3
        }
    }

    throw "PyInstaller build failed: $OutputName"
}

Remove-ProjectDirectory $BuildDir
Remove-ProjectDirectory $DistDir

Write-Host "[1/4] Building desktop application..."
Invoke-PyInstallerBuild `
    (Join-Path $ProjectRoot "MabangWPSAssistant.spec") `
    "MabangWPSAssistant.exe" `
    "MabangWPSAssistant"

Write-Host "[2/4] Building local service..."
Invoke-PyInstallerBuild `
    (Join-Path $ProjectRoot "MabangLocalService.spec") `
    "MabangLocalService.exe" `
    "MabangLocalService"

Write-Host "[3/4] Copying Cloudflare Tunnel..."
$ProgramFilesRoots = @(
    ${env:ProgramFiles(x86)},
    $env:ProgramFiles
) | Where-Object { $_ }
$CloudflaredCandidates = @(
    (Join-Path $ProjectRoot "cloudflared.exe")
) + @($ProgramFilesRoots | ForEach-Object {
    Join-Path $_ "cloudflared\cloudflared.exe"
})
$Cloudflared = $CloudflaredCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Cloudflared) { throw "cloudflared.exe was not found." }
Copy-Item -LiteralPath $Cloudflared -Destination (Join-Path $DistDir "cloudflared.exe") -Force

Write-Host "[4/4] Building installer..."
$IsccCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
) + @($ProgramFilesRoots | ForEach-Object {
    Join-Path $_ "Inno Setup 6\ISCC.exe"
})
$Iscc = $IsccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Iscc) { throw "Inno Setup 6 compiler was not found." }

New-Item -ItemType Directory -Path $InstallerDir -Force | Out-Null
& $Iscc (Join-Path $ProjectRoot "installer\MabangWPSAssistant.iss")
if ($LASTEXITCODE -ne 0) { throw "Installer build failed." }

Write-Host "Build complete:"
Write-Host (Join-Path $InstallerDir "MabangWPSAssistant_Setup_1.1.0.exe")

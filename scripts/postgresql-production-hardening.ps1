[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$StageOnly,
  [string]$ConfirmInstance = ""
)

$ErrorActionPreference = "Stop"
$expectedConfirmation = "commerce_ops_local_pg18"
$serviceName = "postgresql-x64-18"
$service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
if (-not $service) { throw "PostgreSQL service $serviceName was not found" }
$dataMatch = [regex]::Match($service.PathName, '-D\s+"([^"]+)"')
if (-not $dataMatch.Success) { throw "Unable to resolve PostgreSQL service paths" }
$dataDirectory = $dataMatch.Groups[1].Value
$postgresqlConf = Join-Path $dataDirectory "postgresql.conf"
$hbaConf = Join-Path $dataDirectory "pg_hba.conf"
$tlsDirectory = Join-Path $dataDirectory "tls"
$backupRoot = Join-Path ([System.IO.Path]::GetPathRoot($dataDirectory)) "PostgreSQLBackups"
$configBackupRoot = Join-Path $backupRoot "config"
$walArchiveDirectory = Join-Path $backupRoot "wal"
$logicalBackupDirectory = Join-Path $backupRoot "logical"
$secretDirectory = Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "CommerceOps\PostgreSQL\secrets"
$walKeyFile = Join-Path $secretDirectory "wal-archive.key"
$logicalKeyFile = Join-Path $secretDirectory "logical-backup.key"
$nodeExecutable = (Get-Command node).Source
$archiveScript = (Resolve-Path (Join-Path $PSScriptRoot "postgresql-wal-archive.mjs")).Path
$tlsExportScript = (Resolve-Path (Join-Path $PSScriptRoot "postgresql-export-tls-material.mjs")).Path
$fileSettingsValidator = (Resolve-Path (Join-Path $PSScriptRoot "postgresql-file-settings-validate.mjs")).Path
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$postgresEnvFile = Join-Path $repositoryRoot ".env.postgres.local"

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function New-KeyIfMissing([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return $false }
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  Write-Utf8NoBom $Path (([Convert]::ToBase64String($bytes)) + "`n")
  return $true
}

function Set-PostgresTlsEnvironment([bool]$Enabled) {
  if (-not (Test-Path -LiteralPath $postgresEnvFile)) { throw ".env.postgres.local is missing" }
  $values = [ordered]@{
    POSTGRES_SSL = $(if ($Enabled) { "true" } else { "false" })
    POSTGRES_SSL_CA_FILE = (Join-Path $tlsDirectory "root.crt")
  }
  $lines = @(Get-Content -LiteralPath $postgresEnvFile)
  foreach ($entry in $values.GetEnumerator()) {
    $matched = $false
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
      if ($lines[$index] -match ("^" + [regex]::Escape($entry.Key) + "=")) {
        $lines[$index] = "$($entry.Key)=$($entry.Value)"
        $matched = $true
      }
    }
    if (-not $matched) { $lines += "$($entry.Key)=$($entry.Value)" }
  }
  Write-Utf8NoBom $postgresEnvFile (($lines -join "`r`n") + "`r`n")
}

function Protect-Path([string]$Path, [string]$NetworkServiceRights) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $item = Get-Item -LiteralPath $Path
  & icacls.exe $Path /inheritance:r | Out-Null
  if ($item.PSIsContainer) {
    & icacls.exe $Path /grant:r "*$currentSid`:(OI)(CI)(F)" "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-20:$NetworkServiceRights" | Out-Null
  } else {
    & icacls.exe $Path /grant:r "*$currentSid`:(F)" "*S-1-5-18:(F)" "*S-1-5-20:$NetworkServiceRights" | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { throw "Failed to protect ACL for $Path" }
}

function New-TlsMaterial {
  $rootFile = Join-Path $tlsDirectory "root.crt"
  $certFile = Join-Path $tlsDirectory "server.crt"
  $keyFile = Join-Path $tlsDirectory "server.key"
  if ((Test-Path $rootFile) -and (Test-Path $certFile) -and (Test-Path $keyFile)) {
    return $false
  }
  Protect-Path $tlsDirectory "(OI)(CI)(RX)"
  Get-ChildItem -LiteralPath $tlsDirectory -Filter "tls-export-*.json" -File -ErrorAction SilentlyContinue | ForEach-Object {
    Protect-Path $_.FullName "(R)"
    Remove-Item -LiteralPath $_.FullName -Force
  }
  $ca = $null
  $server = $null
  $privatePayload = Join-Path $tlsDirectory "tls-export-$PID.json"
  try {
    $ca = New-SelfSignedCertificate -Type Custom `
      -Subject "CN=Commerce Ops PostgreSQL Root CA" `
      -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
      -KeyUsage CertSign,CRLSign,DigitalSignature `
      -TextExtension @("2.5.29.19={critical}{text}ca=true&pathlength=1") `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -NotAfter (Get-Date).AddYears(10)
    $server = New-SelfSignedCertificate -Type Custom `
      -Subject "CN=localhost" -Signer $ca `
      -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
      -KeyUsage DigitalSignature,KeyEncipherment `
      -TextExtension @(
        "2.5.29.19={critical}{text}ca=false",
        "2.5.29.17={text}DNS=localhost&DNS=$env:COMPUTERNAME&IPAddress=127.0.0.1&IPAddress=::1",
        "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
      ) `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -NotAfter (Get-Date).AddYears(2)
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($server)
    try {
      $parameters = $rsa.ExportParameters($true)
      $payload = [ordered]@{
        rootDer = [Convert]::ToBase64String($ca.RawData)
        serverDer = [Convert]::ToBase64String($server.RawData)
        rsa = [ordered]@{
          n = [Convert]::ToBase64String($parameters.Modulus)
          e = [Convert]::ToBase64String($parameters.Exponent)
          d = [Convert]::ToBase64String($parameters.D)
          p = [Convert]::ToBase64String($parameters.P)
          q = [Convert]::ToBase64String($parameters.Q)
          dp = [Convert]::ToBase64String($parameters.DP)
          dq = [Convert]::ToBase64String($parameters.DQ)
          qi = [Convert]::ToBase64String($parameters.InverseQ)
        }
      }
      Write-Utf8NoBom $privatePayload ($payload | ConvertTo-Json -Depth 5)
      & $nodeExecutable $tlsExportScript --input $privatePayload --output-directory $tlsDirectory | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Node TLS material export failed" }
    } finally { $rsa.Dispose() }
    Protect-Path $rootFile "(R)"
    Protect-Path $certFile "(R)"
    Protect-Path $keyFile "(R)"
    return $true
  } finally {
    Remove-Item -LiteralPath $privatePayload -Force -ErrorAction SilentlyContinue
    if ($server) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($server.Thumbprint)" -Force -ErrorAction SilentlyContinue }
    if ($ca) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($ca.Thumbprint)" -Force -ErrorAction SilentlyContinue }
  }
}

$plan = [ordered]@{
  status = "PLAN"
  service = $serviceName
  dataDirectory = $dataDirectory
  tlsDirectory = $tlsDirectory
  walArchiveDirectory = $walArchiveDirectory
  logicalBackupDirectory = $logicalBackupDirectory
  changesProductionProvider = $false
  touchesSqlite = $false
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 4
  exit 0
}
if ($ConfirmInstance -ne $expectedConfirmation) {
  throw "Apply requires -ConfirmInstance $expectedConfirmation"
}

if ($service.StartName -ne "NT AUTHORITY\NetworkService") { throw "Unexpected PostgreSQL service account: $($service.StartName)" }
if (-not (Test-Path $postgresqlConf) -or -not (Test-Path $hbaConf)) { throw "PostgreSQL configuration files are missing" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$snapshotDirectory = Join-Path $configBackupRoot $stamp
New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $tlsDirectory,$walArchiveDirectory,$logicalBackupDirectory,$secretDirectory -Force | Out-Null
Copy-Item -LiteralPath $postgresqlConf -Destination (Join-Path $snapshotDirectory "postgresql.conf.before")
Copy-Item -LiteralPath $hbaConf -Destination (Join-Path $snapshotDirectory "pg_hba.conf.before")

$walKeyCreated = New-KeyIfMissing $walKeyFile
$logicalKeyCreated = New-KeyIfMissing $logicalKeyFile
Protect-Path $secretDirectory "(OI)(CI)(R)"
Protect-Path $walKeyFile "(R)"
Protect-Path $logicalKeyFile "(R)"
Protect-Path $walArchiveDirectory "(OI)(CI)(M)"
$tlsCreated = New-TlsMaterial

$archiveNode = $nodeExecutable.Replace("\", "/")
$archiveModule = $archiveScript.Replace("\", "/")
$archiveTarget = $walArchiveDirectory.Replace("\", "/")
$archiveKey = $walKeyFile.Replace("\", "/")
$archiveCommand = '"' + $archiveNode + '" "' + $archiveModule + '" --source "%p" --name "%f" --archive-dir "' + $archiveTarget + '" --key-file "' + $archiveKey + '"'
$managedStart = "# BEGIN COMMERCE OPS POSTGRESQL PRODUCTION HARDENING"
$managedEnd = "# END COMMERCE OPS POSTGRESQL PRODUCTION HARDENING"
$managed = @"
$managedStart
ssl = on
ssl_cert_file = 'tls/server.crt'
ssl_key_file = 'tls/server.key'
ssl_ca_file = 'tls/root.crt'
ssl_min_protocol_version = 'TLSv1.2'
wal_level = replica
archive_mode = on
archive_command = '$archiveCommand'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d.log'
log_rotation_age = '1d'
log_truncate_on_rotation = on
log_min_duration_statement = 500
log_line_prefix = '%m [%p] %q%u@%d '
track_io_timing = on
shared_preload_libraries = 'pg_stat_statements'
compute_query_id = on
pg_stat_statements.max = 10000
pg_stat_statements.track = 'all'
$managedEnd
"@
$confText = Get-Content -LiteralPath $postgresqlConf -Raw
$managedPattern = "(?s)\r?\n?# BEGIN COMMERCE OPS POSTGRESQL PRODUCTION HARDENING.*?# END COMMERCE OPS POSTGRESQL PRODUCTION HARDENING\r?\n?"
$confText = [regex]::Replace($confText, $managedPattern, "`r`n")
Write-Utf8NoBom $postgresqlConf ($confText.TrimEnd() + "`r`n`r`n" + $managed.Trim() + "`r`n")

$validationExitCode = 1
try {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $nodeExecutable $fileSettingsValidator --confirm-infrastructure=commerce_ops_pg18 2>&1 | Out-Null
  $validationExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
} catch {
  $ErrorActionPreference = $previousErrorActionPreference
  $validationExitCode = 1
}
if ($validationExitCode -ne 0) {
  Copy-Item -LiteralPath (Join-Path $snapshotDirectory "postgresql.conf.before") -Destination $postgresqlConf -Force
  Copy-Item -LiteralPath (Join-Path $snapshotDirectory "pg_hba.conf.before") -Destination $hbaConf -Force
  throw "PostgreSQL configuration validation failed; configuration was restored"
}

$hbaText = Get-Content -LiteralPath $hbaConf -Raw
$hbaText = [regex]::Replace($hbaText, "(?m)^(\s*)host(\s+)", '${1}hostssl${2}')
Write-Utf8NoBom $hbaConf $hbaText

if ($StageOnly) {
  $stagedHba = Get-Content -LiteralPath $hbaConf -Raw
  $stagedHba = [regex]::Replace($stagedHba, "(?m)^(\s*)hostssl(\s+)", '${1}host${2}')
  Write-Utf8NoBom $hbaConf $stagedHba
  Set-PostgresTlsEnvironment $false
  [ordered]@{
    status = "STAGED_RESTART_REQUIRED"
    service = $serviceName
    snapshotDirectory = $snapshotDirectory
    tlsCreated = $tlsCreated
    walKeyCreated = $walKeyCreated
    logicalKeyCreated = $logicalKeyCreated
    changesProductionProvider = $false
    touchesSqlite = $false
  } | ConvertTo-Json -Depth 4
  exit 0
}

try {
  Restart-Service -Name $serviceName -Force
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $state = (Get-Service -Name $serviceName).Status
  } while ($state -ne "Running" -and (Get-Date) -lt $deadline)
  if ($state -ne "Running") { throw "PostgreSQL service did not return to Running" }
  Set-PostgresTlsEnvironment $true
} catch {
  Copy-Item -LiteralPath (Join-Path $snapshotDirectory "postgresql.conf.before") -Destination $postgresqlConf -Force
  Copy-Item -LiteralPath (Join-Path $snapshotDirectory "pg_hba.conf.before") -Destination $hbaConf -Force
  Restart-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
  throw
}

[ordered]@{
  status = "APPLIED"
  service = $serviceName
  serviceState = (Get-Service -Name $serviceName).Status.ToString()
  snapshotDirectory = $snapshotDirectory
  tlsCreated = $tlsCreated
  walKeyCreated = $walKeyCreated
  logicalKeyCreated = $logicalKeyCreated
  walArchiveDirectory = $walArchiveDirectory
  logicalBackupDirectory = $logicalBackupDirectory
  changesProductionProvider = $false
  touchesSqlite = $false
} | ConvertTo-Json -Depth 4

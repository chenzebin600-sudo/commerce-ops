[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$Database = "commerce_ops",
  [string]$TaskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$backupScript = (Resolve-Path (Join-Path $PSScriptRoot "backup.ps1")).Path
$restoreScript = (Resolve-Path (Join-Path $PSScriptRoot "restore_test.ps1")).Path
$walScript = (Resolve-Path (Join-Path $PSScriptRoot "check_wal.ps1")).Path
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

$principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

$backupAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" -ConfirmDatabase $Database" -WorkingDirectory $ProjectRoot
$backupTrigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At "03:00"

$restoreAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$restoreScript`" -ConfirmDatabase $Database" -WorkingDirectory $ProjectRoot
$restoreTrigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At "05:00"

$walAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$walScript`"" -WorkingDirectory $ProjectRoot
$walTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)

$definitions = @(
  [pscustomobject]@{ Name = "CommerceOpsPostgreSQLBaseBackupWeekly"; Description = "Weekly verified Commerce Ops PostgreSQL physical base backup; no automatic deletion."; Action = $backupAction; Trigger = $backupTrigger },
  [pscustomobject]@{ Name = "CommerceOpsPostgreSQLRestoreTestWeekly"; Description = "Weekly isolated restore test of the latest verified Commerce Ops PostgreSQL physical backup."; Action = $restoreAction; Trigger = $restoreTrigger },
  [pscustomobject]@{ Name = "CommerceOpsPostgreSQLWalMonitor"; Description = "15-minute Commerce Ops PostgreSQL WAL archive size and seven-day retention monitor; never deletes WAL."; Action = $walAction; Trigger = $walTrigger }
)

foreach ($definition in $definitions) {
  Register-ScheduledTask -TaskName $definition.Name -Description $definition.Description -Action $definition.Action -Trigger $definition.Trigger -Principal $principal -Settings $settings -Force | Out-Null
}

Get-ScheduledTask -TaskName $definitions.Name | Select-Object TaskName, State, Description

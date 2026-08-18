param([switch]$KeepCompanionProfile)

. (Join-Path $PSScriptRoot "common.ps1")

$startupMutex = New-Object System.Threading.Mutex($false, (Get-OutputItemsCompanionStartMutexName))
$startupLockTaken = $false
try {
try {
  $startupLockTaken = $startupMutex.WaitOne([TimeSpan]::FromSeconds(180))
} catch [System.Threading.AbandonedMutexException] {
  $startupLockTaken = $true
}
if (-not $startupLockTaken) { throw "另一个产出项启动事务仍在运行，卸载等待已超时。" }

$installStatePath = Join-Path $script:DataRoot "install-state.json"
$removeShortcut = $false
if (Test-Path -LiteralPath $installStatePath -PathType Leaf) {
  try {
    $installState = Get-Content -LiteralPath $installStatePath -Raw | ConvertFrom-Json
    $removeShortcut = $installState.desktopShortcutCreated -eq $true
  } catch { }
}

Stop-OutputItemsCompanion $script:InstallRoot
Stop-OutputItemsHttpService
Unregister-OutputItems
if ($removeShortcut) { Remove-OutputItemsDesktopShortcut }
if (-not $KeepCompanionProfile) { Remove-OutputItemsCompanionPrivateData }
if (Test-Path -LiteralPath $script:InstallRoot) {
  $resolved = (Resolve-Path -LiteralPath $script:InstallRoot).Path
  $expected = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "CodexLocalExtensions\output-items"))
  if ($resolved -ne $expected) { throw "卸载目标异常，已停止：$resolved" }
  if (-not (Test-OutputItemsExtension $resolved)) { throw "卸载目标没有产出项扩展标识，已停止。" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
$uninstallState = [ordered]@{
  installed = $false
  uninstalledAt = (Get-Date).ToString("o")
  dataRoot = $script:DataRoot
  companionProfileRetained = [bool]$KeepCompanionProfile
}
$uninstallState | ConvertTo-Json | Set-Content -LiteralPath $installStatePath -Encoding UTF8
Write-Host "产出项扩展已卸载。历史数据保留在：$script:DataRoot" -ForegroundColor Green
if ($KeepCompanionProfile) { Write-Host "已按参数保留独立 Codex profile。" }
else { Write-Host "独立 Codex profile、运行状态和伴生日志已清除。" }
Write-Host "真实产出文件与产出项历史均未删除。"
Write-Host "没有修改或删除 Codex 本体文件。"
} finally {
  if ($startupLockTaken) { $startupMutex.ReleaseMutex() }
  $startupMutex.Dispose()
}

param(
  [switch]$SkipCopy,
  [switch]$CreateDesktopShortcut
)

. (Join-Path $PSScriptRoot "common.ps1")

function Copy-VerifiedReleasePackage($ReleaseManifest, [string]$SourceRoot, [string]$TargetRoot) {
  New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
  foreach ($entry in @($ReleaseManifest.files)) {
    $relative = ([string]$entry.path).Replace('/', '\')
    $source = Join-Path $SourceRoot $relative
    $target = Join-Path $TargetRoot $relative
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  Copy-Item -LiteralPath (Join-Path $SourceRoot "release-manifest.json") -Destination (Join-Path $TargetRoot "release-manifest.json") -Force
}

function New-OutputItemsDataBackup {
  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $backupRoot = Join-Path $script:DataRoot ("backups\pre-install-$timestamp-$PID")
  $relativeFiles = @("data\items.json", "data\scanner.json", "logs\events.ndjson", "install-state.json")
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $state = [ordered]@{ createdAt = (Get-Date).ToUniversalTime().ToString("o"); files = @() }
  foreach ($relative in $relativeFiles) {
    $source = Join-Path $script:DataRoot $relative
    $existed = Test-Path -LiteralPath $source -PathType Leaf
    if ($existed) {
      $target = Join-Path $backupRoot $relative
      New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $source -Destination $target -Force
    }
    $state.files += [ordered]@{ path = $relative; existed = [bool]$existed }
  }
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backupRoot "backup-state.json") -Encoding UTF8
  return $backupRoot
}

function Restore-OutputItemsDataBackup([string]$BackupRoot) {
  if (-not $BackupRoot -or -not (Test-Path -LiteralPath $BackupRoot -PathType Container)) { return }
  $state = Get-Content -LiteralPath (Join-Path $BackupRoot "backup-state.json") -Raw | ConvertFrom-Json
  foreach ($entry in @($state.files)) {
    $relative = [string]$entry.path
    $target = Join-Path $script:DataRoot $relative
    if ($entry.existed -eq $true) {
      $source = Join-Path $BackupRoot $relative
      New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $source -Destination $target -Force
    } elseif (Test-Path -LiteralPath $target -PathType Leaf) {
      Remove-Item -LiteralPath $target -Force
    }
  }
}

$startupMutex = New-Object System.Threading.Mutex($false, (Get-OutputItemsCompanionStartMutexName))
$startupLockTaken = $false
$stageRoot = $null
$installBackupRoot = $null
$dataBackupRoot = $null
$transactionStarted = $false
$installSucceeded = $false
$hadExistingInstall = $false
$previousVersion = $null

try {
  try {
    $startupLockTaken = $startupMutex.WaitOne([TimeSpan]::FromSeconds(180))
  } catch [System.Threading.AbandonedMutexException] {
    $startupLockTaken = $true
  }
  if (-not $startupLockTaken) { throw "另一个产出项启动事务仍在运行，安装等待已超时。" }

  $sourceRoot = Split-Path $PSScriptRoot -Parent
  if (-not (Test-OutputItemsExtension $sourceRoot)) { throw "安装包不完整：$sourceRoot" }
  $releaseManifest = Assert-OutputItemsReleasePackage $sourceRoot
  $sourceManifest = Get-Content -LiteralPath (Join-Path $sourceRoot "extension.json") -Raw | ConvertFrom-Json
  if ([string]$sourceManifest.version -ne "1.0.0") { throw "正式安装器只接受 v1.0.0 发布包。" }

  $sourceResolved = (Resolve-Path -LiteralPath $sourceRoot).Path
  $expectedTarget = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "CodexLocalExtensions\output-items"))
  if ($sourceResolved.Equals($expectedTarget, [StringComparison]::OrdinalIgnoreCase)) {
    throw "请从已完整解压的 Release 目录运行安装器，不要在现有安装目录内覆盖安装。"
  }
  if ($SkipCopy) { throw "正式 Release 安装不支持 SkipCopy；请从完整安装包执行。" }

  $hadExistingInstall = Test-Path -LiteralPath $script:InstallRoot -PathType Container
  if ($hadExistingInstall) {
    if (-not (Test-OutputItemsExtension $script:InstallRoot)) {
      throw "安装目标已存在且无法确认属于产出项：$script:InstallRoot"
    }
    try { $previousVersion = (Get-Content -LiteralPath (Join-Path $script:InstallRoot "extension.json") -Raw | ConvertFrom-Json).version } catch { }
  }

  $preflightNode = Get-NodeRuntime
  $null = Get-CodexCli
  $null = Get-CodexDesktopExecutable
  & $preflightNode (Join-Path $sourceRoot "scripts\self-test.mjs")
  if ($LASTEXITCODE -ne 0) { throw "安装源服务自检失败，现有安装未修改。" }
  & $preflightNode (Join-Path $sourceRoot "companion\codex-companion.mjs") --self-test
  if ($LASTEXITCODE -ne 0) { throw "安装源伴生程序自检失败，现有安装未修改。" }

  $hadValidationDataRoot = Test-Path Env:OUTPUT_ITEMS_DATA_DIR
  $previousValidationDataRoot = $env:OUTPUT_ITEMS_DATA_DIR
  try {
    $env:OUTPUT_ITEMS_DATA_DIR = $script:DataRoot
    & $preflightNode (Join-Path $sourceRoot "scripts\validate-data.mjs")
    if ($LASTEXITCODE -ne 0) { throw "产出项历史数据校验失败，现有安装未修改。" }
  } finally {
    if ($hadValidationDataRoot) { $env:OUTPUT_ITEMS_DATA_DIR = $previousValidationDataRoot }
    else { Remove-Item Env:OUTPUT_ITEMS_DATA_DIR -ErrorAction SilentlyContinue }
  }

  if ($CreateDesktopShortcut) {
    $candidateShortcut = Get-OutputItemsDesktopShortcutPath
    if ((Test-Path -LiteralPath $candidateShortcut -PathType Leaf) -and -not (Test-OutputItemsDesktopShortcutOwnership $script:InstallRoot)) {
      throw "桌面已存在同名但不属于本扩展的快捷方式，未覆盖：$candidateShortcut"
    }
  }

  $runningCompanion = Get-OutputItemsCompanionState
  if (Test-OutputItemsCompanionHealth $runningCompanion $script:InstallRoot) {
    throw "检测到 Codex 产出项窗口仍在运行。为避免关闭未发送内容，请先双击 [停止 Codex 产出项.bat]，再重新安装。"
  }

  $installParent = Split-Path $script:InstallRoot -Parent
  New-Item -ItemType Directory -Path $installParent -Force | Out-Null
  $nonce = [Guid]::NewGuid().ToString("N")
  $stageRoot = Join-Path $installParent ".output-items-stage-$PID-$nonce"
  $installBackupRoot = Join-Path $installParent ".output-items-backup-$PID-$nonce"
  Copy-VerifiedReleasePackage $releaseManifest $sourceRoot $stageRoot
  $null = Assert-OutputItemsReleasePackage $stageRoot
  & $preflightNode (Join-Path $stageRoot "scripts\self-test.mjs")
  if ($LASTEXITCODE -ne 0) { throw "安装暂存目录自检失败，现有安装未修改。" }

  $dataBackupRoot = New-OutputItemsDataBackup
  Stop-OutputItemsCompanion $sourceRoot
  Stop-OutputItemsHttpService

  $transactionStarted = $true
  if ($hadExistingInstall) { Move-Item -LiteralPath $script:InstallRoot -Destination $installBackupRoot }
  Move-Item -LiteralPath $stageRoot -Destination $script:InstallRoot
  $stageRoot = $null

  $runtime = Register-OutputItems $script:InstallRoot
  & $runtime.Node (Join-Path $script:InstallRoot "scripts\self-test.mjs")
  if ($LASTEXITCODE -ne 0) { throw "已安装服务自检失败。" }

  $hadDataRoot = Test-Path Env:OUTPUT_ITEMS_DATA_DIR
  $previousDataRoot = $env:OUTPUT_ITEMS_DATA_DIR
  try {
    $env:OUTPUT_ITEMS_DATA_DIR = $script:DataRoot
    & $runtime.Node (Join-Path $script:InstallRoot "scripts\register-self.mjs")
    if ($LASTEXITCODE -ne 0) { throw "无法登记产出项公开发行版。" }
  } finally {
    if ($hadDataRoot) { $env:OUTPUT_ITEMS_DATA_DIR = $previousDataRoot }
    else { Remove-Item Env:OUTPUT_ITEMS_DATA_DIR -ErrorAction SilentlyContinue }
  }
  $companionState = Start-OutputItemsCompanion $script:InstallRoot

  $previousShortcutOwned = $false
  $firstInstalledAt = $null
  $previousInstallStatePath = Join-Path $script:DataRoot "install-state.json"
  if (Test-Path -LiteralPath $previousInstallStatePath -PathType Leaf) {
    try {
      $previousInstallState = Get-Content -LiteralPath $previousInstallStatePath -Raw | ConvertFrom-Json
      $previousShortcutOwned = $previousInstallState.desktopShortcutCreated -eq $true
      $firstInstalledAt = if ($previousInstallState.firstInstalledAt) { [string]$previousInstallState.firstInstalledAt } elseif ($previousInstallState.installedAt) { [string]$previousInstallState.installedAt } else { $null }
    } catch { }
  }

  $shortcutPath = $null
  $shortcutExists = $false
  if ($CreateDesktopShortcut) {
    $shortcutPath = Install-OutputItemsDesktopShortcut $script:InstallRoot
    $shortcutExists = $true
  } elseif ($previousShortcutOwned -and (Test-OutputItemsDesktopShortcutOwnership $script:InstallRoot)) {
    $shortcutPath = Get-OutputItemsDesktopShortcutPath
    $shortcutExists = $true
  }

  $state = [ordered]@{
    installed = $true
    firstInstalledAt = if ($firstInstalledAt) { $firstInstalledAt } else { (Get-Date).ToString("o") }
    installedAt = (Get-Date).ToString("o")
    previousVersion = $previousVersion
    currentVersion = [string]$sourceManifest.version
    extensionRoot = $script:InstallRoot
    dataRoot = $script:DataRoot
    dataBackup = $dataBackupRoot
    codexCli = $runtime.Cli
    node = $runtime.Node
    serverName = $script:ServerName
    companionProfile = $script:CompanionProfilePath
    companionRunFile = $script:CompanionStatePath
    companionPid = $companionState.pid
    desktopShortcutCreated = [bool]$shortcutExists
    desktopShortcut = if ($shortcutExists) { $shortcutPath } else { $null }
  }
  New-Item -ItemType Directory -Path $script:DataRoot -Force | Out-Null
  $state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:DataRoot "install-state.json") -Encoding UTF8
  $installSucceeded = $true

  if (Test-Path -LiteralPath $installBackupRoot -PathType Container) {
    Remove-Item -LiteralPath $installBackupRoot -Recurse -Force
    $installBackupRoot = $null
  }

  Write-Host ""
  Write-Host "产出项 v$($sourceManifest.version) 已安装并启用。" -ForegroundColor Green
  Write-Host "扩展目录：$script:InstallRoot"
  Write-Host "数据目录：$script:DataRoot"
  Write-Host "升级前数据备份：$dataBackupRoot"
  if ($shortcutExists) { Write-Host "桌面快捷方式：$shortcutPath" }
  Write-Host '请双击 [启动 Codex 产出项.bat]。首次使用独立 Codex profile 时可能需要登录。' -ForegroundColor Yellow
} catch {
  $installFailure = $_
  $rollbackErrors = [System.Collections.Generic.List[string]]::new()
  if ($transactionStarted -and -not $installSucceeded) {
    try { Stop-OutputItemsCompanion $script:InstallRoot } catch { $rollbackErrors.Add("停止新伴生程序失败：$($_.Exception.Message)") }
    try { Stop-OutputItemsHttpService } catch { $rollbackErrors.Add("停止新服务失败：$($_.Exception.Message)") }
    try { Unregister-OutputItems } catch { $rollbackErrors.Add("移除新 MCP 注册失败：$($_.Exception.Message)") }
    try {
      if (Test-Path -LiteralPath $script:InstallRoot -PathType Container) {
        if (-not (Test-OutputItemsExtension $script:InstallRoot)) { throw "目标目录标识异常，未删除" }
        Remove-Item -LiteralPath $script:InstallRoot -Recurse -Force
      }
      if ($hadExistingInstall -and (Test-Path -LiteralPath $installBackupRoot -PathType Container)) {
        Move-Item -LiteralPath $installBackupRoot -Destination $script:InstallRoot
        $installBackupRoot = $null
      }
    } catch { $rollbackErrors.Add("恢复旧安装目录失败：$($_.Exception.Message)") }
    try { Restore-OutputItemsDataBackup $dataBackupRoot } catch { $rollbackErrors.Add("恢复历史数据失败：$($_.Exception.Message)") }
    if ($hadExistingInstall -and (Test-OutputItemsExtension $script:InstallRoot)) {
      try {
        $null = Register-OutputItems $script:InstallRoot
        $null = Start-OutputItemsCompanion $script:InstallRoot
      } catch { $rollbackErrors.Add("重新启用旧版本失败：$($_.Exception.Message)") }
    }
  }
  $suffix = if ($rollbackErrors.Count) { " 回滚存在问题：" + ($rollbackErrors -join "；") } elseif ($transactionStarted) { " 已恢复升级前安装与数据。" } else { " 现有安装未修改。" }
  throw ($installFailure.Exception.Message + $suffix)
} finally {
  if ($stageRoot -and (Test-Path -LiteralPath $stageRoot -PathType Container)) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($startupLockTaken) { $startupMutex.ReleaseMutex() }
  $startupMutex.Dispose()
}

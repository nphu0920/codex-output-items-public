. (Join-Path $PSScriptRoot "common.ps1")

if (-not (Test-OutputItemsExtension $script:InstallRoot)) {
  throw '产出项尚未安装，请先双击 [安装产出项扩展.bat]。'
}

$state = Start-OutputItemsCompanion $script:InstallRoot -Open
Write-Output "OUTPUT_ITEMS_COMPANION_PID=$($state.pid)"
Write-Output "OUTPUT_ITEMS_CODEX_PID=$($state.codexPid)"
Write-Host "已打开带“产出项”侧栏的独立 Codex 窗口。" -ForegroundColor Green
Write-Host "它使用独立 profile，不修改 Codex 安装目录，也不会影响已打开的普通 Codex 窗口。"

. (Join-Path $PSScriptRoot "common.ps1")

$extensionRoot = if (Test-OutputItemsExtension $script:InstallRoot) {
  $script:InstallRoot
} else {
  Split-Path $PSScriptRoot -Parent
}

Stop-OutputItemsCompanion $extensionRoot
Stop-OutputItemsHttpService
Write-Host "Codex 产出项伴生窗口和本地 HTTP 服务已停止；扩展、历史数据和真实产出文件均已保留。" -ForegroundColor Green

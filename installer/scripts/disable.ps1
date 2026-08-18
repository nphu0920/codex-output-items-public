. (Join-Path $PSScriptRoot "common.ps1")

Stop-OutputItemsCompanion $script:InstallRoot
Stop-OutputItemsHttpService
Unregister-OutputItems
Write-Host "产出项已停用；伴生 Codex、本地 HTTP 服务和 MCP 注册均已停止，扩展文件与历史数据保留。" -ForegroundColor Green

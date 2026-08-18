. (Join-Path $PSScriptRoot "common.ps1")

$runtime = Register-OutputItems $script:InstallRoot
& $runtime.Node (Join-Path $script:InstallRoot "scripts\self-test.mjs")
if ($LASTEXITCODE -ne 0) { throw "产出项 MCP 自检失败。" }
$companionState = Start-OutputItemsCompanion $script:InstallRoot
Write-Host "产出项 MCP 工具和 Codex 伴生入口已启用（伴生 PID：$($companionState.pid)）。" -ForegroundColor Green
Write-Host '双击 [启动 Codex 产出项.bat] 可激活并打开“产出项”页面。'

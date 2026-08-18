. (Join-Path $PSScriptRoot "common.ps1")

$extensionRoot = Split-Path $PSScriptRoot -Parent
$result = Invoke-OutputItemsLauncherSafetySelfTest $extensionRoot
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))

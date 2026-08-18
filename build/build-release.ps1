param(
  [switch]$SkipDependencyInstall,
  [switch]$SkipWebBuild,
  [switch]$SkipTests,
  [switch]$KeepStage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release-common.ps1")

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$distRoot = Join-Path $repoRoot "dist"
$packageName = "codex-output-items-1.0.0"
$stageRoot = Join-Path $distRoot ("stage\" + $packageName)
$zipPath = Join-Path $distRoot "codex-output-items-windows-1.0.0.zip"
$shaPath = "$zipPath.sha256"
$nodePath = Get-BuildNodePath
$npmPath = Get-BuildNpmPath

Invoke-CheckedCommand $nodePath @((Join-Path $repoRoot "build\verify-source.mjs")) $repoRoot
if (-not $SkipTests) { Invoke-CheckedCommand $nodePath @("--test", (Join-Path $repoRoot "tests\release-tooling.test.mjs")) $repoRoot }
if (-not $SkipDependencyInstall) {
  if (-not $npmPath) { throw "未找到 npm；请安装 Node.js 工具链，或在依赖已存在时使用 -SkipDependencyInstall。" }
  Invoke-CheckedCommand $npmPath @("ci", "--prefix", "web") $repoRoot
}
if (-not $SkipWebBuild) {
  if ($npmPath) {
    Invoke-CheckedCommand $npmPath @("--prefix", "web", "run", "build") $repoRoot
  } else {
    $vite = Join-Path $repoRoot "web\node_modules\vite\bin\vite.js"
    if (-not (Test-Path -LiteralPath $vite -PathType Leaf)) { throw "未找到 Vite；请先安装 web 锁定依赖。" }
    Invoke-CheckedCommand $nodePath @($vite, "build", "--configLoader", "runner") (Join-Path $repoRoot "web")
  }
}
if (-not $SkipTests) {
  if ($npmPath) {
    Invoke-CheckedCommand $npmPath @("--prefix", "web", "test") $repoRoot
  } else {
    $webTests = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot "web\tests") -Filter "*.test.mjs" -File | Sort-Object Name | ForEach-Object FullName)
    Invoke-CheckedCommand $nodePath (@("--test") + $webTests) $repoRoot
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "web\dist\index.html") -PathType Leaf)) {
  throw "web/dist 不存在；请先构建前端。"
}

$expectedDist = [IO.Path]::GetFullPath((Join-Path $repoRoot "dist"))
if (Test-Path -LiteralPath $distRoot) {
  $resolvedDist = (Resolve-Path -LiteralPath $distRoot).Path
  if (-not $resolvedDist.Equals($expectedDist, [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝清理异常 dist 路径：$resolvedDist" }
  Remove-Item -LiteralPath $resolvedDist -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

$releaseDefinition = Get-Content -LiteralPath (Join-Path $repoRoot "build\release-files.json") -Raw | ConvertFrom-Json
$targets = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in @($releaseDefinition.files)) {
  $source = [IO.Path]::GetFullPath((Join-Path $repoRoot ([string]$entry.source)))
  $targetRelative = ([string]$entry.target).Replace('/', '\')
  if (-not $targets.Add($targetRelative)) { throw "重复 Release 目标：$targetRelative" }
  $target = [IO.Path]::GetFullPath((Join-Path $stageRoot $targetRelative))
  if (-not $target.StartsWith($stageRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Release 目标越界：$targetRelative" }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release 源文件缺失：$source" }
  New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

$webIndexSource = Join-Path $repoRoot ([string]$releaseDefinition.web.indexSource)
$webIndexTarget = Join-Path $stageRoot (([string]$releaseDefinition.web.indexTarget).Replace('/', '\'))
New-Item -ItemType Directory -Path (Split-Path $webIndexTarget -Parent) -Force | Out-Null
Copy-Item -LiteralPath $webIndexSource -Destination $webIndexTarget -Force
$indexText = Get-Content -LiteralPath $webIndexSource -Raw
$assets = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($match in [regex]::Matches($indexText, '(?:src|href)=["'']/?([^"''?#]+)')) {
  $relative = ([string]$match.Groups[1].Value).Replace('\', '/')
  if (-not $relative.StartsWith("assets/", [StringComparison]::OrdinalIgnoreCase)) { continue }
  if ([IO.Path]::GetExtension($relative) -notin @(".js", ".css")) { throw "不允许的 UI 资源类型：$relative" }
  if (-not $assets.Add($relative)) { continue }
  $source = Join-Path (Join-Path $repoRoot ([string]$releaseDefinition.web.assetSourceRoot)) ($relative.Replace('/', '\'))
  $target = Join-Path (Join-Path $stageRoot ([string]$releaseDefinition.web.assetTargetRoot)) ($relative.Replace('/', '\'))
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "UI 资源缺失：$relative" }
  New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}
if ($assets.Count -lt 2) { throw "生成的 UI 未引用完整 JS/CSS 资源。" }

Invoke-CheckedCommand $nodePath @((Join-Path $repoRoot "build\generate-sbom.mjs"), (Join-Path $stageRoot "SBOM.spdx.json")) $repoRoot
Invoke-CheckedCommand $nodePath @((Join-Path $repoRoot "build\privacy-scan.mjs"), $stageRoot) $repoRoot

$manifestFiles = @()
foreach ($file in (Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force | Sort-Object FullName)) {
  if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Release staging 含重解析点：$($file.FullName)" }
  $manifestFiles += [ordered]@{
    path = Get-ReleaseRelativePath $stageRoot $file.FullName
    size = [int64]$file.Length
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$releaseManifest = [ordered]@{
  format = "codex-output-items-release/v1"
  version = "1.0.0"
  reproducible = $true
  files = $manifestFiles
}
$manifestJson = $releaseManifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $stageRoot "release-manifest.json"), $manifestJson + "`n", (New-Object Text.UTF8Encoding($false)))

$null = Assert-ReleaseDirectory $stageRoot
if (-not $SkipTests) { Invoke-ReleaseSelfTests $stageRoot $nodePath }

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $stageRoot "SBOM.spdx.json") -Destination (Join-Path $distRoot "codex-output-items-1.0.0.spdx.json") -Force
Copy-Item -LiteralPath (Join-Path $stageRoot "release-manifest.json") -Destination (Join-Path $distRoot "release-manifest-1.0.0.json") -Force
New-DeterministicZip $stageRoot $packageName $zipPath
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($shaPath, "$zipHash  $([IO.Path]::GetFileName($zipPath))`n", (New-Object Text.UTF8Encoding($false)))

$verifyArgs = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $repoRoot "build\verify-release.ps1"), "-ZipPath", $zipPath)
if ($SkipTests) { $verifyArgs += "-SkipTests" }
Invoke-CheckedCommand "powershell.exe" $verifyArgs $repoRoot

if (-not $KeepStage -and (Test-Path -LiteralPath (Join-Path $distRoot "stage") -PathType Container)) {
  Remove-Item -LiteralPath (Join-Path $distRoot "stage") -Recurse -Force
}
Write-Output "RELEASE_ZIP=$zipPath"
Write-Output "RELEASE_SHA256=$zipHash"

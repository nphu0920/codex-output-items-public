param(
  [string]$ZipPath = "",
  [switch]$SkipTests,
  [switch]$KeepExtracted
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release-common.ps1")

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if (-not $ZipPath) { $ZipPath = Join-Path $repoRoot "dist\codex-output-items-windows-1.0.0.zip" }
$zipResolved = (Resolve-Path -LiteralPath $ZipPath).Path
$shaPath = "$zipResolved.sha256"
if (-not (Test-Path -LiteralPath $shaPath -PathType Leaf)) { throw "缺少外部 SHA-256 文件：$shaPath" }
$expectedHash = ((Get-Content -LiteralPath $shaPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $zipResolved -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) { throw "Release ZIP 外部 SHA-256 不匹配。" }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zipResolved)
try {
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if (-not $name.StartsWith("codex-output-items-1.0.0/", [StringComparison]::Ordinal) -or $name.StartsWith("/", [StringComparison]::Ordinal) -or $name -match '(^|/)\.\.(/|$)') {
      throw "ZIP 含不安全路径：$name"
    }
  }
} finally {
  $archive.Dispose()
}

$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$extractRoot = Join-Path $temporaryBase ("codex-output-items-release-verify-" + [Guid]::NewGuid().ToString("N"))
$extractFull = [IO.Path]::GetFullPath($extractRoot)
if (-not $extractFull.StartsWith($temporaryBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "临时解压路径异常。" }
New-Item -ItemType Directory -Path $extractFull -Force | Out-Null
try {
  [IO.Compression.ZipFile]::ExtractToDirectory($zipResolved, $extractFull)
  $packageRoot = Join-Path $extractFull "codex-output-items-1.0.0"
  $null = Assert-ReleaseDirectory $packageRoot

  $nodePath = Get-BuildNodePath
  Invoke-CheckedCommand $nodePath @((Join-Path $repoRoot "build\privacy-scan.mjs"), $packageRoot) $repoRoot
  & {
    param($CommonPath, $Root)
    . $CommonPath
    $null = Assert-OutputItemsReleasePackage $Root
  } (Join-Path $packageRoot "scripts\common.ps1") $packageRoot
  if (-not $SkipTests) { Invoke-ReleaseSelfTests $packageRoot $nodePath }
  Write-Output "VERIFY_RELEASE_OK zip=$zipResolved sha256=$actualHash"
  if ($KeepExtracted) { Write-Output "VERIFY_EXTRACTED_ROOT=$extractFull" }
} finally {
  if (-not $KeepExtracted -and (Test-Path -LiteralPath $extractFull -PathType Container)) {
    $resolved = (Resolve-Path -LiteralPath $extractFull).Path
    if (-not $resolved.StartsWith($temporaryBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝清理异常临时目录：$resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

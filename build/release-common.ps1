Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-BuildNodePath {
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($env:OUTPUT_ITEMS_NODE) { $candidates.Add($env:OUTPUT_ITEMS_NODE) }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates.Add($command.Source) }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $candidates.Add($command.Source) }
  $candidates.Add((Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"))
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      & $candidate --input-type=module -e "import('node:sqlite').catch(()=>process.exit(42))" 2>$null
      if ($LASTEXITCODE -eq 0) { return (Resolve-Path -LiteralPath $candidate).Path }
    } catch { }
  }
  throw "未找到支持 node:sqlite 的构建 Node。请设置 OUTPUT_ITEMS_NODE 或安装 Node.js 22.13+。"
}

function Get-BuildNpmPath {
  foreach ($name in @("npm.cmd", "npm")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  return $null
}

function Get-ReleaseRelativePath([string]$Root, [string]$Target) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $targetFull = [IO.Path]::GetFullPath($Target)
  if (-not $targetFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "路径不在预期根目录内：$targetFull"
  }
  return $targetFull.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
}

function Invoke-CheckedCommand([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "命令失败 ($LASTEXITCODE)：$FilePath $($Arguments -join ' ')" }
  } finally {
    Pop-Location
  }
}

function Assert-ReleaseDirectory([string]$PackageRoot) {
  $resolvedRoot = (Resolve-Path -LiteralPath $PackageRoot).Path.TrimEnd('\', '/')
  $manifestPath = Join-Path $resolvedRoot "release-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Release 缺少 release-manifest.json。" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.format -ne "codex-output-items-release/v1" -or [string]$manifest.version -ne "1.0.0") {
    throw "Release 清单格式或版本错误。"
  }

  $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($manifest.files)) {
    $relative = ([string]$entry.path).Replace('\', '/').Trim('/')
    if (-not $relative -or [IO.Path]::IsPathRooted($relative) -or $relative -match '(^|/)\.\.(/|$)' -or -not $expected.Add($relative)) {
      throw "Release 清单含不安全或重复路径：$relative"
    }
    $target = [IO.Path]::GetFullPath((Join-Path $resolvedRoot ($relative.Replace('/', '\'))))
    if (-not $target.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Release 路径越界：$relative" }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Release 文件缺失：$relative" }
    $cursor = $resolvedRoot
    foreach ($segment in ($relative -split '/')) {
      $cursor = Join-Path $cursor $segment
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Release 含重解析点：$relative" }
    }
    $file = Get-Item -LiteralPath $target -Force
    if ([int64]$entry.size -ne [int64]$file.Length) { throw "Release 文件大小不匹配：$relative" }
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Release 文件哈希不匹配：$relative" }
  }

  foreach ($file in (Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Force)) {
    if ($file.FullName.Equals($manifestPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $relative = Get-ReleaseRelativePath $resolvedRoot $file.FullName
    if (-not $expected.Contains($relative)) { throw "Release 含清单外文件：$relative" }
  }

  $extension = Get-Content -LiteralPath (Join-Path $resolvedRoot "extension.json") -Raw | ConvertFrom-Json
  $package = Get-Content -LiteralPath (Join-Path $resolvedRoot "package.json") -Raw | ConvertFrom-Json
  if ($extension.id -ne "local.codex-output-items" -or $extension.version -ne "1.0.0" -or $package.version -ne "1.0.0") {
    throw "Release 元数据不一致。"
  }

  $indexPath = Join-Path $resolvedRoot "ui\index.html"
  $indexText = Get-Content -LiteralPath $indexPath -Raw
  $referenced = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($match in [regex]::Matches($indexText, '(?:src|href)=["'']/?([^"''?#]+)')) {
    $relative = ([string]$match.Groups[1].Value).Replace('\', '/')
    if ($relative.StartsWith("assets/", [StringComparison]::OrdinalIgnoreCase)) {
      $null = $referenced.Add("ui/$relative")
      if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot ($relative.Insert(0, "ui/").Replace('/', '\'))) -PathType Leaf)) {
        throw "UI 引用资源缺失：$relative"
      }
    }
  }
  if ($referenced.Count -lt 2) { throw "UI 至少应引用一个脚本和一个样式资源。" }
  foreach ($asset in (Get-ChildItem -LiteralPath (Join-Path $resolvedRoot "ui\assets") -File -Force)) {
    $relative = Get-ReleaseRelativePath $resolvedRoot $asset.FullName
    if (-not $referenced.Contains($relative)) { throw "UI 含未引用的陈旧资源：$relative" }
  }
  return $manifest
}

function Invoke-ReleaseSelfTests([string]$PackageRoot, [string]$NodePath) {
  $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
  $fixtureParent = Join-Path $repoRoot (".release-fixtures-$PID-" + [Guid]::NewGuid().ToString("N"))
  $hadFixtureOverride = Test-Path Env:OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT
  $previousFixtureOverride = $env:OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT
  New-Item -ItemType Directory -Path $fixtureParent -Force | Out-Null
  try {
    $env:OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT = $fixtureParent
    # Keep the process working directory outside a freshly extracted Windows
    # Temp package. Some Temp ACL/8.3 combinations deny parent inspection even
    # though each explicitly addressed package file remains readable.
    Invoke-CheckedCommand $NodePath @("--check", (Join-Path $PackageRoot "server.mjs")) $fixtureParent
    Invoke-CheckedCommand $NodePath @("--check", (Join-Path $PackageRoot "scripts\codex-output-scanner.mjs")) $fixtureParent
    Invoke-CheckedCommand $NodePath @("--check", (Join-Path $PackageRoot "scripts\github-publisher.mjs")) $fixtureParent
    Invoke-CheckedCommand $NodePath @("--check", (Join-Path $PackageRoot "companion\codex-companion.mjs")) $fixtureParent
    Invoke-CheckedCommand $NodePath @((Join-Path $PackageRoot "scripts\self-test.mjs")) $fixtureParent
    Invoke-CheckedCommand $NodePath @((Join-Path $PackageRoot "scripts\github-publisher-self-test.mjs")) $fixtureParent
    Invoke-CheckedCommand $NodePath @((Join-Path $PackageRoot "scripts\recycle-path-self-test.mjs")) $fixtureParent
    Invoke-CheckedCommand $NodePath @((Join-Path $PackageRoot "companion\codex-companion.mjs"), "--self-test") $fixtureParent
    Invoke-CheckedCommand "powershell.exe" @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PackageRoot "scripts\launcher-safety-self-test.ps1")) $fixtureParent
  } finally {
    if ($hadFixtureOverride) { $env:OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT = $previousFixtureOverride }
    else { Remove-Item Env:OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $fixtureParent -PathType Container) {
      $resolvedFixture = (Resolve-Path -LiteralPath $fixtureParent).Path
      if (-not $resolvedFixture.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝清理异常自测目录：$resolvedFixture" }
      Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    }
  }
}

function New-DeterministicZip([string]$SourceRoot, [string]$PackageName, [string]$ZipPath) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
  $stream = [IO.File]::Open($ZipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = $null
  try {
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    $timestamp = [DateTimeOffset]::Parse("1980-01-01T00:00:00Z")
    foreach ($file in (Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | Sort-Object FullName)) {
      $relative = Get-ReleaseRelativePath $SourceRoot $file.FullName
      $entry = $archive.CreateEntry("$PackageName/$relative", [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = $timestamp
      $input = [IO.File]::OpenRead($file.FullName)
      $output = $entry.Open()
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
  } finally {
    if ($null -ne $archive) { $archive.Dispose() }
    $stream.Dispose()
  }
}

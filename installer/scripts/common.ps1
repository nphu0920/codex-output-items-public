Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ServerName = "output_items"
$script:InstallRoot = Join-Path $env:USERPROFILE "CodexLocalExtensions\output-items"
$script:DataRoot = Join-Path $env:LOCALAPPDATA "CodexOutputItems"
$script:RunRoot = Join-Path $script:DataRoot "run"
$script:ServerStatePath = Join-Path $script:RunRoot "server.json"
$script:CompanionRoot = Join-Path $script:DataRoot "companion"
$script:CompanionProfilePath = Join-Path $script:CompanionRoot "codex-profile"
$script:CompanionStatePath = Join-Path $script:RunRoot "companion.json"
$script:CompanionLogPath = Join-Path $script:RunRoot "companion.log"
$script:DesktopShortcutName = "Codex 产出项.lnk"

function Suspend-OutputItemsTaskContext {
  $snapshot = [ordered]@{}
  foreach ($name in @("CODEX_THREAD_ID", "OUTPUT_ITEMS_SOURCE_THREAD_ID")) {
    $snapshot[$name] = [pscustomobject]@{
      Exists = Test-Path -LiteralPath ("Env:" + $name)
      Value = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
  return $snapshot
}

function Restore-OutputItemsTaskContext($Snapshot) {
  foreach ($name in @("CODEX_THREAD_ID", "OUTPUT_ITEMS_SOURCE_THREAD_ID")) {
    $entry = $Snapshot[$name]
    if ($null -ne $entry -and $entry.Exists) {
      [Environment]::SetEnvironmentVariable($name, [string]$entry.Value, "Process")
    } else {
      [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
  }
}

function Add-CodexAppxCandidates(
  [System.Collections.Generic.List[string]]$Candidates,
  [string[]]$RelativePaths
) {
  try {
    Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
      Sort-Object Version -Descending |
      ForEach-Object {
        if (-not $_.InstallLocation) { return }
        foreach ($relativePath in $RelativePaths) {
          $Candidates.Add((Join-Path $_.InstallLocation $relativePath))
        }
      }
  } catch { }
}

function Get-CodexCli {
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($env:CODEX_CLI_PATH) { $candidates.Add($env:CODEX_CLI_PATH) }
  $configPath = Join-Path $env:USERPROFILE ".codex\config.toml"
  if (Test-Path -LiteralPath $configPath) {
    $raw = Get-Content -LiteralPath $configPath -Raw
    $match = [regex]::Match($raw, 'CODEX_CLI_PATH\s*=\s*[''"]([^''"]+)[''"]', "IgnoreCase")
    if ($match.Success) { $candidates.Add($match.Groups[1].Value) }
  }
  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates.Add($command.Source) }
  Add-CodexAppxCandidates $candidates @(
    "app\resources\codex.exe",
    "app\resources\bin\codex.exe",
    "resources\codex.exe",
    "bin\codex.exe"
  )
  $binRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
  if (Test-Path -LiteralPath $binRoot) {
    Get-ChildItem -LiteralPath $binRoot -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | ForEach-Object { $candidates.Add($_.FullName) }
  }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      & $candidate --version *> $null
      if ($LASTEXITCODE -eq 0) { return (Resolve-Path -LiteralPath $candidate).Path }
    } catch { }
  }
  throw "未找到可执行的 Codex CLI。请安装并启动一次官方 Codex，或设置 CODEX_CLI_PATH 后重试。"
}

function Test-NodeRuntimeCapability([string]$Candidate) {
  if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
  try {
    $probe = "import('node:sqlite').then(()=>process.stdout.write('output-items-node-ok')).catch(()=>process.exit(42))"
    $output = [string](& $Candidate --input-type=module -e $probe 2>$null)
    return $LASTEXITCODE -eq 0 -and $output.Trim() -eq "output-items-node-ok"
  } catch {
    return $false
  }
}

function Get-NodeRuntime {
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($env:OUTPUT_ITEMS_NODE) { $candidates.Add($env:OUTPUT_ITEMS_NODE) }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates.Add($command.Source) }
  $candidates.Add((Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"))
  $codexCliCandidates = [System.Collections.Generic.List[string]]::new()
  if ($env:CODEX_CLI_PATH) { $codexCliCandidates.Add($env:CODEX_CLI_PATH) }
  $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($codexCommand) { $codexCliCandidates.Add($codexCommand.Source) }
  try { $codexCliCandidates.Add((Get-CodexCli)) } catch { }
  foreach ($codexCli in ($codexCliCandidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $codexCli -PathType Leaf)) { continue }
    $resourcesRoot = Split-Path $codexCli -Parent
    $candidates.Add((Join-Path $resourcesRoot "cua_node\bin\node.exe"))
    $candidates.Add((Join-Path $resourcesRoot "node\bin\node.exe"))
    $candidates.Add((Join-Path $resourcesRoot "dependencies\node\bin\node.exe"))
  }
  Add-CodexAppxCandidates $candidates @(
    "app\resources\cua_node\bin\node.exe",
    "app\resources\cua_node\node.exe",
    "app\resources\dependencies\node\bin\node.exe",
    "app\resources\node\bin\node.exe"
  )
  $runtimeRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes\cua_node"
  if (Test-Path -LiteralPath $runtimeRoot) {
    Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -Recurse -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | ForEach-Object { $candidates.Add($_.FullName) }
  }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (Test-NodeRuntimeCapability $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw "未找到支持 node:sqlite 的 Node.js。请安装 Node.js 22.13+，启动一次官方 Codex，或设置 OUTPUT_ITEMS_NODE。"
}

function Get-CodexDesktopExecutable {
  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($env:OUTPUT_ITEMS_CODEX_EXE) { $candidates.Add($env:OUTPUT_ITEMS_CODEX_EXE) }

  try {
    $codexCommand = Get-Command "codex.exe" -ErrorAction SilentlyContinue
    if ($null -ne $codexCommand -and $codexCommand.Source) {
      $resourcesDirectory = Split-Path $codexCommand.Source -Parent
      $appDirectory = Split-Path $resourcesDirectory -Parent
      $candidates.Add((Join-Path $appDirectory "ChatGPT.exe"))
    }
  } catch { }

  try {
    $cli = Get-CodexCli
    $resourcesDirectory = Split-Path $cli -Parent
    $appDirectory = Split-Path $resourcesDirectory -Parent
    $candidates.Add((Join-Path $appDirectory "ChatGPT.exe"))
  } catch { }

  try {
    Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.InstallLocation) {
        $candidates.Add((Join-Path $_.InstallLocation "app\ChatGPT.exe"))
        $candidates.Add((Join-Path $_.InstallLocation "ChatGPT.exe"))
      }
    }
  } catch { }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw "未找到官方 Codex Desktop 的 ChatGPT.exe。请先从 Microsoft Store 安装并启动一次 Codex。"
}

function Test-OutputItemsExtension([string]$ExtensionRoot) {
  $manifestPath = Join-Path $ExtensionRoot "extension.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.id -eq "local.codex-output-items") { return $true }
    # Accept the pre-1.0 local layout without retaining a personal publisher ID.
    return $manifest.name -eq "产出项" -and $manifest.host.tool -eq "open_output_items" -and $manifest.host.resource -eq "ui://output-items/dashboard.html"
  } catch { return $false }
}

function Assert-OutputItemsReleasePackage([string]$PackageRoot) {
  $resolvedRoot = (Resolve-Path -LiteralPath $PackageRoot).Path.TrimEnd('\', '/')
  $releaseManifestPath = Join-Path $resolvedRoot "release-manifest.json"
  if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
    throw "安装包缺少 release-manifest.json；请使用正式 Release ZIP 并完整解压后安装。"
  }

  try {
    $releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "release-manifest.json 无法解析：$($_.Exception.Message)"
  }
  if ($releaseManifest.format -ne "codex-output-items-release/v1") {
    throw "不支持的安装包清单格式。"
  }
  $extensionManifest = Get-Content -LiteralPath (Join-Path $resolvedRoot "extension.json") -Raw | ConvertFrom-Json
  if ([string]$releaseManifest.version -ne [string]$extensionManifest.version) {
    throw "安装包版本不一致：release=$($releaseManifest.version)，extension=$($extensionManifest.version)。"
  }

  $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($releaseManifest.files)) {
    $relative = ([string]$entry.path).Replace('\', '/').Trim('/')
    if (-not $relative -or $relative -eq "release-manifest.json" -or [IO.Path]::IsPathRooted($relative) -or $relative -match '(^|/)\.\.(/|$)') {
      throw "安装包清单包含不安全路径：$relative"
    }
    if (-not $expected.Add($relative)) { throw "安装包清单包含重复路径：$relative" }
    $target = [IO.Path]::GetFullPath((Join-Path $resolvedRoot ($relative.Replace('/', '\'))))
    if (-not $target.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "安装包清单路径越界：$relative"
    }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "安装包文件缺失：$relative" }
    $cursor = $resolvedRoot
    foreach ($segment in ($relative -split '/')) {
      $cursor = Join-Path $cursor $segment
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "安装包不允许链接或重解析点：$relative"
      }
    }
    $actualLength = (Get-Item -LiteralPath $target -Force).Length
    if ([int64]$entry.size -ne [int64]$actualLength) { throw "安装包文件大小不匹配：$relative" }
    $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "安装包文件哈希不匹配：$relative" }
  }

  foreach ($file in (Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Force)) {
    if ($file.FullName.Equals($releaseManifestPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $relative = $file.FullName.Substring($resolvedRoot.Length).TrimStart('\', '/').Replace('\', '/')
    if (-not $expected.Contains($relative)) { throw "安装包包含清单外文件：$relative" }
  }
  return $releaseManifest
}

function Get-OutputItemsRegistrationBlock {
  $configPath = Join-Path $env:USERPROFILE ".codex\config.toml"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
  $raw = Get-Content -LiteralPath $configPath -Raw
  $sectionName = [regex]::Escape($script:ServerName)
  $match = [regex]::Match($raw, "(?ms)^\[mcp_servers\.$sectionName\]\s*(.*?)(?=^\[|\z)")
  if (-not $match.Success) { return $null }
  return $match.Value
}

function Test-OutputItemsRegistrationOwnership([string]$RegistrationBlock, [string]$ExtensionRoot) {
  if (-not $RegistrationBlock -or -not $ExtensionRoot) { return $false }
  try {
    $expectedServer = [System.IO.Path]::GetFullPath((Join-Path $ExtensionRoot "server.mjs")).Replace('\', '/').ToLowerInvariant()
    $normalizedBlock = ([string]$RegistrationBlock).Replace('\', '/').ToLowerInvariant()
    return $normalizedBlock.Contains($expectedServer)
  } catch {
    return $false
  }
}

function Remove-ExistingRegistration([string]$CliPath, [string]$ExpectedExtensionRoot) {
  $registrationBlock = Get-OutputItemsRegistrationBlock
  if ($registrationBlock) {
    if (-not (Test-OutputItemsRegistrationOwnership $registrationBlock $ExpectedExtensionRoot)) {
      throw "MCP 名称 $script:ServerName 已被其他配置占用；为避免误删，安装已停止。"
    }
    & $CliPath mcp remove $script:ServerName | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "无法移除旧的产出项注册。" }
    return
  }

  & $CliPath mcp get $script:ServerName --json *> $null
  if ($LASTEXITCODE -eq 0) {
    throw "检测到非当前用户配置文件中的同名 MCP 注册；无法确认归属，安装已停止。"
  }
}

function Register-OutputItems([string]$ExtensionRoot) {
  if (-not (Test-OutputItemsExtension $ExtensionRoot)) { throw "产出项扩展目录不完整：$ExtensionRoot" }
  $cli = Get-CodexCli
  $node = Get-NodeRuntime
  $server = Join-Path $ExtensionRoot "server.mjs"
  New-Item -ItemType Directory -Path $script:DataRoot -Force | Out-Null
  Remove-ExistingRegistration $cli $script:InstallRoot
  & $cli mcp add $script:ServerName `
    --env "OUTPUT_ITEMS_DATA_DIR=$script:DataRoot" `
    -- $node $server | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Codex 未能注册产出项本地服务。" }
  return [pscustomobject]@{ Cli = $cli; Node = $node; Server = $server }
}

function Unregister-OutputItems {
  $cli = Get-CodexCli
  Remove-ExistingRegistration $cli $script:InstallRoot
}

function Get-OutputItemsHttpState {
  if (-not (Test-Path -LiteralPath $script:ServerStatePath -PathType Leaf)) { return $null }
  try {
    return Get-Content -LiteralPath $script:ServerStatePath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-OutputItemsCompanionUiUrl([string]$BaseUrl) {
  $state = Get-OutputItemsHttpState
  if ($null -ne $state -and $state.companionUrl) {
    return [string]$state.companionUrl
  }
  return ([string]$BaseUrl).TrimEnd('/') + "/?embedded=1&host=codex-companion"
}

function Test-OutputItemsHttpState($State) {
  if ($null -eq $State -or -not $State.url -or -not $State.instanceId -or -not $State.pid) { return $false }
  try {
    $healthUri = ([string]$State.url).TrimEnd('/') + "/health"
    $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
    return $health.ok -eq $true -and [string]$health.instanceId -eq [string]$State.instanceId -and [int]$health.pid -eq [int]$State.pid
  } catch {
    return $false
  }
}

function Remove-OutputItemsHttpState {
  if (Test-Path -LiteralPath $script:ServerStatePath -PathType Leaf) {
    Remove-Item -LiteralPath $script:ServerStatePath -Force
  }
}

function Stop-OutputItemsHttpService {
  $state = Get-OutputItemsHttpState
  if ($null -eq $state) {
    Remove-OutputItemsHttpState
    return
  }

  $processId = 0
  try { $processId = [int]$state.pid } catch { }
  if ($processId -le 0) {
    Remove-OutputItemsHttpState
    return
  }

  $serviceProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $serviceProcess) {
    Remove-OutputItemsHttpState
    return
  }

  $verified = Test-OutputItemsHttpState $state
  if (-not $verified) {
    try {
      $expectedServer = [System.IO.Path]::GetFullPath((Join-Path $script:InstallRoot "server.mjs"))
      $stateServer = [System.IO.Path]::GetFullPath([string]$state.serverPath)
      $recordedStart = [DateTimeOffset]::Parse([string]$state.startedAt).UtcDateTime
      $actualStart = $serviceProcess.StartTime.ToUniversalTime()
      $startDifference = [Math]::Abs(($actualStart - $recordedStart).TotalSeconds)
      $verified = $serviceProcess.ProcessName -match '^node$' -and $stateServer.Equals($expectedServer, [StringComparison]::OrdinalIgnoreCase) -and $startDifference -le 30
    } catch {
      $verified = $false
    }
  }

  if (-not $verified) {
    throw "发现仍在运行的 PID $processId，但无法确认它属于产出项服务。为避免误杀，停止操作已中止且状态记录已保留。"
  }

  Stop-Process -Id $processId -Force -ErrorAction Stop
  try { [void]$serviceProcess.WaitForExit(3000) } catch { }
  Start-Sleep -Milliseconds 150
  if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    throw "产出项 HTTP 服务 PID $processId 未能停止；状态记录已保留。"
  }
  Remove-OutputItemsHttpState
}

function Start-OutputItemsHttpService([string]$ExtensionRoot) {
  if (-not (Test-OutputItemsExtension $ExtensionRoot)) { throw "产出项扩展目录不完整：$ExtensionRoot" }

  $state = Get-OutputItemsHttpState
  if (Test-OutputItemsHttpState $state) { return [string]$state.url }
  Stop-OutputItemsHttpService

  $node = Get-NodeRuntime
  $server = Join-Path $ExtensionRoot "server.mjs"
  New-Item -ItemType Directory -Path $script:RunRoot -Force | Out-Null
  $stdoutPath = Join-Path $script:RunRoot "server.stdout.log"
  $stderrPath = Join-Path $script:RunRoot "server.stderr.log"
  foreach ($logPath in @($stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $logPath -PathType Leaf) { Remove-Item -LiteralPath $logPath -Force }
  }

  $hadDataRoot = Test-Path Env:OUTPUT_ITEMS_DATA_DIR
  $previousDataRoot = $env:OUTPUT_ITEMS_DATA_DIR
  $taskContextSnapshot = Suspend-OutputItemsTaskContext
  try {
    $env:OUTPUT_ITEMS_DATA_DIR = $script:DataRoot
    $quotedServer = '"' + $server + '"'
    $serviceProcess = Start-Process -FilePath $node -ArgumentList @($quotedServer, "--http") -WorkingDirectory $ExtensionRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    if ($hadDataRoot) { $env:OUTPUT_ITEMS_DATA_DIR = $previousDataRoot } else { Remove-Item Env:OUTPUT_ITEMS_DATA_DIR -ErrorAction SilentlyContinue }
    Restore-OutputItemsTaskContext $taskContextSnapshot
  }

  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 100
    if ($serviceProcess.HasExited) {
      $diagnostic = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { Get-Content -LiteralPath $stderrPath -Raw } else { "无错误日志" }
      throw "产出项本地服务启动失败：$diagnostic"
    }
    $state = Get-OutputItemsHttpState
    if ($null -ne $state -and [int]$state.pid -eq $serviceProcess.Id -and (Test-OutputItemsHttpState $state)) {
      return [string]$state.url
    }
  } while ((Get-Date) -lt $deadline)

  if (-not $serviceProcess.HasExited) { Stop-Process -Id $serviceProcess.Id -Force -ErrorAction SilentlyContinue }
  Remove-OutputItemsHttpState
  $diagnostic = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { Get-Content -LiteralPath $stderrPath -Raw } else { "服务未在 10 秒内就绪" }
  throw "产出项本地服务启动超时：$diagnostic"
}

function Get-OutputItemsCompanionState {
  if (-not (Test-Path -LiteralPath $script:CompanionStatePath -PathType Leaf)) { return $null }
  try {
    return Get-Content -LiteralPath $script:CompanionStatePath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Set-OutputItemsCompanionState($State) {
  New-Item -ItemType Directory -Path $script:RunRoot -Force | Out-Null
  $temporary = "$($script:CompanionStatePath).$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
    if (Test-Path -LiteralPath $script:CompanionStatePath -PathType Leaf) {
      # File.Replace is a same-volume atomic replacement; readers see either
      # the old complete JSON or the new complete JSON, never a delete gap.
      [IO.File]::Replace($temporary, $script:CompanionStatePath, $null, $true)
    } else {
      [IO.File]::Move($temporary, $script:CompanionStatePath)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Remove-OutputItemsCompanionState([string]$ExpectedNonce = "", [int]$ExpectedPid = 0) {
  if (Test-Path -LiteralPath $script:CompanionStatePath -PathType Leaf) {
    if ($ExpectedNonce -or $ExpectedPid -gt 0) {
      $current = Get-OutputItemsCompanionState
      if ($null -eq $current) { return }
      if ($ExpectedNonce) {
        $nonceProperty = $current.PSObject.Properties["instanceNonce"]
        if ($null -eq $nonceProperty -or [string]$nonceProperty.Value -cne $ExpectedNonce) { return }
      }
      if ($ExpectedPid -gt 0 -and [int]$current.pid -ne $ExpectedPid) { return }
    }
    Remove-Item -LiteralPath $script:CompanionStatePath -Force
  }
}

function Get-OutputItemsProcessCommandLine([int]$ProcessId) {
  try {
    return [string](Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop).CommandLine
  } catch {
    return ""
  }
}

function Test-OutputItemsCompanionProcessIdentity($State, [string]$ExtensionRoot) {
  $nonceProperty = if ($null -ne $State) { $State.PSObject.Properties["instanceNonce"] } else { $null }
  $startedProperty = if ($null -ne $State) { $State.PSObject.Properties["startedAt"] } else { $null }
  if (
    $null -eq $State -or
    -not $State.pid -or
    $null -eq $nonceProperty -or
    -not $nonceProperty.Value -or
    $null -eq $startedProperty -or
    -not $startedProperty.Value
  ) { return $false }
  $processId = 0
  try { $processId = [int]$State.pid } catch { return $false }
  if ($processId -le 0) { return $false }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.ProcessName -notmatch '^node(?:\.exe)?$') { return $false }

  $helper = Join-Path $ExtensionRoot "companion\focus-managed-codex.ps1"
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    $helper = Join-Path $script:InstallRoot "companion\focus-managed-codex.ps1"
  }
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { return $false }
  $expectedPaths = @(
    (Join-Path $ExtensionRoot "companion\codex-companion.mjs"),
    (Join-Path $script:InstallRoot "companion\codex-companion.mjs")
  ) | Select-Object -Unique
  foreach ($expectedPath in $expectedPaths) {
    try {
      if (-not (Test-Path -LiteralPath $expectedPath -PathType Leaf)) { continue }
      $arguments = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", $helper,
        "-ValidateCompanion",
        "-CompanionProcessId", [string]$processId,
        "-CompanionScript", [System.IO.Path]::GetFullPath($expectedPath),
        "-ExpectedNonce", [string]$nonceProperty.Value,
        "-ExpectedStartedAt", [string]$startedProperty.Value
      )
      $output = @(& powershell.exe @arguments 2>$null)
      if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { continue }
      $result = $output[-1] | ConvertFrom-Json
      if ($result.ok -eq $true -and $result.identity -eq $true) { return $true }
    } catch { }
  }
  return $false
}

function Test-OutputItemsCompanionState($State, [string]$ExtensionRoot, [string]$ExpectedUrl = "") {
  if ($null -eq $State) { return $false }
  foreach ($requiredName in @("pid", "codexPid", "url", "profilePath", "codexExe", "controlPipe", "controlToken")) {
    $requiredProperty = $State.PSObject.Properties[$requiredName]
    if ($null -eq $requiredProperty -or -not $requiredProperty.Value) { return $false }
  }
  $statusProperty = $State.PSObject.Properties["status"]
  if ($null -ne $statusProperty -and [string]$statusProperty.Value -in @("failed", "stopping", "stopped")) { return $false }
  if ($ExpectedUrl -and -not ([string]$State.url).Equals($ExpectedUrl, [StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  try {
    $stateProfile = [System.IO.Path]::GetFullPath([string]$State.profilePath)
    $expectedProfile = [System.IO.Path]::GetFullPath($script:CompanionProfilePath)
    $stateCodex = [System.IO.Path]::GetFullPath([string]$State.codexExe)
    if (-not $stateProfile.Equals($expectedProfile, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    # WindowsApps file probes can block for tens of seconds on some systems.
    # The companion is already authenticated through its per-run control token;
    # keep this hot health-check limited to path shape plus live process checks.
    if (-not [System.IO.Path]::GetFileName($stateCodex).Equals("ChatGPT.exe", [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $companionProcess = Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue
    if ($null -eq $companionProcess -or $companionProcess.ProcessName -notmatch '^node(?:\.exe)?$') { return $false }
    if ($null -eq (Get-Process -Id ([int]$State.codexPid) -ErrorAction SilentlyContinue)) { return $false }
  } catch {
    return $false
  }
  return $true
}

function Start-OutputItemsCompanionProcess(
  [string]$ExtensionRoot,
  [string]$UiUrl,
  [string[]]$Arguments = @(),
  [switch]$Control
) {
  $node = Get-NodeRuntime
  $companion = Join-Path $ExtensionRoot "companion\codex-companion.mjs"
  if (-not (Test-Path -LiteralPath $companion -PathType Leaf)) {
    throw "产出项伴生程序缺失：$companion"
  }
  $codexExe = ""
  if ($Control) {
    $state = Get-OutputItemsCompanionState
    if ($null -ne $state -and $state.codexExe) { $codexExe = [string]$state.codexExe }
  } else {
    $codexExe = Get-CodexDesktopExecutable
  }
  New-Item -ItemType Directory -Path $script:RunRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $script:CompanionProfilePath -Force | Out-Null

  $environmentValues = [ordered]@{
    CODEX_OUTPUT_ITEMS_UI_URL = $UiUrl
    CODEX_OUTPUT_ITEMS_PROFILE = $script:CompanionProfilePath
    CODEX_OUTPUT_ITEMS_RUN_FILE = $script:CompanionStatePath
    CODEX_OUTPUT_ITEMS_LOG = $script:CompanionLogPath
    CODEX_OUTPUT_ITEMS_CODEX_EXE = $codexExe
  }
  $previousValues = @{}
  foreach ($name in $environmentValues.Keys) {
    $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, [string]$environmentValues[$name], "Process")
  }
  $taskContextSnapshot = Suspend-OutputItemsTaskContext

  $suffix = if ($Control) { "control" } else { "resident" }
  $stdoutPath = Join-Path $script:RunRoot "companion.$suffix.stdout.log"
  $stderrPath = Join-Path $script:RunRoot "companion.$suffix.stderr.log"
  if ($Control) {
    foreach ($logPath in @($stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $logPath -PathType Leaf) { Remove-Item -LiteralPath $logPath -Force }
    }
  }
  try {
    $quotedCompanion = '"' + $companion + '"'
    $processArguments = [System.Collections.Generic.List[string]]::new()
    $processArguments.Add($quotedCompanion)
    foreach ($argument in @($Arguments)) {
      if ($null -ne $argument -and [string]$argument -ne "") { $processArguments.Add([string]$argument) }
    }
    return Start-Process -FilePath $node `
      -ArgumentList $processArguments.ToArray() `
      -WorkingDirectory $ExtensionRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
  } finally {
    foreach ($name in $environmentValues.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousValues[$name], "Process")
    }
    Restore-OutputItemsTaskContext $taskContextSnapshot
  }
}

function Get-OutputItemsCompanionDiagnostic([switch]$Control) {
  $suffix = if ($Control) { "control" } else { "resident" }
  $paths = @(
    (Join-Path $script:RunRoot "companion.$suffix.stderr.log"),
    $script:CompanionLogPath
  )
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $content = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
      if ($content) { return $content.Trim() }
    }
  }
  return "无伴生日志"
}

function Invoke-OutputItemsCompanionControl(
  [string]$ExtensionRoot,
  [string]$UiUrl,
  [ValidateSet("--open", "--stop", "--ping")][string]$Command,
  [int]$TimeoutMilliseconds = 50000
) {
  $controller = Start-OutputItemsCompanionProcess $ExtensionRoot $UiUrl @($Command) -Control
  if (-not $controller.WaitForExit($TimeoutMilliseconds)) {
    Stop-Process -Id $controller.Id -Force -ErrorAction SilentlyContinue
    throw "产出项伴生控制命令超时：$Command"
  }
  $controller.WaitForExit()
  $controller.Refresh()
  $stdoutPath = Join-Path $script:RunRoot "companion.control.stdout.log"
  $stderrPath = Join-Path $script:RunRoot "companion.control.stderr.log"
  $stdout = if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue } else { "" }
  $stderr = if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue } else { "" }
  $result = $null
  try {
    $line = @($stdout -split "`r?`n" | Where-Object { $_.Trim() })[-1]
    if ($line) { $result = $line | ConvertFrom-Json }
  } catch { }
  $exitCode = $null
  try { $exitCode = $controller.ExitCode } catch { }
  $exitFailed = $null -ne $exitCode -and [int]$exitCode -ne 0
  $responseFailed = $null -eq $result -or $result.ok -ne $true
  $pingFailed = $Command -eq "--ping" -and $null -ne $result -and $result.running -ne $true
  if ($exitFailed -or $responseFailed -or $pingFailed) {
    $diagnostic = @($stderr.Trim(), $stdout.Trim(), "exitCode=$exitCode") | Where-Object { $_ }
    throw "产出项伴生控制命令失败：$Command`n$($diagnostic -join "`n")"
  }
  return $result
}

function Test-OutputItemsCompanionHealth($State, [string]$ExtensionRoot, [string]$ExpectedUrl = "") {
  if (-not (Test-OutputItemsCompanionState $State $ExtensionRoot $ExpectedUrl)) { return $false }
  try {
    # The controller validates the recorded Node PID before opening the pipe;
    # allow its 5 s fail-closed identity timeout plus the 5 s pipe timeout.
    [void](Invoke-OutputItemsCompanionControl $ExtensionRoot ([string]$State.url) "--ping" 15000)
    return $true
  } catch {
    return $false
  }
}

function Stop-OutputItemsCompanionCore([string]$ExtensionRoot = $script:InstallRoot) {
  $state = Get-OutputItemsCompanionState
  if ($null -eq $state) {
    Remove-OutputItemsCompanionState
    return
  }
  $processId = 0
  try { $processId = [int]$state.pid } catch { }
  $process = if ($processId -gt 0) { Get-Process -Id $processId -ErrorAction SilentlyContinue } else { $null }
  if ($null -eq $process) {
    [void](Remove-OutputItemsCompanionState "" $processId)
    return
  }

  $nonceProperty = $state.PSObject.Properties["instanceNonce"]
  $stateNonce = if ($null -ne $nonceProperty) { [string]$nonceProperty.Value } else { "" }
  $strongIdentity = Test-OutputItemsCompanionProcessIdentity $state $ExtensionRoot

  # A stale run file may point at a reused PID. If the recorded process does
  # not even satisfy the companion state shape, drop only that exact stale
  # record and return immediately; never wait on or signal the unrelated PID.
  if (-not (Test-OutputItemsCompanionState $state $ExtensionRoot)) {
    [void](Remove-OutputItemsCompanionState $stateNonce $processId)
    return
  }

  $companionScript = Join-Path $ExtensionRoot "companion\codex-companion.mjs"
  $controlResult = $null
  if (Test-Path -LiteralPath $companionScript -PathType Leaf) {
    try {
      $controlResult = Invoke-OutputItemsCompanionControl $ExtensionRoot ([string]$state.url) "--stop"
    } catch {
      Write-Warning $_.Exception.Message
    }
  }
  $reasonProperty = if ($null -ne $controlResult) { $controlResult.PSObject.Properties["reason"] } else { $null }
  if ($null -ne $reasonProperty -and [string]$reasonProperty.Value -eq "not-running") {
    [void](Remove-OutputItemsCompanionState $stateNonce $processId)
    return
  }

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      [void](Remove-OutputItemsCompanionState $stateNonce $processId)
      return
    }
    Start-Sleep -Milliseconds 100
  }

  if ($strongIdentity -and (Test-OutputItemsCompanionProcessIdentity $state $ExtensionRoot)) {
    Write-Warning "伴生程序未在限定时间内退出，将终止已验证的伴生 PID $processId。"
    & taskkill.exe /PID $processId /T /F *> $null
    if ($LASTEXITCODE -ne 0) { throw "无法终止已验证的伴生进程树 PID $processId。" }
    Start-Sleep -Milliseconds 250
  } else {
    throw "无法确认伴生 PID $processId 的身份；为避免误杀，停止操作已中止且状态记录已保留。"
  }
  if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    throw "伴生进程 PID $processId 未能停止；状态记录已保留。"
  }
  [void](Remove-OutputItemsCompanionState $stateNonce $processId)
}

function Stop-OutputItemsCompanion([string]$ExtensionRoot = $script:InstallRoot) {
  # Serialize stop/uninstall with cold start. The same PowerShell thread may
  # already own this mutex from Start-OutputItemsCompanion; Windows mutexes are
  # recursive for their owning thread, so the balanced release remains safe.
  $startMutex = New-Object System.Threading.Mutex($false, (Get-OutputItemsCompanionStartMutexName))
  $lockTaken = $false
  try {
    try {
      $lockTaken = $startMutex.WaitOne([TimeSpan]::FromSeconds(180))
    } catch [System.Threading.AbandonedMutexException] {
      $lockTaken = $true
    }
    if (-not $lockTaken) { throw "另一个产出项启动事务仍在运行，停止等待已超时。" }
    Stop-OutputItemsCompanionCore $ExtensionRoot
  } finally {
    if ($lockTaken) { $startMutex.ReleaseMutex() }
    $startMutex.Dispose()
  }
}

function New-OutputItemsInstanceNonce {
  $bytes = New-Object byte[] 24
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-OutputItemsCompanionStartMutexName {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = if ($null -ne $identity.User) { $identity.User.Value } else { [Environment]::UserName }
  $material = "$sid|$([System.IO.Path]::GetFullPath($script:CompanionStatePath).ToLowerInvariant())"
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($material))
  } finally {
    $sha256.Dispose()
  }
  $suffix = -join ($digest[0..15] | ForEach-Object { $_.ToString('x2') })
  # Global makes console/RDP sessions for this Windows user share the same
  # startup transaction; the SID/path digest prevents unrelated users or
  # extension roots from serializing one another.
  return "Global\CodexOutputItemsCompanionStart-$suffix"
}

function Wait-OutputItemsStartingState(
  [string]$ExtensionRoot,
  [string]$UiUrl,
  $InitialState,
  [int]$MaximumSeconds = 75
) {
  $nonceProperty = $InitialState.PSObject.Properties["instanceNonce"]
  $expectedNonce = if ($null -ne $nonceProperty) { [string]$nonceProperty.Value } else { "" }
  $deadline = (Get-Date).AddSeconds($MaximumSeconds)
  $createdProperty = $InitialState.PSObject.Properties["createdAt"]
  if ($null -ne $createdProperty -and $createdProperty.Value) {
    try {
      $createdDeadline = [DateTimeOffset]::Parse([string]$createdProperty.Value).LocalDateTime.AddSeconds($MaximumSeconds)
      if ($createdDeadline -lt $deadline) { $deadline = $createdDeadline }
    } catch { }
  }
  do {
    $current = Get-OutputItemsCompanionState
    if ($null -eq $current) { return $null }
    $statusProperty = $current.PSObject.Properties["status"]
    if ($null -eq $statusProperty -or [string]$statusProperty.Value -ne "starting") { return $current }
    $currentNonceProperty = $current.PSObject.Properties["instanceNonce"]
    if (
      $expectedNonce -and
      ($null -eq $currentNonceProperty -or [string]$currentNonceProperty.Value -cne $expectedNonce)
    ) { return $current }
    if (Test-OutputItemsCompanionHealth $current $ExtensionRoot $UiUrl) { return $current }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  return Get-OutputItemsCompanionState
}

function Start-OutputItemsCompanion([string]$ExtensionRoot, [switch]$Open) {
  # A desktop shortcut can be double-clicked repeatedly before the resident
  # process has written companion.json. Serialize the complete health/start/
  # foreground transaction so only one launcher may create the managed Codex
  # process; later launchers wait, then reuse and focus that same instance.
  $startMutex = New-Object System.Threading.Mutex($false, (Get-OutputItemsCompanionStartMutexName))
  $lockTaken = $false
  try {
    try {
      $lockTaken = $startMutex.WaitOne([TimeSpan]::FromSeconds(180))
    } catch [System.Threading.AbandonedMutexException] {
      $lockTaken = $true
    }
    if (-not $lockTaken) {
      throw "另一个产出项启动器仍在运行，等待其完成已超时。"
    }

    if (-not (Test-OutputItemsExtension $ExtensionRoot)) { throw "产出项扩展目录不完整：$ExtensionRoot" }
    $baseUrl = Start-OutputItemsHttpService $ExtensionRoot
    $uiUrl = Get-OutputItemsCompanionUiUrl $baseUrl
    $state = Get-OutputItemsCompanionState
    $statusProperty = if ($null -ne $state) { $state.PSObject.Properties["status"] } else { $null }
    if ($null -ne $statusProperty -and [string]$statusProperty.Value -eq "starting") {
      $state = Wait-OutputItemsStartingState $ExtensionRoot $uiUrl $state
    }
    if (Test-OutputItemsCompanionHealth $state $ExtensionRoot $uiUrl) {
      if ($Open) { [void](Invoke-OutputItemsCompanionControl $ExtensionRoot $uiUrl "--open" 50000) }
      return Get-OutputItemsCompanionState
    }

    if ($null -ne $state) {
      # A live but unrelated process can reuse a stale PID. Never wait on or
      # terminate it: only stop a resident whose Node command line is the
      # expected companion script; otherwise self-heal by dropping stale state.
      $stateStatusProperty = $state.PSObject.Properties["status"]
      $isStarting = $null -ne $stateStatusProperty -and [string]$stateStatusProperty.Value -eq "starting"
      if ($isStarting -and (Test-OutputItemsCompanionProcessIdentity $state $ExtensionRoot)) {
        $startingPid = [int]$state.pid
        if (-not (Test-OutputItemsCompanionProcessIdentity $state $ExtensionRoot)) {
          throw "starting 伴生 PID $startingPid 的身份在终止前发生变化，已中止。"
        }
        Write-Warning "伴生程序未能完成冷启动，将终止已精确验证的 starting 进程树 PID $startingPid。"
        & taskkill.exe /PID $startingPid /T /F *> $null
        if ($LASTEXITCODE -ne 0 -and $null -ne (Get-Process -Id $startingPid -ErrorAction SilentlyContinue)) {
          throw "无法终止已验证的 starting 伴生进程树 PID $startingPid。"
        }
        $stateNonceProperty = $state.PSObject.Properties["instanceNonce"]
        $stateNonce = if ($null -ne $stateNonceProperty) { [string]$stateNonceProperty.Value } else { "" }
        [void](Remove-OutputItemsCompanionState $stateNonce $startingPid)
      } elseif (Test-OutputItemsCompanionProcessIdentity $state $ExtensionRoot) {
        Stop-OutputItemsCompanion $ExtensionRoot
      } else {
        Remove-OutputItemsCompanionState
      }
    }
    Remove-OutputItemsCompanionState
    foreach ($logPath in @(
      (Join-Path $script:RunRoot "companion.resident.stdout.log"),
      (Join-Path $script:RunRoot "companion.resident.stderr.log"),
      $script:CompanionLogPath
    )) {
      if (Test-Path -LiteralPath $logPath -PathType Leaf) { Remove-Item -LiteralPath $logPath -Force }
    }

    $instanceNonce = New-OutputItemsInstanceNonce
    $createdAt = (Get-Date).ToUniversalTime().ToString("o")
    Set-OutputItemsCompanionState ([ordered]@{
      schemaVersion = 2
      status = "starting"
      pid = $null
      codexPid = $null
      launcherPid = $PID
      createdAt = $createdAt
      url = $uiUrl
      profilePath = $script:CompanionProfilePath
      codexExe = (Get-CodexDesktopExecutable)
      instanceNonce = $instanceNonce
    })
    $arguments = if ($Open) {
      @("--open", "--instance-nonce", $instanceNonce)
    } else {
      @("--instance-nonce", $instanceNonce)
    }
    try {
      $resident = Start-OutputItemsCompanionProcess $ExtensionRoot $uiUrl $arguments
    } catch {
      [void](Remove-OutputItemsCompanionState $instanceNonce 0)
      throw
    }
    $deadline = (Get-Date).AddSeconds(60)
    do {
      Start-Sleep -Milliseconds 100
      if ($resident.HasExited) {
        throw "产出项伴生程序启动失败：$(Get-OutputItemsCompanionDiagnostic)"
      }
      $state = Get-OutputItemsCompanionState
      if (Test-OutputItemsCompanionHealth $state $ExtensionRoot $uiUrl) { return $state }
    } while ((Get-Date) -lt $deadline)

    if (-not $resident.HasExited) {
      # This Process object is the exact child created above. Kill its tree so
      # a timed-out cold start cannot leave an untracked managed ChatGPT child.
      & taskkill.exe /PID $resident.Id /T /F *> $null
      if ($LASTEXITCODE -ne 0 -and $null -ne (Get-Process -Id $resident.Id -ErrorAction SilentlyContinue)) {
        throw "无法终止启动超时的伴生进程树 PID $($resident.Id)。"
      }
    }
    [void](Remove-OutputItemsCompanionState $instanceNonce 0)
    throw "产出项伴生程序启动超时：$(Get-OutputItemsCompanionDiagnostic)"
  } finally {
    if ($lockTaken) { $startMutex.ReleaseMutex() }
    $startMutex.Dispose()
  }
}

function Invoke-OutputItemsLauncherSafetySelfTest([string]$ExtensionRoot) {
  $originalRunRoot = $script:RunRoot
  $originalStatePath = $script:CompanionStatePath
  $originalProfilePath = $script:CompanionProfilePath
  $originalLogPath = $script:CompanionLogPath
  $fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-output-items-launcher-fixture-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
  try {
    $script:RunRoot = $fixtureRoot
    $script:CompanionStatePath = Join-Path $fixtureRoot "companion.json"
    $script:CompanionProfilePath = Join-Path $fixtureRoot "profile"
    $script:CompanionLogPath = Join-Path $fixtureRoot "companion.log"
    $fixtureCodexExe = Join-Path $fixtureRoot "ChatGPT.exe"
    $nonce = New-OutputItemsInstanceNonce
    if ($nonce -notmatch '^[A-Za-z0-9_-]{32}$') { throw "launcher fixture nonce 格式错误。" }
    $mutexName = Get-OutputItemsCompanionStartMutexName
    if (-not $mutexName.StartsWith("Global\CodexOutputItemsCompanionStart-", [StringComparison]::Ordinal)) {
      throw "launcher fixture 未使用跨 session Global mutex。"
    }
    $fixtureMutex = New-Object System.Threading.Mutex($false, $mutexName)
    $fixtureLockTaken = $false
    try {
      $fixtureLockTaken = $fixtureMutex.WaitOne(0)
      if (-not $fixtureLockTaken) { throw "launcher fixture 无法取得 Global mutex。" }
    } finally {
      if ($fixtureLockTaken) { $fixtureMutex.ReleaseMutex() }
      $fixtureMutex.Dispose()
    }

    # Long-lived HTTP/companion/Codex children must not retain the one-shot
    # task context used by register-self. Verify both child inheritance and
    # exact restoration of an existing/absent parent environment pair.
    $taskEnvironmentNames = @("CODEX_THREAD_ID", "OUTPUT_ITEMS_SOURCE_THREAD_ID")
    $originalTaskEnvironment = [ordered]@{}
    foreach ($name in $taskEnvironmentNames) {
      $originalTaskEnvironment[$name] = [pscustomobject]@{
        Exists = Test-Path -LiteralPath ("Env:" + $name)
        Value = [Environment]::GetEnvironmentVariable($name, "Process")
      }
    }
    $taskContextChildSanitized = $false
    $taskContextRestored = $false
    try {
      $fixtureThreadId = @("11111111", "1111", "4111", "8111", "111111111111") -join "-"
      [Environment]::SetEnvironmentVariable("CODEX_THREAD_ID", $fixtureThreadId, "Process")
      [Environment]::SetEnvironmentVariable("OUTPUT_ITEMS_SOURCE_THREAD_ID", $null, "Process")
      $probeScript = Join-Path $fixtureRoot "task-context-probe.ps1"
      $probeResult = Join-Path $fixtureRoot "task-context-probe.json"
      Set-Content -LiteralPath $probeScript -Encoding UTF8 -Value @'
param([string]$OutputPath)
[ordered]@{
  codexThreadPresent = Test-Path Env:CODEX_THREAD_ID
  explicitThreadPresent = Test-Path Env:OUTPUT_ITEMS_SOURCE_THREAD_ID
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $OutputPath -Encoding UTF8
'@
      $snapshot = Suspend-OutputItemsTaskContext
      try {
        $probe = Start-Process -FilePath "powershell.exe" -ArgumentList @(
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", ('"' + $probeScript + '"'), "-OutputPath", ('"' + $probeResult + '"')
        ) -WindowStyle Hidden -PassThru
        if (-not $probe.WaitForExit(10000)) {
          Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue
          throw "task context child fixture 超时。"
        }
        $probe.WaitForExit()
        if ($probe.ExitCode -ne 0) { throw "task context child fixture 失败：exit $($probe.ExitCode)" }
      } finally {
        Restore-OutputItemsTaskContext $snapshot
      }
      $capturedTaskContext = Get-Content -LiteralPath $probeResult -Raw | ConvertFrom-Json
      $taskContextChildSanitized = $capturedTaskContext.codexThreadPresent -eq $false -and $capturedTaskContext.explicitThreadPresent -eq $false
      if (-not $taskContextChildSanitized) { throw "长驻子进程继承了仅供自登记使用的任务上下文。" }
      $taskContextRestored = $env:CODEX_THREAD_ID -eq $fixtureThreadId -and -not (Test-Path Env:OUTPUT_ITEMS_SOURCE_THREAD_ID)
      if (-not $taskContextRestored) { throw "任务上下文清理后未精确恢复父进程环境。" }
    } finally {
      foreach ($name in $taskEnvironmentNames) {
        $entry = $originalTaskEnvironment[$name]
        if ($entry.Exists) {
          [Environment]::SetEnvironmentVariable($name, [string]$entry.Value, "Process")
        } else {
          [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
      }
    }

    # A stale state pointing at this PowerShell fixture must be removed in
    # under two seconds without waiting on or terminating the current process.
    Set-OutputItemsCompanionState ([ordered]@{
      schemaVersion = 2
      status = "running"
      pid = $PID
      codexPid = $PID
      startedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o")
      createdAt = (Get-Date).ToUniversalTime().ToString("o")
      url = "http://127.0.0.1:9/?embedded=1&host=fixture"
      profilePath = $script:CompanionProfilePath
      codexExe = $fixtureCodexExe
      controlPipe = "\\.\pipe\fixture-do-not-open"
      controlToken = ("x" * 64)
      instanceNonce = $nonce
    })
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Stop-OutputItemsCompanion $ExtensionRoot
    $timer.Stop()
    $staleStopMilliseconds = $timer.Elapsed.TotalMilliseconds
    if ($timer.Elapsed.TotalSeconds -ge 2) { throw "stale stop fixture 未直接返回。" }
    if ($null -eq (Get-Process -Id $PID -ErrorAction SilentlyContinue)) {
      throw "stale stop fixture 错误终止了测试进程。"
    }
    if (Test-Path -LiteralPath $script:CompanionStatePath -PathType Leaf) {
      throw "stale stop fixture 未清理陈旧状态。"
    }

    # A Node process that merely mentions the companion path as a later argv
    # value must also be treated as stale and left running.
    $decoy = $null
    try {
      $node = Get-NodeRuntime
      $companionPath = Join-Path $ExtensionRoot "companion\codex-companion.mjs"
      $decoyArguments = @(
        "-e",
        "setInterval(()=>{},1000)",
        ('"' + $companionPath + '"'),
        "--instance-nonce",
        $nonce
      )
      $decoy = Start-Process -FilePath $node -ArgumentList $decoyArguments -WindowStyle Hidden -PassThru
      Start-Sleep -Milliseconds 150
      Set-OutputItemsCompanionState ([ordered]@{
        schemaVersion = 2
        status = "running"
        pid = $decoy.Id
        codexPid = $PID
        startedAt = $decoy.StartTime.ToUniversalTime().ToString("o")
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        url = "http://127.0.0.1:9/?embedded=1&host=fixture"
        profilePath = $script:CompanionProfilePath
        codexExe = $fixtureCodexExe
        controlPipe = "\\.\pipe\fixture-do-not-open"
        controlToken = ("x" * 64)
        instanceNonce = $nonce
      })
      $timer.Restart()
      Stop-OutputItemsCompanion $ExtensionRoot
      $timer.Stop()
      if ($timer.Elapsed.TotalSeconds -ge 2) { throw "Node argv 诱饵 stale stop 未直接返回。" }
      if ($null -eq (Get-Process -Id $decoy.Id -ErrorAction SilentlyContinue)) {
        throw "Node argv 诱饵进程被错误终止。"
      }
    } finally {
      if ($null -ne $decoy -and $null -ne (Get-Process -Id $decoy.Id -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue
      }
    }

    # An expired launcher-owned starting record is bounded and remains
    # available to the caller for exact cleanup/recovery decisions.
    Set-OutputItemsCompanionState ([ordered]@{
      schemaVersion = 2
      status = "starting"
      pid = $null
      launcherPid = 2147483646
      createdAt = (Get-Date).ToUniversalTime().AddMinutes(-2).ToString("o")
      url = "http://127.0.0.1:9/?embedded=1&host=fixture"
      profilePath = $script:CompanionProfilePath
      codexExe = $fixtureCodexExe
      instanceNonce = $nonce
    })
    $timer.Restart()
    $expired = Wait-OutputItemsStartingState $ExtensionRoot "http://127.0.0.1:9/?embedded=1&host=fixture" (Get-OutputItemsCompanionState) 1
    $timer.Stop()
    if ($timer.Elapsed.TotalSeconds -ge 2 -or [string]$expired.status -ne "starting") {
      throw "starting fixture 的过期等待不受限。"
    }
    return [ordered]@{
      ok = $true
      globalMutex = $true
      atomicStartingState = $true
      staleStopDirectReturn = $true
      nodePathDecoyRejected = $true
      taskContextChildSanitized = $taskContextChildSanitized
      taskContextRestored = $taskContextRestored
      staleStopMilliseconds = [Math]::Round($staleStopMilliseconds, 1)
      realCodexTouched = $false
    }
  } finally {
    $script:RunRoot = $originalRunRoot
    $script:CompanionStatePath = $originalStatePath
    $script:CompanionProfilePath = $originalProfilePath
    $script:CompanionLogPath = $originalLogPath
    if (Test-Path -LiteralPath $fixtureRoot) {
      Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-OutputItemsDesktopShortcutPath {
  $desktop = [Environment]::GetFolderPath("Desktop")
  if (-not $desktop) { throw "无法定位当前用户桌面目录。" }
  return Join-Path $desktop $script:DesktopShortcutName
}

function Get-OutputItemsCommandProcessorPath {
  $systemRoot = [Environment]::GetEnvironmentVariable("SystemRoot")
  if (-not $systemRoot) { throw "无法定位 Windows 系统目录。" }
  $commandProcessor = Join-Path $systemRoot "System32\cmd.exe"
  if (-not (Test-Path -LiteralPath $commandProcessor -PathType Leaf)) {
    throw "Windows 命令处理器不存在：$commandProcessor"
  }
  return [System.IO.Path]::GetFullPath($commandProcessor)
}

function Get-OutputItemsDesktopShortcutArguments([string]$Launcher) {
  # cmd.exe requires one quote pair for its /c command string and another for
  # the executable/batch path. WScript.Shell stores this exact form verbatim.
  return '/d /c ""{0}""' -f ([System.IO.Path]::GetFullPath($Launcher))
}

function Install-OutputItemsDesktopShortcut([string]$ExtensionRoot) {
  # Some Windows/WScript combinations persist a direct .cmd shortcut with a
  # blank TargetPath. Point the shortcut at the stable Windows command
  # processor and pass the ASCII launcher as its quoted /c command instead.
  $launcher = Join-Path $ExtensionRoot "start-output-items.cmd"
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "快捷方式目标不存在：$launcher" }
  $commandProcessor = Get-OutputItemsCommandProcessorPath
  $arguments = Get-OutputItemsDesktopShortcutArguments $launcher
  $shortcutPath = Get-OutputItemsDesktopShortcutPath
  if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    if (-not (Test-OutputItemsDesktopShortcutOwnership $ExtensionRoot)) {
      throw "桌面已存在同名但不属于本扩展的快捷方式，未覆盖：$shortcutPath"
    }
    # Recreate an owned shortcut instead of editing it in place. Windows can
    # otherwise retain the blank target from the legacy CJK-target shortcut.
    Remove-Item -LiteralPath $shortcutPath -Force
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $commandProcessor
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $ExtensionRoot
  $shortcut.Description = "启动带产出项侧栏的独立 Codex 窗口"
  try { $shortcut.IconLocation = Get-CodexDesktopExecutable } catch { }
  $shortcut.Save()
  return $shortcutPath
}

function Test-OutputItemsDesktopShortcutOwnership([string]$ExtensionRoot = $script:InstallRoot) {
  $shortcutPath = Get-OutputItemsDesktopShortcutPath
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return $false }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $target = [string]$shortcut.TargetPath
    if ($target) {
      $actualTarget = [System.IO.Path]::GetFullPath($target)
      $commandProcessor = Get-OutputItemsCommandProcessorPath
      if ($actualTarget.Equals($commandProcessor, [StringComparison]::OrdinalIgnoreCase)) {
        $expectedArguments = Get-OutputItemsDesktopShortcutArguments (Join-Path $ExtensionRoot "start-output-items.cmd")
        $actualArguments = ([string]$shortcut.Arguments).Trim()
        return $actualArguments.Equals($expectedArguments, [StringComparison]::OrdinalIgnoreCase)
      }

      # Keep recognizing shortcuts created by v0.4.1-v0.7.0 so the installer
      # can safely replace or remove them during migration.
      $expectedTargets = @(
        (Join-Path $ExtensionRoot "start-output-items.cmd"),
        (Join-Path $ExtensionRoot "启动 Codex 产出项.bat")
      )
      foreach ($expected in $expectedTargets) {
        if ($actualTarget.Equals([System.IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) { return $true }
      }
      return $false
    }

    # Migrate the v0.4.0 shortcut written by Windows PowerShell 5.1 with a
    # blank TargetPath for the former CJK launcher filename. Accept it only
    # when both its metadata and our persisted ownership record match.
    $expectedWorkingDirectory = [System.IO.Path]::GetFullPath($ExtensionRoot)
    $actualWorkingDirectory = [System.IO.Path]::GetFullPath([string]$shortcut.WorkingDirectory)
    if (-not $actualWorkingDirectory.Equals($expectedWorkingDirectory, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([string]$shortcut.Description -ne "启动带产出项侧栏的独立 Codex 窗口") { return $false }
    $installStatePath = Join-Path $script:DataRoot "install-state.json"
    if (-not (Test-Path -LiteralPath $installStatePath -PathType Leaf)) { return $false }
    $installState = Get-Content -LiteralPath $installStatePath -Raw | ConvertFrom-Json
    if ($installState.desktopShortcutCreated -ne $true -or -not $installState.desktopShortcut) { return $false }
    $recordedPath = [System.IO.Path]::GetFullPath([string]$installState.desktopShortcut)
    return $recordedPath.Equals([System.IO.Path]::GetFullPath($shortcutPath), [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Remove-OutputItemsDesktopShortcut([string]$ExtensionRoot = $script:InstallRoot) {
  $shortcutPath = Get-OutputItemsDesktopShortcutPath
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { return }
  if (-not (Test-OutputItemsDesktopShortcutOwnership $ExtensionRoot)) {
    throw "同名桌面快捷方式不是产出项安装器创建的目标，已保留：$shortcutPath"
  }
  Remove-Item -LiteralPath $shortcutPath -Force
}

function Remove-OutputItemsCompanionPrivateData {
  $expectedDataRoot = [System.IO.Path]::GetFullPath($script:DataRoot)
  foreach ($target in @($script:CompanionRoot, $script:RunRoot)) {
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    $expected = [System.IO.Path]::GetFullPath($target)
    if (-not $resolved.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
      throw "伴生私有数据目标异常，已停止清理：$resolved"
    }
    $dataPrefix = $expectedDataRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($dataPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "伴生私有数据目标越界，已停止清理：$resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

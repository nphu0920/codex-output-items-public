param(
  [Parameter(Mandatory = $true)]
  [string]$LiteralDirectory,

  [ValidateRange(250, 15000)]
  [int]$TimeoutMilliseconds = 5000,

  [string]$FixtureWindowsJson,

  [switch]$ValidateInteropOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-NormalizedDirectoryPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value,

    [switch]$RequireExisting
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw 'Directory path is empty.'
  }
  $fullPath = if ($RequireExisting) {
    $item = Get-Item -LiteralPath $Value -Force
    if ($item -is [System.Array] -or -not $item.PSIsContainer) {
      throw 'The foreground target must resolve to exactly one existing directory.'
    }
    [System.IO.Path]::GetFullPath([string]$item.FullName)
  } else {
    [System.IO.Path]::GetFullPath($Value)
  }
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  if ($fullPath.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $root
  }
  $trimCharacters = [char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  return $fullPath.TrimEnd($trimCharacters)
}

function Write-FocusResult {
  param([Parameter(Mandatory = $true)][hashtable]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
}

$targetDirectory = Get-NormalizedDirectoryPath -Value $LiteralDirectory -RequireExisting
$comparison = [System.StringComparison]::OrdinalIgnoreCase

# Fixture mode is deliberately resolved before COM or Win32 interop is loaded.
# It validates exact path/HWND selection without opening, showing, restoring, or
# foregrounding any desktop window.
if ($PSBoundParameters.ContainsKey('FixtureWindowsJson')) {
  $decoded = ConvertFrom-Json -InputObject $FixtureWindowsJson
  $windows = if ($null -eq $decoded) { @() } elseif ($decoded -is [System.Array]) { $decoded } else { @($decoded) }
  $match = $null
  foreach ($window in $windows) {
    try {
      $candidate = Get-NormalizedDirectoryPath -Value ([string]$window.directory)
      if (-not $candidate.Equals($targetDirectory, $comparison)) { continue }
      $hwnd = [long]$window.hwnd
      if ($hwnd -le 0) { continue }
      $match = [pscustomobject]@{ hwnd = $hwnd; directory = $candidate }
      break
    } catch { }
  }
  Write-FocusResult -Value @{
    foreground = $false
    foregroundAttempted = $false
    matched = ($null -ne $match)
    matchedHwnd = if ($null -ne $match) { [string]$match.hwnd } else { $null }
    targetDirectory = $targetDirectory
    testMode = $true
    windowMutationAttempted = $false
    errorCode = if ($null -ne $match) { $null } else { 'no-exact-window' }
  }
  return
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OutputItemsExplorerWindowNative
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
}
'@

  if ($ValidateInteropOnly) {
    Write-FocusResult -Value @{
      foreground = $false
      foregroundAttempted = $false
      matched = $false
      matchedHwnd = $null
      targetDirectory = $targetDirectory
      testMode = $true
      interopValidated = $true
      windowMutationAttempted = $false
      errorCode = $null
    }
    return
  }

  $shell = New-Object -ComObject Shell.Application
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $matchedHwnd = [IntPtr]::Zero
  $mutationAttempted = $false
  try {
    do {
      $currentHwnd = [IntPtr]::Zero
      $collection = $null
      try {
        $collection = $shell.Windows()
        for ($index = 0; $index -lt $collection.Count; $index += 1) {
          $window = $null
          try {
            $window = $collection.Item($index)
            $candidateValue = [string]$window.Document.Folder.Self.Path
            $candidate = Get-NormalizedDirectoryPath -Value $candidateValue
            if (-not $candidate.Equals($targetDirectory, $comparison)) { continue }
            $candidateHwnd = [long]$window.HWND
            if ($candidateHwnd -le 0) { continue }
            $currentHwnd = [IntPtr]::new($candidateHwnd)
            break
          } catch { }
          finally {
            if ($null -ne $window -and [System.Runtime.InteropServices.Marshal]::IsComObject($window)) {
              [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($window)
            }
          }
        }
      } finally {
        if ($null -ne $collection -and [System.Runtime.InteropServices.Marshal]::IsComObject($collection)) {
          [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($collection)
        }
      }

      if ($currentHwnd -ne [IntPtr]::Zero) {
        $matchedHwnd = $currentHwnd
        $mutationAttempted = $true
        [uint32]$targetProcessId = 0
        [uint32]$foregroundProcessId = 0
        $targetThreadId = [OutputItemsExplorerWindowNative]::GetWindowThreadProcessId($currentHwnd, [ref]$targetProcessId)
        $foregroundHwnd = [OutputItemsExplorerWindowNative]::GetForegroundWindow()
        $foregroundThreadId = if ($foregroundHwnd -ne [IntPtr]::Zero) {
          [OutputItemsExplorerWindowNative]::GetWindowThreadProcessId($foregroundHwnd, [ref]$foregroundProcessId)
        } else { [uint32]0 }
        $currentThreadId = [OutputItemsExplorerWindowNative]::GetCurrentThreadId()
        $attachedForeground = $false
        $attachedTarget = $false
        try {
          if ($foregroundThreadId -gt 0 -and $foregroundThreadId -ne $currentThreadId) {
            $attachedForeground = [OutputItemsExplorerWindowNative]::AttachThreadInput($currentThreadId, $foregroundThreadId, $true)
          }
          if ($targetThreadId -gt 0 -and $targetThreadId -ne $currentThreadId -and $targetThreadId -ne $foregroundThreadId) {
            $attachedTarget = [OutputItemsExplorerWindowNative]::AttachThreadInput($currentThreadId, $targetThreadId, $true)
          }
          $showCommand = if ([OutputItemsExplorerWindowNative]::IsIconic($currentHwnd)) { 9 } else { 5 }
          [void][OutputItemsExplorerWindowNative]::ShowWindowAsync($currentHwnd, $showCommand)
          [void][OutputItemsExplorerWindowNative]::BringWindowToTop($currentHwnd)
          [void][OutputItemsExplorerWindowNative]::SetForegroundWindow($currentHwnd)
        } finally {
          if ($attachedTarget) {
            [void][OutputItemsExplorerWindowNative]::AttachThreadInput($currentThreadId, $targetThreadId, $false)
          }
          if ($attachedForeground) {
            [void][OutputItemsExplorerWindowNative]::AttachThreadInput($currentThreadId, $foregroundThreadId, $false)
          }
        }
        Start-Sleep -Milliseconds 80
        if ([OutputItemsExplorerWindowNative]::GetForegroundWindow() -eq $currentHwnd) {
          Write-FocusResult -Value @{
            foreground = $true
            foregroundAttempted = $true
            matched = $true
            matchedHwnd = [string]$currentHwnd.ToInt64()
            targetDirectory = $targetDirectory
            testMode = $false
            windowMutationAttempted = $true
            errorCode = $null
          }
          return
        }
      }
      if ($stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        Start-Sleep -Milliseconds 100
      }
    } while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds)
  } finally {
    if ($null -ne $shell -and [System.Runtime.InteropServices.Marshal]::IsComObject($shell)) {
      [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
  }

  Write-FocusResult -Value @{
    foreground = $false
    foregroundAttempted = $mutationAttempted
    matched = ($matchedHwnd -ne [IntPtr]::Zero)
    matchedHwnd = if ($matchedHwnd -ne [IntPtr]::Zero) { [string]$matchedHwnd.ToInt64() } else { $null }
    targetDirectory = $targetDirectory
    testMode = $false
    windowMutationAttempted = $mutationAttempted
    errorCode = if ($matchedHwnd -ne [IntPtr]::Zero) { 'foreground-denied' } else { 'no-exact-window' }
  }
} catch {
  Write-FocusResult -Value @{
    foreground = $false
    foregroundAttempted = $false
    matched = $false
    matchedHwnd = $null
    targetDirectory = $targetDirectory
    testMode = $false
    windowMutationAttempted = $false
    errorCode = 'helper-error'
    helperMessage = [string]$_.Exception.Message
  }
}

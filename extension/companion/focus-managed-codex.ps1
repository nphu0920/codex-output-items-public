[CmdletBinding(DefaultParameterSetName = "Focus")]
param(
  [Parameter(ParameterSetName = "Focus", Mandatory = $true)]
  [int]$ManagedProcessId,

  [Parameter(ParameterSetName = "Focus", Mandatory = $true)]
  [string]$ProfilePath,

  [Parameter(ParameterSetName = "Focus", Mandatory = $true)]
  [string]$CodexExecutable,

  [Parameter(ParameterSetName = "Focus")]
  [ValidateRange(250, 15000)]
  [int]$TimeoutMilliseconds = 8000,

  [Parameter(ParameterSetName = "SelfTest", Mandatory = $true)]
  [switch]$SelfTest,

  [Parameter(ParameterSetName = "CompanionIdentity", Mandatory = $true)]
  [switch]$ValidateCompanion,

  [Parameter(ParameterSetName = "CompanionIdentity", Mandatory = $true)]
  [int]$CompanionProcessId,

  [Parameter(ParameterSetName = "CompanionIdentity", Mandatory = $true)]
  [string]$CompanionScript,

  [Parameter(ParameterSetName = "CompanionIdentity")]
  [string]$ExpectedNonce = "",

  [Parameter(ParameterSetName = "CompanionIdentity")]
  [string]$ExpectedStartedAt = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

if (-not ("OutputItems.WindowNative" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace OutputItems {
  public static class WindowNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    public sealed class ProcessInfo {
      public int ProcessId;
      public int ParentProcessId;
      public string Name;
      public string ExecutablePath;
      public string CommandLine;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32 {
      public uint dwSize;
      public uint cntUsage;
      public uint th32ProcessID;
      public IntPtr th32DefaultHeapID;
      public uint th32ModuleID;
      public uint cntThreads;
      public uint th32ParentProcessID;
      public int pcPriClassBase;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
      public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [DllImport("shell32.dll", SetLastError = true)]
    public static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argumentCount
    );

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(
      IntPtr process,
      uint flags,
      StringBuilder executableName,
      ref uint size
    );

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr process,
      int processInformationClass,
      IntPtr processInformation,
      uint processInformationLength,
      out uint returnLength
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern IntPtr GetWindowLongPtr32(IntPtr window, int index);

    public static IntPtr GetWindowLongPtr(IntPtr window, int index) {
      return IntPtr.Size == 8
        ? GetWindowLongPtr64(window, index)
        : GetWindowLongPtr32(window, index);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, StringBuilder className, int maximumCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out RECT rectangle);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(
      IntPtr window,
      IntPtr insertAfter,
      int x,
      int y,
      int width,
      int height,
      uint flags
    );

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr window, bool alternateTab);

    public static IntPtr[] EnumerateTopLevelWindows() {
      List<IntPtr> windows = new List<IntPtr>();
      EnumWindowsProc callback = delegate(IntPtr window, IntPtr parameter) {
        windows.Add(window);
        return true;
      };
      if (!EnumWindows(callback, IntPtr.Zero)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      return windows.ToArray();
    }

    public static ProcessInfo[] SnapshotProcesses() {
      const uint TH32CS_SNAPPROCESS = 0x00000002;
      IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (snapshot == new IntPtr(-1)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      try {
        List<ProcessInfo> processes = new List<ProcessInfo>();
        PROCESSENTRY32 entry = new PROCESSENTRY32();
        entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (!Process32FirstW(snapshot, ref entry)) {
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        do {
          processes.Add(new ProcessInfo {
            ProcessId = (int)entry.th32ProcessID,
            ParentProcessId = (int)entry.th32ParentProcessID,
            Name = entry.szExeFile ?? ""
          });
          entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        } while (Process32NextW(snapshot, ref entry));
        return processes.ToArray();
      } finally {
        CloseHandle(snapshot);
      }
    }

    private static IntPtr OpenProcessForQuery(int processId) {
      const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)processId);
      if (process == IntPtr.Zero) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      return process;
    }

    public static string GetProcessImagePath(int processId) {
      IntPtr process = OpenProcessForQuery(processId);
      try {
        uint capacity = 32768;
        StringBuilder path = new StringBuilder((int)capacity);
        if (!QueryFullProcessImageNameW(process, 0, path, ref capacity)) {
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return path.ToString();
      } finally {
        CloseHandle(process);
      }
    }

    public static string GetProcessCommandLine(int processId) {
      const int ProcessCommandLineInformation = 60;
      IntPtr process = OpenProcessForQuery(processId);
      try {
        uint required = 0;
        NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out required);
        if (required == 0) {
          throw new InvalidOperationException("Windows did not return a command-line buffer size.");
        }
        IntPtr buffer = Marshal.AllocHGlobal((int)required);
        try {
          uint returned;
          int status = NtQueryInformationProcess(
            process,
            ProcessCommandLineInformation,
            buffer,
            required,
            out returned
          );
          if (status != 0) {
            throw new InvalidOperationException(
              "NtQueryInformationProcess(ProcessCommandLineInformation) failed with NTSTATUS 0x"
              + status.ToString("X8")
            );
          }
          UNICODE_STRING commandLine = (UNICODE_STRING)Marshal.PtrToStructure(
            buffer,
            typeof(UNICODE_STRING)
          );
          if (commandLine.Buffer == IntPtr.Zero || commandLine.Length == 0) return "";
          return Marshal.PtrToStringUni(commandLine.Buffer, commandLine.Length / 2);
        } finally {
          Marshal.FreeHGlobal(buffer);
        }
      } finally {
        CloseHandle(process);
      }
    }
  }
}
'@
}

function Write-Result($Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 6))
}

function Get-NormalizedPath([string]$Value) {
  if (-not $Value) { return "" }
  return [System.IO.Path]::GetFullPath($Value).TrimEnd('\')
}

function ConvertFrom-NativeCommandLine([string]$CommandLine) {
  if (-not $CommandLine) { return @() }
  $count = 0
  $pointer = [OutputItems.WindowNative]::CommandLineToArgvW($CommandLine, [ref]$count)
  if ($pointer -eq [IntPtr]::Zero) {
    throw "无法解析伴生 Codex 命令行。"
  }
  try {
    $arguments = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $count; $index += 1) {
      $argumentPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr(
        $pointer,
        $index * [IntPtr]::Size
      )
      $arguments.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($argumentPointer))
    }
    return $arguments.ToArray()
  } finally {
    [void][OutputItems.WindowNative]::LocalFree($pointer)
  }
}

function Test-ProfileArgument([string[]]$Arguments, [string]$ExpectedProfile) {
  $expected = Get-NormalizedPath $ExpectedProfile
  for ($index = 0; $index -lt $Arguments.Count; $index += 1) {
    $argument = [string]$Arguments[$index]
    $candidate = ""
    if ($argument.StartsWith("--user-data-dir=", [StringComparison]::OrdinalIgnoreCase)) {
      $candidate = $argument.Substring("--user-data-dir=".Length)
    } elseif (
      $argument.Equals("--user-data-dir", [StringComparison]::OrdinalIgnoreCase) -and
      $index + 1 -lt $Arguments.Count
    ) {
      $candidate = [string]$Arguments[$index + 1]
    }
    if (-not $candidate) { continue }
    try {
      if ((Get-NormalizedPath $candidate).Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    } catch { }
  }
  return $false
}

function Test-InstanceNonceArgument([string[]]$Arguments, [string]$ExpectedNonce) {
  if (-not $ExpectedNonce) { return $false }
  for ($index = 0; $index -lt $Arguments.Count; $index += 1) {
    $argument = [string]$Arguments[$index]
    if (
      $argument.Equals("--instance-nonce", [StringComparison]::Ordinal) -and
      $index + 1 -lt $Arguments.Count -and
      [string]$Arguments[$index + 1] -ceq $ExpectedNonce
    ) { return $true }
    if (
      $argument.StartsWith("--instance-nonce=", [StringComparison]::Ordinal) -and
      $argument.Substring("--instance-nonce=".Length) -ceq $ExpectedNonce
    ) { return $true }
  }
  return $false
}

function Test-CompanionScriptArgument([string[]]$Arguments, [string]$ExpectedScript) {
  if ($Arguments.Count -lt 2) { return $false }
  try {
    $candidate = Get-NormalizedPath ([string]$Arguments[1])
    $expected = Get-NormalizedPath $ExpectedScript
    return $candidate.Equals($expected, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Get-ManagedProcessIds([object[]]$Processes, [int]$RootProcessId) {
  $managed = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$managed.Add($RootProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $Processes) {
      $processId = [int]$process.ProcessId
      $parentId = [int]$process.ParentProcessId
      if (-not $managed.Contains($processId) -and $managed.Contains($parentId)) {
        [void]$managed.Add($processId)
        $changed = $true
      }
    }
  }
  Write-Output -NoEnumerate $managed
}

function Get-ManagedProcessRows([int]$RootProcessId) {
  # Snapshot process IDs and parent IDs without reading unrelated command
  # lines. Only the explicitly managed root is opened for executable/profile
  # validation below.
  $all = @([OutputItems.WindowNative]::SnapshotProcesses())
  $root = $all | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1
  if ($null -eq $root) { return @() }
  $root.ExecutablePath = [OutputItems.WindowNative]::GetProcessImagePath($RootProcessId)
  $root.CommandLine = [OutputItems.WindowNative]::GetProcessCommandLine($RootProcessId)
  $managed = Get-ManagedProcessIds $all $RootProcessId
  return @($all | Where-Object { $managed.Contains([int]$_.ProcessId) })
}

function Assert-ManagedCodexIdentity(
  [object[]]$Processes,
  [int]$RootProcessId,
  [string]$ExpectedProfile,
  [string]$ExpectedExecutable
) {
  $root = $Processes | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1
  if ($null -eq $root) {
    throw "伴生 Codex PID $RootProcessId 不存在。"
  }

  $expectedExecutablePath = Get-NormalizedPath $ExpectedExecutable
  if (-not [System.IO.Path]::GetFileName($expectedExecutablePath).Equals("ChatGPT.exe", [StringComparison]::OrdinalIgnoreCase)) {
    throw "伴生状态中的 Codex 可执行文件不是 ChatGPT.exe。"
  }
  if (-not ([string]$root.Name).Equals("ChatGPT.exe", [StringComparison]::OrdinalIgnoreCase)) {
    throw "PID $RootProcessId 不是 ChatGPT.exe，已拒绝操作窗口。"
  }

  try {
    $actualExecutablePath = Get-NormalizedPath ([string]$root.ExecutablePath)
  } catch {
    throw "伴生 Codex PID $RootProcessId 的可执行文件路径无效。"
  }
  if (-not $actualExecutablePath.Equals($expectedExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "伴生 Codex PID $RootProcessId 的可执行文件与运行状态不匹配。"
  }

  $arguments = @(ConvertFrom-NativeCommandLine ([string]$root.CommandLine))
  if ($arguments.Count -eq 0) {
    throw "无法读取伴生 Codex PID $RootProcessId 的命令行，已拒绝操作窗口。"
  }
  if (-not (Test-ProfileArgument $arguments $ExpectedProfile)) {
    throw "伴生 Codex PID $RootProcessId 未使用预期的独立 profile，已拒绝操作窗口。"
  }
  $managed = Get-ManagedProcessIds $Processes $RootProcessId
  Write-Output -NoEnumerate $managed
}

function Assert-CompanionProcessIdentity(
  [int]$RootProcessId,
  [string]$ExpectedScript,
  [string]$Nonce = "",
  [string]$StartedAt = ""
) {
  $rows = @(Get-ManagedProcessRows $RootProcessId)
  $root = $rows | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1
  if ($null -eq $root) { throw "伴生进程 PID $RootProcessId 不存在。" }
  if (-not ([string]$root.Name -match '^node(?:\.exe)?$')) {
    throw "PID $RootProcessId 不是 Node.js 伴生进程。"
  }
  $arguments = @(ConvertFrom-NativeCommandLine ([string]$root.CommandLine))
  $expected = Get-NormalizedPath $ExpectedScript
  # The launcher invokes exactly: node.exe <companion-script> <flags>.
  # Requiring argv[1], rather than accepting the path anywhere in the command
  # line, rejects unrelated Node programs that merely mention it.
  $scriptMatched = Test-CompanionScriptArgument $arguments $expected
  if (-not $scriptMatched) {
    throw "PID $RootProcessId 未运行预期的产出项伴生脚本。"
  }

  if ($Nonce) {
    if (-not (Test-InstanceNonceArgument $arguments $Nonce)) {
      throw "PID $RootProcessId 的实例 nonce 与运行状态不匹配。"
    }
  }

  $actualStartedAt = [Diagnostics.Process]::GetProcessById($RootProcessId).StartTime.ToUniversalTime()
  if ($StartedAt) {
    $expectedStartedAt = [DateTimeOffset]::Parse($StartedAt).UtcDateTime
    if ([Math]::Abs(($actualStartedAt - $expectedStartedAt).TotalSeconds) -gt 10) {
      throw "PID $RootProcessId 的启动时间与运行状态不匹配。"
    }
  }
  return [ordered]@{
    ok = $true
    identity = $true
    companionProcessId = $RootProcessId
    executable = [string]$root.ExecutablePath
    script = $expected
    nonce = if ($Nonce) { $Nonce } else { $null }
    startedAt = $actualStartedAt.ToString("o")
  }
}

function Get-WindowTextValue([IntPtr]$Window) {
  $length = [OutputItems.WindowNative]::GetWindowTextLength($Window)
  $builder = New-Object Text.StringBuilder ([Math]::Max(2, $length + 1))
  [void][OutputItems.WindowNative]::GetWindowText($Window, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Get-WindowClassValue([IntPtr]$Window) {
  $builder = New-Object Text.StringBuilder 256
  [void][OutputItems.WindowNative]::GetClassName($Window, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Find-ManagedCodexWindow([System.Collections.Generic.HashSet[int]]$ManagedIds) {
  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($window in [OutputItems.WindowNative]::EnumerateTopLevelWindows()) {
    $windowProcessId = [uint32]0
    [void][OutputItems.WindowNative]::GetWindowThreadProcessId($window, [ref]$windowProcessId)
    if (-not $ManagedIds.Contains([int]$windowProcessId)) { continue }

    # Ignore owned/tool/no-activate surfaces such as Electron overlays. The
    # managed PID tree is the primary boundary; title text is never used for
    # identity, so an ordinary Codex window cannot be selected accidentally.
    if ([OutputItems.WindowNative]::GetWindow($window, 4) -ne [IntPtr]::Zero) { continue }
    $extendedStyle = [OutputItems.WindowNative]::GetWindowLongPtr($window, -20).ToInt64()
    if (($extendedStyle -band 0x80) -ne 0 -or ($extendedStyle -band 0x08000000) -ne 0) { continue }

    $rectangle = New-Object OutputItems.WindowNative+RECT
    if (-not [OutputItems.WindowNative]::GetWindowRect($window, [ref]$rectangle)) { continue }
    $width = [Math]::Abs($rectangle.Right - $rectangle.Left)
    $height = [Math]::Abs($rectangle.Bottom - $rectangle.Top)
    if ($width -lt 240 -or $height -lt 160) { continue }

    $className = Get-WindowClassValue $window
    $title = Get-WindowTextValue $window
    $visible = [OutputItems.WindowNative]::IsWindowVisible($window)
    $score = 0
    if ($className.StartsWith("Chrome_WidgetWin_", [StringComparison]::Ordinal)) { $score += 100 }
    if ($title) { $score += 20 }
    if ($visible) { $score += 10 }
    if (-not [OutputItems.WindowNative]::IsIconic($window)) { $score += 5 }
    $score += [Math]::Min(25, [int](($width * $height) / 100000))
    $candidates.Add([pscustomobject]@{
      Handle = $window
      ProcessId = [int]$windowProcessId
      ClassName = $className
      Title = $title
      Width = $width
      Height = $height
      Score = $score
    })
  }
  return $candidates | Sort-Object Score, Width, Height -Descending | Select-Object -First 1
}

function Request-WindowForeground([IntPtr]$Window) {
  # SW_RESTORE also makes a hidden normal window visible. AttachThreadInput is
  # scoped to this short-lived helper and released in finally.
  [void][OutputItems.WindowNative]::ShowWindowAsync($Window, 9)
  $targetProcessId = [uint32]0
  $targetThread = [OutputItems.WindowNative]::GetWindowThreadProcessId($Window, [ref]$targetProcessId)
  $foregroundWindow = [OutputItems.WindowNative]::GetForegroundWindow()
  $foregroundProcessId = [uint32]0
  $foregroundThread = if ($foregroundWindow -ne [IntPtr]::Zero) {
    [OutputItems.WindowNative]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)
  } else { [uint32]0 }
  $currentThread = [OutputItems.WindowNative]::GetCurrentThreadId()
  $attachedTarget = $false
  $attachedForeground = $false
  try {
    if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
      $attachedTarget = [OutputItems.WindowNative]::AttachThreadInput($currentThread, $targetThread, $true)
    }
    if (
      $foregroundThread -ne 0 -and
      $foregroundThread -ne $currentThread -and
      $foregroundThread -ne $targetThread
    ) {
      $attachedForeground = [OutputItems.WindowNative]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    [void][OutputItems.WindowNative]::SetWindowPos($Window, [IntPtr]::Zero, 0, 0, 0, 0, 0x0043)
    [void][OutputItems.WindowNative]::BringWindowToTop($Window)
    [void][OutputItems.WindowNative]::SetForegroundWindow($Window)
    [OutputItems.WindowNative]::SwitchToThisWindow($Window, $true)
    [void][OutputItems.WindowNative]::SetForegroundWindow($Window)
  } finally {
    if ($attachedForeground) {
      [void][OutputItems.WindowNative]::AttachThreadInput($currentThread, $foregroundThread, $false)
    }
    if ($attachedTarget) {
      [void][OutputItems.WindowNative]::AttachThreadInput($currentThread, $targetThread, $false)
    }
  }
}

function Invoke-ManagedCodexForeground {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  $candidate = $null
  $stableHandle = [IntPtr]::Zero
  $stableCount = 0
  $managedIds = $null
  do {
    # Refresh the process tree and repeat root executable/profile validation on
    # every pass. A late renderer is picked up, while PID reuse during the
    # wait fails closed before any window operation.
    $processes = @(Get-ManagedProcessRows $ManagedProcessId)
    $managedIds = Assert-ManagedCodexIdentity `
      $processes `
      $ManagedProcessId `
      $ProfilePath `
      $CodexExecutable
    $candidate = Find-ManagedCodexWindow $managedIds
    if ($null -eq $candidate) {
      $stableHandle = [IntPtr]::Zero
      $stableCount = 0
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($candidate.Handle -eq $stableHandle) {
      $stableCount += 1
    } else {
      $stableHandle = $candidate.Handle
      $stableCount = 1
    }
    if ($stableCount -lt 2) {
      Start-Sleep -Milliseconds 100
      continue
    }
    Request-WindowForeground $candidate.Handle
    Start-Sleep -Milliseconds 75
    $foregroundWindow = [OutputItems.WindowNative]::GetForegroundWindow()
    if (
      [OutputItems.WindowNative]::IsWindowVisible($candidate.Handle) -and
      -not [OutputItems.WindowNative]::IsIconic($candidate.Handle) -and
      $foregroundWindow -eq $candidate.Handle
    ) {
      return [ordered]@{
        ok = $true
        focused = $true
        managedProcessId = $ManagedProcessId
        windowProcessId = $candidate.ProcessId
        windowHandle = ("0x{0:X}" -f $candidate.Handle.ToInt64())
        className = $candidate.ClassName
        visible = $true
        minimized = $false
        managedProcessCount = $managedIds.Count
      }
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  if ($null -eq $candidate) {
    throw "在限定时间内未找到伴生 Codex PID $ManagedProcessId 的主窗口。"
  }
  $foreground = [OutputItems.WindowNative]::GetForegroundWindow()
  $foregroundProcessId = [uint32]0
  if ($foreground -ne [IntPtr]::Zero) {
    [void][OutputItems.WindowNative]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  }
  throw "伴生 Codex 窗口已恢复，但 Windows 拒绝将其置于前台（当前前台 PID $foregroundProcessId）。"
}

try {
  if ($SelfTest) {
    $fixtureDrive = [IO.Path]::GetPathRoot([Environment]::SystemDirectory)
    $fixtureRoot = Join-Path $fixtureDrive "OutputItemsFixture"
    $fixtureProgramExe = Join-Path $fixtureRoot "Program Files\WindowsApps\ChatGPT.exe"
    $fixtureProfile = Join-Path $fixtureRoot "Profile With Space"
    $managedRoot = Join-Path $fixtureRoot "Managed"
    $managedScript = Join-Path $managedRoot "companion.mjs"
    $managedExecutable = Join-Path $managedRoot "ChatGPT.exe"
    $managedProfile = Join-Path $fixtureRoot "Managed Profile"
    $otherExecutable = Join-Path (Join-Path $fixtureRoot "Other") "ChatGPT.exe"
    $otherProfile = Join-Path $fixtureRoot "Other Profile"
    $parsed = @(ConvertFrom-NativeCommandLine ('"{0}" "--user-data-dir={1}" --flag' -f $fixtureProgramExe, $fixtureProfile))
    if ($parsed.Count -ne 3 -or $parsed[1] -ne "--user-data-dir=$fixtureProfile") {
      throw "CommandLineToArgvW 隔离测试失败。"
    }
    if (-not (Test-ProfileArgument $parsed ($fixtureProfile.ToLowerInvariant() + [IO.Path]::DirectorySeparatorChar))) {
      throw "profile 参数等值测试失败。"
    }
    if (Test-ProfileArgument $parsed ($fixtureProfile + "-Other")) {
      throw "profile 参数边界测试失败。"
    }
    $nonceParsed = @(ConvertFrom-NativeCommandLine 'node.exe companion.mjs --instance-nonce fixture_nonce_1234567890')
    if (-not (Test-InstanceNonceArgument $nonceParsed 'fixture_nonce_1234567890')) {
      throw "实例 nonce 精确参数测试失败。"
    }
    if (Test-InstanceNonceArgument $nonceParsed 'fixture_nonce_1234567890_suffix') {
      throw "实例 nonce 参数边界测试失败。"
    }
    $scriptArguments = @('node.exe', $managedScript, '--instance-nonce', 'fixture_nonce_1234567890')
    if (-not (Test-CompanionScriptArgument $scriptArguments $managedScript.ToLowerInvariant())) {
      throw "伴生脚本 argv[1] 精确匹配测试失败。"
    }
    $decoyArguments = @('node.exe', '-e', 'setTimeout(() => {}, 1000)', $managedScript)
    if (Test-CompanionScriptArgument $decoyArguments $managedScript) {
      throw "无关 Node 的伴生脚本路径诱饵未被拒绝。"
    }
    $synthetic = @(
      [pscustomobject]@{
        ProcessId = 41
        ParentProcessId = 1
        Name = "ChatGPT.exe"
        ExecutablePath = $managedExecutable
        CommandLine = ('"{0}" "--user-data-dir={1}"' -f $managedExecutable, $managedProfile)
      },
      [pscustomobject]@{ ProcessId = 42; ParentProcessId = 41; Name = "ChatGPT.exe" },
      [pscustomobject]@{ ProcessId = 43; ParentProcessId = 42; Name = "ChatGPT.exe" },
      # An ordinary Codex process with the same executable name is a sibling,
      # not a descendant of the managed root, and must never be selected.
      [pscustomobject]@{ ProcessId = 44; ParentProcessId = 1; Name = "ChatGPT.exe" }
    )
    $syntheticManaged = Get-ManagedProcessIds $synthetic 41
    if (
      -not ($syntheticManaged -is [System.Collections.Generic.HashSet[int]]) -or
      $syntheticManaged.Count -ne 3 -or
      -not $syntheticManaged.Contains(43) -or
      $syntheticManaged.Contains(44)
    ) {
      throw "托管进程树隔离测试失败。"
    }
    $validatedSynthetic = Assert-ManagedCodexIdentity `
      $synthetic `
      41 `
      $managedProfile `
      $managedExecutable
    if (-not $validatedSynthetic.Contains(43) -or $validatedSynthetic.Contains(44)) {
      throw "普通 Codex sibling 排除测试失败。"
    }
    $wrongExecutableRejected = $false
    try {
      [void](Assert-ManagedCodexIdentity $synthetic 41 $managedProfile $otherExecutable)
    } catch { $wrongExecutableRejected = $true }
    if (-not $wrongExecutableRejected) { throw "Codex 可执行文件身份错误未被拒绝。" }
    $wrongProfileRejected = $false
    try {
      [void](Assert-ManagedCodexIdentity $synthetic 41 $otherProfile $managedExecutable)
    } catch { $wrongProfileRejected = $true }
    if (-not $wrongProfileRejected) { throw "Codex 独立 profile 身份错误未被拒绝。" }
    $nativeRows = @(Get-ManagedProcessRows $PID)
    $nativeRoot = $nativeRows | Where-Object { [int]$_.ProcessId -eq $PID } | Select-Object -First 1
    if ($null -eq $nativeRoot -or -not $nativeRoot.ExecutablePath -or -not $nativeRoot.CommandLine) {
      throw "受管进程原生查询隔离测试失败。"
    }
    Write-Result ([ordered]@{
      ok = $true
      mode = "self-test"
      nativeLoaded = $true
      profileIdentity = $true
      descendantIdentity = $true
      executableMismatchRejected = $true
      profileMismatchRejected = $true
      ordinaryCodexSiblingExcluded = $true
      stableWindowPasses = 2
      nativeProcessQuery = $true
      exactNonceArgument = $true
      exactScriptPosition = $true
      nodePathDecoyRejected = $true
      windowMutation = $false
    })
    exit 0
  }

  if ($ValidateCompanion) {
    Write-Result (Assert-CompanionProcessIdentity `
      $CompanionProcessId `
      $CompanionScript `
      $ExpectedNonce `
      $ExpectedStartedAt)
    exit 0
  }

  Write-Result (Invoke-ManagedCodexForeground)
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-Result ([ordered]@{ ok = $false; focused = $false; error = $message })
  [Console]::Error.WriteLine("产出项窗口前台恢复失败: $message")
  exit 1
}

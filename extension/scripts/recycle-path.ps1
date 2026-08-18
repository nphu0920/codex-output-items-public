param(
  [Parameter(Mandatory = $true)]
  [string]$LiteralTarget,

  [Parameter(Mandatory = $true)]
  [string]$AllowedRoot,

  [Parameter(Mandatory = $true)]
  [string]$ProtectedRootsJson
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedExistingPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Label path is empty."
  }
  $entry = Get-Item -LiteralPath $Value -Force
  if ($entry -is [System.Array]) {
    throw "$Label must resolve to exactly one filesystem item."
  }
  $fullName = [string]$entry.FullName
  if ([string]::IsNullOrWhiteSpace($fullName)) {
    throw "$Label does not expose a valid filesystem path."
  }
  $fullPath = [System.IO.Path]::GetFullPath($fullName)
  $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
  if ($fullPath.Equals($pathRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $pathRoot
  }
  $trimCharacters = [char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  return $fullPath.TrimEnd($trimCharacters)
}

if (-not (Test-Path -LiteralPath $LiteralTarget)) {
  throw "Target does not exist: $LiteralTarget"
}

Add-Type -AssemblyName Microsoft.VisualBasic
$item = Get-Item -LiteralPath $LiteralTarget -Force
$allowed = Get-Item -LiteralPath $AllowedRoot -Force
$comparison = [System.StringComparison]::OrdinalIgnoreCase
$separator = [System.IO.Path]::DirectorySeparatorChar
$targetPath = Get-NormalizedExistingPath -Value ([string]$item.FullName) -Label 'Target'
$allowedPath = Get-NormalizedExistingPath -Value ([string]$allowed.FullName) -Label 'Allowed root'

if (-not ($targetPath.Equals($allowedPath, $comparison) -or $targetPath.StartsWith($allowedPath + $separator, $comparison))) {
  throw 'Target escaped the authorized output root.'
}

$driveRoot = [System.IO.Path]::GetPathRoot($targetPath)
if ($targetPath.Equals($driveRoot, $comparison)) {
  throw 'A drive root cannot be recycled.'
}
$drive = [System.IO.DriveInfo]::new($driveRoot)
if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) {
  throw "Only a local fixed drive can use recycle-bin deletion: $driveRoot"
}

$current = $item
while ($null -ne $current) {
  if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Reparse points are not allowed in a deletion path: $($current.FullName)"
  }
  $parent = if ($current -is [System.IO.DirectoryInfo]) { $current.Parent } else { $current.Directory }
  if ($null -eq $parent) { break }
  $current = Get-Item -LiteralPath $parent.FullName -Force
}

# Windows PowerShell 5.1 returns a JSON array as one Object[] pipeline value.
# Wrapping that pipeline in @() creates a nested array and later coerces every
# root into one space-separated invalid path. Keep the decoded array flat and
# enumerate it directly so PowerShell 5.1 and PowerShell 7 behave identically.
$decodedProtectedRoots = ConvertFrom-Json -InputObject $ProtectedRootsJson
$protectedRoots = [System.Collections.Generic.List[string]]::new()
if ($null -ne $decodedProtectedRoots) {
  if ($decodedProtectedRoots -isnot [System.Array]) {
    throw 'ProtectedRootsJson must contain a JSON array.'
  }
  foreach ($decodedRoot in $decodedProtectedRoots) {
    if ($decodedRoot -isnot [string]) {
      throw 'Every protected root must be a string.'
    }
    if (-not [string]::IsNullOrWhiteSpace($decodedRoot)) {
      $protectedRoots.Add([string]$decodedRoot)
    }
  }
}
if ($protectedRoots.Count -eq 0) {
  throw 'At least one protected root is required.'
}
foreach ($protectedRoot in $protectedRoots) {
  if (-not (Test-Path -LiteralPath $protectedRoot)) { continue }
  $protectedPath = Get-NormalizedExistingPath -Value $protectedRoot -Label 'Protected root'
  if (
    $targetPath.Equals($protectedPath, $comparison) -or
    $targetPath.StartsWith($protectedPath + $separator, $comparison) -or
    $protectedPath.StartsWith($targetPath + $separator, $comparison)
  ) {
    throw "Protected system or extension path cannot be recycled: $targetPath"
  }
}

if ($item.PSIsContainer) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $item.FullName,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
    [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
  )
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
    $item.FullName,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
    [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException
  )
}

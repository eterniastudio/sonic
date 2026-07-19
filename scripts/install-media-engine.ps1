[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$headers = @{ 'User-Agent' = 'Sonic-Media-Engine-Setup' }

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$File)

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($File)
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
}

function Assert-Sha256 {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  $expectedHash = $Expected.Trim().ToLowerInvariant()
  if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
    throw "The media engine manifest contains an invalid SHA-256 value."
  }
  $actualHash = Get-Sha256 -File $File
  if ($actualHash -cne $expectedHash) {
    throw "Media engine checksum mismatch for $([IO.Path]::GetFileName($File))."
  }
}

function Get-VerifiedMember {
  param(
    [Parameter(Mandatory = $true)][string]$ExtractionRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  $root = [IO.Path]::GetFullPath($ExtractionRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $member = [IO.Path]::GetFullPath((Join-Path $root $RelativePath))
  if (-not $member.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "A media engine archive member escaped its extraction directory."
  }
  if (-not (Test-Path -LiteralPath $member -PathType Leaf)) {
    throw "A required media engine archive member is missing: $RelativePath"
  }
  Assert-Sha256 -File $member -Expected $ExpectedSha256
  return $member
}

function Assert-NoReparsePointsBelowRoot {
  param(
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $root = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $target = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a local data path outside Windows LocalApplicationData."
  }

  $relativePath = $target.Substring($root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $current = $root
  foreach ($segment in $relativePath.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $segment
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -Force -LiteralPath $current
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to use a Sonic local data parent that contains a reparse point."
      }
    }
  }
}

function Remove-PathWithoutFollowingReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Path)

  $item = Get-Item -Force -LiteralPath $Path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($item.PSIsContainer) {
      [IO.Directory]::Delete($item.FullName)
    } else {
      [IO.File]::Delete($item.FullName)
    }
    return
  }

  if (-not $item.PSIsContainer) {
    if (($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
      $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
    }
    [IO.File]::Delete($item.FullName)
    return
  }

  foreach ($child in Get-ChildItem -Force -LiteralPath $item.FullName) {
    Remove-PathWithoutFollowingReparsePoints -Path $child.FullName
  }
  [IO.Directory]::Delete($item.FullName)
}

function Remove-SafeDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AllowedParent,
    [Parameter(Mandatory = $true)][string]$RequiredNamePattern
  )

  $parent = [IO.Path]::GetFullPath($AllowedParent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $candidate = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ([IO.Path]::GetDirectoryName($candidate) -cne $parent) {
    throw "Refusing to remove a directory outside Sonic's local data folder."
  }
  if ([IO.Path]::GetFileName($candidate) -notmatch $RequiredNamePattern) {
    throw "Refusing to remove an unexpected local data directory."
  }
  Assert-NoReparsePointsBelowRoot -TrustedRoot ([Environment]::GetFolderPath('LocalApplicationData')) -Path $parent
  if (-not (Test-Path -LiteralPath $candidate)) {
    return
  }
  Remove-PathWithoutFollowingReparsePoints -Path $candidate
}

function Test-InstalledEngine {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)]$FfmpegDefinition,
    [Parameter(Mandatory = $true)]$DenoDefinition
  )

  $ffmpegPath = Join-Path $Directory 'ffmpeg.exe'
  $ffprobePath = Join-Path $Directory 'ffprobe.exe'
  $denoPath = Join-Path $Directory 'deno.exe'
  if (
    -not (Test-Path -LiteralPath $ffmpegPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $ffprobePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $denoPath -PathType Leaf)
  ) {
    return $false
  }
  return (
    (Get-Sha256 -File $ffmpegPath) -ceq ([string]$FfmpegDefinition.executables.ffmpeg.sha256).ToLowerInvariant() -and
    (Get-Sha256 -File $ffprobePath) -ceq ([string]$FfmpegDefinition.executables.ffprobe.sha256).ToLowerInvariant() -and
    (Get-Sha256 -File $denoPath) -ceq ([string]$DenoDefinition.executable.sha256).ToLowerInvariant()
  )
}

$manifestFile = [IO.Path]::GetFullPath($ManifestPath)
if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) {
  throw "Sonic's pinned media engine manifest is missing."
}
$manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2 -or $manifest.targetTriple -ne 'x86_64-pc-windows-msvc') {
  throw "Sonic's media engine manifest is incompatible with this build."
}
$ffmpeg = $manifest.tools.ffmpeg
$deno = $manifest.tools.deno
if (-not $ffmpeg -or $ffmpeg.delivery -ne 'runtime-download' -or -not $deno -or $deno.delivery -ne 'runtime-download') {
  throw "Sonic's media engine manifest does not define its runtime packages."
}

$ffmpegArtifactUri = [Uri]$ffmpeg.artifact.url
if (
  $ffmpegArtifactUri.Scheme -ne 'https' -or
  $ffmpegArtifactUri.Host -ne 'github.com' -or
  $ffmpegArtifactUri.AbsolutePath -notmatch '^/BtbN/FFmpeg-Builds/releases/download/autobuild-[0-9-]+/ffmpeg-[A-Za-z0-9._-]+-win64-lgpl\.zip$'
) {
  throw "Sonic's media engine URL is not an approved immutable BtbN release asset."
}
if ([IO.Path]::GetFileName($ffmpegArtifactUri.AbsolutePath) -cne [string]$ffmpeg.artifact.name) {
  throw "Sonic's media engine artifact name does not match its URL."
}
$denoArtifactUri = [Uri]$deno.artifact.url
if (
  $denoArtifactUri.Scheme -ne 'https' -or
  $denoArtifactUri.Host -ne 'github.com' -or
  $denoArtifactUri.AbsolutePath -notmatch '^/denoland/deno/releases/download/v[0-9.]+/deno-x86_64-pc-windows-msvc\.zip$'
) {
  throw "Sonic's Deno URL is not an approved immutable release asset."
}
if ([IO.Path]::GetFileName($denoArtifactUri.AbsolutePath) -cne [string]$deno.artifact.name) {
  throw "Sonic's Deno artifact name does not match its URL."
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData)) {
  throw "Windows did not provide a local application data folder."
}
$allowedParent = [IO.Path]::GetFullPath((Join-Path $localAppData 'studio.eternia.sonic'))
$installRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$expectedInstallRoot = [IO.Path]::GetFullPath((Join-Path $allowedParent 'media-engine')).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
if ($installRoot -cne $expectedInstallRoot) {
  throw "Refusing to install the media engine outside Sonic's local data folder."
}
Assert-NoReparsePointsBelowRoot -TrustedRoot $localAppData -Path $allowedParent
New-Item -ItemType Directory -Force -Path $allowedParent | Out-Null
Assert-NoReparsePointsBelowRoot -TrustedRoot $localAppData -Path $allowedParent

$mutex = New-Object Threading.Mutex($false, 'Local\studio.eternia.sonic.media-engine')
$hasMutex = $false
try {
  $hasMutex = $mutex.WaitOne([TimeSpan]::FromMinutes(3))
  if (-not $hasMutex) {
    throw "Timed out waiting for another Sonic media engine setup to finish."
  }
  Get-ChildItem -LiteralPath $allowedParent -Force -Directory -Filter '.media-engine-work-*' |
    Where-Object { $_.Name -match '^\.media-engine-work-[a-f0-9]{32}$' } |
    ForEach-Object {
      Remove-SafeDirectory -Path $_.FullName -AllowedParent $allowedParent -RequiredNamePattern '^\.media-engine-work-[a-f0-9]{32}$'
    }

  if ($Remove) {
    if (Test-Path -LiteralPath $installRoot) {
      Remove-SafeDirectory -Path $installRoot -AllowedParent $allowedParent -RequiredNamePattern '^media-engine$'
    }
    Write-Output 'removed'
    exit 0
  }
  if (Test-InstalledEngine -Directory $installRoot -FfmpegDefinition $ffmpeg -DenoDefinition $deno) {
    Write-Output 'ready'
    exit 0
  }

  if (Test-Path -LiteralPath $installRoot) {
    Remove-SafeDirectory -Path $installRoot -AllowedParent $allowedParent -RequiredNamePattern '^media-engine$'
  }

  $workRoot = Join-Path $allowedParent ('.media-engine-work-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $workRoot | Out-Null
  try {
    $ffmpegArchive = Join-Path $workRoot ([string]$ffmpeg.artifact.name)
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $ffmpegArtifactUri.AbsoluteUri -OutFile $ffmpegArchive
    Assert-Sha256 -File $ffmpegArchive -Expected ([string]$ffmpeg.artifact.sha256)
    $denoArchive = Join-Path $workRoot ([string]$deno.artifact.name)
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $denoArtifactUri.AbsoluteUri -OutFile $denoArchive
    Assert-Sha256 -File $denoArchive -Expected ([string]$deno.artifact.sha256)

    $ffmpegExtracted = Join-Path $workRoot 'ffmpeg-extracted'
    $denoExtracted = Join-Path $workRoot 'deno-extracted'
    $payload = Join-Path $workRoot 'payload'
    New-Item -ItemType Directory -Path $ffmpegExtracted | Out-Null
    New-Item -ItemType Directory -Path $denoExtracted | Out-Null
    New-Item -ItemType Directory -Path $payload | Out-Null
    Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtracted -Force
    Expand-Archive -LiteralPath $denoArchive -DestinationPath $denoExtracted -Force

    $ffmpegExe = Get-VerifiedMember -ExtractionRoot $ffmpegExtracted -RelativePath ([string]$ffmpeg.executables.ffmpeg.archivePath) -ExpectedSha256 ([string]$ffmpeg.executables.ffmpeg.sha256)
    $ffprobeExe = Get-VerifiedMember -ExtractionRoot $ffmpegExtracted -RelativePath ([string]$ffmpeg.executables.ffprobe.archivePath) -ExpectedSha256 ([string]$ffmpeg.executables.ffprobe.sha256)
    $license = Get-VerifiedMember -ExtractionRoot $ffmpegExtracted -RelativePath ([string]$ffmpeg.license.archivePath) -ExpectedSha256 ([string]$ffmpeg.license.sha256)
    $denoExe = Get-VerifiedMember -ExtractionRoot $denoExtracted -RelativePath ([string]$deno.executable.archivePath) -ExpectedSha256 ([string]$deno.executable.sha256)

    Copy-Item -LiteralPath $ffmpegExe -Destination (Join-Path $payload 'ffmpeg.exe')
    Copy-Item -LiteralPath $ffprobeExe -Destination (Join-Path $payload 'ffprobe.exe')
    Copy-Item -LiteralPath $denoExe -Destination (Join-Path $payload 'deno.exe')
    Copy-Item -LiteralPath $license -Destination (Join-Path $payload 'FFMPEG-LGPL-3.0.txt')
    [ordered]@{
      version = [string]$ffmpeg.version
      releaseTag = [string]$ffmpeg.releaseTag
      artifactUrl = [string]$ffmpeg.artifact.url
      sourceUrl = [string]$ffmpeg.sourceUrl
      ffmpegSourceUrl = [string]$ffmpeg.ffmpegSourceUrl
      distributionLicense = [string]$ffmpeg.distributionLicense
      archiveSha256 = [string]$ffmpeg.artifact.sha256
      ffmpegSha256 = [string]$ffmpeg.executables.ffmpeg.sha256
      ffprobeSha256 = [string]$ffmpeg.executables.ffprobe.sha256
      denoVersion = [string]$deno.version
      denoArtifactUrl = [string]$deno.artifact.url
      denoSourceUrl = [string]$deno.sourceUrl
      denoDistributionLicense = [string]$deno.distributionLicense
      denoArchiveSha256 = [string]$deno.artifact.sha256
      denoSha256 = [string]$deno.executable.sha256
    } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $payload 'engine.json')

    Move-Item -LiteralPath $payload -Destination $installRoot
    if (-not (Test-InstalledEngine -Directory $installRoot -FfmpegDefinition $ffmpeg -DenoDefinition $deno)) {
      throw "The installed media engine failed its final checksum validation."
    }
  } finally {
    if (Test-Path -LiteralPath $workRoot) {
      Remove-SafeDirectory -Path $workRoot -AllowedParent $allowedParent -RequiredNamePattern '^\.media-engine-work-[a-f0-9]{32}$'
    }
  }
  Write-Output 'installed'
} finally {
  if ($hasMutex) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}

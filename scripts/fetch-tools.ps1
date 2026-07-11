[CmdletBinding()]
param(
  [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$binDirectory = Join-Path $projectRoot "src-tauri\binaries"
$pythonRuntimeDirectory = Join-Path $binDirectory "python-runtime"
$licenseDirectory = Join-Path $projectRoot "licenses"
$cacheDirectory = Join-Path $projectRoot ".cache\sonic-tools"
$manifestPath = Join-Path $PSScriptRoot "tool-manifest.json"
$headers = @{ "User-Agent" = "Sonic-Desktop-Setup" }

function Get-Sha256 {
  param(
    [Parameter(Mandatory = $true)][string]$File
  )

  # Use .NET directly so the bootstrap works in both Windows PowerShell 5.1
  # and pwsh without depending on Get-FileHash behavior.
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($File)
    try {
      return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
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

  $normalizedExpected = $Expected.Trim().ToLowerInvariant()
  if ($normalizedExpected -notmatch '^[a-f0-9]{64}$') {
    throw "Invalid SHA-256 value configured for $File."
  }

  $actual = Get-Sha256 -File $File
  if ($actual -ne $normalizedExpected) {
    throw "Checksum mismatch for $File. Expected $normalizedExpected, received $actual."
  }

  Write-Host "Verified $([IO.Path]::GetFileName($File)) ($actual)"
}

function Assert-ArtifactDefinition {
  param(
    [Parameter(Mandatory = $true)]$Artifact,
    [Parameter(Mandatory = $true)][string]$ToolName
  )

  if (-not $Artifact.name -or -not $Artifact.url -or -not $Artifact.sha256) {
    throw "$ToolName has an incomplete artifact definition in $manifestPath."
  }
  if ([IO.Path]::GetFileName([string]$Artifact.name) -ne [string]$Artifact.name) {
    throw "$ToolName's artifact name must not contain a directory."
  }

  $uri = [Uri]$Artifact.url
  if ($uri.Scheme -ne 'https') {
    throw "$ToolName's artifact URL must use HTTPS."
  }
  if ($uri.Host -eq 'github.com') {
    if ($uri.AbsolutePath -notmatch '/releases/download/' -or $uri.AbsolutePath -match '/releases/(latest|download/latest)/') {
      throw "$ToolName's GitHub artifact URL must identify an immutable versioned release, not latest."
    }
  } elseif ($uri.Host -eq 'www.python.org') {
    if ($uri.AbsolutePath -notmatch '^/ftp/python/[0-9]+\.[0-9]+\.[0-9]+/python-[0-9]+\.[0-9]+\.[0-9]+-embed-amd64\.zip$') {
      throw "$ToolName's python.org artifact URL must identify an exact embeddable Python release."
    }
  } else {
    throw "$ToolName's artifact host is not approved: $($uri.Host)"
  }
  if ([string]$Artifact.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw "$ToolName's artifact SHA-256 must contain exactly 64 hexadecimal characters."
  }
}

function Get-VerifiedArtifact {
  param(
    [Parameter(Mandatory = $true)]$Artifact,
    [Parameter(Mandatory = $true)][string]$ToolName
  )

  Assert-ArtifactDefinition -Artifact $Artifact -ToolName $ToolName
  $destination = Join-Path $cacheDirectory ([string]$Artifact.name)

  if (Test-Path -LiteralPath $destination) {
    try {
      Assert-Sha256 -File $destination -Expected ([string]$Artifact.sha256)
      Write-Host "Using verified cached $($Artifact.name)."
      return $destination
    } catch {
      Write-Warning "Discarding cached $($Artifact.name): $($_.Exception.Message)"
      Remove-Item -Force -LiteralPath $destination
    }
  }

  $partial = "$destination.download"
  if (Test-Path -LiteralPath $partial) {
    Remove-Item -Force -LiteralPath $partial
  }

  Write-Host "Downloading $($Artifact.name) from $($Artifact.url)..."
  try {
    Invoke-WebRequest -Headers $headers -Uri ([string]$Artifact.url) -OutFile $partial
    Assert-Sha256 -File $partial -Expected ([string]$Artifact.sha256)
    Move-Item -Force -LiteralPath $partial -Destination $destination
  } finally {
    if (Test-Path -LiteralPath $partial) {
      Remove-Item -Force -LiteralPath $partial
    }
  }

  return $destination
}

function Reset-GeneratedDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $allowedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $requiredPrefix = $allowedRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset a directory outside Sonic's $Description root: $resolvedPath"
  }

  if (Test-Path -LiteralPath $resolvedPath) {
    Remove-Item -Recurse -Force -LiteralPath $resolvedPath
  }
  New-Item -ItemType Directory -Path $resolvedPath | Out-Null
}

function Reset-CacheSubdirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  Reset-GeneratedDirectory -Path $Path -Root $cacheDirectory -Description 'tool cache'
}

function Get-ArchiveMember {
  param(
    [Parameter(Mandatory = $true)][string]$ExtractionRoot,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  $root = [IO.Path]::GetFullPath($ExtractionRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $candidate = [IO.Path]::GetFullPath((Join-Path $root $RelativePath))
  $requiredPrefix = $root + [IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Archive member escapes its extraction directory: $RelativePath"
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Pinned archive member was not found: $RelativePath"
  }

  Assert-Sha256 -File $candidate -Expected $ExpectedSha256
  return $candidate
}

function New-DevelopmentAlias {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Alias
  )

  if (Test-Path -LiteralPath $Alias) {
    Remove-Item -Force -LiteralPath $Alias
  }
  try {
    New-Item -ItemType HardLink -Path $Alias -Target $Source | Out-Null
  } catch {
    Copy-Item -Force -LiteralPath $Source -Destination $Alias
  }
}

function Assert-ReportedVersion {
  param(
    [Parameter(Mandatory = $true)][string]$ToolName,
    [Parameter(Mandatory = $true)][string]$Reported,
    [Parameter(Mandatory = $true)][string]$ExpectedPattern
  )

  if ($Reported -notmatch $ExpectedPattern) {
    throw "$ToolName reported '$Reported', which does not match the pinned manifest version."
  }
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Pinned tool manifest not found: $manifestPath"
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2) {
  throw "Unsupported tool manifest schema version: $($manifest.schemaVersion)"
}
if ([string]$manifest.targetTriple -ne $TargetTriple) {
  throw "The pinned tool manifest supports $($manifest.targetTriple), but $TargetTriple was requested."
}
if ($TargetTriple -ne "x86_64-pc-windows-msvc") {
  throw "The Sonic bootstrap currently supports Windows x64 only. Received: $TargetTriple"
}

$ytDlp = $manifest.tools.ytDlp
$python = $manifest.tools.python
$ffmpeg = $manifest.tools.ffmpeg
$deno = $manifest.tools.deno
foreach ($tool in @(
  @{ Name = 'yt-dlp'; Definition = $ytDlp },
  @{ Name = 'Python'; Definition = $python },
  @{ Name = 'FFmpeg'; Definition = $ffmpeg },
  @{ Name = 'Deno'; Definition = $deno }
)) {
  if (
    -not $tool.Definition -or
    -not $tool.Definition.version -or
    -not $tool.Definition.releaseTag -or
    -not $tool.Definition.sourceUrl -or
    -not $tool.Definition.distributionLicense -or
    $tool.Definition.delivery -notin @('bundled', 'runtime-download')
  ) {
    throw "$($tool.Name) has an incomplete definition in $manifestPath."
  }
}

New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $licenseDirectory | Out-Null

# yt-dlp's zipimport build avoids the GPL-covered PyInstaller executable. It is
# launched by Sonic through the isolated official CPython embeddable runtime.
$ytDlpArtifact = Get-VerifiedArtifact -Artifact $ytDlp.artifact -ToolName 'yt-dlp'

$pythonArchive = Get-VerifiedArtifact -Artifact $python.artifact -ToolName 'Python'
$pythonExtracted = Join-Path $cacheDirectory "python-$($python.releaseTag)"
Reset-CacheSubdirectory -Path $pythonExtracted
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonExtracted -Force
$pythonExe = Get-ArchiveMember -ExtractionRoot $pythonExtracted -RelativePath ([string]$python.executable.archivePath) -ExpectedSha256 ([string]$python.executable.sha256)
$pythonLicense = Get-ArchiveMember -ExtractionRoot $pythonExtracted -RelativePath ([string]$python.license.archivePath) -ExpectedSha256 ([string]$python.license.sha256)

Reset-GeneratedDirectory -Path $pythonRuntimeDirectory -Root $binDirectory -Description 'generated binaries'
Get-ChildItem -LiteralPath $pythonExtracted -File | ForEach-Object {
  Copy-Item -Force -LiteralPath $_.FullName -Destination (Join-Path $pythonRuntimeDirectory $_.Name)
}
$pythonTarget = Join-Path $pythonRuntimeDirectory "python-$TargetTriple.exe"
Copy-Item -Force -LiteralPath $pythonExe -Destination $pythonTarget
Assert-Sha256 -File $pythonTarget -Expected ([string]$python.executable.sha256)
$ytDlpTarget = Join-Path $pythonRuntimeDirectory "yt-dlp"
Copy-Item -Force -LiteralPath $ytDlpArtifact -Destination $ytDlpTarget
Assert-Sha256 -File $ytDlpTarget -Expected ([string]$ytDlp.artifact.sha256)
Copy-Item -Force -LiteralPath $pythonLicense -Destination (Join-Path $licenseDirectory "PYTHON-$($python.version).txt")

# FFmpeg and ffprobe are extracted from one immutable, dated upstream build.
$ffmpegArchive = Get-VerifiedArtifact -Artifact $ffmpeg.artifact -ToolName 'FFmpeg'
$ffmpegExtracted = Join-Path $cacheDirectory "ffmpeg-$($ffmpeg.releaseTag)"
Reset-CacheSubdirectory -Path $ffmpegExtracted
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtracted -Force
$ffmpegExe = Get-ArchiveMember -ExtractionRoot $ffmpegExtracted -RelativePath ([string]$ffmpeg.executables.ffmpeg.archivePath) -ExpectedSha256 ([string]$ffmpeg.executables.ffmpeg.sha256)
$ffprobeExe = Get-ArchiveMember -ExtractionRoot $ffmpegExtracted -RelativePath ([string]$ffmpeg.executables.ffprobe.archivePath) -ExpectedSha256 ([string]$ffmpeg.executables.ffprobe.sha256)
$ffmpegLicense = Get-ArchiveMember -ExtractionRoot $ffmpegExtracted -RelativePath ([string]$ffmpeg.license.archivePath) -ExpectedSha256 ([string]$ffmpeg.license.sha256)
$ffmpegTarget = Join-Path $binDirectory "ffmpeg-$TargetTriple.exe"
$ffprobeTarget = Join-Path $binDirectory "ffprobe-$TargetTriple.exe"
Copy-Item -Force -LiteralPath $ffmpegExe -Destination $ffmpegTarget
Copy-Item -Force -LiteralPath $ffprobeExe -Destination $ffprobeTarget
Assert-Sha256 -File $ffmpegTarget -Expected ([string]$ffmpeg.executables.ffmpeg.sha256)
Assert-Sha256 -File $ffprobeTarget -Expected ([string]$ffmpeg.executables.ffprobe.sha256)
Copy-Item -Force -LiteralPath $ffmpegLicense -Destination (Join-Path $licenseDirectory "FFMPEG-LGPL-3.0.txt")

# Deno is distributed as a versioned ZIP with a single executable.
$denoArchive = Get-VerifiedArtifact -Artifact $deno.artifact -ToolName 'Deno'
$denoExtracted = Join-Path $cacheDirectory "deno-$($deno.releaseTag)"
Reset-CacheSubdirectory -Path $denoExtracted
Expand-Archive -LiteralPath $denoArchive -DestinationPath $denoExtracted -Force
$denoExe = Get-ArchiveMember -ExtractionRoot $denoExtracted -RelativePath ([string]$deno.executable.archivePath) -ExpectedSha256 ([string]$deno.executable.sha256)
$denoTarget = Join-Path $binDirectory "deno-$TargetTriple.exe"
Copy-Item -Force -LiteralPath $denoExe -Destination $denoTarget
Assert-Sha256 -File $denoTarget -Expected ([string]$deno.executable.sha256)

# Tauri resolves target-suffixed sidecars itself. These aliases allow the
# Python-hosted yt-dlp process to find its verified child tools in development.
New-DevelopmentAlias $pythonTarget (Join-Path $pythonRuntimeDirectory "python.exe")
New-DevelopmentAlias $ffmpegTarget (Join-Path $binDirectory "ffmpeg.exe")
New-DevelopmentAlias $ffprobeTarget (Join-Path $binDirectory "ffprobe.exe")
New-DevelopmentAlias $denoTarget (Join-Path $binDirectory "deno.exe")

$pythonReported = [string](& $pythonTarget --version | Select-Object -First 1)
$ytDlpReported = [string](& $pythonTarget -I $ytDlpTarget --version | Select-Object -First 1)
$ffmpegReported = [string](& $ffmpegTarget -version | Select-Object -First 1)
$ffprobeReported = [string](& $ffprobeTarget -version | Select-Object -First 1)
$denoReported = [string](& $denoTarget --version | Select-Object -First 1)

Assert-ReportedVersion -ToolName 'yt-dlp' -Reported $ytDlpReported -ExpectedPattern ("^" + [Regex]::Escape([string]$ytDlp.version) + "$")
Assert-ReportedVersion -ToolName 'Python' -Reported $pythonReported -ExpectedPattern ("^Python " + [Regex]::Escape([string]$python.version) + "(?:\s|$)")
Assert-ReportedVersion -ToolName 'FFmpeg' -Reported $ffmpegReported -ExpectedPattern ("^ffmpeg version " + [Regex]::Escape([string]$ffmpeg.version) + "(?:\s|$)")
Assert-ReportedVersion -ToolName 'ffprobe' -Reported $ffprobeReported -ExpectedPattern ("^ffprobe version " + [Regex]::Escape([string]$ffmpeg.version) + "(?:\s|$)")
Assert-ReportedVersion -ToolName 'Deno' -Reported $denoReported -ExpectedPattern ("^deno " + [Regex]::Escape([string]$deno.version) + "(?:\s|$)")

$versions = [ordered]@{
  schemaVersion = 1
  target = $TargetTriple
  manifest = "scripts/tool-manifest.json"
  ytDlp = [ordered]@{
    version = [string]$ytDlp.version
    releaseTag = [string]$ytDlp.releaseTag
    sourceUrl = [string]$ytDlp.sourceUrl
    distributionLicense = [string]$ytDlp.distributionLicense
    delivery = [string]$ytDlp.delivery
    reported = $ytDlpReported
    sha256 = [string]$ytDlp.artifact.sha256
  }
  python = [ordered]@{
    version = [string]$python.version
    releaseTag = [string]$python.releaseTag
    sourceUrl = [string]$python.sourceUrl
    distributionLicense = [string]$python.distributionLicense
    delivery = [string]$python.delivery
    reported = $pythonReported
    sha256 = [string]$python.executable.sha256
  }
  ffmpeg = [ordered]@{
    version = [string]$ffmpeg.version
    releaseTag = [string]$ffmpeg.releaseTag
    sourceUrl = [string]$ffmpeg.sourceUrl
    distributionLicense = [string]$ffmpeg.distributionLicense
    delivery = [string]$ffmpeg.delivery
    reported = $ffmpegReported
    sha256 = [string]$ffmpeg.executables.ffmpeg.sha256
  }
  ffprobe = [ordered]@{
    version = [string]$ffmpeg.version
    releaseTag = [string]$ffmpeg.releaseTag
    sourceUrl = [string]$ffmpeg.sourceUrl
    distributionLicense = [string]$ffmpeg.distributionLicense
    delivery = [string]$ffmpeg.delivery
    reported = $ffprobeReported
    sha256 = [string]$ffmpeg.executables.ffprobe.sha256
  }
  deno = [ordered]@{
    version = [string]$deno.version
    releaseTag = [string]$deno.releaseTag
    sourceUrl = [string]$deno.sourceUrl
    distributionLicense = [string]$deno.distributionLicense
    delivery = [string]$deno.delivery
    reported = $denoReported
    sha256 = [string]$deno.executable.sha256
  }
}
$versions | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $binDirectory "versions.json")

Write-Host "Sonic's pinned local media tools are ready in $binDirectory"

[CmdletBinding()]
param(
  [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$binDirectory = Join-Path $projectRoot "src-tauri\binaries"
$cacheDirectory = Join-Path $projectRoot ".cache\sonic-tools"
$headers = @{ "User-Agent" = "Sonic-Desktop-Setup" }

New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null

function Get-ReleaseAsset {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Write-Host "Downloading $([IO.Path]::GetFileName($Destination))..."
  Invoke-WebRequest -Headers $headers -Uri $Url -OutFile $Destination
}

function Assert-Sha256 {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  # Use the .NET implementation directly instead of Get-FileHash so the
  # bootstrap stays portable across Windows PowerShell and pwsh runners.
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($File)
    try {
      $actual = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
  $normalizedExpected = $Expected.Trim().ToLowerInvariant()
  if ($actual -ne $normalizedExpected) {
    throw "Checksum mismatch for $File. Expected $normalizedExpected, received $actual."
  }
  Write-Host "Verified $([IO.Path]::GetFileName($File)) ($actual)"
}

function Get-ChecksumFromManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Manifest,
    [Parameter(Mandatory = $true)][string]$AssetName
  )

  $escapedName = [Regex]::Escape($AssetName)
  $line = Get-Content -LiteralPath $Manifest | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+\*?$escapedName$" } | Select-Object -First 1
  if (-not $line) {
    throw "Could not find a checksum for $AssetName in $Manifest."
  }
  return ($line -split "\s+")[0]
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

if ($TargetTriple -ne "x86_64-pc-windows-msvc") {
  throw "The private Sonic bootstrap currently supports Windows x64 only. Received: $TargetTriple"
}

$ytDlpAsset = "yt-dlp.exe"
$ytDlpPath = Join-Path $cacheDirectory $ytDlpAsset
$ytDlpManifest = Join-Path $cacheDirectory "yt-dlp-SHA2-256SUMS"
Get-ReleaseAsset "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$ytDlpAsset" $ytDlpPath
Get-ReleaseAsset "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" $ytDlpManifest
Assert-Sha256 $ytDlpPath (Get-ChecksumFromManifest $ytDlpManifest $ytDlpAsset)
$ytDlpTarget = Join-Path $binDirectory "yt-dlp-$TargetTriple.exe"
Copy-Item -Force -LiteralPath $ytDlpPath -Destination $ytDlpTarget

$ffmpegAsset = "ffmpeg-master-latest-win64-gpl.zip"
$ffmpegArchive = Join-Path $cacheDirectory $ffmpegAsset
$ffmpegManifest = Join-Path $cacheDirectory "ffmpeg-checksums.sha256"
$ffmpegExtracted = Join-Path $cacheDirectory "ffmpeg"
Get-ReleaseAsset "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/$ffmpegAsset" $ffmpegArchive
Get-ReleaseAsset "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256" $ffmpegManifest
Assert-Sha256 $ffmpegArchive (Get-ChecksumFromManifest $ffmpegManifest $ffmpegAsset)
if (Test-Path $ffmpegExtracted) { Remove-Item -Recurse -Force -LiteralPath $ffmpegExtracted }
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtracted -Force
$ffmpegExe = Get-ChildItem -Recurse -File -LiteralPath $ffmpegExtracted -Filter "ffmpeg.exe" | Select-Object -First 1
$ffprobeExe = Get-ChildItem -Recurse -File -LiteralPath $ffmpegExtracted -Filter "ffprobe.exe" | Select-Object -First 1
if (-not $ffmpegExe -or -not $ffprobeExe) { throw "FFmpeg archive did not contain ffmpeg.exe and ffprobe.exe." }
$ffmpegTarget = Join-Path $binDirectory "ffmpeg-$TargetTriple.exe"
$ffprobeTarget = Join-Path $binDirectory "ffprobe-$TargetTriple.exe"
Copy-Item -Force -LiteralPath $ffmpegExe.FullName -Destination $ffmpegTarget
Copy-Item -Force -LiteralPath $ffprobeExe.FullName -Destination $ffprobeTarget

$denoRelease = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/denoland/deno/releases/latest"
$denoAsset = "deno-x86_64-pc-windows-msvc.zip"
$denoArchive = Join-Path $cacheDirectory $denoAsset
$denoChecksumFile = Join-Path $cacheDirectory "$denoAsset.sha256sum"
$denoExtracted = Join-Path $cacheDirectory "deno"
Get-ReleaseAsset "https://github.com/denoland/deno/releases/download/$($denoRelease.tag_name)/$denoAsset" $denoArchive
Get-ReleaseAsset "https://github.com/denoland/deno/releases/download/$($denoRelease.tag_name)/$denoAsset.sha256sum" $denoChecksumFile
$denoChecksumText = Get-Content -Raw -LiteralPath $denoChecksumFile
if ($denoChecksumText -match "(?im)^Hash\s*:\s*([a-fA-F0-9]{64})") {
  $denoExpected = $Matches[1]
} elseif ($denoChecksumText -match "(?im)^([a-fA-F0-9]{64})(?:\s|$)") {
  $denoExpected = $Matches[1]
} else {
  throw "Could not parse Deno's published SHA-256 checksum."
}
Assert-Sha256 $denoArchive $denoExpected
if (Test-Path $denoExtracted) { Remove-Item -Recurse -Force -LiteralPath $denoExtracted }
Expand-Archive -LiteralPath $denoArchive -DestinationPath $denoExtracted -Force
$denoExe = Get-ChildItem -Recurse -File -LiteralPath $denoExtracted -Filter "deno.exe" | Select-Object -First 1
if (-not $denoExe) { throw "Deno archive did not contain deno.exe." }
$denoTarget = Join-Path $binDirectory "deno-$TargetTriple.exe"
Copy-Item -Force -LiteralPath $denoExe.FullName -Destination $denoTarget

# Tauri resolves target-suffixed sidecars itself. These aliases allow yt-dlp,
# which launches FFmpeg and Deno as child tools, to find them during `tauri dev`.
New-DevelopmentAlias $ytDlpTarget (Join-Path $binDirectory "yt-dlp.exe")
New-DevelopmentAlias $ffmpegTarget (Join-Path $binDirectory "ffmpeg.exe")
New-DevelopmentAlias $ffprobeTarget (Join-Path $binDirectory "ffprobe.exe")
New-DevelopmentAlias $denoTarget (Join-Path $binDirectory "deno.exe")

$versions = [ordered]@{
  fetchedAt = (Get-Date).ToUniversalTime().ToString("o")
  target = $TargetTriple
  ytDlp = (& $ytDlpPath --version | Select-Object -First 1)
  ffmpeg = (& $ffmpegExe.FullName -version | Select-Object -First 1)
  deno = $denoRelease.tag_name
}
$versions | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $binDirectory "versions.json")

Write-Host "Sonic's local media tools are ready in $binDirectory"

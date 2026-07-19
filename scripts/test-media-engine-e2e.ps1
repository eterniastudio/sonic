[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()][string]$Url = 'https://www.youtube.com/watch?v=53AhGVjmO94',
  [ValidateRange(30, 600)][int]$TimeoutSeconds = 300,
  [ValidateRange(1048576, 536870912)][long]$MaxDownloadBytes = 100663296,
  [ValidateRange(1, 30)][int]$SampleSeconds = 8
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$nasaVideoId = '53AhGVjmO94'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifestPath = Join-Path $PSScriptRoot 'tool-manifest.json'
$binaryRoot = Join-Path $projectRoot 'src-tauri\binaries'
$pythonRoot = Join-Path $binaryRoot 'python-runtime'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
  [IO.Path]::DirectorySeparatorChar,
  [IO.Path]::AltDirectorySeparatorChar
)
$workspaceName = 'sonic-media-e2e-' + [Guid]::NewGuid().ToString('N')
$workspace = Join-Path $tempRoot $workspaceName
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)

function ConvertTo-WindowsCommandLineArgument {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
  )

  if ($Value.IndexOf([char]0) -ge 0) {
    throw 'A process argument contains a null character.'
  }
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  # Follow CommandLineToArgvW escaping when Windows PowerShell 5.1 does not
  # expose ProcessStartInfo.ArgumentList. No command shell is involved.
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Get-RemainingSeconds {
  param(
    [ValidateRange(1, 600)][int]$MaximumSeconds = 600
  )

  $remaining = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
  if ($remaining -lt 1) {
    throw "The media-engine E2E deadline of $TimeoutSeconds seconds expired."
  }
  return [Math]::Min([int]$remaining, $MaximumSeconds)
}

function Stop-DirectProcessTree {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process
  )

  if ($Process.HasExited) {
    return
  }

  # taskkill is invoked directly, never through cmd.exe or PowerShell string
  # evaluation. /T prevents a timed-out Deno/FFmpeg child surviving yt-dlp.
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  if (Test-Path -LiteralPath $taskkill -PathType Leaf) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $taskkill
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $arguments = @('/PID', $Process.Id.ToString(), '/T', '/F')
    $argumentListProperty = $startInfo.PSObject.Properties['ArgumentList']
    if ($null -ne $argumentListProperty) {
      foreach ($argument in $arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
      }
    } else {
      $startInfo.Arguments = (($arguments | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument -Value $_
      }) -join ' ')
    }
    $killer = New-Object System.Diagnostics.Process
    $killer.StartInfo = $startInfo
    try {
      if ($killer.Start()) {
        [void]$killer.WaitForExit(10000)
      }
    } finally {
      $killer.Dispose()
    }
  }

  if (-not $Process.HasExited) {
    try {
      $Process.Kill()
      [void]$Process.WaitForExit(10000)
    } catch {
      Write-Warning "Could not fully terminate timed-out process $($Process.Id): $($_.Exception.Message)"
    }
  }
}

function Invoke-DirectProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$PathValue,
    [ValidateRange(1, 600)][int]$MaximumSeconds = 600,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  # Match Sonic's production process isolation: clear the inherited environment,
  # then restore only OS/temp/proxy values and a deliberately narrow PATH.
  $startInfo.EnvironmentVariables.Clear()
  foreach ($variable in @(
    'SystemRoot',
    'TEMP',
    'TMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY'
  )) {
    $value = [Environment]::GetEnvironmentVariable($variable)
    if ($null -ne $value) {
      $startInfo.EnvironmentVariables[$variable] = $value
    }
  }
  $startInfo.EnvironmentVariables['PATH'] = $PathValue

  $argumentListProperty = $startInfo.PSObject.Properties['ArgumentList']
  if ($null -ne $argumentListProperty) {
    foreach ($argument in $Arguments) {
      [void]$startInfo.ArgumentList.Add($argument)
    }
  } else {
    $startInfo.Arguments = (($Arguments | ForEach-Object {
      ConvertTo-WindowsCommandLineArgument -Value $_
    }) -join ' ')
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $started = $false
  try {
    if (-not $process.Start()) {
      throw "Could not start $Description."
    }
    $started = $true
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $waitSeconds = Get-RemainingSeconds -MaximumSeconds $MaximumSeconds
    if (-not $process.WaitForExit($waitSeconds * 1000)) {
      Stop-DirectProcessTree -Process $process
      throw "$Description timed out after $waitSeconds seconds."
    }

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout.Length -gt 4194304 -or $stderr.Length -gt 4194304) {
      throw "$Description produced an unexpectedly large diagnostic stream."
    }
    if ($process.ExitCode -ne 0) {
      $diagnostic = (($stderr + "`n" + $stdout).Trim() -split "`r?`n" | Select-Object -Last 12) -join "`n"
      if ($diagnostic.Length -gt 3000) {
        $diagnostic = $diagnostic.Substring($diagnostic.Length - 3000)
      }
      throw "$Description exited with code $($process.ExitCode).`n$diagnostic"
    }

    return [pscustomobject]@{
      Stdout = [string]$stdout
      Stderr = [string]$stderr
      ExitCode = [int]$process.ExitCode
    }
  } finally {
    if ($started -and -not $process.HasExited) {
      Stop-DirectProcessTree -Process $process
    }
    $process.Dispose()
  }
}

function Get-Sha256 {
  param(
    [Parameter(Mandatory = $true)][string]$File
  )

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

function Assert-NoReparsePointsInPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $root = [IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($root) -or -not [IO.Path]::IsPathRooted($fullPath)) {
    throw "The $Description path is not an absolute filesystem path."
  }

  $current = $root
  $relative = $fullPath.Substring($root.Length)
  foreach ($segment in $relative.Split(
    @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
    [StringSplitOptions]::RemoveEmptyEntries
  )) {
    $current = Join-Path $current $segment
    if (-not (Test-Path -LiteralPath $current)) {
      throw "The $Description path does not exist: $current"
    }
    $item = Get-Item -Force -LiteralPath $current
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to use a $Description path containing a reparse point: $current"
    }
  }

  $leaf = Get-Item -Force -LiteralPath $fullPath
  if (-not $leaf.PSIsContainer) {
    throw "The $Description path is not a directory: $fullPath"
  }
  return $fullPath
}

function Assert-PinnedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $expected = $ExpectedSha256.Trim().ToLowerInvariant()
  if ($expected -notmatch '^[a-f0-9]{64}$') {
    throw "The pinned manifest contains an invalid hash for $Description."
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The local pinned $Description is missing. Run scripts/fetch-tools.ps1 first."
  }
  $item = Get-Item -Force -LiteralPath $Path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0) {
    throw "The local pinned $Description is not a safe regular file."
  }
  $actual = Get-Sha256 -File $item.FullName
  if ($actual -cne $expected) {
    throw "The local pinned $Description failed SHA-256 verification."
  }
  return $item.FullName
}

function Remove-PathWithoutFollowingReparsePoints {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

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

function Remove-SafeTempWorkspace {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AllowedParent
  )

  $parent = [IO.Path]::GetFullPath($AllowedParent).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $candidate = [IO.Path]::GetFullPath($Path).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  if ([IO.Path]::GetDirectoryName($candidate) -cne $parent) {
    throw "Refusing to remove an E2E workspace outside the exact Temp parent."
  }
  if ([IO.Path]::GetFileName($candidate) -cnotmatch '^sonic-media-e2e-[a-f0-9]{32}$') {
    throw "Refusing to remove a directory without Sonic's random E2E workspace name."
  }
  [void](Assert-NoReparsePointsInPath -Path $parent -Description 'Temp root')
  if (Test-Path -LiteralPath $candidate) {
    Remove-PathWithoutFollowingReparsePoints -Path $candidate
  }
}

function Get-YouTubeVideoId {
  param(
    [Parameter(Mandatory = $true)][string]$InputUrl
  )

  $trimmed = $InputUrl.Trim()
  if ($trimmed.Length -eq 0 -or $trimmed.Length -gt 2048) {
    throw 'Enter a direct HTTPS YouTube video URL.'
  }
  $uri = $null
  if (-not [Uri]::TryCreate($trimmed, [UriKind]::Absolute, [ref]$uri)) {
    throw 'Enter a direct HTTPS YouTube video URL.'
  }
  if ($uri.Scheme -cne 'https' -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
    throw 'Only secure YouTube video URLs without credentials are supported.'
  }

  $urlHost = $uri.DnsSafeHost.ToLowerInvariant()
  $segments = @($uri.AbsolutePath.Split('/') | Where-Object { $_.Length -gt 0 })
  $videoId = $null
  if ($urlHost -in @('youtu.be', 'www.youtu.be')) {
    if ($segments.Count -ge 1) {
      $videoId = $segments[0]
    }
  } elseif ($urlHost -in @('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com')) {
    if ($segments.Count -ge 1 -and $segments[0] -ceq 'watch') {
      foreach ($pair in $uri.Query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
        $parts = $pair.Split('=', 2)
        if ([Uri]::UnescapeDataString($parts[0]) -ceq 'v' -and $parts.Count -eq 2) {
          $videoId = [Uri]::UnescapeDataString($parts[1])
          break
        }
      }
    } elseif ($segments.Count -ge 2 -and $segments[0] -in @('shorts', 'live', 'embed')) {
      $videoId = $segments[1]
    }
  } elseif ($urlHost -in @('youtube-nocookie.com', 'www.youtube-nocookie.com')) {
    if ($segments.Count -ge 2 -and $segments[0] -ceq 'embed') {
      $videoId = $segments[1]
    }
  }

  if (
    [string]::IsNullOrWhiteSpace($videoId) -or
    $videoId.Length -lt 6 -or
    $videoId.Length -gt 64 -or
    $videoId -cnotmatch '^[A-Za-z0-9_-]+$'
  ) {
    throw 'Enter a direct YouTube video, Short, or live-video URL.'
  }
  return [string]$videoId
}

function Get-FirstOutputLine {
  param(
    [Parameter(Mandatory = $true)]$Result
  )

  return (($Result.Stdout + "`n" + $Result.Stderr).Trim() -split "`r?`n" | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
  } | Select-Object -First 1)
}

function Assert-RegularWorkspaceFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedParent,
    [Parameter(Mandatory = $true)][long]$MaximumBytes,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $fullPath = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  if ([IO.Path]::GetDirectoryName($fullPath) -cne $parent) {
    throw "The $Description escaped Sonic's isolated E2E workspace."
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "The $Description was not created."
  }
  $item = Get-Item -Force -LiteralPath $fullPath
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The $Description is a reparse point."
  }
  if ($item.Length -le 0 -or $item.Length -gt $MaximumBytes) {
    throw "The $Description size is outside the allowed 1..$MaximumBytes byte range."
  }
  return $item
}

if ($env:OS -cne 'Windows_NT') {
  throw 'Sonic media-engine E2E currently supports Windows only.'
}

$videoId = Get-YouTubeVideoId -InputUrl $Url
if (-not $PSBoundParameters.ContainsKey('Url') -and $videoId -cne $nasaVideoId) {
  throw 'The default live source must remain the authorized NASA SVS video.'
}

[void](Assert-NoReparsePointsInPath -Path $projectRoot -Description 'repository workspace')
[void](Assert-NoReparsePointsInPath -Path $tempRoot -Description 'Temp root')
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Pinned tool manifest not found: $manifestPath"
}
$manifestItem = Get-Item -Force -LiteralPath $manifestPath
if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to read a reparse-point tool manifest.'
}
$manifest = Get-Content -Raw -LiteralPath $manifestItem.FullName | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2 -or [string]$manifest.targetTriple -cne 'x86_64-pc-windows-msvc') {
  throw 'The media-engine E2E requires Sonic tool-manifest schema 2 for Windows x64.'
}

$python = Assert-PinnedFile `
  -Path (Join-Path $pythonRoot 'python-x86_64-pc-windows-msvc.exe') `
  -ExpectedSha256 ([string]$manifest.tools.python.executable.sha256) `
  -Description 'Python runtime'
$ytDlp = Assert-PinnedFile `
  -Path (Join-Path $pythonRoot 'yt-dlp') `
  -ExpectedSha256 ([string]$manifest.tools.ytDlp.artifact.sha256) `
  -Description 'yt-dlp package'
$deno = Assert-PinnedFile `
  -Path (Join-Path $binaryRoot 'deno-x86_64-pc-windows-msvc.exe') `
  -ExpectedSha256 ([string]$manifest.tools.deno.executable.sha256) `
  -Description 'Deno runtime'
$ffmpeg = Assert-PinnedFile `
  -Path (Join-Path $binaryRoot 'ffmpeg-x86_64-pc-windows-msvc.exe') `
  -ExpectedSha256 ([string]$manifest.tools.ffmpeg.executables.ffmpeg.sha256) `
  -Description 'FFmpeg executable'
$ffprobe = Assert-PinnedFile `
  -Path (Join-Path $binaryRoot 'ffprobe-x86_64-pc-windows-msvc.exe') `
  -ExpectedSha256 ([string]$manifest.tools.ffmpeg.executables.ffprobe.sha256) `
  -Description 'ffprobe executable'

$systemPath = Join-Path $env:SystemRoot 'System32'
$mediaPath = Split-Path -Parent $ffmpeg
$sourceFile = $null
$transcodedFile = Join-Path $workspace 'sonic-e2e.mp3'
$expectedTags = [ordered]@{
  TITLE = 'Sonic Media Engine E2E'
  ARTIST = 'Eternia Studios'
  TBPM = '128'
  TKEY = 'F# minor'
}

try {
  New-Item -ItemType Directory -Path $workspace -ErrorAction Stop | Out-Null
  $safeWorkspace = Assert-NoReparsePointsInPath -Path $workspace -Description 'random E2E workspace'
  if (
    [IO.Path]::GetDirectoryName($safeWorkspace) -cne $tempRoot -or
    [IO.Path]::GetFileName($safeWorkspace) -cne $workspaceName
  ) {
    throw "The random E2E workspace is not an exact child of Windows Temp."
  }

  $pythonVersion = Get-FirstOutputLine -Result (Invoke-DirectProcess `
    -FilePath $python `
    -Arguments @('--version') `
    -WorkingDirectory $safeWorkspace `
    -PathValue $systemPath `
    -MaximumSeconds 15 `
    -Description 'Python version probe')
  $ytDlpVersion = Get-FirstOutputLine -Result (Invoke-DirectProcess `
    -FilePath $python `
    -Arguments @('-I', $ytDlp, '--version') `
    -WorkingDirectory $safeWorkspace `
    -PathValue $systemPath `
    -MaximumSeconds 20 `
    -Description 'yt-dlp version probe')
  $denoVersion = Get-FirstOutputLine -Result (Invoke-DirectProcess `
    -FilePath $deno `
    -Arguments @('--version') `
    -WorkingDirectory $safeWorkspace `
    -PathValue $mediaPath `
    -MaximumSeconds 15 `
    -Description 'Deno version probe')
  $ffmpegVersion = Get-FirstOutputLine -Result (Invoke-DirectProcess `
    -FilePath $ffmpeg `
    -Arguments @('-version') `
    -WorkingDirectory $safeWorkspace `
    -PathValue $mediaPath `
    -MaximumSeconds 15 `
    -Description 'FFmpeg version probe')
  $ffprobeVersion = Get-FirstOutputLine -Result (Invoke-DirectProcess `
    -FilePath $ffprobe `
    -Arguments @('-version') `
    -WorkingDirectory $safeWorkspace `
    -PathValue $mediaPath `
    -MaximumSeconds 15 `
    -Description 'ffprobe version probe')

  if ($pythonVersion -cnotmatch ('^Python ' + [regex]::Escape([string]$manifest.tools.python.version) + '(?:\s|$)')) {
    throw "Pinned Python reported an unexpected version: $pythonVersion"
  }
  if ($ytDlpVersion -cne [string]$manifest.tools.ytDlp.version) {
    throw "Pinned yt-dlp reported an unexpected version: $ytDlpVersion"
  }
  if ($denoVersion -cnotmatch ('^deno ' + [regex]::Escape([string]$manifest.tools.deno.version) + '(?:\s|$)')) {
    throw "Pinned Deno reported an unexpected version: $denoVersion"
  }
  if ($ffmpegVersion -cnotmatch ('^ffmpeg version ' + [regex]::Escape([string]$manifest.tools.ffmpeg.version) + '(?:\s|$)')) {
    throw "Pinned FFmpeg reported an unexpected version: $ffmpegVersion"
  }
  if ($ffprobeVersion -cnotmatch ('^ffprobe version ' + [regex]::Escape([string]$manifest.tools.ffmpeg.version) + '(?:\s|$)')) {
    throw "Pinned ffprobe reported an unexpected version: $ffprobeVersion"
  }

  # Keep this argument list synchronized with acquire_youtube in jobs.rs. The
  # only E2E-specific difference is the deliberately lower --max-filesize cap.
  $downloadArguments = @(
    '-I',
    $ytDlp,
    '--ignore-config',
    '--no-playlist',
    '--no-update',
    '--no-plugin-dirs',
    '--no-remote-components',
    '--js-runtimes',
    ('deno:' + $deno),
    '--match-filter',
    '!is_live',
    '--socket-timeout',
    '20',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    '--file-access-retries',
    '3',
    '--concurrent-fragments',
    '4',
    '--newline',
    '--no-colors',
    '--progress',
    '--progress-template',
    'download:SONIC_PROGRESS:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress._percent_str)s',
    '--print',
    'after_move:SONIC_OUTPUT:%(filepath)s',
    '--windows-filenames',
    '--no-overwrites',
    '--max-filesize',
    $MaxDownloadBytes.ToString([Globalization.CultureInfo]::InvariantCulture),
    '--paths',
    $safeWorkspace,
    '--output',
    'source.%(ext)s',
    '--format',
    'bestaudio/best',
    '--ffmpeg-location',
    $mediaPath,
    '--',
    $Url.Trim()
  )
  $download = Invoke-DirectProcess `
    -FilePath $python `
    -Arguments $downloadArguments `
    -WorkingDirectory $safeWorkspace `
    -PathValue $systemPath `
    -MaximumSeconds 240 `
    -Description 'isolated yt-dlp acquisition'

  $downloadLines = @(($download.Stdout + "`n" + $download.Stderr) -split "`r?`n" | ForEach-Object {
    $_.Trim()
  } | Where-Object { $_.Length -gt 0 })
  $progressRecords = @($downloadLines | Where-Object { $_.StartsWith('SONIC_PROGRESS:', [StringComparison]::Ordinal) })
  $outputRecords = @($downloadLines | Where-Object { $_.StartsWith('SONIC_OUTPUT:', [StringComparison]::Ordinal) })
  if ($progressRecords.Count -lt 1) {
    throw 'yt-dlp completed without a SONIC_PROGRESS record.'
  }
  foreach ($record in $progressRecords) {
    if ($record.Substring('SONIC_PROGRESS:'.Length).Split('|').Count -ne 6) {
      throw "yt-dlp emitted a malformed SONIC_PROGRESS record: $record"
    }
  }
  if ($outputRecords.Count -ne 1) {
    throw "yt-dlp must emit exactly one SONIC_OUTPUT record; received $($outputRecords.Count)."
  }
  $reportedOutput = $outputRecords[0].Substring('SONIC_OUTPUT:'.Length).Trim()
  if ([string]::IsNullOrWhiteSpace($reportedOutput)) {
    throw 'yt-dlp emitted an empty SONIC_OUTPUT path.'
  }
  $sourceFile = Assert-RegularWorkspaceFile `
    -Path $reportedOutput `
    -ExpectedParent $safeWorkspace `
    -MaximumBytes $MaxDownloadBytes `
    -Description 'acquired source audio'
  if ($sourceFile.BaseName -cne 'source') {
    throw "yt-dlp reported an unexpected output name: $($sourceFile.Name)"
  }

  $workspaceFiles = @(Get-ChildItem -Force -LiteralPath $safeWorkspace)
  foreach ($file in $workspaceFiles) {
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "A media process created an unsafe reparse point in the E2E workspace."
    }
  }
  $workspaceBytes = ($workspaceFiles | Where-Object { -not $_.PSIsContainer } | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $workspaceBytes) {
    $workspaceBytes = 0
  }
  if ([long]$workspaceBytes -gt $MaxDownloadBytes) {
    throw "The isolated acquisition workspace exceeded the configured size bound."
  }

  # This is Sonic's MP3 V0 export contract plus -t for a bounded live E2E sample.
  $transcodeArguments = @(
    '-nostdin',
    '-hide_banner',
    '-y',
    '-i',
    $sourceFile.FullName,
    '-t',
    $SampleSeconds.ToString([Globalization.CultureInfo]::InvariantCulture),
    '-map',
    '0:a:0',
    '-vn',
    '-map_metadata',
    '-1',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '0',
    '-metadata',
    ('title=' + $expectedTags.TITLE),
    '-metadata',
    ('artist=' + $expectedTags.ARTIST),
    '-metadata',
    'BPM=128',
    '-metadata',
    ('TBPM=' + $expectedTags.TBPM),
    '-metadata',
    'tempo=128',
    '-metadata',
    ('INITIALKEY=' + $expectedTags.TKEY),
    '-metadata',
    ('TKEY=' + $expectedTags.TKEY),
    '-metadata',
    ('key=' + $expectedTags.TKEY),
    '-id3v2_version',
    '3',
    '-progress',
    'pipe:1',
    '-nostats',
    $transcodedFile
  )
  $transcode = Invoke-DirectProcess `
    -FilePath $ffmpeg `
    -Arguments $transcodeArguments `
    -WorkingDirectory $safeWorkspace `
    -PathValue $mediaPath `
    -MaximumSeconds 90 `
    -Description 'bounded Sonic MP3 V0 transcode'
  if (($transcode.Stdout + "`n" + $transcode.Stderr) -cnotmatch '(?m)^progress=end\s*$') {
    throw 'FFmpeg completed without its final progress=end record.'
  }
  $outputFile = Assert-RegularWorkspaceFile `
    -Path $transcodedFile `
    -ExpectedParent $safeWorkspace `
    -MaximumBytes 16777216 `
    -Description 'transcoded E2E sample'

  $probeArguments = @(
    '-v',
    'error',
    '-show_entries',
    'format=format_name,duration,size:format_tags:stream=codec_type,codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,duration:stream_tags',
    '-of',
    'json',
    '--',
    $outputFile.FullName
  )
  $probe = Invoke-DirectProcess `
    -FilePath $ffprobe `
    -Arguments $probeArguments `
    -WorkingDirectory $safeWorkspace `
    -PathValue $mediaPath `
    -MaximumSeconds 30 `
    -Description 'ffprobe metadata readback'
  try {
    $probeData = $probe.Stdout | ConvertFrom-Json
  } catch {
    throw "ffprobe returned invalid JSON: $($_.Exception.Message)"
  }
  $audioStreams = @($probeData.streams | Where-Object { $_.codec_type -ceq 'audio' })
  if ($audioStreams.Count -lt 1) {
    throw 'ffprobe readback found no audio stream in the E2E sample.'
  }
  $tagMap = @{}
  if ($null -ne $probeData.format -and $null -ne $probeData.format.tags) {
    foreach ($property in $probeData.format.tags.PSObject.Properties) {
      $tagMap[$property.Name.ToUpperInvariant()] = [string]$property.Value
    }
  }
  foreach ($entry in $expectedTags.GetEnumerator()) {
    if (-not $tagMap.ContainsKey($entry.Key) -or $tagMap[$entry.Key] -cne [string]$entry.Value) {
      $actual = if ($tagMap.ContainsKey($entry.Key)) { $tagMap[$entry.Key] } else { '<missing>' }
      throw "ffprobe tag assertion failed for $($entry.Key): expected '$($entry.Value)', received '$actual'."
    }
  }
  $duration = 0.0
  if (-not [double]::TryParse(
    [string]$probeData.format.duration,
    [Globalization.NumberStyles]::Float,
    [Globalization.CultureInfo]::InvariantCulture,
    [ref]$duration
  )) {
    throw 'ffprobe returned no valid output duration.'
  }
  if ($duration -le 0 -or $duration -gt ($SampleSeconds + 1.5)) {
    throw "The transcoded output duration $duration seconds exceeded its bounded sample window."
  }

  $outputHash = Get-Sha256 -File $outputFile.FullName
  $lastProgress = $progressRecords[$progressRecords.Count - 1]
  Write-Host "Sonic media-engine E2E passed."
  Write-Host "Source       YouTube $videoId$(if ($videoId -ceq $nasaVideoId) { ' (NASA SVS)' } else { ' (explicit override)' })"
  Write-Host "Tools        Python $($manifest.tools.python.version) | yt-dlp $ytDlpVersion | Deno $($manifest.tools.deno.version)"
  Write-Host "Media        FFmpeg/ffprobe $($manifest.tools.ffmpeg.version)"
  Write-Host "Acquisition  $($sourceFile.Name), $($sourceFile.Length) bytes, $($progressRecords.Count) progress record(s), 1 output record"
  Write-Host "Progress     $lastProgress"
  Write-Host "Readback     title='$($tagMap.TITLE)', artist='$($tagMap.ARTIST)', TBPM=$($tagMap.TBPM), TKEY='$($tagMap.TKEY)'"
  Write-Host "Sample       $([Math]::Round($duration, 3))s, $($outputFile.Length) bytes, SHA-256 $outputHash"
} finally {
  Remove-SafeTempWorkspace -Path $workspace -AllowedParent $tempRoot
}

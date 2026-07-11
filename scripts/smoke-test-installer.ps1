[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$ReferenceIconPath,
  [ValidateRange(5, 60)][int]$StartupSeconds = 30,
  [ValidateRange(30, 600)][int]$OperationTimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($ReferenceIconPath)) {
  $ReferenceIconPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\icons\32x32.png'
}

function Invoke-HiddenProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [switch]$AllowNonZeroExit
  )

  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill() } catch { Write-Warning "Could not terminate timed-out process $($process.Id): $($_.Exception.Message)" }
      throw "Process timed out after $TimeoutSeconds seconds: $FilePath $($Arguments -join ' ')"
    }
    $process.Refresh()
    if (-not $AllowNonZeroExit -and $process.ExitCode -ne 0) {
      throw "Process exited with code $($process.ExitCode): $FilePath $($Arguments -join ' ')"
    }
    return $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

function Invoke-ToolProbe {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "Failed to start packaged tool: $FilePath"
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill() } catch { Write-Warning "Could not terminate timed-out tool probe $($process.Id): $($_.Exception.Message)" }
      throw "Packaged tool probe timed out after $TimeoutSeconds seconds: $FilePath $Arguments"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      throw "Packaged tool exited with code $($process.ExitCode): $FilePath $Arguments`n$stdout`n$stderr"
    }
    $reported = (($stdout + "`n" + $stderr).Trim() -split "`r?`n" | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($reported)) {
      throw "Packaged tool returned no version output: $FilePath"
    }
    Write-Host "Packaged $([IO.Path]::GetFileName($FilePath)) probe: $reported"
    return [string]$reported
  } finally {
    $process.Dispose()
  }
}

function Get-Sha256 {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

function Get-BitmapAnalysis {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Bitmap]$Bitmap
  )

  $stream = New-Object System.IO.MemoryStream
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $redDominantPixels = 0
    $colors = New-Object 'System.Collections.Generic.HashSet[int]'
    $pixels = New-Object 'System.Collections.Generic.List[int]'
    for ($y = 0; $y -lt $Bitmap.Height; $y++) {
      for ($x = 0; $x -lt $Bitmap.Width; $x++) {
        $pixel = $Bitmap.GetPixel($x, $y)
        if ($pixel.A -gt 32 -and $pixel.R -ge 120 -and $pixel.R -gt ($pixel.G + 35) -and $pixel.R -gt ($pixel.B + 35)) {
          $redDominantPixels++
        }
        [void]$colors.Add($pixel.ToArgb())
        $pixels.Add($pixel.ToArgb())
      }
    }

    $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream.Position = 0
    return [PSCustomObject]@{
      Fingerprint = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
      RedDominantPixels = $redDominantPixels
      UniqueColors = $colors.Count
      Pixels = $pixels.ToArray()
    }
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-StandardizedIconAnalysis {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Icon]$Icon
  )

  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawIcon($Icon, (New-Object System.Drawing.Rectangle 0, 0, 32, 32))
    return Get-BitmapAnalysis -Bitmap $bitmap
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Get-ReferenceArtworkAnalysis {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $source = [System.Drawing.Bitmap]::FromFile($Path)
  try {
    if ($source.Width -ne 32 -or $source.Height -ne 32) {
      throw "The Sonic reference artwork must be exactly 32 by 32 pixels: $Path"
    }
    return Get-BitmapAnalysis -Bitmap $source
  } finally {
    $source.Dispose()
  }
}

function Compare-IconAnalysis {
  param(
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)]$Actual
  )

  if ($Expected.Pixels.Count -ne $Actual.Pixels.Count) {
    throw 'Icon analyses do not contain the same number of pixels.'
  }
  $differentPixels = 0
  $channelDifference = 0L
  for ($index = 0; $index -lt $Expected.Pixels.Count; $index++) {
    $expectedColor = [System.Drawing.Color]::FromArgb([int]$Expected.Pixels[$index])
    $actualColor = [System.Drawing.Color]::FromArgb([int]$Actual.Pixels[$index])
    if ($expectedColor.ToArgb() -ne $actualColor.ToArgb()) {
      $differentPixels++
    }
    $channelDifference += [Math]::Abs([int]$expectedColor.A - [int]$actualColor.A)
    $channelDifference += [Math]::Abs([int]$expectedColor.R - [int]$actualColor.R)
    $channelDifference += [Math]::Abs([int]$expectedColor.G - [int]$actualColor.G)
    $channelDifference += [Math]::Abs([int]$expectedColor.B - [int]$actualColor.B)
  }
  return [PSCustomObject]@{
    DifferentPixels = $differentPixels
    MeanChannelError = $channelDifference / ($Expected.Pixels.Count * 4.0)
  }
}

function Get-FileIconAnalysis {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$IconFile
  )

  if ($IconFile) {
    $icon = New-Object System.Drawing.Icon $Path, 32, 32
  } else {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
  }
  if ($null -eq $icon) {
    throw "No associated Windows icon resource was found in $Path."
  }
  try {
    return Get-StandardizedIconAnalysis -Icon $icon
  } finally {
    $icon.Dispose()
  }
}

function Assert-IconMatches {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedFingerprint,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $analysis = Get-FileIconAnalysis -Path $Path
  if ($analysis.Fingerprint -cne $ExpectedFingerprint) {
    throw "$Description icon does not match Sonic's packaged icon resource. File: $Path"
  }
  Write-Host "Verified $Description icon resource ($($analysis.Fingerprint); $($analysis.RedDominantPixels) red pixels; $($analysis.UniqueColors) colors)."
}

function Get-InstalledExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$AllowedNames,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $matches = @(Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction Stop | Where-Object {
    $AllowedNames -contains $_.Name
  })
  if ($matches.Count -ne 1) {
    throw "Expected exactly one installed $Description executable under $Root; found $($matches.Count)."
  }
  if ($matches[0].Length -le 0) {
    throw "Installed $Description executable is empty: $($matches[0].FullName)"
  }
  return $matches[0]
}

function Get-SonicShortcuts {
  param(
    [Parameter(Mandatory = $true)][string]$InstalledExecutable
  )

  $searchRoots = @(
    [Environment]::GetFolderPath('DesktopDirectory'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('Programs'),
    [Environment]::GetFolderPath('CommonPrograms')
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique

  $shell = New-Object -ComObject WScript.Shell
  $matching = @()
  foreach ($root in $searchRoots) {
    foreach ($link in Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue) {
      try {
        $shortcut = $shell.CreateShortcut($link.FullName)
        if ([IO.Path]::GetFullPath([string]$shortcut.TargetPath) -ieq [IO.Path]::GetFullPath($InstalledExecutable)) {
          $matching += [PSCustomObject]@{
            Path = $link.FullName
            TargetPath = [string]$shortcut.TargetPath
            IconLocation = [string]$shortcut.IconLocation
          }
        }
      } catch {
        Write-Verbose "Could not inspect shortcut $($link.FullName): $($_.Exception.Message)"
      }
    }
  }
  return @($matching | Sort-Object Path -Unique)
}

function Remove-IsolatedSmokeDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AllowedRoot
  )

  $resolvedRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside the isolated smoke-test root: $resolvedPath"
  }
  if (Test-Path -LiteralPath $resolvedPath) {
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
  }
}

$installer = Get-Item -LiteralPath $InstallerPath -ErrorAction Stop
if ($installer.Extension -ine '.exe' -or $installer.Length -le 0) {
  throw "Installer must be a non-empty Windows executable: $($installer.FullName)"
}
if ($installer.Name -notmatch ('^Sonic_' + [regex]::Escape($ExpectedVersion) + '_x64-setup\.exe$')) {
  throw "Installer '$($installer.Name)' does not match expected release version '$ExpectedVersion'."
}
if (-not (Test-Path -LiteralPath $ReferenceIconPath -PathType Leaf)) {
  throw "Reference icon is missing: $ReferenceIconPath"
}

Add-Type -AssemblyName System.Drawing
$referenceIcon = Get-ReferenceArtworkAnalysis -Path ([IO.Path]::GetFullPath($ReferenceIconPath))
if ($referenceIcon.RedDominantPixels -lt 40 -or $referenceIcon.UniqueColors -lt 16) {
  throw "The Sonic reference icon failed its palette sanity check ($($referenceIcon.RedDominantPixels) red pixels; $($referenceIcon.UniqueColors) colors)."
}
$installerIcon = Get-FileIconAnalysis -Path $installer.FullName
if ($installerIcon.RedDominantPixels -lt 40 -or $installerIcon.UniqueColors -lt 16) {
  throw "The installer icon does not look like Sonic's red artwork ($($installerIcon.RedDominantPixels) red pixels; $($installerIcon.UniqueColors) colors)."
}
$iconDifference = Compare-IconAnalysis -Expected $referenceIcon -Actual $installerIcon
if ($iconDifference.DifferentPixels -gt 64 -or $iconDifference.MeanChannelError -gt 1.0) {
  throw "The installer icon does not match Sonic's 32px source artwork ($($iconDifference.DifferentPixels) pixels differ; mean channel error $($iconDifference.MeanChannelError)). File: $($installer.FullName)"
}
$embeddedIconFingerprint = $installerIcon.Fingerprint
Write-Host "Verified installer icon resource ($embeddedIconFingerprint; $($installerIcon.RedDominantPixels) red pixels; $($installerIcon.UniqueColors) colors; $($iconDifference.DifferentPixels) source pixels differ)."

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData)) {
  throw 'The current user does not have a LocalApplicationData directory.'
}
$isolationBase = if (-not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:RUNNER_TEMP } else { $localAppData }
$smokeRoot = Join-Path $isolationBase 'SonicInstallerSmoke'
$installDirectory = Join-Path $smokeRoot ([Guid]::NewGuid().ToString('N'))

$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Sonic'
if (Test-Path -LiteralPath $uninstallRegistryPath) {
  throw "A current-user Sonic installation is already registered. Run the installer smoke test only on a clean Windows runner. Registry key: $uninstallRegistryPath"
}
New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
$appDataCandidates = @(
  (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'studio.eternia.sonic'),
  (Join-Path $localAppData 'studio.eternia.sonic')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
$preexistingAppData = @{}
foreach ($appDataPath in $appDataCandidates) {
  $preexistingAppData[$appDataPath] = Test-Path -LiteralPath $appDataPath
}

$appProcess = $null
$uninstaller = $null
$trackedShortcuts = @()
$installAttempted = $false
$uninstallVerified = $false

try {
  Write-Host "Silently installing $($installer.Name) into isolated per-user path $installDirectory"
  $installAttempted = $true
  Invoke-HiddenProcess -FilePath $installer.FullName -Arguments @('/S', "/D=$installDirectory") -TimeoutSeconds $OperationTimeoutSeconds | Out-Null

  if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) {
    throw "The installer did not honor the isolated install directory: $installDirectory"
  }

  if (-not (Test-Path -LiteralPath $uninstallRegistryPath)) {
    throw "The installer did not register Sonic at $uninstallRegistryPath."
  }
  $uninstallRegistration = Get-ItemProperty -LiteralPath $uninstallRegistryPath
  $registeredLocation = ([string]$uninstallRegistration.InstallLocation).Trim().Trim('"').TrimEnd('\', '/')
  $expectedLocation = [IO.Path]::GetFullPath($installDirectory).TrimEnd('\', '/')
  if ([IO.Path]::GetFullPath($registeredLocation).TrimEnd('\', '/') -ine $expectedLocation) {
    throw "Registered InstallLocation '$registeredLocation' does not match isolated path '$expectedLocation'."
  }
  if ([string]$uninstallRegistration.DisplayVersion -cne $ExpectedVersion) {
    throw "Registered DisplayVersion '$($uninstallRegistration.DisplayVersion)' does not match '$ExpectedVersion'."
  }
  if ([string]$uninstallRegistration.Publisher -cne 'Eternia Studios') {
    throw "Registered Publisher '$($uninstallRegistration.Publisher)' is not 'Eternia Studios'."
  }
  Write-Host "Verified HKCU installer registration for Sonic $ExpectedVersion by Eternia Studios."

  $sonic = Get-InstalledExecutable -Root $installDirectory -AllowedNames @('Sonic.exe', 'sonic.exe') -Description 'Sonic application'
  Assert-IconMatches -Path $sonic.FullName -ExpectedFingerprint $embeddedIconFingerprint -Description 'application executable'

  $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -Recurse -File | Where-Object { $_.Name -match '(?i)^uninstall.*\.exe$' })
  if ($uninstallers.Count -ne 1) {
    throw "Expected exactly one NSIS uninstaller under $installDirectory; found $($uninstallers.Count)."
  }
  $uninstaller = $uninstallers[0]
  Assert-IconMatches -Path $uninstaller.FullName -ExpectedFingerprint $embeddedIconFingerprint -Description 'uninstaller'

  $trackedShortcuts = @(Get-SonicShortcuts -InstalledExecutable $sonic.FullName)
  if ($trackedShortcuts.Count -lt 1) {
    throw "The installer did not create a Start Menu or desktop shortcut targeting $($sonic.FullName)."
  }
  foreach ($shortcut in $trackedShortcuts) {
    if (-not [string]::IsNullOrWhiteSpace($shortcut.IconLocation)) {
      $shortcutIconPath = ($shortcut.IconLocation -replace ',\s*-?\d+\s*$', '').Trim('"')
      if (-not (Test-Path -LiteralPath $shortcutIconPath -PathType Leaf)) {
        throw "Shortcut icon location does not exist: $($shortcut.IconLocation)"
      }
      Assert-IconMatches -Path $shortcutIconPath -ExpectedFingerprint $embeddedIconFingerprint -Description "shortcut $($shortcut.Path)"
    }
    Write-Host "Verified shortcut target: $($shortcut.Path)"
  }

  foreach ($resourceName in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'ffmpeg-build-configuration.txt', 'tool-manifest.json', 'versions.json', 'install-media-engine.ps1')) {
    $resourcePath = Join-Path $installDirectory $resourceName
    if (-not (Test-Path -LiteralPath $resourcePath -PathType Leaf)) {
      throw "Required packaged resource is missing: $resourcePath"
    }
  }
  foreach ($licenseName in @('GPL-3.0.txt', 'OFL-1.1.txt', 'DENO-MIT.txt', 'YT-DLP-ZIPIMPORT-LICENSES.txt', 'PYTHON-3.13.14.txt', 'FFMPEG-LGPL-3.0.txt')) {
    $licensePath = Join-Path $installDirectory "licenses\$licenseName"
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
      throw "Required packaged third-party license is missing: $licensePath"
    }
  }
  foreach ($noticeName in @('SONIC-NPM-THIRD-PARTY-NOTICES.txt', 'SONIC-RUST-THIRD-PARTY-LICENSES.html')) {
    $noticePath = Join-Path $installDirectory "licenses\generated\$noticeName"
    if (-not (Test-Path -LiteralPath $noticePath -PathType Leaf) -or (Get-Item -LiteralPath $noticePath).Length -le 0) {
      throw "Required generated dependency notice is missing or empty: $noticePath"
    }
  }
  $packagedVersions = Get-Content -Raw -LiteralPath (Join-Path $installDirectory 'versions.json') | ConvertFrom-Json
  $packagedManifest = Get-Content -Raw -LiteralPath (Join-Path $installDirectory 'tool-manifest.json') | ConvertFrom-Json

  foreach ($obsoleteName in @('yt-dlp.exe', 'deno.exe', 'ffmpeg.exe', 'ffprobe.exe')) {
    $obsolete = @(Get-ChildItem -LiteralPath $installDirectory -Recurse -File | Where-Object { $_.Name -ieq $obsoleteName })
    if ($obsolete.Count -ne 0) {
      throw "The installer must not redistribute obsolete/GPL media executable '$obsoleteName': $($obsolete.FullName -join ', ')"
    }
  }

  $bundledToolDefinitions = @(
    @{ Name = 'python'; VersionProperty = 'python'; Allowed = @('python.exe', 'python-x86_64-pc-windows-msvc.exe'); Arguments = '--version' }
  )
  $bundledTools = @{}
  foreach ($definition in $bundledToolDefinitions) {
    $tool = Get-InstalledExecutable -Root $installDirectory -AllowedNames $definition.Allowed -Description $definition.Name
    $bundledTools[$definition.Name] = $tool
    $versionProperty = $packagedVersions.PSObject.Properties[$definition.VersionProperty]
    if ($null -eq $versionProperty -or [string]::IsNullOrWhiteSpace([string]$versionProperty.Value.sha256) -or [string]::IsNullOrWhiteSpace([string]$versionProperty.Value.reported)) {
      throw "Packaged versions.json has no complete '$($definition.VersionProperty)' record."
    }
    $actualHash = Get-Sha256 -Path $tool.FullName
    if ($actualHash -cne ([string]$versionProperty.Value.sha256).ToLowerInvariant()) {
      throw "Installed $($definition.Name) checksum does not match packaged versions.json."
    }
    $reported = Invoke-ToolProbe -FilePath $tool.FullName -Arguments $definition.Arguments -TimeoutSeconds 20
    if ($reported -cne [string]$versionProperty.Value.reported) {
      throw "Installed $($definition.Name) reported '$reported'; versions.json records '$($versionProperty.Value.reported)'."
    }
    Write-Host "Verified installed $($definition.Name) SHA-256 ($actualHash)."
  }

  $ytDlpPackage = Join-Path $installDirectory 'yt-dlp'
  if (-not (Test-Path -LiteralPath $ytDlpPackage -PathType Leaf)) {
    throw "The installed yt-dlp zipimport package is missing: $ytDlpPackage"
  }
  $ytDlpHash = Get-Sha256 -Path $ytDlpPackage
  if ($ytDlpHash -cne ([string]$packagedVersions.ytDlp.sha256).ToLowerInvariant()) {
    throw 'The installed yt-dlp zipimport package failed checksum validation.'
  }
  $quotedYtDlp = '"' + $ytDlpPackage.Replace('"', '\"') + '"'
  $ytDlpReported = Invoke-ToolProbe -FilePath $bundledTools['python'].FullName -Arguments "-I $quotedYtDlp --version" -TimeoutSeconds 20
  if ($ytDlpReported -cne [string]$packagedVersions.ytDlp.reported) {
    throw "Hosted yt-dlp reported '$ytDlpReported'; versions.json records '$($packagedVersions.ytDlp.reported)'."
  }
  Write-Host "Verified Python-hosted yt-dlp zipimport package SHA-256 ($ytDlpHash)."

  $mediaEngineDirectory = Join-Path $localAppData 'studio.eternia.sonic\media-engine'
  if (Test-Path -LiteralPath $mediaEngineDirectory) {
    throw "The clean smoke runner already contains Sonic's optional media engine: $mediaEngineDirectory"
  }
  $setupScript = Join-Path $installDirectory 'install-media-engine.ps1'
  $manifestPath = Join-Path $installDirectory 'tool-manifest.json'
  $systemPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $setupArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ManifestPath "{1}" -InstallDirectory "{2}"' -f $setupScript, $manifestPath, $mediaEngineDirectory
  $setupResult = Invoke-ToolProbe -FilePath $systemPowerShell -Arguments $setupArguments -TimeoutSeconds $OperationTimeoutSeconds
  if ($setupResult -notin @('installed', 'ready')) {
    throw "Media engine setup returned an unexpected result: $setupResult"
  }

  foreach ($engineResource in @('deno.exe', 'ffmpeg.exe', 'ffprobe.exe', 'FFMPEG-LGPL-3.0.txt', 'engine.json')) {
    $enginePath = Join-Path $mediaEngineDirectory $engineResource
    if (-not (Test-Path -LiteralPath $enginePath -PathType Leaf)) {
      throw "Verified media engine setup did not create $enginePath"
    }
  }
  $engineDefinition = $packagedManifest.tools.ffmpeg
  $denoDefinition = $packagedManifest.tools.deno
  $engineRecord = Get-Content -Raw -LiteralPath (Join-Path $mediaEngineDirectory 'engine.json') | ConvertFrom-Json
  foreach ($recordCheck in @(
    @{ Name = 'FFmpeg version'; Actual = [string]$engineRecord.version; Expected = [string]$engineDefinition.version },
    @{ Name = 'FFmpeg archive hash'; Actual = [string]$engineRecord.archiveSha256; Expected = [string]$engineDefinition.artifact.sha256 },
    @{ Name = 'FFmpeg executable hash'; Actual = [string]$engineRecord.ffmpegSha256; Expected = [string]$engineDefinition.executables.ffmpeg.sha256 },
    @{ Name = 'ffprobe executable hash'; Actual = [string]$engineRecord.ffprobeSha256; Expected = [string]$engineDefinition.executables.ffprobe.sha256 },
    @{ Name = 'Deno version'; Actual = [string]$engineRecord.denoVersion; Expected = [string]$denoDefinition.version },
    @{ Name = 'Deno archive hash'; Actual = [string]$engineRecord.denoArchiveSha256; Expected = [string]$denoDefinition.artifact.sha256 },
    @{ Name = 'Deno executable hash'; Actual = [string]$engineRecord.denoSha256; Expected = [string]$denoDefinition.executable.sha256 }
  )) {
    if ($recordCheck.Actual -cne $recordCheck.Expected) {
      throw "engine.json $($recordCheck.Name) '$($recordCheck.Actual)' does not match manifest '$($recordCheck.Expected)'."
    }
  }
  $engineLicenseHash = Get-Sha256 -Path (Join-Path $mediaEngineDirectory 'FFMPEG-LGPL-3.0.txt')
  if ($engineLicenseHash -cne ([string]$engineDefinition.license.sha256).ToLowerInvariant()) {
    throw 'The runtime media engine LGPL license failed checksum validation.'
  }
  foreach ($engineTool in @(
    @{ Name = 'ffmpeg'; Arguments = '-version' },
    @{ Name = 'ffprobe'; Arguments = '-version' }
  )) {
    $enginePath = Join-Path $mediaEngineDirectory "$($engineTool.Name).exe"
    $expectedHash = [string]$engineDefinition.executables.($engineTool.Name).sha256
    $actualHash = Get-Sha256 -Path $enginePath
    if ($actualHash -cne $expectedHash.ToLowerInvariant()) {
      throw "Runtime-downloaded $($engineTool.Name) failed checksum validation."
    }
    $reported = Invoke-ToolProbe -FilePath $enginePath -Arguments $engineTool.Arguments -TimeoutSeconds 20
    if ($reported -notmatch ('^' + [regex]::Escape($engineTool.Name) + ' version ' + [regex]::Escape([string]$engineDefinition.version) + '(?:\s|$)')) {
      throw "Runtime-downloaded $($engineTool.Name) reported an unexpected version: $reported"
    }
    Write-Host "Verified runtime-downloaded $($engineTool.Name) SHA-256 ($actualHash)."
  }
  $denoPath = Join-Path $mediaEngineDirectory 'deno.exe'
  $denoHash = Get-Sha256 -Path $denoPath
  if ($denoHash -cne ([string]$denoDefinition.executable.sha256).ToLowerInvariant()) {
    throw 'Runtime-downloaded Deno failed checksum validation.'
  }
  $denoReported = Invoke-ToolProbe -FilePath $denoPath -Arguments '--version' -TimeoutSeconds 20
  if ($denoReported -notmatch ('^deno ' + [regex]::Escape([string]$denoDefinition.version) + '(?:\s|$)')) {
    throw "Runtime-downloaded Deno reported an unexpected version: $denoReported"
  }
  Write-Host "Verified runtime-downloaded Deno SHA-256 ($denoHash)."

  Write-Host "Launching packaged Sonic and waiting up to $StartupSeconds seconds for its main window."
  $appProcess = Start-Process -FilePath $sonic.FullName -PassThru
  $startupDeadline = [DateTime]::UtcNow.AddSeconds($StartupSeconds)
  $windowReady = $false
  while ([DateTime]::UtcNow -lt $startupDeadline) {
    Start-Sleep -Milliseconds 500
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
      throw "Packaged Sonic exited during startup with code $($appProcess.ExitCode)."
    }
    if ($appProcess.MainWindowHandle -ne [IntPtr]::Zero) {
      $windowReady = $true
      break
    }
  }
  if (-not $windowReady) {
    throw "Packaged Sonic stayed alive but did not create a main window within $StartupSeconds seconds."
  }
  if ($appProcess.MainWindowTitle -notmatch '(?i)Sonic') {
    throw "Packaged Sonic opened an unexpected window titled '$($appProcess.MainWindowTitle)'."
  }
  Write-Host "Packaged Sonic opened '$($appProcess.MainWindowTitle)' (PID $($appProcess.Id))."

  if (-not $appProcess.CloseMainWindow()) {
    Stop-Process -Id $appProcess.Id -Force
  } elseif (-not $appProcess.WaitForExit(10000)) {
    Stop-Process -Id $appProcess.Id -Force
  }
  $appProcess.Dispose()
  $appProcess = $null

  Write-Host "Silently uninstalling Sonic from $installDirectory"
  Invoke-HiddenProcess -FilePath $uninstaller.FullName -Arguments @('/S') -TimeoutSeconds $OperationTimeoutSeconds | Out-Null

  $cleanupDeadline = [DateTime]::UtcNow.AddSeconds($OperationTimeoutSeconds)
  do {
    $installRemains = Test-Path -LiteralPath $installDirectory
    $registryRemains = Test-Path -LiteralPath $uninstallRegistryPath
    $shortcutRemains = @($trackedShortcuts | Where-Object { Test-Path -LiteralPath $_.Path }).Count -gt 0
    $engineRemains = Test-Path -LiteralPath $mediaEngineDirectory
    if (-not $installRemains -and -not $registryRemains -and -not $shortcutRemains -and -not $engineRemains) {
      break
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $cleanupDeadline)

  if ($installRemains) {
    $leftovers = @(Get-ChildItem -LiteralPath $installDirectory -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    throw "Silent uninstall left the isolated install directory behind: $installDirectory`n$($leftovers -join "`n")"
  }
  if ($registryRemains) {
    throw "Silent uninstall left Sonic's uninstall registration behind: $uninstallRegistryPath"
  }
  if ($engineRemains) {
    throw "Silent uninstall left Sonic's optional media engine behind: $mediaEngineDirectory"
  }
  foreach ($shortcut in $trackedShortcuts) {
    if (Test-Path -LiteralPath $shortcut.Path) {
      throw "Silent uninstall left a Sonic shortcut behind: $($shortcut.Path)"
    }
  }

  $uninstallVerified = $true
  Write-Host 'Installer smoke test passed: install, bundled tools, verified runtime engine, icons, startup, uninstall, and cleanup are verified.'
} finally {
  if ($null -ne $appProcess) {
    try {
      if (-not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
    } catch {
      Write-Warning "Could not stop Sonic during smoke-test cleanup: $($_.Exception.Message)"
    } finally {
      $appProcess.Dispose()
    }
  }

  if ($installAttempted -and -not $uninstallVerified -and $null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller.FullName)) {
    try {
      Invoke-HiddenProcess -FilePath $uninstaller.FullName -Arguments @('/S') -TimeoutSeconds $OperationTimeoutSeconds -AllowNonZeroExit | Out-Null
    } catch {
      Write-Warning "Fallback silent uninstall failed: $($_.Exception.Message)"
    }
  }
  if (Test-Path -LiteralPath $uninstallRegistryPath) {
    try {
      $leftoverRegistration = Get-ItemProperty -LiteralPath $uninstallRegistryPath
      $leftoverLocation = ([string]$leftoverRegistration.InstallLocation).Trim().Trim('"').TrimEnd('\', '/')
      if (-not [string]::IsNullOrWhiteSpace($leftoverLocation) -and [IO.Path]::GetFullPath($leftoverLocation) -ieq [IO.Path]::GetFullPath($installDirectory)) {
        Remove-Item -LiteralPath $uninstallRegistryPath -Recurse -Force
      } else {
        Write-Warning "Refusing to remove a Sonic uninstall registration that does not point to the isolated smoke directory."
      }
    } catch {
      Write-Warning "Could not clean the isolated uninstall registration: $($_.Exception.Message)"
    }
  }
  foreach ($shortcut in $trackedShortcuts) {
    try {
      if (Test-Path -LiteralPath $shortcut.Path) { Remove-Item -LiteralPath $shortcut.Path -Force }
    } catch {
      Write-Warning "Could not remove smoke-test shortcut $($shortcut.Path): $($_.Exception.Message)"
    }
  }
  if (Test-Path -LiteralPath $installDirectory) {
    try {
      Remove-IsolatedSmokeDirectory -Path $installDirectory -AllowedRoot $smokeRoot
    } catch {
      Write-Warning "Could not remove isolated smoke-test directory: $($_.Exception.Message)"
    }
  }
  if ((Test-Path -LiteralPath $smokeRoot) -and -not (Get-ChildItem -LiteralPath $smokeRoot -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $smokeRoot -Force
  }
  foreach ($appDataPath in $appDataCandidates) {
    if (-not $preexistingAppData[$appDataPath] -and (Test-Path -LiteralPath $appDataPath)) {
      try {
        $allowedAppDataRoot = Split-Path -Parent $appDataPath
        Remove-IsolatedSmokeDirectory -Path $appDataPath -AllowedRoot $allowedAppDataRoot
      } catch {
        Write-Warning "Could not remove app data created by the smoke test at ${appDataPath}: $($_.Exception.Message)"
      }
    }
  }
}

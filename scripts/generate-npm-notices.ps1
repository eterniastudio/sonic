[CmdletBinding()]
param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $projectRoot 'artifacts\licenses\SONIC-NPM-THIRD-PARTY-NOTICES.txt'
}
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction Stop
}
$packagePaths = @(& $npmCommand.Source ls --omit=dev --parseable --all 2>$null)
if ($LASTEXITCODE -ne 0) {
  throw 'npm could not resolve Sonic''s production dependency tree.'
}

$root = [IO.Path]::GetFullPath($projectRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$requiredPrefix = $root + [IO.Path]::DirectorySeparatorChar
$packages = foreach ($packagePath in ($packagePaths | Select-Object -Skip 1)) {
  $directory = [IO.Path]::GetFullPath($packagePath)
  if (-not $directory.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "npm reported a dependency outside Sonic's workspace: $directory"
  }
  $packageJsonPath = Join-Path $directory 'package.json'
  if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
    throw "A production dependency is missing package.json: $directory"
  }
  $package = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
  if (-not $package.name -or -not $package.version -or -not $package.license) {
    throw "A production dependency has incomplete package metadata: $directory"
  }
  $noticeFiles = @(Get-ChildItem -LiteralPath $directory -File | Where-Object {
    $_.Name -match '^(?i)(LICENSE|LICENCE|COPYING|NOTICE)(\..*|[-_].*)?$'
  } | Sort-Object Name)
  if ($noticeFiles.Count -eq 0) {
    throw "No license or notice file was found for $($package.name)@$($package.version)."
  }
  [PSCustomObject]@{
    Id = "$($package.name)@$($package.version)"
    License = if ($package.license -is [string]) { $package.license } else { $package.license | ConvertTo-Json -Compress }
    Homepage = if ($package.homepage) { [string]$package.homepage } elseif ($package.repository.url) { [string]$package.repository.url } else { '' }
    Files = $noticeFiles
  }
}
$packages = @($packages | Sort-Object Id -Unique)

$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
$writer = New-Object IO.StreamWriter($resolvedOutput, $false, $utf8WithoutBom)
try {
  $writer.WriteLine('Sonic npm runtime dependency notices')
  $writer.WriteLine('====================================')
  $writer.WriteLine('')
  $writer.WriteLine('Generated from package-lock.json and npm''s production dependency graph.')
  $writer.WriteLine('Only packages included in Sonic''s runtime webview bundle are listed.')
  $writer.WriteLine('')
  foreach ($package in $packages) {
    $writer.WriteLine(('=' * 78))
    $writer.WriteLine($package.Id)
    $writer.WriteLine("Declared license: $($package.License)")
    if ($package.Homepage) {
      $writer.WriteLine("Homepage/source: $($package.Homepage)")
    }
    foreach ($file in $package.Files) {
      $writer.WriteLine('')
      $writer.WriteLine("--- $($file.Name) ---")
      $writer.WriteLine('')
      $writer.Write((Get-Content -Raw -LiteralPath $file.FullName))
      $writer.WriteLine('')
    }
    $writer.WriteLine('')
  }
} finally {
  $writer.Dispose()
}

Write-Host "Wrote $($packages.Count) npm runtime dependency notices to $resolvedOutput"

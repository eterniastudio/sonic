[CmdletBinding()]
param(
  [string]$ExpectedTag,
  [string]$RepositoryRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Split-Path -Parent $PSScriptRoot
}

function Get-TomlPackageVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $content = Get-Content -Raw -LiteralPath $Path
  $packageSections = [regex]::Matches(
    $content,
    '(?ms)^\s*\[package\]\s*(?<body>.*?)(?=^\s*\[|\z)'
  )
  if ($packageSections.Count -ne 1) {
    throw "Expected exactly one [package] section in $Path; found $($packageSections.Count)."
  }

  $versionMatches = [regex]::Matches(
    $packageSections[0].Groups['body'].Value,
    '(?m)^\s*version\s*=\s*"(?<version>[^"]+)"\s*(?:#.*)?$'
  )
  if ($versionMatches.Count -ne 1) {
    throw "Expected exactly one package version in $Path; found $($versionMatches.Count)."
  }
  return $versionMatches[0].Groups['version'].Value
}

function Get-CargoLockPackageVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$PackageName
  )

  $content = Get-Content -Raw -LiteralPath $Path
  $matchingVersions = @()
  $packageBlocks = [regex]::Matches(
    $content,
    '(?ms)^\s*\[\[package\]\]\s*(?<body>.*?)(?=^\s*\[\[package\]\]|\z)'
  )

  foreach ($block in $packageBlocks) {
    $body = $block.Groups['body'].Value
    $nameMatch = [regex]::Match($body, '(?m)^\s*name\s*=\s*"(?<name>[^"]+)"\s*$')
    if ($nameMatch.Success -and $nameMatch.Groups['name'].Value -ceq $PackageName) {
      $versionMatch = [regex]::Match($body, '(?m)^\s*version\s*=\s*"(?<version>[^"]+)"\s*$')
      if (-not $versionMatch.Success) {
        throw "The '$PackageName' package in $Path does not contain a version."
      }
      $matchingVersions += $versionMatch.Groups['version'].Value
    }
  }

  if ($matchingVersions.Count -ne 1) {
    throw "Expected exactly one '$PackageName' package in $Path; found $($matchingVersions.Count)."
  }
  return $matchingVersions[0]
}

$root = [IO.Path]::GetFullPath($RepositoryRoot)
$requiredFiles = [ordered]@{
  PackageJson = Join-Path $root 'package.json'
  PackageLock = Join-Path $root 'package-lock.json'
  CargoToml = Join-Path $root 'src-tauri\Cargo.toml'
  CargoLock = Join-Path $root 'src-tauri\Cargo.lock'
  TauriConfig = Join-Path $root 'src-tauri\tauri.conf.json'
}
foreach ($entry in $requiredFiles.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) {
    throw "Required version source is missing: $($entry.Value)"
  }
}

$jsonVersionReader = @'
const fs = require('fs');
const [packagePath, lockPath, tauriPath] = process.argv.slice(1);
const read = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const packageJson = read(packagePath);
const packageLock = read(lockPath);
const tauriConfig = read(tauriPath);
const requiredString = (value, source) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${source} must be a non-empty string.`);
  }
  return value;
};
if (!packageLock.packages || !Object.prototype.hasOwnProperty.call(packageLock.packages, '')) {
  throw new Error('package-lock.json does not contain packages[""].');
}
process.stdout.write(JSON.stringify({
  packageJson: requiredString(packageJson.version, 'package.json version'),
  packageLockRoot: requiredString(packageLock.version, 'package-lock.json root version'),
  packageLockPackage: requiredString(packageLock.packages[''].version, 'package-lock.json packages[""] version'),
  tauriConfig: requiredString(tauriConfig.version, 'tauri.conf.json version')
}));
'@
$jsonVersionOutput = & node -e $jsonVersionReader $requiredFiles.PackageJson $requiredFiles.PackageLock $requiredFiles.TauriConfig
if ($LASTEXITCODE -ne 0) {
  throw "Node.js could not read the JSON version sources (exit code $LASTEXITCODE)."
}
$jsonVersions = $jsonVersionOutput | ConvertFrom-Json

$versions = [ordered]@{
  'package.json' = [string]$jsonVersions.packageJson
  'package-lock.json root' = [string]$jsonVersions.packageLockRoot
  'package-lock.json packages[""]' = [string]$jsonVersions.packageLockPackage
  'Cargo.toml [package]' = Get-TomlPackageVersion -Path $requiredFiles.CargoToml
  'Cargo.lock sonic package' = Get-CargoLockPackageVersion -Path $requiredFiles.CargoLock -PackageName 'sonic'
  'tauri.conf.json' = [string]$jsonVersions.tauriConfig
}

$canonicalVersion = $versions['package.json']
$semverPattern = '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
if ($canonicalVersion -cnotmatch $semverPattern) {
  throw "package.json version '$canonicalVersion' is not a valid exact semantic version."
}

$mismatches = @()
foreach ($entry in $versions.GetEnumerator()) {
  if ($entry.Value -cne $canonicalVersion) {
    $mismatches += "$($entry.Key)='$($entry.Value)'"
  }
}
if ($mismatches.Count -gt 0) {
  throw "Release version mismatch. Expected '$canonicalVersion' everywhere; mismatches: $($mismatches -join ', ')."
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedTag)) {
  $tagPattern = '^v(?<version>' + $semverPattern.TrimStart('^').TrimEnd('$') + ')$'
  $tagMatch = [regex]::Match($ExpectedTag, $tagPattern)
  if (-not $tagMatch.Success) {
    throw "Release tag '$ExpectedTag' must be an exact semantic version prefixed with 'v' (for example, v0.1.4)."
  }
  $tagVersion = $tagMatch.Groups['version'].Value
  if ($tagVersion -cne $canonicalVersion) {
    throw "Release tag '$ExpectedTag' does not match the source version '$canonicalVersion'."
  }
}

$versions.GetEnumerator() | ForEach-Object {
  Write-Host ("{0,-34} {1}" -f $_.Key, $_.Value)
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedTag)) {
  Write-Host ("{0,-34} {1}" -f 'Git tag', $ExpectedTag)
}
Write-Host "All Sonic release version sources agree on $canonicalVersion."

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
  "version=$canonicalVersion" | Add-Content -Encoding utf8 -LiteralPath $env:GITHUB_OUTPUT
}

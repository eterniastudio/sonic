[CmdletBinding()]
param(
  [string]$GeneratorPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($GeneratorPath)) {
  $GeneratorPath = Join-Path $PSScriptRoot 'generate-updater-manifest.ps1'
}
$generator = (Resolve-Path -LiteralPath $GeneratorPath -ErrorAction Stop).Path
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($generator, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
  throw "Updater manifest generator has parser errors:`n$($errors.Message -join "`n")"
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testName = 'sonic-updater-manifest-test-' + [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $tempRoot $testName
try {
  New-Item -ItemType Directory -Path $testRoot -ErrorAction Stop | Out-Null
  $installer = Join-Path $testRoot 'Sonic_2.4.6_x64-setup.exe'
  $signature = "$installer.sig"
  $output = Join-Path $testRoot 'latest.json'
  [IO.File]::WriteAllBytes($installer, [byte[]](1, 2, 3, 4))
  [IO.File]::WriteAllText($signature, 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3QgdXBkYXRlciBzaWduYXR1cmU=', (New-Object Text.UTF8Encoding($false)))

  & $generator `
    -Version '2.4.6' `
    -InstallerPath $installer `
    -SignaturePath $signature `
    -OutputPath $output `
    -Tag 'v2.4.6' `
    -Notes 'Updater manifest fixture.' `
    -PubDate '2026-07-19T03:45:00Z'

  $raw = Get-Content -Raw -LiteralPath $output
  $manifest = $raw | ConvertFrom-Json
  $platform = $manifest.platforms.'windows-x86_64'
  if ([string]$manifest.version -cne '2.4.6') { throw 'Updater manifest version was not preserved.' }
  if ([string]$manifest.pub_date -cne '2026-07-19T03:45:00Z') { throw 'Updater manifest publication date was not normalized.' }
  if ([string]$manifest.notes -cne 'Updater manifest fixture.') { throw 'Updater manifest notes were not preserved.' }
  if ([string]$platform.signature -cne 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3QgdXBkYXRlciBzaWduYXR1cmU=') { throw 'Updater signature content was not embedded.' }
  if ([string]$platform.url -cne 'https://github.com/eterniastudio/sonic/releases/download/v2.4.6/Sonic_2.4.6_x64-setup.exe') { throw "Unexpected updater URL: $($platform.url)" }
  if ($raw -match [regex]::Escape($testRoot)) { throw 'Updater metadata leaked a local build path.' }
  Write-Host 'Updater manifest validation passed (schema, URL, signature, date, notes, and path redaction).'
} finally {
  $candidate = [IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
  if ([IO.Path]::GetDirectoryName($candidate) -cne $tempRoot -or [IO.Path]::GetFileName($candidate) -cnotmatch '^sonic-updater-manifest-test-[a-f0-9]{32}$') {
    throw 'Refusing to clean an updater test directory outside the exact Temp boundary.'
  }
  if (Test-Path -LiteralPath $candidate) {
    $reparse = @(Get-Item -Force -LiteralPath $candidate) + @(Get-ChildItem -Force -Recurse -LiteralPath $candidate) |
      Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }
    if (@($reparse).Count -gt 0) { throw "Refusing to clean updater test data containing a reparse point: $($reparse[0].FullName)" }
    Remove-Item -LiteralPath $candidate -Recurse -Force
  }
}

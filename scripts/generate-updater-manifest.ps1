[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$SignaturePath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$Repository = 'eterniastudio/sonic',
  [string]$Tag,
  [string]$Notes,
  [string]$PubDate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Version -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "Updater version '$Version' is not valid semantic version text."
}
if ($Repository -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "Updater repository '$Repository' is not a GitHub owner/repository pair."
}
if ([string]::IsNullOrWhiteSpace($Tag)) {
  $Tag = "v$Version"
}
if ($Tag.IndexOf([char]0) -ge 0 -or $Tag -match '[\r\n/]') {
  throw 'Updater release tag contains an unsafe character.'
}
if ([string]::IsNullOrWhiteSpace($Notes)) {
  $Notes = "Sonic v$Version is available. See the GitHub release for full details."
}
if ($Notes.Length -gt 20000 -or $Notes.IndexOf([char]0) -ge 0) {
  throw 'Updater release notes exceed the safe manifest limit.'
}

$installer = Get-Item -LiteralPath $InstallerPath -ErrorAction Stop
$signatureFile = Get-Item -LiteralPath $SignaturePath -ErrorAction Stop
if ($installer.Extension -ine '.exe' -or $installer.Length -le 0) {
  throw "Updater installer must be a non-empty .exe file: $($installer.FullName)"
}
if ($signatureFile.Name -cne "$($installer.Name).sig" -or $signatureFile.Length -le 0) {
  throw "Updater signature must be the non-empty sidecar '$($installer.Name).sig'."
}
$signature = (Get-Content -Raw -LiteralPath $signatureFile.FullName).Trim()
if ($signature.Length -lt 32 -or $signature.Length -gt 4096 -or $signature.IndexOf([char]0) -ge 0) {
  throw 'Updater signature content is empty or outside the expected size range.'
}

$published = [DateTimeOffset]::UtcNow
if (-not [string]::IsNullOrWhiteSpace($PubDate)) {
  if (-not [DateTimeOffset]::TryParse(
    $PubDate,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$published
  )) {
    throw "Updater publication date '$PubDate' is not RFC 3339 compatible."
  }
}

$output = [IO.Path]::GetFullPath($OutputPath)
$outputParent = [IO.Path]::GetDirectoryName($output)
if ([string]::IsNullOrWhiteSpace($outputParent) -or -not (Test-Path -LiteralPath $outputParent -PathType Container)) {
  throw "Updater manifest output directory does not exist: $outputParent"
}
if ([IO.Path]::GetFileName($output) -cne 'latest.json') {
  throw 'Updater manifest output must be named latest.json.'
}

$escapedTag = [Uri]::EscapeDataString($Tag)
$escapedInstaller = [Uri]::EscapeDataString($installer.Name)
$manifest = [ordered]@{
  version = $Version
  notes = $Notes
  pub_date = $published.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = $signature
      url = "https://github.com/$Repository/releases/download/$escapedTag/$escapedInstaller"
    }
  }
}

$json = $manifest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($output, $json + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote signed updater metadata for Sonic $Version to $output"

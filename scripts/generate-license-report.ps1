[CmdletBinding()]
param(
  [string]$NpmSbomPath = "artifacts/sbom/sonic-npm.cdx.json",
  [string]$CargoSbomPath = "artifacts/sbom/sonic-cargo.cdx.json",
  [string]$OutputPath = "artifacts/sbom/THIRD_PARTY_LICENSE_REPORT.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-LicenseValues {
  param([Parameter(Mandatory = $true)]$Component)

  $values = @()
  $licensesProperty = $Component.PSObject.Properties['licenses']
  if ($null -eq $licensesProperty) { return @("NOASSERTION") }
  foreach ($entry in @($licensesProperty.Value)) {
    if ($null -eq $entry) { continue }
    $expression = $entry.PSObject.Properties['expression']
    $license = $entry.PSObject.Properties['license']
    if ($null -ne $expression -and $expression.Value) {
      $values += [string]$expression.Value
    } elseif ($null -ne $license -and $license.Value) {
      $id = $license.Value.PSObject.Properties['id']
      $name = $license.Value.PSObject.Properties['name']
      if ($null -ne $id -and $id.Value) {
        $values += [string]$id.Value
      } elseif ($null -ne $name -and $name.Value) {
        $values += [string]$name.Value
      }
    }
  }
  if ($values.Count -eq 0) { return @("NOASSERTION") }
  return @($values | Sort-Object -Unique)
}

function Get-ComponentRecords {
  param(
    [Parameter(Mandatory = $true)]$Bom,
    [Parameter(Mandatory = $true)][string]$Ecosystem
  )

  foreach ($component in @($Bom.components)) {
    if ($null -eq $component -or [string]::IsNullOrWhiteSpace([string]$component.name)) {
      continue
    }
    $versionProperty = $component.PSObject.Properties['version']
    $purlProperty = $component.PSObject.Properties['purl']
    [PSCustomObject][ordered]@{
      ecosystem = $Ecosystem
      name = [string]$component.name
      version = if ($null -ne $versionProperty) { [string]$versionProperty.Value } else { "" }
      licenses = @(Get-LicenseValues -Component $component)
      purl = if ($null -ne $purlProperty) { [string]$purlProperty.Value } else { "" }
    }
  }
}

foreach ($path in @($NpmSbomPath, $CargoSbomPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required CycloneDX SBOM is missing: $path"
  }
}

$npmBom = Get-Content -Raw -LiteralPath $NpmSbomPath | ConvertFrom-Json
$cargoBom = Get-Content -Raw -LiteralPath $CargoSbomPath | ConvertFrom-Json
$npmVersion = [string]$npmBom.metadata.component.version
$cargoVersion = [string]$cargoBom.metadata.component.version
if ([string]::IsNullOrWhiteSpace($npmVersion) -or $npmVersion -cne $cargoVersion) {
  throw "The npm and Cargo SBOM application versions do not agree."
}

$components = @(
  Get-ComponentRecords -Bom $npmBom -Ecosystem "npm"
  Get-ComponentRecords -Bom $cargoBom -Ecosystem "cargo"
) | Sort-Object ecosystem, name, version
if ($components.Count -eq 0) {
  throw "No dependency components were found in the CycloneDX SBOMs."
}

$report = [ordered]@{
  schemaVersion = 1
  application = "Sonic"
  version = $npmVersion
  generatedFrom = @(
    [IO.Path]::GetFileName($NpmSbomPath),
    [IO.Path]::GetFileName($CargoSbomPath)
  )
  components = $components
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent)) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath $OutputPath
Write-Host "Wrote $($components.Count) dependency license records to $OutputPath."

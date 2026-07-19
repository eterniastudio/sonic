[CmdletBinding()]
param(
  [string]$ScriptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ScriptPath)) {
  $ScriptPath = Join-Path $PSScriptRoot 'smoke-test-installer.ps1'
}

$resolvedScript = (Resolve-Path -LiteralPath $ScriptPath -ErrorAction Stop).Path
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $resolvedScript,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
  throw "Installer smoke script has parser errors:`n$($parseErrors.Message -join "`n")"
}

$source = Get-Content -Raw -LiteralPath $resolvedScript
function Assert-SourceContains {
  param([Parameter(Mandatory = $true)][string]$Needle)
  if ($source.IndexOf($Needle, [StringComparison]::Ordinal) -lt 0) {
    throw "Installer smoke script is missing required safety contract: $Needle"
  }
}

foreach ($functionName in @(
  'ConvertTo-WindowsCommandLineArgument',
  'ConvertTo-NsisInstallArguments',
  'Get-SonicUninstallRegistrations',
  'Get-SonicRunEntries',
  'Get-SonicShortcuts',
  'Assert-CleanSonicPreflight',
  'Remove-OwnedRegistryKey',
  'Remove-OwnedRunEntries',
  'Remove-IsolatedSmokeDirectory'
)) {
  $definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq $functionName
  }, $true)
  if ($null -eq $definition) {
    throw "Installer smoke script is missing safety function '$functionName'."
  }
}

$preflightCall = $source.IndexOf("Assert-CleanSonicPreflight ```r`n", [StringComparison]::Ordinal)
if ($preflightCall -lt 0) {
  $preflightCall = $source.IndexOf("Assert-CleanSonicPreflight ```n", [StringComparison]::Ordinal)
}
$preflightOnlyGate = $source.IndexOf('if ($PreflightOnly)', [StringComparison]::Ordinal)
$firstInstallMutation = $source.IndexOf('New-Item -ItemType Directory -Path $smokeRoot', [StringComparison]::Ordinal)
if ($preflightCall -lt 0 -or $preflightOnlyGate -lt 0 -or $firstInstallMutation -lt 0 -or
    -not ($preflightCall -lt $preflightOnlyGate -and $preflightOnlyGate -lt $firstInstallMutation)) {
  throw 'Clean-state preflight and PreflightOnly must both execute before the first smoke-directory mutation.'
}

foreach ($contract in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Eternia Studios\Sonic',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  "Get-Process -Name 'Sonic'",
  "Join-Path `$sonicLocalData 'media-engine'",
  "Join-Path `$sonicLocalData 'data'",
  "Join-Path `$sonicLocalData 'EBWebView'",
  'Get-SonicShortcuts',
  'Get-SonicUninstallRegistrations -RegistryRoots $uninstallRegistryRoots',
  'foreach ($leftoverProductPath in $productRegistryPaths)',
  'foreach ($shortcut in Get-SonicShortcuts)',
  'ConvertTo-NsisInstallArguments -InstallDirectory $installDirectory',
  '-RawArguments $installerArguments',
  '$startInfo.Arguments = $RawArguments',
  'ArgumentList.Add($argument)',
  'Cleanup residue remains:',
  'throw ($failureParts -join'
)) {
  Assert-SourceContains -Needle $contract
}

# Load only the two pure argument-formatting functions' AST extents; do not
# dot-source or run the installer smoke script.
foreach ($pureFunctionName in @('ConvertTo-WindowsCommandLineArgument', 'ConvertTo-NsisInstallArguments')) {
  $definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq $pureFunctionName
  }, $true)
  Invoke-Expression $definition.Extent.Text
}

$quotingCases = @(
  @{ Input = '/S'; Expected = '/S' },
  @{ Input = ''; Expected = '""' },
  @{ Input = 'value"quoted'; Expected = '"value\"quoted"' },
  @{ Input = 'C:\path with space\'; Expected = '"C:\path with space\\"' }
)
foreach ($case in $quotingCases) {
  $actual = ConvertTo-WindowsCommandLineArgument -Value $case.Input
  if ($actual -cne $case.Expected) {
    throw "Command-line quoting failed for '$($case.Input)': expected '$($case.Expected)', got '$actual'."
  }
}

$nsisCases = @(
  @{ Input = 'C:\SonicSmoke\run'; Expected = '/S /D=C:\SonicSmoke\run' },
  @{ Input = 'C:\Sonic Smoke\run'; Expected = '/S /D=C:\Sonic Smoke\run' }
)
foreach ($case in $nsisCases) {
  $actual = ConvertTo-NsisInstallArguments -InstallDirectory $case.Input
  if ($actual -cne $case.Expected -or $actual.Contains('"')) {
    throw "NSIS /D formatting failed for '$($case.Input)': expected '$($case.Expected)', got '$actual'."
  }
}

foreach ($unsafePath in @('relative\run', "C:\bad`"path", "C:\bad`npath")) {
  $rejected = $false
  try {
    [void](ConvertTo-NsisInstallArguments -InstallDirectory $unsafePath)
  } catch {
    $rejected = $true
  }
  if (-not $rejected) {
    throw "Unsafe NSIS install path was accepted: $unsafePath"
  }
}

Write-Host 'Installer smoke safety validation passed (parser, preflight ordering, resource coverage, normal argv quoting, raw final NSIS /D formatting, and fatal cleanup contract).'

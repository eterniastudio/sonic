[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$resolvedInstall = [IO.Path]::GetFullPath($InstallDirectory)
if ([string]::IsNullOrWhiteSpace($resolvedInstall) -or [IO.Path]::GetPathRoot($resolvedInstall) -eq $resolvedInstall) {
  throw 'The stem-engine install directory is invalid.'
}

$launcher = Get-Command py.exe -ErrorAction SilentlyContinue
if (-not $launcher) {
  throw 'Python 3.13 is required for the optional stem engine. Install Python from python.org, then retry setup.'
}

New-Item -ItemType Directory -Path $resolvedInstall -Force | Out-Null
$venv = Join-Path $resolvedInstall 'runtime'
if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe') -PathType Leaf)) {
  & $launcher.Source -3.13 -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Python could not create the isolated stem-engine environment.' }
}

$python = Join-Path $venv 'Scripts\python.exe'
& $python -I -m pip install --disable-pip-version-check --only-binary=:all: 'audio-separator==0.44.2'
if ($LASTEXITCODE -ne 0) { throw 'The optional stem-engine packages could not be installed.' }

$separator = Join-Path $venv 'Scripts\audio-separator.exe'
if (-not (Test-Path -LiteralPath $separator -PathType Leaf)) {
  throw 'Stem-engine setup completed without the audio-separator command.'
}

Write-Output "Stem engine ready: $separator"

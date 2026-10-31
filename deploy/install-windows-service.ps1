param(
  [string]$InstallRoot = "C:\Program Files\StreamKit",
  [string]$ConfigPath = "C:\ProgramData\StreamKit\orchestrator.json"
)
$ErrorActionPreference = 'Stop'
# Compatibility entry point; SCM policy lives in the native executable.
$binary = Join-Path $InstallRoot 'orchestrator.exe'
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Missing $binary" }
& $binary service install --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Native service installation failed' }
& $binary service start --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Native startup failed; inspect the configured service log' }

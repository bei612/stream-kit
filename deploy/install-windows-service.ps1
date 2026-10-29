param(
  [string]$InstallRoot = "C:\Program Files\StreamKit",
  [string]$ConfigPath = "C:\ProgramData\StreamKit\orchestrator.json"
)
$ErrorActionPreference = "Stop"
$binary = Join-Path $InstallRoot "orchestrator.exe"
if (!(Test-Path $binary)) { throw "Missing $binary" }
New-Item -ItemType Directory -Force (Split-Path $ConfigPath) | Out-Null
if (!(Get-Service -Name StreamKitOrchestrator -ErrorAction SilentlyContinue)) {
  New-Service -Name StreamKitOrchestrator -BinaryPathName "`"$binary`" --config `"$ConfigPath`"" -DisplayName "Stream-Kit Orchestrator" -StartupType Automatic
}
Start-Service StreamKitOrchestrator

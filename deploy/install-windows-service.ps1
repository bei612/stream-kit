param(
  [string]$InstallRoot = "C:\Program Files\StreamKit",
  [string]$ConfigPath = "C:\ProgramData\StreamKit\orchestrator.json"
)
$ErrorActionPreference = "Stop"
$binary = Join-Path $InstallRoot "orchestrator.exe"
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Missing $binary" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Prepare the configuration before installing the service: $ConfigPath" }
if (!(Test-Path -LiteralPath (Join-Path $InstallRoot 'dist/index.html') -PathType Leaf)) { throw 'The installed management page is missing' }
$binary = (Resolve-Path -LiteralPath $binary).Path
$manifest = Get-Content -LiteralPath (Join-Path $InstallRoot 'bundle-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.verification_version -ne 1) { throw 'Rebuild a current control-plane bundle before installing; this package does not declare the verification command' }
& $binary verify-bundle $InstallRoot
if ($LASTEXITCODE -ne 0) { throw 'Bundle verification failed; service configuration was not changed' }
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$command = "`"$binary`" --config `"$ConfigPath`""
$existing = Get-CimInstance Win32_Service -Filter "Name='StreamKitOrchestrator'"
if ($existing -and $existing.PathName -ne $command) {
  throw 'An existing StreamKitOrchestrator service uses different paths; migrate it explicitly before installing this bundle'
}
if (!$existing) {
  New-Service -Name StreamKitOrchestrator -BinaryPathName $command -DisplayName "Stream-Kit Orchestrator" -StartupType Automatic
}
& "$env:SystemRoot/System32/sc.exe" failure StreamKitOrchestrator reset= 86400 actions= restart/5000/restart/15000/restart/60000
if ($LASTEXITCODE -ne 0) { throw "Failed to configure service recovery: $LASTEXITCODE" }
& "$env:SystemRoot/System32/sc.exe" failureflag StreamKitOrchestrator 1
if ($LASTEXITCODE -ne 0) { throw "Failed to enable recovery for service errors: $LASTEXITCODE" }
Start-Service StreamKitOrchestrator

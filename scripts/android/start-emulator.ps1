param(
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    [ValidatePattern('^StreamKit_[A-Za-z0-9_]+$')][string]$AvdName = 'StreamKit_API_36',
    [ValidateRange(5554,5682)][int]$Port = 5580,
    [switch]$ShowWindow
)
$ErrorActionPreference = 'Stop'
if ($Port % 2 -ne 0) { throw 'Android emulator console port must be even.' }
$sdk = [IO.Path]::GetFullPath($SdkRoot)
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emulator = Join-Path $sdk 'emulator\emulator.exe'
foreach ($tool in @($adb, $emulator)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Official Android SDK tool not found: $tool" }
}
$serial = "emulator-$Port"
$connected = & $adb devices
if ($LASTEXITCODE -ne 0) { throw 'Unable to query Android devices.' }
if ($connected -match "^$serial\s") {
    $name = & $adb -s $serial emu avd name
    if ($LASTEXITCODE -ne 0 -or $name -notcontains $AvdName) { throw 'The selected port belongs to another or unavailable AVD.' }
    Write-Output "Reusing $AvdName ($serial); no second emulator started."
    return
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port,($Port + 1) -ErrorAction SilentlyContinue) {
    throw 'Emulator ports are in use; existing listeners were not changed.'
}
$available = & $emulator -list-avds
if ($LASTEXITCODE -ne 0 -or $available -notcontains $AvdName) { throw 'AVD is not installed. Provision it with the official Android SDK first.' }
$logs = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))) '.local\android\emulator'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$launchArguments = @('-avd',$AvdName,'-no-snapshot','-no-boot-anim','-gpu','auto','-port',"$Port")
if (-not $ShowWindow) { $launchArguments += '-no-window' }
$windowStyle = if ($ShowWindow) { 'Normal' } else { 'Hidden' }
$process = Start-Process -FilePath $emulator -ArgumentList $launchArguments -WindowStyle $windowStyle -PassThru `
    -RedirectStandardOutput (Join-Path $logs "$stamp.stdout.log") -RedirectStandardError (Join-Path $logs "$stamp.stderr.log")
# No wipe-data, host driver installation, virtualization changes, or open gRPC control port.
Write-Output "Started $AvdName ($serial), launcher PID $($process.Id). Boot readiness is separate; check adb shell getprop sys.boot_completed."

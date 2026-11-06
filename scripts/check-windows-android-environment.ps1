param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateSet('auto','off')][string]$Acceleration = 'auto'
)
# Hosted CI environment qualification, not product acceptance. Do not execute
# on a developer's shared host or change Windows virtualization features.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This qualification is restricted to disposable hosted Windows runners'
}
$sdk = [IO.Path]::GetFullPath($env:ANDROID_HOME)
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new evidence directory' }
[void](New-Item -ItemType Directory -Path $output)
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$manager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
$avdManager = Join-Path $sdk 'cmdline-tools\latest\bin\avdmanager.bat'
foreach ($tool in @($emulator,$adb,$manager,$avdManager)) {
    if (!(Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Official SDK tool missing: $tool" }
}
$name = 'StreamKit_Input_CI'
$serial = 'emulator-5580'
$result = [ordered]@{schema_version=1;passed=$false;scope='Official Android emulator startup on isolated Windows CI; not app, media or input acceptance';started_at=[DateTime]::UtcNow.ToString('o');system_image='system-images;android-36;google_apis;x86_64';host_virtualization_changed=$false}
$owned = $null
function Invoke-OwnedAdb([string[]]$AdbArguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($adb)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $AdbArguments) { $info.ArgumentList.Add($argument) }
    $client = [Diagnostics.Process]::new()
    $client.StartInfo = $info
    try {
        [void]$client.Start()
        $stdout = $client.StandardOutput.ReadToEndAsync()
        $stderr = $client.StandardError.ReadToEndAsync()
        if (!$client.WaitForExit(8000)) {
            $client.Kill()
            [void]$client.WaitForExit(2000)
            return [pscustomobject]@{code=124; text=''}
        }
        [void]$stdout.Wait(1000)
        [void]$stderr.Wait(1000)
        return [pscustomobject]@{code=$client.ExitCode; text=$(if ($stdout.IsCompletedSuccessfully) {$stdout.Result} else {''})}
    } finally { $client.Dispose() }
}
function Save-Qualification { $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'result.json') -Encoding utf8 }
try {
    $result.emulator_version = @(& $emulator -version 2>&1 | ForEach-Object {"$_"})
    $result.acceleration_check = @(& $emulator -accel-check 2>&1 | ForEach-Object {"$_"})
    $accel = if ($Acceleration -eq 'off' -or $LASTEXITCODE -ne 0) {'off'} else {'auto'}
    $result.acceleration_mode = $accel
    $existing = Invoke-OwnedAdb -AdbArguments @('devices')
    if ($existing.code -ne 0 -or $existing.text -match '(?m)^emulator-5580\s') { throw 'Selected emulator port is unavailable' }
    if (Get-NetTCPConnection -State Listen -LocalPort 5580,5581 -ErrorAction SilentlyContinue) { throw 'Emulator ports are already in use' }
    $result.stage = 'installing_system_image'; Save-Qualification
    & $manager --install $result.system_image
    if ($LASTEXITCODE -ne 0) { throw 'Official system image installation failed' }
    'no' | & $avdManager create avd --name $name --package $result.system_image --device pixel_6
    if ($LASTEXITCODE -ne 0) { throw 'Official AVD creation failed' }
    $launch = @('-avd',$name,'-port','5580','-no-window','-no-snapshot','-no-boot-anim','-noaudio','-gpu','swiftshader','-accel',$accel,'-memory','2048','-cores','2')
    $owned = Start-Process -FilePath $emulator -ArgumentList $launch -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $output 'emulator.stdout.log') -RedirectStandardError (Join-Path $output 'emulator.stderr.log')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $result.stage = 'waiting_for_android_boot'; Save-Qualification
    while ($timer.Elapsed.TotalSeconds -lt 480) {
        $owned.Refresh()
        if ($owned.HasExited) { throw 'Emulator exited before Android finished booting' }
        $boot = Invoke-OwnedAdb -AdbArguments @('-s',$serial,'shell','getprop','sys.boot_completed')
        if ($boot.code -eq 0 -and $boot.text.Trim() -eq '1') {
            $result.boot_seconds = [Math]::Round($timer.Elapsed.TotalSeconds,1)
            $api = Invoke-OwnedAdb -AdbArguments @('-s',$serial,'shell','getprop','ro.build.version.sdk')
            $abi = Invoke-OwnedAdb -AdbArguments @('-s',$serial,'shell','getprop','ro.product.cpu.abi')
            if ($api.code -ne 0 -or $abi.code -ne 0) { throw 'Android properties unavailable after boot' }
            $result.android_api = $api.text.Trim()
            $result.android_abi = $abi.text.Trim()
            $result.passed = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (!$result.passed) { throw 'Android did not boot within the eight-minute qualification budget' }
} catch { $result.error = $_.Exception.Message }
finally {
    if ($owned) {
        # The unique AVD/console port was reserved before launch. Close only it.
        $shutdown = Invoke-OwnedAdb -AdbArguments @('-s',$serial,'emu','kill')
        $result.shutdown_requested = $shutdown.code -eq 0
        $owned.Dispose()
    }
    $result.finished_at = [DateTime]::UtcNow.ToString('o')
    $result.stage = 'finished'; Save-Qualification
}
if (!$result.passed) { throw $result.error }

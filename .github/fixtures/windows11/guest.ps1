param([switch]$Resume)
$ErrorActionPreference = 'Stop'
$computer = Get-CimInstance Win32_ComputerSystem
if ($computer.Manufacturer -ne 'QEMU' -or $computer.Model -ne 'StreamKit-Win11-Acceptance') {
    throw 'This fixture is limited to the isolated acceptance guest'
}
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Expected the guest console session' }
$windows = Get-CimInstance Win32_OperatingSystem
if ($windows.ProductType -ne 1 -or [int]$windows.BuildNumber -lt 22000) {
    throw 'Expected a Windows 11 client kernel'
}
$work = 'C:\StreamKitAcceptance'
$output = Join-Path $work 'result'
$manifest = Join-Path $work 'installer\installer-manifest.json'
$resultFile = Join-Path $output 'result.json'
$task = 'StreamKitRebootAcceptance'

function Write-GuestEvidence($Value) {
    $utf8 = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
    $port = [System.IO.Ports.SerialPort]::new('COM1', 115200)
    try {
        $port.WriteTimeout = 8000
        $port.Open()
        $port.WriteLine('STREAMKIT_EVIDENCE ' + [Convert]::ToBase64String($utf8))
    } finally {
        $port.Dispose()
    }
}

function Read-DiagnosticTail([string]$Path, [int]$Lines, [int]$Limit) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $text = (Get-Content -LiteralPath $Path -Encoding UTF8 -Tail $Lines) -join [Environment]::NewLine
        $text.Substring([Math]::Max(0, $text.Length - $Limit))
    }
}

function Read-FixtureJson([string]$Path) {
    $json = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true))
    if ([string]::IsNullOrWhiteSpace($json)) { throw 'Fixture JSON document is empty' }
    ConvertFrom-Json -InputObject $json
}

function Read-NativeInitialization($Identity) {
    $details = [ordered]@{}
    $diagnosticStarted = Get-Date
    $diagnostic = Join-Path $PSScriptRoot 'diagnostic'
    if (Test-Path -LiteralPath $diagnostic -PathType Container) {
        $startEvent = 'StreamKitNativeStart'
        $stopEvent = 'StreamKitNativeStop'
        try {
            $payload = Join-Path $work 'diagnostic'
            Copy-Item -LiteralPath $diagnostic -Destination $payload -Recurse
            $runtime = Join-Path $payload 'orchestrator\orchestrator.exe'
            $nativeLog = Join-Path $work 'diagnostic-stderr.txt'
            $nativeArguments = @('init-platform','--root',$payload,'--data-dir',(Join-Path $work 'diagnostic-data'),
                '--control-port','19000','--gateway-port','18080','--renderer-port','48989',
                '--usb-audio-vendor-id',$Identity.vendor_id,'--usb-audio-product-id',$Identity.product_id)
            if ($Identity.serial_prefix) {
                $nativeArguments += @('--usb-audio-serial-prefix',('"' + $Identity.serial_prefix + '"'))
            }
            $processFilter = "ProcessName = 'sunshine.exe' OR ProcessName = 'web-server.exe'"
            try {
                Register-WmiEvent -Query "SELECT * FROM Win32_ProcessStartTrace WHERE $processFilter" -SourceIdentifier $startEvent | Out-Null
                Register-WmiEvent -Query "SELECT * FROM Win32_ProcessStopTrace WHERE $processFilter" -SourceIdentifier $stopEvent | Out-Null
            } catch {
                $details.native_trace_error = $_.Exception.Message
            }
            $timer = [Diagnostics.Stopwatch]::StartNew()
            $process = Start-Process -FilePath $runtime -ArgumentList $nativeArguments -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $work 'diagnostic-stdout.txt') -RedirectStandardError $nativeLog
            $initializerProcess = $process.Id
            try {
                $null = $process.Handle
                # The initializer runs three gateway operations (30 s each) and one renderer operation (60 s).
                if (-not $process.WaitForExit(165000)) { $process.Kill(); throw 'Native diagnostic exceeded its time limit' }
                $details.native_elapsed_ms = $timer.ElapsedMilliseconds
                $details.native_init_exit = $process.ExitCode
                $details.native_init_error = Read-DiagnosticTail $nativeLog 12 3000
            } finally { $process.Dispose() }

            # This directory exists only if the verified diagnostic runtime reached its preparer.
            # Preserve the component log, never the staged configuration or credential files.
            $stages = @(Get-ChildItem -LiteralPath $work -Directory -Filter '.stream-kit-setup-*' -Force)
            if ($stages.Count -eq 1) {
                $rendererLog = Join-Path $stages[0].FullName 'sunshine\sunshine.log'
                $details.renderer_log_present = Test-Path -LiteralPath $rendererLog -PathType Leaf
                $details.renderer_log = Read-DiagnosticTail $rendererLog 55 6500
                $config = Join-Path $stages[0].FullName 'sunshine\sunshine.conf'
                if (Test-Path -LiteralPath $config -PathType Leaf) {
                    $renderer = Join-Path $payload 'sunshine\sunshine.exe'
                    $probe = Join-Path $PSScriptRoot 'renderer-probe.cjs'
                    $details.renderer_probe = & (Join-Path $work 'node.exe') $probe $renderer $config | ConvertFrom-Json
                }
            }
            $started = @(Get-Event -SourceIdentifier $startEvent -ErrorAction SilentlyContinue | ForEach-Object {
                $_.SourceEventArgs.NewEvent
            } | Where-Object ParentProcessID -eq $initializerProcess)
            $stopped = @(Get-Event -SourceIdentifier $stopEvent -ErrorAction SilentlyContinue | ForEach-Object {
                $_.SourceEventArgs.NewEvent
            })
            $details.native_children = @(foreach ($event in $started) {
                $completion = $stopped | Where-Object ProcessID -eq $event.ProcessID | Select-Object -First 1
                @{
                    process = $event.ProcessName
                    completed = [bool]$completion
                    exit = $(if($completion){[uint32]$completion.ExitStatus})
                    elapsed_ms = $(if($completion){[math]::Round(([long]$completion.TIME_CREATED - [long]$event.TIME_CREATED) / 10000, 1)})
                }
            })
            $details.renderer_application_events = @(Get-WinEvent -FilterHashtable @{
                LogName = 'Application'; Id = 1000,1001,1002; StartTime = $diagnosticStarted
            } -MaxEvents 15 -ErrorAction SilentlyContinue | Where-Object Message -like '*sunshine.exe*' |
                Select-Object -First 3 | ForEach-Object {
                    @{id = $_.Id; provider = $_.ProviderName; message = $_.Message.Substring(0,[Math]::Min(800,$_.Message.Length))}
                })
        } catch {
            $details.native_diagnostic_error = $_.Exception.Message
        } finally {
            foreach ($name in $startEvent,$stopEvent) {
                Unregister-Event -SourceIdentifier $name -ErrorAction SilentlyContinue
                Remove-Event -SourceIdentifier $name -ErrorAction SilentlyContinue
            }
        }
    }
    return $details
}

function Read-InstallFailure($Install) {
    $details = if ($Install.install_exit -ne 0) { Read-NativeInitialization $Install.identity } else { [ordered]@{} }
    $details.installer_log = Read-DiagnosticTail (Join-Path $output 'install.log') 100 8500
    $details.setupapi_delta = Read-DiagnosticTail (Join-Path $output 'setupapi-install-delta.log') 50 5000
    $details.runtime_startup = $Install.runtime_startup_failure
    $lanResult = Join-Path $output 'windows-lan-guest.json'
    if (Test-Path -LiteralPath $lanResult -PathType Leaf) {
        $details.lan = Read-FixtureJson $lanResult
    }
    return $details
}

$fixtureStage = 'prepare'
$testExit = $null
$package = $null
try {
    if (-not $Resume) {
        if (-not (Confirm-SecureBootUEFI) -or -not (Get-Tpm).TpmPresent) {
            throw 'Windows did not report UEFI Secure Boot and a TPM'
        }
        Write-GuestEvidence @{
            phase = 'guest_ready'; build = [int]$windows.BuildNumber; secure_boot = $true; tpm_present = $true
            guest_utc = [DateTime]::UtcNow.ToString('o'); guest_time_zone = (Get-TimeZone).Id
        }
        New-Item -ItemType Directory -Path $work | Out-Null
        foreach ($name in 'node.exe','guest.ps1','scripts','installer') {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $work -Recurse
        }
        if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'lan-fixture') -PathType Container) {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lan-fixture') -Destination $work -Recurse
        }
        if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'initialization-only') -PathType Leaf) {
            $package = Read-FixtureJson $manifest
            Write-GuestEvidence @{
                phase = 'diagnostic_completed'; passed = $false
                commit = $package.commit; installer_sha256 = $package.file.sha256
                diagnostics = Read-NativeInitialization $package.audio_driver.identity
            }
            return
        }
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File C:\StreamKitAcceptance\guest.ps1 -Resume'
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal | Out-Null
    }
    Set-Location -LiteralPath $work
    $mode = if ($Resume) { '--win11-resume' } else { '--win11-stage' }
    $fixtureStage = 'read_manifest'
    $package = Read-FixtureJson $manifest
    $fixtureStage = 'run_acceptance'
    & (Join-Path $work 'node.exe') (Join-Path $work 'scripts\accept-windows-installer.cjs') $manifest $output $mode
    $testExit = $LASTEXITCODE
    $fixtureStage = 'read_acceptance_result'
    $result = Read-FixtureJson $resultFile
    $fixtureStage = 'verify_acceptance_result'
    if ($null -eq $result -or $result.commit -ne $package.commit -or $result.installer_sha256 -ne $package.file.sha256) {
        throw 'Installer evidence does not identify the fixture package'
    }
    if ($result.phase -eq 'awaiting_reboot') {
        if ($Resume -or $testExit -ne 0) { throw 'Acceptance exited without replacing the reboot checkpoint' }
    } elseif ($result.phase -notin 'completed', 'failed' -or ($result.phase -eq 'completed' -and $testExit -ne 0)) {
        throw 'Acceptance exited without a valid terminal result'
    }
    $diagnostics = $null
    if ($result.phase -eq 'failed') {
        try { $diagnostics = Read-InstallFailure $result }
        catch {
            $diagnostics = @{ diagnostic_error = $_.Exception.Message; line = $_.InvocationInfo.ScriptLineNumber
                runtime_startup = $result.runtime_startup_failure }
        }
    }
    $fixtureStage = 'emit_acceptance_result'
    Write-GuestEvidence @{
        phase = $result.phase; passed = $result.passed; error = $result.error
        exit_code = $testExit; commit = $result.commit; installer_source_commit = $result.installer_source_commit
        installer_sha256 = $result.installer_sha256; install_exit = $result.install_exit
        pre_reboot = $result.pre_reboot; post_reboot = $result.post_reboot
        admin_login = $result.admin_login; defaults_preserved = $result.defaults_preserved
        audio_default_observations = $result.audio_default_observations
        pcm_frames = $result.pair.captured_frames; pcm_dropped = $result.pair.target.dropped_frames
        scm_restarted = $result.scm_restarted; gateway_restarted = $result.gateway_restarted
        uninstall_exit = $result.uninstall_exit; service_removed = $result.service_removed; data_preserved = $result.data_preserved
        lan_address_change = $result.lan_address_change
        diagnostics = $diagnostics
    }
    if (-not $Resume -and $testExit -eq 0 -and $result.phase -eq 'awaiting_reboot') {
        $fixtureStage = 'request_reboot'
        Restart-Computer -Force
    }
} catch {
    $failure = $_
    $file = Get-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
    Write-GuestEvidence @{
        phase = 'fixture_failed'; passed = $false; error = $failure.Exception.Message
        fixture_stage = $fixtureStage; fixture_line = $failure.InvocationInfo.ScriptLineNumber
        acceptance_exit_code = $testExit; resumed = [bool]$Resume; result_bytes = $file.Length
        commit = $package.commit; installer_sha256 = $package.file.sha256
    }
    exit 1
} finally {
    if ($Resume) { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
}

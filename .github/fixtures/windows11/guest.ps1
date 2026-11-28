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
    Send-GuestEvidence ([Convert]::ToBase64String($utf8))
}

function Send-GuestEvidence([string]$Payload) {
    $port = [System.IO.Ports.SerialPort]::new('COM1', 115200)
    try {
        $port.WriteTimeout = 8000
        $port.Open()
        $port.WriteLine('STREAMKIT_EVIDENCE ' + $Payload)
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

function Get-NewGuestBugCheck {
    $checkpoint = Get-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
    if (-not $checkpoint) { return }
    $events = Get-WinEvent -FilterHashtable @{
        LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'
        Id = 41; StartTime = $checkpoint.CreationTime.AddMinutes(-1)
    } -MaxEvents 8 -ErrorAction SilentlyContinue
    foreach ($event in $events) {
        [xml]$xml = $event.ToXml()
        $fields = @{}
        foreach ($item in $xml.Event.EventData.Data) { $fields[$item.Name] = $item.'#text' }
        if ($fields.BugcheckCode -notmatch '^[1-9][0-9]{0,9}$') { continue }
        $parameters = @(1..4 | ForEach-Object {
            $value = $fields["BugcheckParameter$_"]
            if ($value -match '^0x[0-9a-fA-F]{1,16}$') { $value }
        })
        return @{
            bugcheck_code = [uint32]$fields.BugcheckCode; bugcheck_parameters = $parameters
            recorded_utc = $event.TimeCreated.ToUniversalTime().ToString('o')
            event_record_id = $event.RecordId
        }
    }
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

function Read-InstallFailure([bool]$DiagnoseInitializer, $Identity) {
    $details = if ($DiagnoseInitializer) { Read-NativeInitialization $Identity } else { [ordered]@{} }
    $details.installer_log = Read-DiagnosticTail (Join-Path $output 'install.log') 100 8500
    $details.setupapi_delta = Read-DiagnosticTail (Join-Path $output 'setupapi-install-delta.log') 50 5000
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
        # Keep crash recording inside the verified disposable guest.
        $crashControl = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
        New-ItemProperty -LiteralPath $crashControl -Name AutoReboot -PropertyType DWord -Value 1 -Force | Out-Null
        New-ItemProperty -LiteralPath $crashControl -Name LogEvent -PropertyType DWord -Value 1 -Force | Out-Null
        New-ItemProperty -LiteralPath $crashControl -Name CrashDumpEnabled -PropertyType DWord -Value 3 -Force | Out-Null
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
    if ($Resume) {
        $fixtureStage = 'observe_resume'
        $bugcheck = Get-NewGuestBugCheck
        if ($bugcheck) {
            Write-GuestEvidence @{
                phase = 'kernel_fault'; passed = $false; bugcheck = $bugcheck
                commit = $package.commit; installer_sha256 = $package.file.sha256
            }
            exit 1
        }
        Write-GuestEvidence @{
            phase = 'resume_started'; boot_utc = $windows.LastBootUpTime.ToUniversalTime().ToString('o')
            observed_at = [DateTime]::UtcNow.ToString('o')
            commit = $package.commit; installer_sha256 = $package.file.sha256
        }
    }
    $fixtureStage = 'run_acceptance'
    $node = Join-Path $work 'node.exe'
    & $node (Join-Path $work 'scripts\accept-windows-installer.cjs') $manifest $output $mode
    $testExit = $LASTEXITCODE
    $fixtureStage = 'read_acceptance_result'
    $reporter = Join-Path $work 'scripts\result-report.cjs'
    $reportMode = if ($Resume) { 'resume' } else { 'stage' }
    $line = & $node $reporter $manifest $resultFile $testExit $reportMode
    if ($LASTEXITCODE -ne 0 -or $line -notmatch '^(awaiting_reboot|completed|failed) ([01]) ([A-Za-z0-9+/=]+)$') {
        throw 'Acceptance result could not be validated'
    }
    $phase = $Matches[1]
    $diagnoseInitializer = $Matches[2] -eq '1'
    $payload = $Matches[3]
    if ($phase -eq 'failed') {
        try { $diagnostics = Read-InstallFailure $diagnoseInitializer $package.audio_driver.identity }
        catch {
            $diagnostics = @{ diagnostic_error = $_.Exception.Message; line = $_.InvocationInfo.ScriptLineNumber }
        }
        $previousEncoding = $OutputEncoding
        try {
            $OutputEncoding = [Text.UTF8Encoding]::new($false)
            $expanded = $diagnostics | ConvertTo-Json -Depth 12 -Compress |
                & $node $reporter $manifest $resultFile $testExit diagnostics
            if ($LASTEXITCODE -eq 0 -and $expanded -match '^failed 0 ([A-Za-z0-9+/=]+)$') {
                $payload = $Matches[1]
            }
        } finally {
            $OutputEncoding = $previousEncoding
        }
    }
    $fixtureStage = 'emit_acceptance_result'
    Send-GuestEvidence $payload
    if ($phase -eq 'awaiting_reboot') {
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
        result_sha256 = $(if ($file) { (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() })
    }
    exit 1
} finally {
    if ($Resume) { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
}

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

function Read-InstallFailure($Install) {
    $details = [ordered]@{
        installer_log = Read-DiagnosticTail (Join-Path $output 'install.log') 100 8500
        setupapi_delta = Read-DiagnosticTail (Join-Path $output 'setupapi-install-delta.log') 50 5000
    }
    $diagnosticStarted = Get-Date
    $diagnostic = Join-Path $PSScriptRoot 'diagnostic'
    if ((Test-Path -LiteralPath $diagnostic -PathType Container) -and $Install.install_exit -ne 0) {
        try {
            $payload = Join-Path $work 'diagnostic'
            Copy-Item -LiteralPath $diagnostic -Destination $payload -Recurse
            $runtime = Join-Path $payload 'orchestrator\orchestrator.exe'
            $nativeLog = Join-Path $work 'diagnostic-stderr.txt'
            $nativeArguments = @('init-platform','--root',$payload,'--data-dir',(Join-Path $work 'diagnostic-data'),
                '--control-port','19000','--gateway-port','18080','--renderer-port','48989',
                '--usb-audio-vendor-id',$Install.identity.vendor_id,'--usb-audio-product-id',$Install.identity.product_id)
            if ($Install.identity.serial_prefix) {
                $nativeArguments += @('--usb-audio-serial-prefix',('"' + $Install.identity.serial_prefix + '"'))
            }
            $process = Start-Process -FilePath $runtime -ArgumentList $nativeArguments -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $work 'diagnostic-stdout.txt') -RedirectStandardError $nativeLog
            try {
                $null = $process.Handle
                if (-not $process.WaitForExit(75000)) { $process.Kill(); throw 'Native diagnostic exceeded its time limit' }
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
            }
            $details.renderer_application_events = @(Get-WinEvent -FilterHashtable @{
                LogName = 'Application'; Id = 1000,1001,1002; StartTime = $diagnosticStarted
            } -MaxEvents 15 -ErrorAction SilentlyContinue | Where-Object Message -like '*sunshine.exe*' |
                Select-Object -First 3 | ForEach-Object {
                    @{id = $_.Id; provider = $_.ProviderName; message = $_.Message.Substring(0,[Math]::Min(800,$_.Message.Length))}
                })
        } catch {
            $details.native_diagnostic_error = $_.Exception.Message
        }
    }
    return $details
}

try {
    if (-not $Resume) {
        if (-not (Confirm-SecureBootUEFI) -or -not (Get-Tpm).TpmPresent) {
            throw 'Windows did not report UEFI Secure Boot and a TPM'
        }
        Write-GuestEvidence @{ phase = 'guest_ready'; build = [int]$windows.BuildNumber; secure_boot = $true; tpm_present = $true }
        New-Item -ItemType Directory -Path $work | Out-Null
        foreach ($name in 'node.exe','guest.ps1','scripts','installer') {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $work -Recurse
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
    & (Join-Path $work 'node.exe') (Join-Path $work 'scripts\accept-windows-installer.cjs') $manifest $output $mode
    $testExit = $LASTEXITCODE
    $result = Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
    $diagnostics = if ($result.phase -eq 'failed') { Read-InstallFailure $result }
    Write-GuestEvidence @{
        phase = $result.phase; passed = $result.passed; error = $result.error
        exit_code = $testExit; commit = $result.commit; installer_source_commit = $result.installer_source_commit
        installer_sha256 = $result.installer_sha256; install_exit = $result.install_exit
        pre_reboot = $result.pre_reboot; post_reboot = $result.post_reboot
        admin_login = $result.admin_login; defaults_preserved = $result.defaults_preserved
        pcm_frames = $result.pair.captured_frames; pcm_dropped = $result.pair.target.dropped_frames
        scm_restarted = $result.scm_restarted; gateway_restarted = $result.gateway_restarted
        uninstall_exit = $result.uninstall_exit; service_removed = $result.service_removed; data_preserved = $result.data_preserved
        diagnostics = $diagnostics
    }
    if (-not $Resume -and $testExit -eq 0 -and $result.phase -eq 'awaiting_reboot') {
        Restart-Computer -Force
    }
} catch {
    Write-GuestEvidence @{phase = 'fixture_failed'; passed = $false; error = $_.Exception.Message}
    exit 1
} finally {
    if ($Resume) { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
}

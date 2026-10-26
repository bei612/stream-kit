$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root '.local/runtime'
$exe = Join-Path $root 'orchestrator/dist/orchestrator.exe'
$config = Join-Path $runtime 'config.json'
if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $config)) {
    throw 'Build orchestrator and configure the local runtime before starting.'
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 9000 -ErrorAction SilentlyContinue)
if ($listeners.Count) {
    foreach ($listener in $listeners) {
        $existing = Get-Process -Id $listener.OwningProcess
        if ($existing.Path -ne $exe) { throw 'Port 9000 belongs to another application.' }
    }
    Write-Host 'Stream-Kit is already running: http://127.0.0.1:9000'
    return
}
$process = Start-Process -FilePath $exe -ArgumentList @('--config', ('"' + $config + '"')) `
    -WorkingDirectory $runtime -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtime 'orchestrator-stdout.log') `
    -RedirectStandardError (Join-Path $runtime 'orchestrator-stderr.log')
$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'orchestrator.pid')
Write-Host "Stream-Kit started (PID $($process.Id)): http://127.0.0.1:9000"
Write-Host "Accounts: $(Join-Path $runtime 'credentials.json')"

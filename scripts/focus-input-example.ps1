param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ExamplePath
)
# Test-owned window only. Never inject system input, attach input queues, alter
# foreground policy, or interact with a remote-control/privacy window.
$ErrorActionPreference = 'Stop'
$expected = (Resolve-Path -LiteralPath $ExamplePath).Path
$owned = Get-Process -Id $ProcessId -ErrorAction Stop
try {
    if (![String]::Equals($owned.MainModule.FileName, $expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Example process ownership mismatch'
    }
    if ($owned.SessionId -ne (Get-Process -Id $PID).SessionId) { throw 'Example is in a different Windows session' }
    $owned.Refresh()
    $window = $owned.MainWindowHandle
    if ($window -eq [IntPtr]::Zero) { throw 'Example has no visible main window' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedExampleFocus {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
    if ([OwnedExampleFocus]::GetForegroundWindow() -ne $window) {
        [void][OwnedExampleFocus]::SetForegroundWindow($window)
    }
    if ([OwnedExampleFocus]::GetForegroundWindow() -ne $window) { throw 'OS did not grant focus to the owned Example; no input sent' }
    [pscustomobject]@{process_id=$owned.Id; foreground=$true} | ConvertTo-Json -Compress
} finally { $owned.Dispose() }

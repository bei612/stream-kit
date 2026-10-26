$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StreamKitWindowProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
}
'@
$example = @(Get-Process checkerboard -ErrorAction SilentlyContinue)
if ($example.Count -ne 1) { throw 'Expected exactly one checkerboard process' }
$point = New-Object StreamKitWindowProbe+Point
if (-not [StreamKitWindowProbe]::GetCursorPos([ref]$point)) { throw 'Cannot read pointer position' }
[pscustomobject]@{
    foregroundIsExample = ([StreamKitWindowProbe]::GetForegroundWindow() -eq $example[0].MainWindowHandle)
    responding = $example[0].Responding
    cursor = @{ x = $point.X; y = $point.Y }
} | ConvertTo-Json -Depth 3

param([string]$Executable = (Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts/example/checkerboard.exe'))
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$outputDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts/example'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class CheckerboardProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
    public static string Capture(IntPtr window, string path, int cols, int rows) {
        Rect rect;
        if (!GetClientRect(window, out rect) || rect.Right < 100 || rect.Bottom < 100)
            throw new Exception("Invalid client rectangle");
        using (var bitmap = new Bitmap(rect.Right, rect.Bottom)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                var dc = graphics.GetHdc();
                try { if (!PrintWindow(window, dc, 1)) throw new Exception("PrintWindow failed"); }
                finally { graphics.ReleaseHdc(dc); }
            }
            int cellW = rect.Right / cols, cellH = rect.Bottom / rows;
            var first = bitmap.GetPixel(cellW / 2, cellH / 2);
            var second = bitmap.GetPixel(cellW + cellW / 2, cellH / 2);
            var border = bitmap.GetPixel(0, 0);
            if (first.ToArgb() != Color.FromArgb(30, 41, 59).ToArgb() ||
                second.ToArgb() != Color.FromArgb(15, 23, 42).ToArgb() ||
                border.ToArgb() != Color.FromArgb(34, 197, 94).ToArgb())
                throw new Exception("Checkerboard colors or border are incorrect: " + first + ", " + second + ", " + border);
            bitmap.Save(path, ImageFormat.Png);
        }
        return rect.Right + "x" + rect.Bottom;
    }
}
'@

$results = @()
foreach ($case in @(
    @{ Name = 'default'; Arguments = ''; Cols = 8; Rows = 8 },
    @{ Name = 'custom'; Arguments = '12 6'; Cols = 12; Rows = 6 },
    @{ Name = 'fullscreen'; Arguments = '-fullscreen 10'; Cols = 10; Rows = 10 }
)) {
    $start = @{ FilePath = $Executable; PassThru = $true; WindowStyle = 'Hidden' }
    if ($case.Arguments) { $start.ArgumentList = $case.Arguments }
    $process = Start-Process @start
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 100
            $process.Refresh()
            if ($process.HasExited) { throw "Example exited before opening a window: $($process.ExitCode)" }
        } while ($process.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
        if ($process.MainWindowHandle -eq 0) { throw 'Example did not open a window within 15 seconds' }
        if (-not $process.Responding) { throw 'Example window is unresponsive' }
        if ($process.MainWindowTitle -notlike "Checkerboard $($case.Cols)x$($case.Rows)*") {
            throw "Unexpected title: $($process.MainWindowTitle)"
        }
        $screenshot = Join-Path $outputDir ($case.Name + '.png')
        $size = [CheckerboardProbe]::Capture($process.MainWindowHandle, $screenshot, $case.Cols, $case.Rows)
        $resized = $null
        if ($case.Name -eq 'custom') {
            if (-not [CheckerboardProbe]::SetWindowPos($process.MainWindowHandle, [IntPtr]::Zero, 0, 0, 960, 720, 6)) {
                throw 'Window resize failed'
            }
            Start-Sleep -Milliseconds 200
            $resized = [CheckerboardProbe]::Capture($process.MainWindowHandle, (Join-Path $outputDir 'custom-resized.png'), $case.Cols, $case.Rows)
            if ($resized -eq $size) { throw 'Client dimensions did not change after resizing' }
        }
        if (-not $process.CloseMainWindow()) { throw 'WM_CLOSE could not be sent' }
        if (-not $process.WaitForExit(5000)) { throw 'Example did not exit after WM_CLOSE' }
        if ($process.ExitCode -ne 0) { throw "Example exited with code $($process.ExitCode)" }
        $results += [pscustomobject]@{ Case = $case.Name; ClientSize = $size; Resized = $resized; Screenshot = $screenshot; ExitCode = $process.ExitCode; Passed = $true }
    } finally {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
        $process.Dispose()
    }
}
$results | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $outputDir 'smoke-results.json')
$results | Format-Table Case,ClientSize,Resized,ExitCode,Passed

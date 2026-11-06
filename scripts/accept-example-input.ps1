param(
    [Parameter(Mandatory = $true)][string]$ExamplePath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$ObserveOnly
)

# A test-owned interactive window, not a system-wide input hook or service.
# Keep OS foreground/UIPI policy intact and never type into a different window.
$ErrorActionPreference = 'Stop'
$example = (Resolve-Path -LiteralPath $ExamplePath).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new evidence directory' }
[void](New-Item -ItemType Directory -Path $output)
$stdout = Join-Path $output 'input-events.jsonl'
$stderr = Join-Path $output 'example.log'
$result = [ordered]@{
    schema_version = 1; passed = $false
    scope = $(if ($ObserveOnly) {'Example observer startup/close only; no injected input'} else {'Windows native input into an owned Example; not Android/Web end-to-end acceptance'})
    example_sha256 = (Get-FileHash -LiteralPath $example -Algorithm SHA256).Hash.ToLowerInvariant()
    started_at = [DateTime]::UtcNow.ToString('o')
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ExampleNativeInput {
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int l,t,r,b; }
 [StructLayout(LayoutKind.Explicit,Size=40)] struct INPUT {
  [FieldOffset(0)]public uint type;
  [FieldOffset(8)]public int x; [FieldOffset(12)]public int y;
  [FieldOffset(20)]public uint mouseFlags;
  [FieldOffset(8)]public ushort key; [FieldOffset(12)]public uint keyFlags;
 }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint pid);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr w,uint flag);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w,out RECT r);
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] data,int size);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint f,bool inherit,uint access);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr h,int kind,StringBuilder text,uint size,out uint needed);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
 public static string Desktop() {
  var h=OpenInputDesktop(0,false,1);
  if(h==IntPtr.Zero)return "unavailable:"+Marshal.GetLastWin32Error();
  try{var b=new StringBuilder(256);uint n;return GetUserObjectInformation(h,2,b,512,out n)?b.ToString():"unavailable:"+Marshal.GetLastWin32Error();}
  finally{CloseDesktop(h);}
 }
 public static int Key(IntPtr window) {
  if(GetForegroundWindow()!=window)throw new InvalidOperationException("Owned Example is not foreground; no key sent");
  var n=SendInput(2,new[]{new INPUT{type=1,key=0x87},new INPUT{type=1,key=0x87,keyFlags=2}},40);
  if(n!=2)throw new InvalidOperationException("Key injection rejected: "+Marshal.GetLastWin32Error());
  return (int)n;
 }
 public static int Click(IntPtr window) {
  if(GetForegroundWindow()!=window)throw new InvalidOperationException("Owned Example is not foreground; no click sent");
  RECT r;if(!GetWindowRect(window,out r))throw new InvalidOperationException("Cannot locate owned window");
  var p=new POINT{x=(r.l+r.r)/2,y=r.t+120};
  if(GetAncestor(WindowFromPoint(p),2)!=window)throw new InvalidOperationException("Owned canvas is obscured; no click sent");
  int x=(int)((long)(p.x-GetSystemMetrics(76))*65535/(GetSystemMetrics(78)-1));
  int y=(int)((long)(p.y-GetSystemMetrics(77))*65535/(GetSystemMetrics(79)-1));
  var n=SendInput(2,new[]{new INPUT{x=x,y=y,mouseFlags=0xc003},new INPUT{x=x,y=y,mouseFlags=0xc005}},40);
  if(n!=2)throw new InvalidOperationException("Click injection rejected: "+Marshal.GetLastWin32Error());
  return (int)n;
 }
}
'@

$owned = $null
$exitCode = 0
function Read-Events {
    if (!(Test-Path -LiteralPath $stdout)) { return @() }
    $events = foreach ($line in (Get-Content -LiteralPath $stdout -Encoding UTF8)) {
        try { $event = $line | ConvertFrom-Json } catch { continue }
        if ($event.type -eq 'stream-kit-example-input' -and $event.schema_version -eq 1 -and $event.process_id -eq $owned.Id) { $event }
    }
    return @($events)
}
function Wait-Event([string]$name, [uint64]$keys, [uint64]$clicks) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $event = @(Read-Events | Where-Object { $_.event -eq $name -and $_.keys -eq $keys -and $_.clicks -eq $clicks })
        if ($event.Count) { return $event[-1] }
        if ($owned.HasExited) { throw "Example exited before $name" }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Example did not receive $name with keys=$keys clicks=$clicks; sender success is not delivery"
}
try {
    [void][ExampleNativeInput]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
    $result.input_desktop = [ExampleNativeInput]::Desktop()
    if (!$ObserveOnly -and $result.input_desktop -ne 'Default') { throw 'Interactive Default desktop is unavailable; no input sent' }
    # Visibility is required to test real Win32 input; the window closes below.
    $owned = Start-Process -FilePath $example -ArgumentList '--input-events','-fullscreen' -WindowStyle Normal -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # Retain the OS process handle while it is alive, including its exit status.
    [void]$owned.Handle
    $result.process_id = $owned.Id
    $result.ready = Wait-Event 'ready' 0 0
    if (!$ObserveOnly) {
        $owned.Refresh()
        $window = $owned.MainWindowHandle
        $ownerId = [uint32]0
        [void][ExampleNativeInput]::GetWindowThreadProcessId($window, [ref]$ownerId)
        if (!$window -or $ownerId -ne $owned.Id) { throw 'Window does not belong to this test process' }
        [void][ExampleNativeInput]::SetForegroundWindow($window)
        Start-Sleep -Milliseconds 150
        if ([ExampleNativeInput]::GetForegroundWindow() -ne $window) { throw 'Windows did not grant foreground to the owned Example; no input sent' }
        $result.key_events_accepted = [ExampleNativeInput]::Key($window)
        $result.key_received = Wait-Event 'key_down' 1 0
        $result.mouse_events_accepted = [ExampleNativeInput]::Click($window)
        $result.click_received = Wait-Event 'pointer_down' 1 1
    }
    $result.passed = $true
} catch {
    $result.error = $_.Exception.Message
    $exitCode = 1
} finally {
    if ($owned -and !$owned.HasExited) {
        [void]$owned.CloseMainWindow()
        if (!$owned.WaitForExit(5000)) {
            # Only the retained process created by this script may be terminated.
            $owned.Kill()
            [void]$owned.WaitForExit(5000)
            $result.passed = $false
            $result.cleanup_error = 'Owned Example required termination'
            $exitCode = 1
        }
    }
    if ($owned) {
        $result.events = @(Read-Events)
        $result.exit_code = $owned.ExitCode
        $result.clean_exit = $owned.HasExited -and $owned.ExitCode -eq 0
        if (!$result.clean_exit -or !($result.events | Where-Object event -eq 'closed')) { $result.passed=$false; $exitCode=1 }
        $owned.Dispose()
    }
    $result.finished_at = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'result.json') -Encoding UTF8
    Write-Output ($result | ConvertTo-Json -Depth 8 -Compress)
}
exit $exitCode

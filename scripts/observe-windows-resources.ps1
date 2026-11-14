# External acceptance observer; never installed or loaded by the product.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ProgramDirectory,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [ValidateRange(2,14400)][int]$DurationSeconds = 3600,
    [ValidateRange(0,3600)][int]$WarmupSeconds = 900,
    [ValidateRange(1,60)][int]$IntervalSeconds = 15,
    [int[]]$BrowserProcessId = @()
)
$ErrorActionPreference = 'Stop'
if ($WarmupSeconds -ge $DurationSeconds) { throw 'Warmup must precede the observation window' }
if ([Math]::Ceiling($DurationSeconds / $IntervalSeconds) -gt 5000) { throw 'Observation exceeds sample budget' }
$runtimeRoot = (Resolve-Path -LiteralPath $ProgramDirectory).ProviderPath.TrimEnd('\')
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if ($outputRoot.StartsWith($runtimeRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $outputRoot -eq $runtimeRoot) { throw 'Evidence must be outside runtime' }
if (Test-Path -LiteralPath $outputRoot) { throw 'Use a new evidence directory' }
$componentPaths = @{}
foreach ($component in @('orchestrator','media-gateway','sunshine')) {
    $componentPaths[$component] = (Join-Path $runtimeRoot $component) + '\'
}
$browserOwners = @{}
foreach ($browserId in $BrowserProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$browserId"
    if (!$process -or $process.Name -notin @('chrome.exe','msedge.exe','firefox.exe')) { throw 'Expected an existing browser owner process' }
    $browserOwners[$browserId] = $process.CreationDate.ToUniversalTime().ToString('o')
}
$manifest = Get-Content -LiteralPath (Join-Path $runtimeRoot 'platform-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$componentSources = @{}
foreach ($component in $componentPaths.Keys) {
    $bundle=Get-Content -LiteralPath (Join-Path $componentPaths[$component] 'bundle-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $componentSources[$component]=$bundle.commit
}
New-Item -ItemType Directory -Path $outputRoot | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$samplesFile = Join-Path $outputRoot 'samples.jsonl'
$summaryFile = Join-Path $outputRoot 'result.json'
$watch = [Diagnostics.Stopwatch]::StartNew()
$count = 0
$result = [ordered]@{schema_version=1;complete=$false;platform_source=$manifest.commit;component_sources=$componentSources;duration_seconds=$DurationSeconds;warmup_seconds=$WarmupSeconds;interval_seconds=$IntervalSeconds;started_at=[DateTime]::UtcNow.ToString('o');samples=0;pcm_saved=$false;scope='External process private bytes, working set, handles and threads. No heap proof or 168-hour acceptance.';instances=@{};error=$null}
try {
    while ($watch.Elapsed.TotalSeconds -lt $DurationSeconds) {
        $elapsed = $watch.Elapsed.TotalSeconds
        $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,Name,PrivatePageCount,WorkingSetSize,HandleCount,ThreadCount)
        $browserTree = @{}
        foreach ($process in $processes) {
            $processId = [int]$process.ProcessId
            if ($browserOwners.ContainsKey($processId) -and $process.CreationDate.ToUniversalTime().ToString('o') -eq $browserOwners[$processId]) { $browserTree[$processId] = $process.CreationDate }
        }
        do {
            $added = $false
            foreach ($process in $processes) {
                $parent = [int]$process.ParentProcessId; $processId = [int]$process.ProcessId
                if ($browserTree.ContainsKey($parent) -and !$browserTree.ContainsKey($processId) -and $process.CreationDate -ge $browserTree[$parent]) { $browserTree[$processId]=$process.CreationDate; $added=$true }
            }
        } while ($added)
        $rows = @()
        foreach ($process in $processes) {
            $component = $null
            foreach ($name in $componentPaths.Keys) {
                if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($componentPaths[$name],[StringComparison]::OrdinalIgnoreCase)) { $component=$name; break }
            }
            if (!$component -and $browserTree.ContainsKey([int]$process.ProcessId)) { $component='owned-browser' }
            if (!$component) { continue }
            $birth = $process.CreationDate.ToUniversalTime().ToString('o')
            $row = [ordered]@{component=$component;pid=[int]$process.ProcessId;created_at=$birth;private_bytes=[long]$process.PrivatePageCount;working_set_bytes=[long]$process.WorkingSetSize;handles=[int]$process.HandleCount;threads=[int]$process.ThreadCount}
            $rows += $row
            $identity = "$($process.ProcessId)/$birth"
            if (!$result.instances.ContainsKey($identity)) {
                if ($result.instances.Count -ge 512) { throw 'Process lifecycle inventory exceeded observation budget' }
                $result.instances[$identity]=[ordered]@{component=$component;first_seen_seconds=$elapsed;last_seen_seconds=$elapsed;post_warmup_samples=0;first=$null;last=$null;peak_private_bytes=0;peak_handles=0}
            }
            $instance=$result.instances[$identity]; $instance.last_seen_seconds=$elapsed
            if ($elapsed -ge $WarmupSeconds) {
                $instance.post_warmup_samples++
                if (!$instance.first) { $instance.first=$row }
                $instance.last=$row
                $instance.peak_private_bytes=[Math]::Max($instance.peak_private_bytes,$row.private_bytes)
                $instance.peak_handles=[Math]::Max($instance.peak_handles,$row.handles)
            }
        }
        if ($rows.Count -gt 256) { throw 'Process count exceeded observation budget' }
        foreach ($component in $componentPaths.Keys) {
            if (!@($rows | Where-Object {$_.component -eq $component}).Count) { throw "No observable process for $component; use an elevated terminal and a running deployment" }
        }
        $record=[ordered]@{elapsed_seconds=$elapsed;at=[DateTime]::UtcNow.ToString('o');post_warmup=($elapsed -ge $WarmupSeconds);processes=$rows}
        [IO.File]::AppendAllText($samplesFile,($record|ConvertTo-Json -Depth 8 -Compress)+"`n",$utf8)
        $count++; $result.samples=$count
        if ((Get-Item -LiteralPath $samplesFile).Length -gt 16MB) { throw 'Evidence exceeded size budget' }
        [IO.File]::WriteAllText($summaryFile,($result|ConvertTo-Json -Depth 10),$utf8)
        # PowerShell can select Math.Min(int,int) and round a subsecond tail
        # down to zero. Explicit doubles preserve the requested sample pacing.
        $remaining=[Math]::Min([double]$IntervalSeconds,[double]($DurationSeconds-$watch.Elapsed.TotalSeconds))
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Ceiling($remaining*1000)) }
    }
    $result.complete=$true
} catch { $result.error=$_.Exception.Message; throw }
finally {
    $result.elapsed_seconds=$watch.Elapsed.TotalSeconds
    $result.finished_at=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($summaryFile,($result|ConvertTo-Json -Depth 10),$utf8)
}

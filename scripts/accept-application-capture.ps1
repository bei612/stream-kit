param(
    [Parameter(Mandatory = $true)][string]$OutputDevice,
    [string]$BuildDirectory = '.local/cmake-build-sunshine',
    [string]$ExamplePath = 'artifacts/example/checkerboard.exe'
)

# Native Windows acceptance: only test-owned renderer processes and an explicitly
# selected output device. Does not start Sunshine services or change audio defaults.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = (Resolve-Path (Join-Path $root $BuildDirectory)).Path
$example = (Resolve-Path (Join-Path $root $ExamplePath)).Path
$tests = Join-Path $build 'tests/test_sunshine.exe'
if (!(Test-Path -LiteralPath $tests -PathType Leaf)) { throw 'Build the native Sunshine test target first.' }
$report = Join-Path $root ('artifacts/application-capture/' + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ'))
New-Item -ItemType Directory -Path $report -Force | Out-Null
$variables = @('STREAM_KIT_EXAMPLE_PATH', 'STREAM_KIT_EXAMPLE_AUDIO_OUTPUT', 'STREAM_KIT_EXAMPLE_BOOTSTRAP')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$summary = [ordered]@{
    passed = $false
    scope = 'Native window frames, resize/revocation, process-tree 997 Hz audio, exited bootstrap root, and live process ownership across catalog publication. No browser transport or physical microphone claim.'
    output_device = $OutputDevice
    example_sha256 = (Get-FileHash -LiteralPath $example -Algorithm SHA256).Hash.ToLowerInvariant()
    sunshine_sha256 = (Get-FileHash -LiteralPath (Join-Path $build 'sunshine.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    test_binary_sha256 = (Get-FileHash -LiteralPath $tests -Algorithm SHA256).Hash.ToLowerInvariant()
    runs = @()
}
try {
    $env:STREAM_KIT_EXAMPLE_PATH = $example
    $env:STREAM_KIT_EXAMPLE_AUDIO_OUTPUT = $OutputDevice
    foreach ($kind in @('direct', 'bootstrap')) {
        [Environment]::SetEnvironmentVariable('STREAM_KIT_EXAMPLE_BOOTSTRAP', $(if ($kind -eq 'bootstrap') { '1' } else { $null }), 'Process')
        $filter = 'ApplicationCaptureIntegrationTest.*'
        if ($kind -eq 'direct') { $filter += ':CaptureTargetTest.*:CaptureConfigTest.*:WindowsAudioTest.*:ConfigHttpTest.CaptureCapabilities*:ProcessLifecycleIntegrationTest.*' }
        $testJson = Join-Path $report ($kind + '.json')
        $arguments = '--gtest_also_run_disabled_tests --gtest_filter=' + $filter + ' "--gtest_output=json:' + $testJson + '"'
        $process = Start-Process -FilePath $tests -ArgumentList $arguments -WorkingDirectory (Join-Path $build 'tests') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $report ($kind + '.log')) -RedirectStandardError (Join-Path $report ($kind + '.stderr.log'))
        if ($process.ExitCode -ne 0) { throw "Native $kind acceptance failed (exit $($process.ExitCode)); see $report" }
        $result = Get-Content -LiteralPath $testJson -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($result.failures -ne 0 -or $result.errors -ne 0) { throw "Native $kind acceptance reported failures" }
        $media = @($result.testsuites | Where-Object { $_.name -eq 'ApplicationCaptureIntegrationTest' })
        if ($media.Count -ne 1 -or $media[0].tests -ne 2 -or @($media[0].testsuite | Where-Object { $_.result -ne 'COMPLETED' }).Count -ne 0) { throw "Native $kind media checks were skipped or incomplete" }
        if ($kind -eq 'direct') {
            $lifecycle = @($result.testsuites | Where-Object { $_.name -eq 'ProcessLifecycleIntegrationTest' })
            if ($lifecycle.Count -ne 1 -or $lifecycle[0].tests -ne 1 -or @($lifecycle[0].testsuite | Where-Object { $_.result -ne 'COMPLETED' }).Count -ne 0) { throw 'Native process lifecycle check was skipped or incomplete' }
            $summary['lifecycle'] = $lifecycle[0].testsuite
        }
        Copy-Item -LiteralPath (Join-Path $build 'tests/application-capture.bmp') -Destination (Join-Path $report ($kind + '.bmp'))
        $summary.runs += @{ kind = $kind; tests = $result.tests; failures = $result.failures; media = $media[0].testsuite }
    }
    $summary.passed = $true
} catch {
    $summary['error'] = $_.Exception.Message
    throw
} finally {
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    $summary['finished_at'] = [DateTime]::UtcNow.ToString('o')
    $summary | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $report 'result.json') -Encoding UTF8
    Write-Output $report
}

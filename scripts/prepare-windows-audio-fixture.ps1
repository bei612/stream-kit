# Test-runner provisioning only. Never called by a product installer or runtime.
# GitHub destroys this hosted VM after the job. It has no physical audio devices;
# the caller installs only the synthetic USB audio fixture after this check.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Synthetic recording access may only be configured on a GitHub-hosted Windows test runner'
}
if (@(Get-CimInstance Win32_SoundDevice).Count -ne 0) {
    throw 'Refusing to change recording access on a runner with existing sound devices'
}
node scripts/record-windows-audio-environment.cjs --policy-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$report = 'artifacts/audio-playback/windows-environment.json'
Copy-Item -LiteralPath $report -Destination 'artifacts/audio-playback/windows-access-before.json'
$before = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
$access = $before.windows.recording_access
if ($access.machine -ne 'Allow' -or $access.app_policy -eq 2 -or $access.device_class_status -eq 'DeniedBySystem' -or $access.device_class_query_error) {
    throw 'Runner system policy does not allow synthetic recording; machine policy is not changed'
}

# Windows Server images may initialize this user's microphone consent to Deny.
# Explicit test-user consent is part of this disposable synthetic fixture, just
# as starting its audio service is. Do not change machine or enterprise policy.
$consent = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
foreach ($key in @($consent, ($consent + '\NonPackaged'))) {
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -LiteralPath $key -Name Value -Value Allow -PropertyType String -Force | Out-Null
}
node scripts/record-windows-audio-environment.cjs --policy-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$after = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
if ($after.windows.recording_access.device_class_status -ne 'Allowed') {
    throw 'Windows did not grant recording access to the synthetic test user'
}
Copy-Item -LiteralPath $report -Destination 'artifacts/audio-playback/windows-access-after.json'

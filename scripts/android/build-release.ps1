param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$')][string]$Version,
    [Parameter(Mandatory=$true)][ValidateRange(1,999999999)][int]$VersionCode,
    [string]$KeyDirectory = (Join-Path $env:LOCALAPPDATA 'StreamKitKeys\android')
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$project = Join-Path $repository 'third_party\moonlight-android'
$keyFile = Join-Path $KeyDirectory 'stream-kit-release.p12'
$passwordFile = Join-Path $KeyDirectory 'password.dpapi'
if (-not (Test-Path -LiteralPath $keyFile) -or -not (Test-Path -LiteralPath $passwordFile)) {
    throw 'Project release signing identity is missing; never create a replacement during a build.'
}
$protected = [IO.File]::ReadAllText($passwordFile).Trim() | ConvertTo-SecureString
$environmentNames = @('JAVA_HOME','ANDROID_HOME','GRADLE_USER_HOME','STREAM_KIT_ANDROID_KEYSTORE','STREAM_KIT_ANDROID_STORE_PASSWORD')
$previous = @{}
foreach ($name in $environmentNames) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Join-Path $env:LOCALAPPDATA 'Android\jdk\jdk-21.0.13+9' }
    if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    if (-not $env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = Join-Path $env:LOCALAPPDATA 'Android\gradle-cache' }
    $env:STREAM_KIT_ANDROID_KEYSTORE = $keyFile
    $env:STREAM_KIT_ANDROID_STORE_PASSWORD = (New-Object System.Net.NetworkCredential('', $protected)).Password
    $buildLog = Join-Path $env:LOCALAPPDATA 'Android\downloads\stream-kit-android-release.log'
    Push-Location $project
    try {
        $sourceCommit = (& git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Unable to identify source revision' }
        $sourceDirty = if (& git status --porcelain) { 'true' } else { 'false' }
        $buildArgs = @(':app:assembleNonRootRelease', ':app:writeManagedRuntimeInventory', "-PstreamKitVersionName=$Version", "-PstreamKitVersionCode=$VersionCode", "-PstreamKitSourceCommit=$sourceCommit", "-PstreamKitSourceDirty=$sourceDirty", '--no-daemon','--max-workers=2','--console=plain')
        # Windows PowerShell 5 turns redirected native stderr (including javac
        # warnings) into ErrorRecords. The process exit code is authoritative.
        try {
            $ErrorActionPreference = 'Continue'
            & .\gradlew.bat @buildArgs *> $buildLog
            $buildExit = $LASTEXITCODE
        } finally { $ErrorActionPreference = 'Stop' }
        if ($buildExit -ne 0) { Get-Content $buildLog -Tail 35; throw 'Android release build failed' }
        $apk = Join-Path $project 'app\build\outputs\apk\nonRoot\release\app-nonRoot-release.apk'
        $apksigner = Join-Path $env:ANDROID_HOME 'build-tools\37.0.0\apksigner.bat'
        & $apksigner verify --verbose --print-certs $apk
        if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
        Get-FileHash -LiteralPath $apk -Algorithm SHA256
        Write-Output 'Signed release candidate built; publication and media acceptance are separate steps.'
    } finally { Pop-Location }
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    $protected.Dispose()
}

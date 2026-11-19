param(
    [Parameter(Mandatory=$true)][ValidateSet('observer','bookmark')][string]$Profile,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$Sdk = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    [string]$Platform = 'android-37.0',
    [string]$BuildTools = '37.0.0',
    [string]$Jdk = (Join-Path $env:LOCALAPPDATA 'Android\jdk\jdk-21.0.13+9'),
    [string]$KeyDirectory = (Join-Path $env:LOCALAPPDATA 'StreamKitKeys\android')
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot $(if ($Profile -eq 'bookmark') { 'android-bookmark' } else { 'android' })
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new build directory; existing evidence is preserved.' }
$platformJar = Join-Path $Sdk "platforms\$Platform\android.jar"
$sdkTools = Join-Path $Sdk "build-tools\$BuildTools"
foreach ($required in @($platformJar, (Join-Path $Jdk 'bin\javac.exe'), (Join-Path $sdkTools 'aapt2.exe'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required SDK tool is missing: $required" }
}
$oldJava = $env:JAVA_HOME
$oldPassword = $env:STREAM_KIT_ACCEPTANCE_KEY_PASSWORD
$protected = $null
function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Acceptance tool failed: $([IO.Path]::GetFileName($File))" }
}
try {
    $env:JAVA_HOME = $Jdk
    New-Item -ItemType Directory -Path $output,(Join-Path $output 'classes'),(Join-Path $output 'dex') | Out-Null
    $sources = @(Get-ChildItem -LiteralPath $source -Filter '*.java' | ForEach-Object FullName)
    Invoke-Checked (Join-Path $Jdk 'bin\javac.exe') (@('-encoding','UTF-8','-source','8','-target','8','-bootclasspath',$platformJar,'-d',(Join-Path $output 'classes')) + $sources)
    $classes = @(Get-ChildItem -LiteralPath (Join-Path $output 'classes') -Recurse -Filter '*.class' | ForEach-Object FullName)
    Invoke-Checked (Join-Path $sdkTools 'd8.bat') (@('--lib',$platformJar,'--output',(Join-Path $output 'dex')) + $classes)
    $unsigned = Join-Path $output 'unsigned.apk'
    Invoke-Checked (Join-Path $sdkTools 'aapt2.exe') @('link','--manifest',(Join-Path $source 'AndroidManifest.xml'),'-I',$platformJar,'-o',$unsigned)
    Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($unsigned, [IO.Compression.ZipArchiveMode]::Update)
    try { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $output 'dex\classes.dex'),'classes.dex') | Out-Null }
    finally { $zip.Dispose() }
    $aligned = Join-Path $output 'aligned.apk'
    Invoke-Checked (Join-Path $sdkTools 'zipalign.exe') @('-f','4',$unsigned,$aligned)
    if ($Profile -eq 'bookmark') {
        $key = Join-Path $KeyDirectory 'stream-kit-release.p12'
        $protected = [IO.File]::ReadAllText((Join-Path $KeyDirectory 'password.dpapi')).Trim() | ConvertTo-SecureString
        $env:STREAM_KIT_ACCEPTANCE_KEY_PASSWORD = (New-Object System.Net.NetworkCredential('', $protected)).Password
        $alias = 'stream-kit'
    } else {
        $key = Join-Path $output 'observer.p12'
        $env:STREAM_KIT_ACCEPTANCE_KEY_PASSWORD = [Guid]::NewGuid().ToString('N')
        $alias = 'observer'
        Invoke-Checked (Join-Path $Jdk 'bin\keytool.exe') @('-genkeypair','-keystore',$key,'-storepass:env','STREAM_KIT_ACCEPTANCE_KEY_PASSWORD','-alias',$alias,'-keyalg','RSA','-keysize','2048','-validity','2','-dname','CN=Local acceptance observer')
    }
    $apk = Join-Path $output ($Profile + '.apk')
    Invoke-Checked (Join-Path $sdkTools 'apksigner.bat') @('sign','--ks',$key,'--ks-key-alias',$alias,'--ks-pass','env:STREAM_KIT_ACCEPTANCE_KEY_PASSWORD','--out',$apk,$aligned)
    Invoke-Checked (Join-Path $sdkTools 'apksigner.bat') @('verify','--verbose','--print-certs',$apk)
    Get-FileHash -LiteralPath $apk -Algorithm SHA256
} finally {
    $env:JAVA_HOME = $oldJava
    $env:STREAM_KIT_ACCEPTANCE_KEY_PASSWORD = $oldPassword
    if ($protected) { $protected.Dispose() }
}

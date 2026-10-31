# Build tools only, in the workspace. Never invoked by the product installer.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$profile = Get-Content -LiteralPath (Join-Path $repoRoot 'third_party-manifests/windows-release-tools.json') -Raw | ConvertFrom-Json
if ($profile.schema_version -ne 1) { throw 'Unsupported Windows release tool profile' }
$toolRoot = Join-Path $repoRoot '.local/toolchains/windows-release'
$downloadRoot = Join-Path $repoRoot '.local/downloads/windows-release'
New-Item -ItemType Directory -Path $toolRoot, $downloadRoot -Force | Out-Null

function Get-ReleaseTool($Definition) {
    $uri = [Uri]$Definition.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or
        $Definition.file -notmatch '^[A-Za-z0-9._-]+$' -or $Definition.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Invalid official release tool profile'
    }
    $file = Join-Path $downloadRoot $Definition.file
    if (-not (Test-Path -LiteralPath $file)) {
        Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $file
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Definition.sha256) {
        throw "Release tool SHA-256 mismatch: $($Definition.file)"
    }
    return $file
}

$cmakeArchive = Get-ReleaseTool $profile.cmake
$cmakeRoot = Join-Path $toolRoot "cmake-$($profile.cmake.version)-windows-x86_64"
if (Test-Path -LiteralPath $cmakeRoot) { throw 'Release CMake directory already exists; use a fresh workspace' }
Expand-Archive -LiteralPath $cmakeArchive -DestinationPath $toolRoot
$cmake = Join-Path $cmakeRoot 'bin/cmake.exe'
$version = & $cmake --version
if ($LASTEXITCODE -ne 0 -or $version[0] -ne "cmake version $($profile.cmake.version)") { throw 'Official CMake version mismatch' }

$innoInstaller = Get-ReleaseTool $profile.inno
$signature = Get-AuthenticodeSignature -LiteralPath $innoInstaller
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Pyrsys B\.V\.') {
    throw 'Invalid Inno Setup installer publisher signature'
}
$innoRoot = Join-Path $toolRoot "inno-$($profile.inno.version)"
if (Test-Path -LiteralPath $innoRoot) { throw 'Release Inno directory already exists; use a fresh workspace' }
$process = Start-Process -FilePath $innoInstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/SP-', '/NORESTART', '/CURRENTUSER', '/PORTABLE=1', "/DIR=`"$innoRoot`"") -PassThru -Wait -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Inno Setup build-tool installation failed: $($process.ExitCode)" }
$iscc = Join-Path $innoRoot 'ISCC.exe'
$version = & $iscc --version
if ($LASTEXITCODE -ne 0 -or -not ($version -match [Regex]::Escape($profile.inno.version))) { throw 'Official Inno compiler version mismatch' }

if ($env:GITHUB_ENV) {
    "KITWARE_BIN=$(Join-Path $cmakeRoot 'bin')" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
    "INNO_ISCC=$iscc" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
    "RELEASE_NODE_BIN=$(Split-Path -Parent (Get-Command node -ErrorAction Stop).Source)" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
}
if ($env:GITHUB_PATH) {
    (Join-Path $cmakeRoot 'bin') | Out-File -LiteralPath $env:GITHUB_PATH -Encoding utf8 -Append
}
Write-Output "Prepared official CMake $($profile.cmake.version) and Inno Setup $($profile.inno.version) for source builds."

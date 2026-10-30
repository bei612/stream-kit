$ErrorActionPreference = 'Stop'
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'Go is required on PATH' }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Rust and the native MSVC toolchain are required on PATH' }
$outputDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts/example'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$savedCGO = $env:CGO_ENABLED
$savedGOOS = $env:GOOS
$savedGOARCH = $env:GOARCH
$savedCargoTarget = $env:CARGO_TARGET_DIR
Push-Location $PSScriptRoot
try {
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $exe = Join-Path $outputDir 'checkerboard.exe'
    go build -trimpath -ldflags '-H=windowsgui' -o $exe .
    if ($LASTEXITCODE -ne 0) { throw "Example build failed (exit $LASTEXITCODE)" }
    $env:CARGO_TARGET_DIR = Join-Path (Split-Path $PSScriptRoot -Parent) '.local/targets/example-audio'
    cargo build --locked --manifest-path (Join-Path $PSScriptRoot '../components/audio-target/Cargo.toml') --bin audio-probe -j 1
    if ($LASTEXITCODE -ne 0) { throw "Example audio build failed (exit $LASTEXITCODE)" }
    $audioExe = Join-Path $outputDir 'audio-probe.exe'
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'debug/audio-probe.exe') -Destination $audioExe -Force
    Compress-Archive -LiteralPath @($exe, $audioExe) -DestinationPath (Join-Path $outputDir 'example.zip') -Force
    # Refresh the original sample locations as well, so they cannot launch an old binary.
    Copy-Item -LiteralPath $exe -Destination (Join-Path $PSScriptRoot 'checkerboard.exe') -Force
    Copy-Item -LiteralPath $audioExe -Destination (Join-Path $PSScriptRoot 'audio-probe.exe') -Force
    Copy-Item -LiteralPath (Join-Path $outputDir 'example.zip') -Destination (Join-Path (Split-Path $PSScriptRoot -Parent) 'example.zip') -Force
    Write-Host "Example built: $exe"
} finally {
    $env:CGO_ENABLED = $savedCGO
    $env:GOOS = $savedGOOS
    $env:GOARCH = $savedGOARCH
    $env:CARGO_TARGET_DIR = $savedCargoTarget
    Pop-Location
}

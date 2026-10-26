$ErrorActionPreference = 'Stop'
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'Go is required on PATH' }
$outputDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts/example'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$savedCGO = $env:CGO_ENABLED
$savedGOOS = $env:GOOS
$savedGOARCH = $env:GOARCH
Push-Location $PSScriptRoot
try {
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $exe = Join-Path $outputDir 'checkerboard.exe'
    go build -trimpath -ldflags '-H=windowsgui' -o $exe .
    if ($LASTEXITCODE -ne 0) { throw "Example build failed (exit $LASTEXITCODE)" }
    Compress-Archive -LiteralPath $exe -DestinationPath (Join-Path $outputDir 'example.zip') -Force
    Write-Host "Example built: $exe"
} finally {
    $env:CGO_ENABLED = $savedCGO
    $env:GOOS = $savedGOOS
    $env:GOARCH = $savedGOARCH
    Pop-Location
}

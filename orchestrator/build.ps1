$ErrorActionPreference = "Stop"

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)" }
}

foreach ($tool in @('git', 'go', 'npm.cmd')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Required tool is not on PATH: $tool"
    }
}

$savedCGO = $env:CGO_ENABLED
$savedGOOS = $env:GOOS
$savedGOARCH = $env:GOARCH
Push-Location $PSScriptRoot
try {
    $Version = git describe --tags --always --dirty
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine Git version' }
    $Commit = git rev-parse --short HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine Git commit' }
    $BuildTime = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $LDFlags = "-X main.version=$Version -X main.commit=$Commit -X main.buildTime=$BuildTime"

    Write-Host '[1/3] Building frontend...' -ForegroundColor Cyan
    Push-Location (Join-Path $PSScriptRoot 'web')
    try {
        Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund')
        Invoke-Checked 'npm.cmd' @('run', 'build')
    } finally { Pop-Location }

    Write-Host '[2/3] Building backend (Windows x64)...' -ForegroundColor Cyan
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    Invoke-Checked 'go' @('build', '-mod=vendor', '-trimpath', '-ldflags', $LDFlags, '-o', 'dist/orchestrator.exe', './cmd/orchestrator')

    Write-Host '[3/3] Packaging...' -ForegroundColor Cyan
    $frontendTarget = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist/dist'))
    $distRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist')) + [IO.Path]::DirectorySeparatorChar
    if (-not $frontendTarget.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Frontend output is outside the build directory'
    }
    if (Test-Path -LiteralPath $frontendTarget) { Remove-Item -LiteralPath $frontendTarget -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web/dist') -Destination $frontendTarget -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.example.json') -Destination (Join-Path $PSScriptRoot 'dist/config.example.json') -Force
    Write-Host 'Build complete: dist/orchestrator.exe, dist/dist/, dist/config.example.json' -ForegroundColor Green
} finally {
    $env:CGO_ENABLED = $savedCGO
    $env:GOOS = $savedGOOS
    $env:GOARCH = $savedGOARCH
    Pop-Location
}

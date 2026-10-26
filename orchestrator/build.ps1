$ErrorActionPreference = "Stop"

$Version = git describe --tags --always 2>$null
if (!$Version) { $Version = "dev" }
$Commit = git rev-parse --short HEAD 2>$null
if (!$Commit) { $Commit = "unknown" }
$BuildTime = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
$LDFlags = "-X main.version=$Version -X main.commit=$Commit -X main.buildTime=$BuildTime"

Write-Host "[1/3] Building frontend..." -ForegroundColor Cyan
Push-Location web
npm install --silent
npm run build
Pop-Location

Write-Host "[2/3] Building backend (Windows x64)..." -ForegroundColor Cyan
$env:CGO_ENABLED = "0"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -ldflags $LDFlags -o dist/orchestrator.exe ./cmd/orchestrator

Write-Host "[3/3] Packaging..." -ForegroundColor Cyan
if (Test-Path dist/dist) { Remove-Item -Recurse -Force dist/dist }
Copy-Item -Recurse web/dist dist/dist
Copy-Item config.example.json dist/config.example.json

Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green
Write-Host "  dist/orchestrator.exe"
Write-Host "  dist/dist/ (frontend)"
Write-Host "  dist/config.example.json"

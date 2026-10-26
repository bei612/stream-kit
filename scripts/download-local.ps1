$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$local = Join-Path $root '.local'
$downloads = Join-Path $local 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'local-components.json') | ConvertFrom-Json
foreach ($component in $manifest.components) {
    $archive = Join-Path $downloads $component.archive
    $valid = (Test-Path -LiteralPath $archive) -and ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -eq $component.sha256)
    if (-not $valid) {
        & curl.exe --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 300 $component.url --output $archive
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($component.name)" }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $component.sha256) {
        throw "SHA-256 mismatch: $($component.name)"
    }
    $destination = Join-Path $local $component.directory
    if (-not (Test-Path -LiteralPath (Join-Path $destination $component.executable))) {
        Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
    }
    Write-Host "$($component.name) $($component.version): verified and available in $destination"
}

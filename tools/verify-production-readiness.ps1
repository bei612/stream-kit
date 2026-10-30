param([string]$Cargo = 'cargo')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'third_party/moonlight-web-stream/Cargo.toml'

# Symbol searches are not behavioral acceptance tests.
& $Cargo check --locked --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw 'Media gateway compilation failed' }
& $Cargo test --locked --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw 'Media gateway unit tests failed' }
Write-Output 'Media gateway compilation and unit tests passed. Production and end-to-end acceptance remain separate requirements.'

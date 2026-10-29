$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Require-Path([string]$path) {
  if (!(Test-Path $path)) { throw "Missing required path: $path" }
}

Require-Path '.github/workflows/cross-platform-build.yml'
Require-Path 'deploy/stream-kit-orchestrator.service'
Require-Path 'deploy/install-windows-service.ps1'
Require-Path 'third_party-manifests/upstream-lock.json'
Require-Path 'third_party/sunshine'
Require-Path 'third_party/moonlight-web-stream'
Require-Path 'third_party/moonlight-qt'

$lock = Get-Content 'third_party-manifests/upstream-lock.json' -Raw | ConvertFrom-Json
foreach ($name in @('sunshine', 'moonlight-web-stream', 'moonlight-qt', 'moonlight-common-rust')) {
  if (-not $lock.components.$name) { throw "Missing upstream lock entry: $name" }
}

$media = Get-Content 'third_party/moonlight-web-stream/src/app/media.rs' -Raw
foreach ($needle in @('MediaSessionRegistry', 'publish_video', 'publish_audio', 'claim_controller', 'is_upstream_owner')) {
  if ($media -notmatch [regex]::Escape($needle)) { throw "Missing media invariant: $needle" }
}

$webrtc = Get-Content 'third_party/moonlight-web-stream/src/api/stream/webrtc/stream.rs' -Raw
foreach ($needle in @('can_control', 'dropping viewer microphone frame', 'if upstream_owner')) {
  if ($webrtc -notmatch [regex]::Escape($needle)) { throw "Missing WebRTC invariant: $needle" }
}

Write-Output 'stream-kit production-readiness static checks passed'

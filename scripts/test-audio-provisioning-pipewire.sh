#!/usr/bin/env bash
# Development-only server fixture. Private sockets; no systemd service changes.
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d /tmp/stream-kit-pipewire.XXXXXXXX)
export XDG_RUNTIME_DIR="$fixture"
export PIPEWIRE_RUNTIME_DIR="$fixture"
export PULSE_RUNTIME_PATH="$fixture/pulse"
export PULSE_SERVER="unix:$fixture/pulse/native"
mkdir -m 700 "$fixture/pulse"
pipewire > "$fixture/pipewire.log" 2>&1 &
core_pid=$!
pulse_pid=''
cleanup() {
  if [[ -n $pulse_pid ]]; then kill "$pulse_pid" 2>/dev/null || true; wait "$pulse_pid" 2>/dev/null || true; fi
  kill "$core_pid" 2>/dev/null || true
  wait "$core_pid" 2>/dev/null || true
  mkdir -p "$repo/artifacts/audio-provisioning"
  cp "$fixture/pipewire.log" "$repo/artifacts/audio-provisioning/pipewire.log"
  if [[ -f "$fixture/pulse.log" ]]; then cp "$fixture/pulse.log" "$repo/artifacts/audio-provisioning/pipewire-pulse.log"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
pipewire-pulse > "$fixture/pulse.log" 2>&1 &
pulse_pid=$!
for attempt in {1..100}; do
  kill -0 "$core_pid" "$pulse_pid"
  if pactl info >/dev/null 2>&1; then break; fi
  sleep 0.1
done
pactl info
# Establish pre-existing virtual defaults so the test can detect unintended
# default changes. There is no physical device or session manager in this fixture.
pactl load-module module-null-sink sink_name=fixture_output rate=48000 channels=2
pactl load-module module-remap-source master=fixture_output.monitor source_name=fixture_input
pactl set-default-sink fixture_output
pactl set-default-source fixture_input
cd "$repo/orchestrator"
STREAM_KIT_ISOLATED_AUDIO_TEST=1 go test -count=1 -v ./internal/audiodevice

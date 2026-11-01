#!/usr/bin/env bash
# Development-only server fixture. Private sockets; no systemd service changes.
set -euo pipefail
repo=$(cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d /tmp/stream-kit-pipewire.XXXXXXXX)
export XDG_RUNTIME_DIR="$fixture"
export PIPEWIRE_RUNTIME_DIR="$fixture"
export PULSE_RUNTIME_PATH="$fixture/pulse"
export PULSE_SERVER="unix:$fixture/pulse/native"
export XDG_CONFIG_HOME="$fixture/config"
export XDG_STATE_HOME="$fixture/state"
mkdir -m 700 "$fixture/pulse"
mkdir -p "$XDG_CONFIG_HOME/wireplumber/main.lua.d" "$XDG_CONFIG_HOME/wireplumber/bluetooth.lua.d" "$XDG_STATE_HOME"
# Ubuntu 24.04's WirePlumber 0.4 loads these overrides before 90-enable-all.
# Keep real session policy/default metadata, while disabling hardware monitors.
wireplumber --version | grep -q '0.4\.'
printf '%s\n' 'alsa_monitor.enabled = false' 'v4l2_monitor.enabled = false' 'libcamera_monitor.enabled = false' > "$XDG_CONFIG_HOME/wireplumber/main.lua.d/51-stream-kit-fixture.lua"
printf '%s\n' 'bluez_monitor.enabled = false' > "$XDG_CONFIG_HOME/wireplumber/bluetooth.lua.d/51-stream-kit-fixture.lua"
pipewire > "$fixture/pipewire.log" 2>&1 &
core_pid=$!
pulse_pid=''
policy_pid=''
cleanup() {
  if [[ -n $policy_pid ]]; then kill "$policy_pid" 2>/dev/null || true; wait "$policy_pid" 2>/dev/null || true; fi
  if [[ -n $pulse_pid ]]; then kill "$pulse_pid" 2>/dev/null || true; wait "$pulse_pid" 2>/dev/null || true; fi
  kill "$core_pid" 2>/dev/null || true
  wait "$core_pid" 2>/dev/null || true
  mkdir -p "$repo/artifacts/audio-provisioning"
  cp "$fixture/pipewire.log" "$repo/artifacts/audio-provisioning/pipewire.log"
  if [[ -f "$fixture/pulse.log" ]]; then cp "$fixture/pulse.log" "$repo/artifacts/audio-provisioning/pipewire-pulse.log"; fi
  if [[ -f "$fixture/policy.log" ]]; then cp "$fixture/policy.log" "$repo/artifacts/audio-provisioning/wireplumber.log"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
pipewire-pulse > "$fixture/pulse.log" 2>&1 &
pulse_pid=$!
wireplumber > "$fixture/policy.log" 2>&1 &
policy_pid=$!
for attempt in {1..100}; do
  kill -0 "$core_pid" "$pulse_pid" "$policy_pid"
  if pactl info >/dev/null 2>&1; then break; fi
  sleep 0.1
done
pactl info
# Establish pre-existing virtual defaults so the test can detect unintended
# default changes. Hardware monitors are disabled in the private session policy.
pactl load-module module-null-sink sink_name=fixture_output rate=48000 channels=2
pactl load-module module-remap-source master=fixture_output.monitor source_name=fixture_input
for attempt in {1..100}; do
  if pactl set-default-sink fixture_output && pactl set-default-source fixture_input; then break; fi
  kill -0 "$policy_pid"
  sleep 0.1
done
[[ $(pactl get-default-sink) == fixture_output && $(pactl get-default-source) == fixture_input ]]
mkdir -p "$repo/artifacts/audio-provisioning"
pactl list short modules > "$repo/artifacts/audio-provisioning/pipewire-modules.txt"
pactl --format=json list modules > "$repo/artifacts/audio-provisioning/pipewire-modules.json"
cd "$repo/orchestrator"
STREAM_KIT_ISOLATED_AUDIO_TEST=1 go test -count=1 -v ./internal/audiodevice

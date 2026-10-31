#!/bin/sh
# Real virtual-device acceptance in an isolated user PulseAudio instance.
# No hardware modules, TCP listener, system defaults, or existing daemon changes.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
application_only=0
if [ "${1:-}" = --application-only ]; then
    application_only=1
    shift
    [ "$#" -eq 1 ] && [ -x "$1" ] || { echo 'Pass an absolute path to test_sunshine' >&2; exit 2; }
fi
cd "$repo/components/audio-target"
if [ "$application_only" -eq 0 ]; then
    cargo build --locked --examples
fi
fixture=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/stream-kit-audio.XXXXXX")
mkdir "$fixture/runtime" "$fixture/state"
export PULSE_RUNTIME_PATH="$fixture/runtime"
export PULSE_STATE_PATH="$fixture/state"
export PULSE_SERVER="unix:$fixture/native"
# Anonymous authentication is confined to a Unix socket inside a mode-0700
# test directory. This fixture never exposes a production or network endpoint.
cat > "$fixture/default.pa" <<EOF
load-module module-null-sink sink_name=stream_kit_acceptance rate=48000 channels=2 sink_properties=device.description=StreamKitAcceptance
load-module module-remap-source master=stream_kit_acceptance.monitor source_name=stream_kit_capture source_properties=device.description=StreamKitCapture
load-module module-native-protocol-unix socket=$fixture/native auth-anonymous=1
EOF
pulseaudio -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --file="$fixture/default.pa" --log-target="file:$fixture/server.log" &
server_pid=$!
cleanup() { kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
attempt=0
until pactl info >/dev/null 2>&1; do
    if ! kill -0 "$server_pid" 2>/dev/null || [ "$attempt" -ge 30 ]; then
        cat "$fixture/server.log"
        exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done
mkdir -p "$repo/artifacts/audio-target"
if [ "$application_only" -eq 0 ]; then
    cargo run --locked --quiet --example verify_pair -- pulseaudio:stream_kit_acceptance pulseaudio:stream_kit_capture > "$repo/artifacts/audio-target/linux-pair-result.json"
    cat "$repo/artifacts/audio-target/linux-pair-result.json"
fi
cp "$fixture/server.log" "$repo/artifacts/audio-target/linux-pulse.log"
if [ "$#" -gt 0 ]; then
    # Optional absolute path to the source-built Sunshine test executable.
    # Reuse this hardware-free server to exercise real per-application monitors.
    PULSE_SINK=stream_kit_acceptance STREAM_KIT_TEST_PULSE_APPLICATION_AUDIO=1 \
        "$1" --gtest_filter='LinuxApplicationAudio.*:LinuxCaptureTargetTest.*' \
        --gtest_output="json:$repo/artifacts/audio-target/linux-application-audio.json"
fi

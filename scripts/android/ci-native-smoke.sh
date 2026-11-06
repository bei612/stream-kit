#!/usr/bin/env bash
set -euo pipefail
# Hosted-runner-only fixture. The separate instrumentation APK is never published.
test -c /dev/kvm
sudo chmod a+rw /dev/kvm
avdmanager create avd --force --name StreamKit_Release_CI \
  --package 'system-images;android-36;google_apis;x86_64' --device pixel_6 <<< 'no'
"$ANDROID_HOME/emulator/emulator" -avd StreamKit_Release_CI -port 5580 \
  -no-window -no-snapshot -noaudio -no-boot-anim -gpu swiftshader \
  > "$RUNNER_TEMP/stream-kit-emulator.log" 2>&1 &
emulator_pid=$!
trap 'kill "$emulator_pid" 2>/dev/null || true' EXIT
ready=false
for attempt in $(seq 1 150); do
  kill -0 "$emulator_pid"
  if [[ "$(adb -s emulator-5580 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == '1' ]]; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  tail -n 60 "$RUNNER_TEMP/stream-kit-emulator.log"
  exit 1
fi
adb -s emulator-5580 install -r third_party/moonlight-android/app/build/outputs/apk/nonRoot/release/app-nonRoot-release.apk
adb -s emulator-5580 install -r third_party/moonlight-android/app/build/outputs/apk/androidTest/nonRoot/release/app-nonRoot-release-androidTest.apk
result=$(adb -s emulator-5580 shell am instrument -w io.github.bei612.streamkit.test/com.limelight.streamkit.NativeLibrarySmoke)
printf '%s\n' "$result"
grep -q 'stream_kit_native_smoke=passed' <<< "$result"
grep -q 'INSTRUMENTATION_CODE: -1' <<< "$result"

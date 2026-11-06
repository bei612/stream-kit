#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]]
test -c /dev/kvm
scratch=$(mktemp -d "$RUNNER_TEMP/stream-kit-input.XXXXXXXX")
evidence="$GITHUB_WORKSPACE/artifacts/android-input-evidence"
tls="$scratch/tls"
mkdir -p "$tls" "$evidence"
umask 077
export ANDROID_AVD_HOME="$scratch/avd"
mkdir -p "$ANDROID_AVD_HOME"
serial=emulator-5580
display_pid='' wm_pid='' emulator_pid=''
cleanup() {
  # Retain only resource/termination diagnostics, never intent URLs, full
  # logcat, UI contents or credentials. These remain test artifacts only.
  if [[ -n "$emulator_pid" ]]; then
    timeout 5s adb -s "$serial" shell cat /proc/meminfo > "$evidence/android-memory.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" logcat -d -b events -s am_kill:I am_proc_died:I '*:S' > "$evidence/android-process-exits.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" logcat -d -s lowmemorykiller:I lmkd:I '*:S' > "$evidence/android-memory-kills.txt" 2>/dev/null || true
  fi
  if [[ -n "$emulator_pid" ]]; then timeout 10s adb -s "$serial" emu kill >/dev/null 2>&1 || true; kill "$emulator_pid" 2>/dev/null || true; fi
  if [[ -n "$wm_pid" ]]; then kill "$wm_pid" 2>/dev/null || true; fi
  if [[ -n "$display_pid" ]]; then kill "$display_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Stream Kit isolated input CI CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=Stream Kit isolated input CI' \
  -keyout "$tls/server.key" -out "$tls/server.csr" >/dev/null 2>&1
cat > "$tls/leaf.ext" <<'CERT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,IP:10.0.2.2,DNS:localhost
CERT
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -days 1 -sha256 -extfile "$tls/leaf.ext" -out "$tls/server.crt" >/dev/null 2>&1
openssl verify -CAfile "$tls/ca.crt" "$tls/server.crt"
openssl x509 -in "$tls/ca.crt" -noout -fingerprint -sha256 > "$evidence/test-ca-fingerprint.txt"
# Trust belongs only to this disposable CI machine and official AVD. No TLS
# error overrides, custom TrustManager, debug APK or production CA is used.
sudo install -m 644 "$tls/ca.crt" /usr/local/share/ca-certificates/stream-kit-isolated-input.crt
sudo update-ca-certificates >/dev/null
mkdir -p "$HOME/.pki/nssdb"
if [[ ! -f "$HOME/.pki/nssdb/cert9.db" ]]; then certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password; fi
certutil -A -d "sql:$HOME/.pki/nssdb" -n StreamKitIsolatedInput -t 'C,,' -i "$tls/ca.crt"
export NODE_EXTRA_CA_CERTS="$tls/ca.crt"
sudo chmod a+rw /dev/kvm
avdmanager create avd --name StreamKit_Input_CI --package 'system-images;android-36;google_apis;x86_64' --device pixel_6 <<< no
"$ANDROID_HOME/emulator/emulator" -avd StreamKit_Input_CI -port 5580 -memory 4096 -no-window -no-snapshot -noaudio -no-boot-anim -gpu swiftshader \
  > "$evidence/emulator.log" 2>&1 &
emulator_pid=$!
ready=false
boot_deadline=$((SECONDS + 300))
while (( SECONDS < boot_deadline )); do
  kill -0 "$emulator_pid"
  if [[ "$(timeout 5s adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
# AOSP UserCertificateSource reads the user store under /data/misc/user/<id>.
# Provision the public test CA on the root-capable official CI image before
# launching the release APK, then return adbd to its ordinary shell identity.
adb -s "$serial" root
timeout 30s adb -s "$serial" wait-for-device
[[ $(adb -s "$serial" shell am get-current-user | tr -d '\r') == 0 ]]
ca_hash=$(openssl x509 -in "$tls/ca.crt" -subject_hash_old -noout)
[[ "$ca_hash" =~ ^[0-9a-f]{8}$ ]]
adb -s "$serial" shell mkdir -p /data/misc/user/0/cacerts-added
adb -s "$serial" shell chown system:system /data/misc/user/0/cacerts-added
adb -s "$serial" shell chmod 755 /data/misc/user/0/cacerts-added
adb -s "$serial" push "$tls/ca.crt" "/data/misc/user/0/cacerts-added/$ca_hash.0" >/dev/null
adb -s "$serial" shell chown system:system "/data/misc/user/0/cacerts-added/$ca_hash.0"
adb -s "$serial" shell chmod 644 "/data/misc/user/0/cacerts-added/$ca_hash.0"
adb -s "$serial" shell restorecon -R /data/misc/user/0/cacerts-added
adb -s "$serial" unroot
timeout 30s adb -s "$serial" wait-for-device
[[ $(adb -s "$serial" shell id -u | tr -d '\r') == 2000 ]]
adb -s "$serial" install artifacts/input-download/*.apk
adb -s "$serial" install -t artifacts/input-example/android/observer.apk
adb -s "$serial" shell input keyevent KEYCODE_WAKEUP
adb -s "$serial" shell wm dismiss-keyguard
export DISPLAY=:91
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp > "$evidence/xvfb.log" 2>&1 &
display_pid=$!
for attempt in $(seq 1 30); do if xdpyinfo >/dev/null 2>&1; then break; fi; sleep 1; done
xdpyinfo >/dev/null
openbox > "$evidence/window-manager.log" 2>&1 &
wm_pid=$!
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=streamkit_ci >/dev/null
pactl set-default-sink streamkit_ci
runtime=artifacts/input-runtime/opt/stream-kit
node scripts/accept-source-stream.cjs --sunshine "$runtime/sunshine/bin/sunshine" --gateway "$runtime/media-gateway/web-server" \
  --orchestrator "$runtime/orchestrator/orchestrator" --web-assets "$runtime/media-gateway/dist" \
  --example artifacts/input-example/x11-observer --verify-input --clients 2 --hold-seconds 0 \
  --android-serial "$serial" --android-adb "$ANDROID_HOME/platform-tools/adb" --tls-dir "$tls"

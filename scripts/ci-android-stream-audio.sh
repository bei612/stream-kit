#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]]
test -c /dev/kvm
scratch=$(mktemp -d "$RUNNER_TEMP/stream-kit-audio.XXXXXXXX")
evidence="$GITHUB_WORKSPACE/artifacts/android-audio-evidence"
tls="$scratch/tls"
mkdir -p "$tls" "$evidence"
umask 077
export ANDROID_AVD_HOME="$scratch/avd"
mkdir -p "$ANDROID_AVD_HOME"
serial=emulator-5580
display_pid='' wm_pid='' emulator_pid='' pulse_pid=''
cleanup() {
  # Retain only resource/termination diagnostics, never intent URLs, full
  # logcat, UI contents or credentials. These remain test artifacts only.
  if [[ -n "$emulator_pid" ]]; then
    timeout 5s adb -s "$serial" shell cat /proc/meminfo > "$evidence/android-memory.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" shell dumpsys cpuinfo > "$evidence/android-cpu.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" logcat -d -b events -s am_kill:I am_proc_died:I '*:S' > "$evidence/android-process-exits.txt" 2>/dev/null || true
    timeout 5s adb -s "$serial" logcat -d -s lowmemorykiller:I lmkd:I '*:S' > "$evidence/android-memory-kills.txt" 2>/dev/null || true
  fi
  if [[ -n "$emulator_pid" ]]; then timeout 10s adb -s "$serial" emu kill >/dev/null 2>&1 || true; kill "$emulator_pid" 2>/dev/null || true; fi
  if [[ -n "$wm_pid" ]]; then kill "$wm_pid" 2>/dev/null || true; fi
  if [[ -n "$display_pid" ]]; then kill "$display_pid" 2>/dev/null || true; fi
  if [[ -n "$pulse_pid" ]]; then kill "$pulse_pid" 2>/dev/null || true; fi
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
# Private real PulseAudio server and separate endpoints. No host defaults change.
mkdir -p "$scratch/pulse-runtime" "$scratch/pulse-state"
export PULSE_RUNTIME_PATH="$scratch/pulse-runtime" PULSE_STATE_PATH="$scratch/pulse-state"
export PULSE_SERVER="unix:$scratch/pulse.sock"
cat > "$scratch/pulse.pa" <<EOF
load-module module-null-sink sink_name=streamkit_host rate=48000 channels=2
load-module module-null-sink sink_name=streamkit_android rate=48000 channels=2
load-module module-remap-source master=streamkit_android.monitor source_name=streamkit_android_capture
load-module module-null-sink sink_name=streamkit_program rate=48000 channels=2
load-module module-null-sink sink_name=streamkit_microphone rate=48000 channels=2
load-module module-remap-source master=streamkit_microphone.monitor source_name=streamkit_microphone_capture
load-module module-native-protocol-unix socket=$scratch/pulse.sock auth-anonymous=1
set-default-sink streamkit_host
EOF
pulseaudio -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --file="$scratch/pulse.pa" --log-target="file:$evidence/pulse.log" &
pulse_pid=$!
for attempt in $(seq 1 50); do if pactl info >/dev/null 2>&1; then break; fi; kill -0 "$pulse_pid"; sleep 0.1; done
pactl info >/dev/null

# The official Linux -no-window launcher selects a headless binary whose public
# implementation links PulseAudio stubs. Use the full official binary on this
# isolated X server so an actual PulseAudio output backend is required.
export DISPLAY=:91
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp > "$evidence/xvfb.log" 2>&1 &
display_pid=$!
for attempt in $(seq 1 30); do if xdpyinfo >/dev/null 2>&1; then break; fi; kill -0 "$display_pid"; sleep 1; done
xdpyinfo >/dev/null
openbox > "$evidence/window-manager.log" 2>&1 &
wm_pid=$!

sudo chmod a+rw /dev/kvm
avdmanager create avd --name StreamKit_Audio_CI --package 'system-images;android-36;google_apis;x86_64' --device pixel_6 <<< no
PULSE_SINK=streamkit_android "$ANDROID_HOME/emulator/emulator" -avd StreamKit_Audio_CI -port 5580 -memory 4096 -no-snapshot -no-boot-anim -gpu swiftshader -grpc 8554 -grpc-use-token \
  > "$evidence/emulator.log" 2>&1 &
emulator_pid=$!
export STREAM_KIT_AUDIO_EMULATOR_ROOT_PID="$emulator_pid"
ready=false
boot_deadline=$((SECONDS + 300))
while (( SECONDS < boot_deadline )); do
  kill -0 "$emulator_pid"
  if [[ "$(timeout 5s adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
# Restarting adbd can close its requesting transport before the acknowledgement.
# Verify the resulting identity after reconnection; never trust only exit status.
adb_identity() {
  local action="$1" expected="$2" deadline=$((SECONDS + 40))
  while (( SECONDS < deadline )); do
    timeout 8s adb -s "$serial" "$action" >/dev/null 2>&1 || true
    timeout 5s adb -s "$serial" wait-for-device >/dev/null 2>&1 || true
    if [[ "$(timeout 5s adb -s "$serial" shell id -u 2>/dev/null | tr -d '\r' || true)" == "$expected" ]]; then return 0; fi
    sleep 1
  done
  echo "Official test emulator did not enter requested adb identity: $expected" >&2
  return 1
}
# AOSP UserCertificateSource reads the user store under /data/misc/user/<id>.
# Provision the public test CA on the root-capable official CI image before
# launching the release APK, then return adbd to its ordinary shell identity.
adb_identity root 0
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
adb_identity unroot 2000
# Bound software rasterization cost independently of the 720p30 stream profile.
adb -s "$serial" shell wm size 720x1280
adb -s "$serial" shell wm density 240
adb -s "$serial" install artifacts/input-download/*.apk
adb -s "$serial" install -t artifacts/input-example/android/observer.apk
adb -s "$serial" shell input keyevent KEYCODE_WAKEUP
adb -s "$serial" shell wm dismiss-keyguard
# Locate the official owned emulator discovery entry, retaining its token only
# in this private scratch directory. Never print/upload discovery or token data.
node - "$scratch/grpc.json" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const matches=new Map();
function walk(dir,depth){if(depth>7||!fs.existsSync(dir))return;let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())walk(file,depth+1);else if(/^pid_[0-9]+(?:_info)?\.ini$/.test(entry.name)){let value;try{if(fs.statSync(file).size>65536)continue;value=fs.readFileSync(file,'utf8')}catch{continue}if(/^grpc.port=8554\s*$/m.test(value)){const token=value.match(/^grpc.token=(.+)$/m)?.[1].trim();if(token)matches.set(file,token)}}}}
for(const root of [os.tmpdir(),'/run/user/'+process.getuid(),path.join(os.homedir(),'.android'),process.env.RUNNER_TEMP].filter(Boolean))walk(root,0);
assert.equal(matches.size,1,'Expected one authenticated official emulator discovery entry');
fs.writeFileSync(process.argv[2],JSON.stringify({address:'127.0.0.1:8554',token:[...matches.values()][0]}),{mode:0o600});
NODE
runtime=artifacts/input-runtime/opt/stream-kit
node scripts/accept-source-stream.cjs --sunshine "$runtime/sunshine/bin/sunshine" --gateway "$runtime/media-gateway/web-server" \
  --orchestrator "$runtime/orchestrator/orchestrator" --web-assets "$runtime/media-gateway/dist" \
  --example artifacts/input-example/x11-audio-program --example-output streamkit_program --android-audio --clients 2 --hold-seconds 0 \
  --android-serial "$serial" --android-adb "$ANDROID_HOME/platform-tools/adb" --tls-dir "$tls" \
  --android-grpc-config "$scratch/grpc.json" --audio-probe artifacts/input-example/audio-probe \
  --target-render-device pulseaudio:streamkit_microphone --target-capture-device pulseaudio:streamkit_microphone_capture

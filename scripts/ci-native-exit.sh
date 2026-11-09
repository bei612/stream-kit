#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]]
scratch=$(mktemp -d "$RUNNER_TEMP/stream-kit-native-exit.XXXXXXXX")
evidence="$GITHUB_WORKSPACE/artifacts/native-exit-evidence"
tls="$scratch/tls"
mkdir -p "$tls" "$evidence"
umask 077
display_pid='' wm_pid=''
cleanup() {
  if [[ -n "$wm_pid" ]]; then kill "$wm_pid" 2>/dev/null || true; fi
  if [[ -n "$display_pid" ]]; then kill "$display_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Stream Kit isolated native exit CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=Stream Kit isolated native exit' \
  -keyout "$tls/server.key" -out "$tls/server.csr" >/dev/null 2>&1
cat > "$tls/leaf.ext" <<'CERT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:localhost
CERT
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -days 1 -sha256 -extfile "$tls/leaf.ext" -out "$tls/server.crt" >/dev/null 2>&1
openssl verify -CAfile "$tls/ca.crt" "$tls/server.crt"
sudo install -m 644 "$tls/ca.crt" /usr/local/share/ca-certificates/stream-kit-native-exit.crt
sudo update-ca-certificates >/dev/null
mkdir -p "$HOME/.pki/nssdb"
if [[ ! -f "$HOME/.pki/nssdb/cert9.db" ]]; then certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password; fi
certutil -A -d "sql:$HOME/.pki/nssdb" -n StreamKitNativeExit -t 'C,,' -i "$tls/ca.crt"
export NODE_EXTRA_CA_CERTS="$tls/ca.crt"
export DISPLAY=:91
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp > "$evidence/xvfb.log" 2>&1 &
display_pid=$!
for attempt in $(seq 1 30); do if xdpyinfo >/dev/null 2>&1; then break; fi; sleep 1; done
xdpyinfo >/dev/null
openbox > "$evidence/window-manager.log" 2>&1 &
wm_pid=$!
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=streamkit_native_exit >/dev/null
pactl set-default-sink streamkit_native_exit
runtime=artifacts/input-runtime/opt/stream-kit
node scripts/accept-source-stream.cjs --sunshine "$runtime/sunshine/bin/sunshine" --gateway "$runtime/media-gateway/web-server" \
  --orchestrator "$runtime/orchestrator/orchestrator" --web-assets "$runtime/media-gateway/dist" \
  --example artifacts/input-example/x11-observer --verify-native-exit --clients 2 --hold-seconds 0 --tls-dir "$tls"

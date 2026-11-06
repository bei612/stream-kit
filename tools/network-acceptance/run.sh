#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID != 0 ]]
scratch=$(mktemp -d "$RUNNER_TEMP/stream-kit-network.XXXXXXXX")
export STREAM_KIT_NETWORK_FIXTURE="$scratch"
mkdir -p "$scratch/client-run" "$scratch/tls" artifacts/network-address-evidence
umask 077
server_if=sknet-server
client_ns=sknet-client
! ip link show "$server_if" >/dev/null 2>&1
! ip netns list | cut -d ' ' -f 1 | grep -Fxq "$client_ns"
namespace_created=false interface_created=false
client_pid='' avahi_pid='' display_pid=''
cleanup() {
  for log in server-avahi client-avahi client-dbus xvfb; do
    if [[ -f "$scratch/$log.log" ]]; then sudo cat "$scratch/$log.log" > "artifacts/network-address-evidence/$log.log"; fi
  done
  if [[ -f "$scratch/client.pid" ]]; then
    local owned_pid; owned_pid=$(cat "$scratch/client.pid")
    if [[ "$owned_pid" =~ ^[1-9][0-9]*$ ]] && sudo cat "/proc/$owned_pid/cmdline" 2>/dev/null | tr '\0' '\n' | grep -Fxq "$GITHUB_WORKSPACE/tools/network-acceptance/client.sh"; then sudo kill -TERM "$owned_pid" || true; fi
  fi
  if [[ -n "$avahi_pid" ]]; then sudo kill "$avahi_pid" 2>/dev/null || true; fi
  if [[ -n "$display_pid" ]]; then kill "$display_pid" 2>/dev/null || true; fi
  if [[ "$interface_created" == true ]]; then sudo ip link delete "$server_if" 2>/dev/null || true; fi
  if [[ "$namespace_created" == true ]]; then sudo ip netns delete "$client_ns" 2>/dev/null || true; fi
}
trap cleanup EXIT
sudo ip netns add "$client_ns"
namespace_created=true
sudo ip link add "$server_if" type veth peer name sknet-peer
interface_created=true
sudo ip link set sknet-peer netns "$client_ns"
sudo ip address add 198.18.31.1/24 dev "$server_if"
sudo ip link set "$server_if" up
sudo ip -n "$client_ns" address add 198.18.31.100/24 dev sknet-peer
sudo ip -n "$client_ns" link set lo up
sudo ip -n "$client_ns" link set sknet-peer up
# No default route: the client can reach only the dedicated fixture LAN.
for side in server client; do
  interface="$server_if"; [[ "$side" == client ]] && interface=sknet-peer
  cat > "$scratch/$side-avahi.conf" <<EOF
[server]
host-name=stream-kit-$side
use-ipv4=yes
use-ipv6=no
allow-interfaces=$interface
[publish]
publish-hinfo=no
publish-workstation=no
EOF
done
chmod 711 "$scratch"
chmod 700 "$scratch/tls"
chmod 644 "$scratch/server-avahi.conf" "$scratch/client-avahi.conf"
sudo systemctl stop avahi-daemon.socket avahi-daemon.service || true
sudo systemctl start dbus
sudo avahi-daemon --no-chroot -f "$scratch/server-avahi.conf" > "$scratch/server-avahi.log" 2>&1 &
avahi_pid=$!
sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,RUNNER_TEMP ip netns exec "$client_ns" \
  unshare --mount bash "$GITHUB_WORKSPACE/tools/network-acceptance/client.sh" "$scratch" &
client_pid=$!
for attempt in $(seq 1 100); do [[ -f "$scratch/client.pid" ]] && break; kill -0 "$client_pid"; sleep 0.1; done
[[ -f "$scratch/client.pid" ]]
tls="$scratch/tls"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=Stream Kit isolated network CI CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=stream-kit-server.local' \
  -keyout "$tls/server.key" -out "$tls/server.csr" >/dev/null 2>&1
cat > "$tls/leaf.ext" <<'CERT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:stream-kit-server.local,IP:127.0.0.1
CERT
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -days 1 -sha256 -extfile "$tls/leaf.ext" -out "$tls/server.crt" >/dev/null 2>&1
sudo install -m 644 "$tls/ca.crt" /usr/local/share/ca-certificates/stream-kit-isolated-network.crt
sudo update-ca-certificates >/dev/null
mkdir -p "$HOME/.pki/nssdb"
if [[ ! -f "$HOME/.pki/nssdb/cert9.db" ]]; then certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password; fi
certutil -A -d "sql:$HOME/.pki/nssdb" -n StreamKitIsolatedNetwork -t 'C,,' -i "$tls/ca.crt"
export NODE_EXTRA_CA_CERTS="$tls/ca.crt" DISPLAY=:92
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp > "$scratch/xvfb.log" 2>&1 &
display_pid=$!
for attempt in $(seq 1 30); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
xdpyinfo >/dev/null
bash scripts/test-audio-target-linux.sh --command node tools/network-acceptance/verify.cjs

#!/usr/bin/env bash
# Generated payload metadata is inserted by build-linux-installer.mjs.
set -euo pipefail
umask 077
fail() { printf 'Stream-Kit: %s\n' "$*" >&2; exit 1; }
render_user=''
start=1
while (($#)); do
  case "$1" in
    --user) (($# >= 2)) || fail '--user requires the rendering session owner'; render_user=$2; shift 2 ;;
    --no-start) start=0; shift ;;
    --help) printf 'Usage: sudo bash INSTALLER.run --user RENDER_USER [--no-start]\nUbuntu 24.04 amd64; installs native components and preserves existing data.\n'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[[ $EUID == 0 ]] || fail 'Run the installer with sudo; rendering itself runs as the selected user'
[[ $render_user =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail '--user must name the non-root rendering session owner'
[[ $(uname -m) == x86_64 ]] || fail 'This package requires amd64'
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || fail 'This package targets Ubuntu 24.04'
entry=$(getent passwd "$render_user") || fail 'Rendering user does not exist'
IFS=: read -r account _ uid gid _ home login_shell <<< "$entry"
[[ $uid -ge 1000 && $uid -lt 65534 && $home == /* && -d $home && ! -L $home ]] || fail 'Select a regular rendering user with an existing real home directory'
[[ $(stat -c %u "$home") == "$uid" ]] || fail 'Rendering home has a different owner'
if [[ -e /var/lib/stream-kit/render-user ]]; then
  [[ $(cat /var/lib/stream-kit/render-user) == "$render_user" ]] || fail 'Existing installation belongs to another rendering user'
fi
as_user() {
  runuser -u "$render_user" -- env HOME="$home" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}
if ((start)); then
  [[ -S /run/user/$uid/bus ]] || fail 'No active user service manager; log in as the rendering user or use --no-start'
  as_user systemctl --user show-environment | grep -Eq '^(DISPLAY|WAYLAND_DISPLAY)=.+' || fail 'Rendering session environment is unavailable; use --no-start and start after desktop login'
fi
# Verify bytes before asking the package manager to change the host. No Node,
# compilers, shell-downloaded application binaries or runtime npm are involved.
temporary=$(mktemp -d /tmp/stream-kit-install.XXXXXXXX)
trap 'rm -f -- "$temporary/stream-kit.deb"; rmdir -- "$temporary"' EXIT
payload_line=$(awk '/^__STREAM_KIT_PAYLOAD__$/ { print NR + 1; exit }' "$0")
[[ $payload_line =~ ^[0-9]+$ ]] || fail 'Installer payload marker is missing'
tail -n +"$payload_line" "$0" > "$temporary/stream-kit.deb"
[[ $(sha256sum "$temporary/stream-kit.deb" | cut -d ' ' -f 1) == "$STREAM_KIT_PAYLOAD_SHA256" ]] || fail 'Installer payload hash mismatch'
# Let apt's sandbox read only this immutable, verified package.
chmod 755 "$temporary"
chmod 644 "$temporary/stream-kit.deb"
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$temporary/stream-kit.deb"
install -d -m 700 /var/lib/stream-kit
printf '%s\n' "$render_user" > /var/lib/stream-kit/render-user
binary=/opt/stream-kit/orchestrator/orchestrator
for component in orchestrator media-gateway sunshine; do as_user "$binary" verify-bundle "/opt/stream-kit/$component"; done
data="$home/.local/share/stream-kit/runtime"
if [[ -e $data || -L $data ]]; then
  [[ -d $data && ! -L $data && $(stat -c %u "$data") == "$uid" ]] || fail 'Existing runtime data has an invalid type or owner'
  as_user "$binary" check-config --config "$data/orchestrator.json"
else
  as_user install -d -m 700 "$home/.local/share/stream-kit"
  as_user "$binary" init-platform --root /opt/stream-kit --data-dir "$data"
fi
if ((start)); then
  modprobe uinput
  modprobe uhid
  udevadm control --reload-rules
  udevadm trigger --property-match=DEVNAME=/dev/uinput
  udevadm trigger --property-match=DEVNAME=/dev/uhid
  as_user systemctl --user daemon-reload
  as_user systemctl --user enable stream-kit.service
  as_user systemctl --user restart stream-kit.service
  as_user systemctl --user is-active --quiet stream-kit.service
  printf 'Stream-Kit service started; check component readiness in management. Administrator credentials: %s/orchestrator.json\n' "$data"
else
  printf 'Stream-Kit installed and configured; service not started. After desktop login: systemctl --user enable --now stream-kit.service\nAdministrator credentials: %s/orchestrator.json\n' "$data"
fi
exit 0

#!/usr/bin/env bash
# Disposable CI client: separate network and /run (Avahi/DBus) from the server.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $EUID == 0 ]]
scratch="$1"
[[ "$scratch" == "$RUNNER_TEMP"/stream-kit-network.* && -d "$scratch/client-run" ]]
mount --make-rprivate /
mount --bind "$scratch/client-run" /run
mkdir -p /run/dbus /run/avahi-daemon
chown avahi:avahi /run/avahi-daemon
bus_pid='' avahi_pid=''
cleanup() {
  if [[ -n "$avahi_pid" ]]; then kill "$avahi_pid" 2>/dev/null || true; fi
  if [[ -n "$bus_pid" ]]; then kill "$bus_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT
dbus-daemon --system --nofork --nopidfile > "$scratch/client-dbus.log" 2>&1 &
bus_pid=$!
for attempt in $(seq 1 50); do [[ -S /run/dbus/system_bus_socket ]] && break; sleep 0.1; done
avahi-daemon --no-chroot -f "$scratch/client-avahi.conf" > "$scratch/client-avahi.log" 2>&1 &
avahi_pid=$!
for attempt in $(seq 1 50); do [[ -S /run/avahi-daemon/socket ]] && break; sleep 0.1; done
[[ -S /run/avahi-daemon/socket ]]
printf '%s\n' "$$" > "$scratch/client.pid"
while kill -0 "$bus_pid" && kill -0 "$avahi_pid"; do sleep 1; done
exit 1

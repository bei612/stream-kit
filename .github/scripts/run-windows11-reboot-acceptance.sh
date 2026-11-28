#!/usr/bin/env bash
set -euo pipefail

if [[ -n ${RELEASE_TAG:-} && -n ${PRODUCT_RUN_ID:-} ]] ||
   [[ -z ${RELEASE_TAG:-} && -z ${PRODUCT_RUN_ID:-} ]]; then
  echo 'Select one published release tag or one product build run' >&2
  exit 1
fi
if [[ -n ${RELEASE_TAG:-} ]]; then
  [[ $RELEASE_TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[1-9][0-9]*)?$ ]] || { echo 'Invalid release tag' >&2; exit 1; }
fi
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && -r /dev/kvm && -w /dev/kvm ]]
if [[ ${INITIALIZATION_ONLY:-false} == true && ${LAN_ADDRESS_CHANGE:-false} == true ]]; then
  echo 'Initialization-only and LAN acceptance are mutually exclusive' >&2
  exit 1
fi

output="$PWD/artifacts/windows11-reboot"
mkdir -p "$output"
disk_root=$RUNNER_TEMP
if [[ -w /mnt && $(df --output=avail -B1 /mnt | tail -1) -gt $(df --output=avail -B1 "$disk_root" | tail -1) ]]; then
  disk_root=/mnt
fi
available=$(df --output=avail -B1 "$disk_root" | tail -1)
if (( available < 26 * 1024**3 )); then
  echo "Win11 guest requires 26 GiB free including its verified ISO. Available bytes: $available" >&2
  exit 1
fi
work=$(mktemp -d "$disk_root/stream-kit-win11.XXXXXXXX")
control=$(mktemp -d /tmp/stream-kit-qmp.XXXXXXXX)
guest_pid=
lan_pid=
tap_created=false
tap=sk-win11-lan
cleanup() {
  if [[ -n "$guest_pid" ]]; then
    kill "$guest_pid" 2>/dev/null || true
    wait "$guest_pid" 2>/dev/null || true
  fi
  # The runner is ephemeral. Only clean up processes and folders created for this guest.
  if [[ -s "$control/tpm.pid" ]]; then
    kill "$(cat "$control/tpm.pid")" 2>/dev/null || true
  fi
  if [[ -n "$lan_pid" ]]; then
    kill "$lan_pid" 2>/dev/null || true
    wait "$lan_pid" 2>/dev/null || true
  fi
  if [[ "$tap_created" == true ]]; then
    sudo ip link delete "$tap"
  fi
  if [[ -s "$work/qemu.log" ]]; then cp "$work/qemu.log" "$output/qemu.log"; fi
  rm -rf -- "$work" "$control"
}
trap cleanup EXIT
mkdir -p "$work/input/installer" "$work/input/scripts" "$work/tpm"

windows_build_commit() {
  local run_id=$1 commit
  [[ $run_id =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid product build run ID' >&2; return 1; }
  commit=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id" | jq -er --arg repo "$GITHUB_REPOSITORY" '
    select(.head_repository.full_name == $repo and .head_branch == "main" and
      .path == ".github/workflows/windows-product-release.yml" and .event == "workflow_dispatch")
    | .head_sha | select(test("^[a-f0-9]{40}$"))') || return
  gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?filter=latest&per_page=100" | jq -e '
    [.jobs[] | select(.name == "Source-built Windows unified installer" and .status == "completed" and .conclusion == "success")]
    | length == 1' > /dev/null || return
  printf '%s\n' "$commit"
}

if [[ -n ${PRODUCT_RUN_ID:-} ]]; then
  source_commit=$(windows_build_commit "$PRODUCT_RUN_ID")
  gh run download "$PRODUCT_RUN_ID" --name "windows-product-installer-$source_commit" --dir "$work/input/installer"
else
  tag_object=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG")
  source_commit=$(jq -er '.object | select(.type == "commit") | .sha | select(test("^[a-f0-9]{40}$"))' <<< "$tag_object")
  gh release download "$RELEASE_TAG" --pattern '*windows-amd64-setup.exe' --pattern installer-manifest.json --dir "$work/input/installer"
fi
manifest="$work/input/installer/installer-manifest.json"
installer=$(jq -er --arg commit "$source_commit" '
  select(.commit == $commit and .installer_source_commit == $commit and
    .platform == "windows" and .architecture == "amd64" and .payload_profile == "runtime" and
    .reused_payload == false and .audio_driver.kernel_signature_verified == true)
  | .file.name | select(test("^[A-Za-z0-9.-]+-windows-amd64-setup\\.exe$"))' "$manifest")
installer_hash=$(jq -er '.file.sha256 | select(test("^[a-f0-9]{64}$"))' "$manifest")
printf '%s  %s\n' "$installer_hash" "$work/input/installer/$installer" | sha256sum --check
diagnostic_run=${DIAGNOSTIC_PRODUCT_RUN_ID:-${PRODUCT_RUN_ID:-}}
if [[ ${INITIALIZATION_ONLY:-false} == true && -z $diagnostic_run ]]; then
  echo 'Initialization diagnostics require the source-matched runtime' >&2
  exit 1
fi
if [[ -n $diagnostic_run ]]; then
  if [[ $diagnostic_run != "${PRODUCT_RUN_ID:-}" ]]; then
    diagnostic_commit=$(windows_build_commit "$diagnostic_run")
    [[ $diagnostic_commit == "$source_commit" ]] || { echo 'Diagnostic payload does not match the installer source' >&2; exit 1; }
  fi
  gh run download "$diagnostic_run" --name "windows-product-payload-$source_commit" --dir "$work/input/diagnostic"
  payload_hash=$(jq -er '.payload_manifest_sha256 | select(test("^[a-f0-9]{64}$"))' "$manifest")
  printf '%s  %s\n' "$payload_hash" "$work/input/diagnostic/platform-manifest.json" | sha256sum --check
fi
jq -n --arg source "$source_commit" --arg acceptance "$GITHUB_SHA" --arg installer "$installer" --arg sha256 "$installer_hash" \
  --arg tag "${RELEASE_TAG:-}" --arg run "${PRODUCT_RUN_ID:-}" --arg diagnostic "$diagnostic_run" \
  '{source_commit:$source, acceptance_commit:$acceptance, installer_file:$installer, installer_sha256:$sha256,
    release_tag:($tag | select(length>0) // null), product_run_id:($run | tonumber? // null),
    diagnostic_product_run_id:($diagnostic | tonumber? // null)}' > "$output/provenance.json"
unset GH_TOKEN

fetch=(curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --retry 2)
node_base=https://nodejs.org/dist/v26.4.0
"${fetch[@]}" --max-time 180 "$node_base/win-x64/node.exe" -o "$work/input/node.exe"
"${fetch[@]}" --max-time 30 "$node_base/SHASUMS256.txt" -o "$work/node-sums"
awk '$2 == "win-x64/node.exe" { print $1 "  node.exe" }' "$work/node-sums" > "$work/input/.node-checksum"
(cd "$work/input" && sha256sum --check .node-checksum)
rm -- "$work/input/.node-checksum"
cp scripts/accept-windows-installer.cjs scripts/maintain-windows-runtime.cjs "$work/input/scripts/"
cp .github/fixtures/windows11/guest.ps1 "$work/input/"
cp .github/fixtures/windows11/renderer-probe.cjs "$work/input/"
if [[ ${INITIALIZATION_ONLY:-false} == true ]]; then
  touch "$work/input/initialization-only"
fi
guest_network=(-nic none)
lan_observer=()
if [[ ${LAN_ADDRESS_CHANGE:-false} == true ]]; then
  fixture="$work/input/lan-fixture"
  mkdir "$fixture"
  cp .github/fixtures/windows11/network.json "$fixture/"
  cp .github/fixtures/windows11/lan-guest.cjs "$work/input/scripts/"
  client_address=$(jq -er '.client_address' "$fixture/network.json")
  mac=$(jq -er '.mac | ascii_downcase | gsub("-";":")' "$fixture/network.json")
  python3 - "$fixture/network.json" <<'PY'
import ipaddress, json, subprocess, sys
config = json.load(open(sys.argv[1]))
subnet = ipaddress.ip_network(config['subnet'])
routes = json.loads(subprocess.check_output(['ip', '-j', '-4', 'route', 'show', 'table', 'all']))
assert all(not subnet.overlaps(ipaddress.ip_network(route['dst'], strict=False)) for route in routes
           if route.get('dst') not in (None, 'default', '0.0.0.0/0')), 'Fixture route overlaps a runner network'
assert all(ipaddress.ip_address(config[key]) in subnet for key in ('client_address', 'old_address', 'new_address'))
PY
  ! ip link show dev "$tap" >/dev/null 2>&1
  sudo ip tuntap add dev "$tap" mode tap user "$(id -un)"
  tap_created=true
  sudo ip address add "$client_address/24" dev "$tap"
  sudo ip link set "$tap" up
  # Attach the NIC via QMP after standalone installation and reboot checks.
  guest_network=(-netdev "tap,id=fixture,ifname=$tap,script=no,downscript=no" -device "pcie-root-port,id=sklanport")
  lan_observer=("$mac")
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 35 -subj '/CN=Stream Kit Windows LAN fixture CA' \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$fixture/ca.key" -out "$fixture/ca.crt" 2>/dev/null
  mkdir -p "$HOME/.pki/nssdb"
  if [[ ! -f "$HOME/.pki/nssdb/cert9.db" ]]; then certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password; fi
  certutil -A -d "sql:$HOME/.pki/nssdb" -n StreamKitWindowsLAN -t 'C,,' -i "$fixture/ca.crt"
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go -C example build -trimpath -ldflags '-H=windowsgui' -o "$fixture/checkerboard.exe" .
  node .github/fixtures/windows11/lan-client.cjs "$fixture" "$output" &
  lan_pid=$!
fi
password="Aa0-$(openssl rand -hex 24)!"
sed "s/__GUEST_PASSWORD__/$password/g" .github/fixtures/windows11/Autounattend.xml > "$work/input/Autounattend.xml"
unset password
genisoimage -quiet -J -r -V STREAMKIT_TEST -o "$work/inputs.iso" "$work/input"

# Microsoft Evaluation Center, Windows 11 Enterprise 26H2 x64 en-US.
iso_url=https://software-static.download.prss.microsoft.com/dbazure/26300.9457.260913-1737.26h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso
iso_hash=bc3f24086ebadc94489066b5ad78089e2cf5c3491e90e790bb81a2b199c10e38
"${fetch[@]}" --max-time 840 "$iso_url" -o "$work/windows.iso"
printf '%s  %s\n' "$iso_hash" "$work/windows.iso" | sha256sum --check
echo 'Verified Microsoft evaluation media and the immutable product installer.'
cp /usr/share/OVMF/OVMF_VARS_4M.ms.fd "$work/uefi-vars.fd"
qemu-img create -q -f qcow2 "$work/guest.qcow2" 72G
swtpm socket --tpm2 --tpmstate "dir=$work/tpm" --ctrl "type=unixio,path=$control/tpm" \
  --pid "file=$control/tpm.pid" --daemon
available_cpus=$(nproc)
guest_cpus=$((available_cpus > 4 ? 4 : available_cpus))
(( guest_cpus >= 2 )) || { echo 'The guest requires at least two available virtual CPUs' >&2; exit 1; }
# Windows reads the RTC as local time. Match the unattended fixture's UTC zone.
TZ=UTC qemu-system-x86_64 -machine q35,accel=kvm,smm=on -cpu host -smp "$guest_cpus" -m 6144 \
  -rtc base=localtime,clock=host \
  -smbios 'type=1,manufacturer=QEMU,product=StreamKit-Win11-Acceptance' \
  -global driver=cfi.pflash01,property=secure,value=on \
  -drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.ms.fd \
  -drive "if=pflash,format=raw,unit=1,file=$work/uefi-vars.fd" \
  -chardev "socket,id=chrtpm,path=$control/tpm" -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0 \
  -drive "if=ide,format=qcow2,discard=unmap,file=$work/guest.qcow2" \
  -drive "if=ide,media=cdrom,readonly=on,format=raw,file=$work/windows.iso" \
  -drive "if=ide,media=cdrom,readonly=on,format=raw,file=$work/inputs.iso" \
  -boot order=c,once=d "${guest_network[@]}" -display none -vga std \
  -audiodev driver=none,id=audio0 -device ich9-intel-hda -device hda-duplex,audiodev=audio0 \
  -serial "file:$work/serial.log" -qmp "unix:$control/qmp,server=on,wait=off" \
  > "$work/qemu.log" 2>&1 &
guest_pid=$!
python3 .github/fixtures/windows11/observe.py "$control/qmp" "$work/serial.log" "$output" "$guest_pid" "${lan_observer[@]}"
if [[ ${INITIALIZATION_ONLY:-false} == true ]]; then
  jq -e --arg commit "$source_commit" --arg hash "$installer_hash" '
    .phase == "diagnostic_completed" and .commit == $commit and .installer_sha256 == $hash and
    (.diagnostics.native_init_exit | type == "number")
  ' "$output/result.json" > /dev/null
  echo 'Native initialization diagnostics collected. Installer and restart acceptance was not executed.'
  exit 0
fi
lan_evidence=()
if [[ ${LAN_ADDRESS_CHANGE:-false} == true ]]; then
  wait "$lan_pid"
  lan_pid=
  lan_evidence=("$output/windows-lan-client.json")
fi
node scripts/verify-windows-android-promotion.mjs --windows11-reboot "$manifest" "$output/guest.json" "$output/result.json" "${lan_evidence[@]}"
echo 'Clean Win11 install, full VM reboot, original process ownership, PCM and uninstall passed.'

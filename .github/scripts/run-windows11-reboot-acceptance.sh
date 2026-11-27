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
cleanup() {
  if [[ -n "$guest_pid" ]]; then
    kill "$guest_pid" 2>/dev/null || true
    wait "$guest_pid" 2>/dev/null || true
  fi
  # The runner is ephemeral. Only clean up processes and folders created for this guest.
  if [[ -s "$control/tpm.pid" ]]; then
    kill "$(cat "$control/tpm.pid")" 2>/dev/null || true
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
qemu-system-x86_64 -machine q35,accel=kvm,smm=on -cpu host -smp 2 -m 6144 \
  -smbios 'type=1,manufacturer=QEMU,product=StreamKit-Win11-Acceptance' \
  -global driver=cfi.pflash01,property=secure,value=on \
  -drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.ms.fd \
  -drive "if=pflash,format=raw,unit=1,file=$work/uefi-vars.fd" \
  -chardev "socket,id=chrtpm,path=$control/tpm" -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0 \
  -drive "if=ide,format=qcow2,discard=unmap,file=$work/guest.qcow2" \
  -drive "if=ide,media=cdrom,readonly=on,format=raw,file=$work/windows.iso" \
  -drive "if=ide,media=cdrom,readonly=on,format=raw,file=$work/inputs.iso" \
  -boot order=c,once=d -nic none -display none -vga std \
  -audiodev driver=none,id=audio0 -device ich9-intel-hda -device hda-duplex,audiodev=audio0 \
  -serial "file:$work/serial.log" -qmp "unix:$control/qmp,server=on,wait=off" \
  > "$work/qemu.log" 2>&1 &
guest_pid=$!
python3 .github/fixtures/windows11/observe.py "$control/qmp" "$work/serial.log" "$output" "$guest_pid"
if [[ ${INITIALIZATION_ONLY:-false} == true ]]; then
  jq -e --arg commit "$source_commit" --arg hash "$installer_hash" '
    .phase == "diagnostic_completed" and .commit == $commit and .installer_sha256 == $hash and
    (.diagnostics.native_init_exit | type == "number")
  ' "$output/result.json" > /dev/null
  echo 'Native initialization diagnostics collected. Installer and restart acceptance was not executed.'
  exit 0
fi
jq -e --arg commit "$source_commit" --arg hash "$installer_hash" '
  .phase == "completed" and .passed == true and .exit_code == 0 and .commit == $commit and
  .installer_source_commit == $commit and .installer_sha256 == $hash and
  (.install_exit == 0 or .install_exit == 3010) and .pre_reboot.boot_utc != .post_reboot.boot_utc and
  (.post_reboot.processes | length == 3) and .admin_login == true and .defaults_preserved == true and
  .pcm_frames > 0 and .pcm_dropped == 0 and .gateway_restarted == true and .scm_restarted == true and
  .uninstall_exit == 0 and .service_removed == true and .data_preserved == true
' "$output/result.json" > /dev/null
echo 'Clean Win11 install, full VM reboot, original process ownership, PCM and uninstall passed.'

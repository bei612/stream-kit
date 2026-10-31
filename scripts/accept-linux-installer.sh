#!/usr/bin/env bash
# Native package/initialization check only: no apt install, drivers or media.
set -euo pipefail
[[ $# == 1 && $EUID != 0 ]] || { echo 'Expected installer directory, run as non-root' >&2; exit 1; }
output=$(realpath "$1")
cd "$output"
sha256sum -c SHA256SUMS
shopt -s nullglob
installers=(*-setup.run)
[[ ${#installers[@]} == 1 ]] || exit 1
bash "${installers[0]}" --help
line=$(awk '/^__STREAM_KIT_PAYLOAD__$/ { print NR + 1; exit }' "${installers[0]}")
temporary=$(mktemp -d "$output/native-init.XXXXXXXX")
tail -n +"$line" "${installers[0]}" > "$temporary/package.deb"
cmp -- "$temporary/package.deb" "$output/stream-kit.deb"
dpkg-deb --info "$temporary/package.deb"
dpkg-deb --extract "$temporary/package.deb" "$temporary/extracted"
root="$temporary/extracted/opt/stream-kit"
control="$root/orchestrator/orchestrator"
"$control" init-platform --root "$root" --data-dir "$temporary/runtime"
"$control" check-config --config "$temporary/runtime/orchestrator.json"
[[ $(stat -c %a "$temporary/runtime") == 700 ]]
# The initializer must never replace existing credentials/data on reinstall.
before=$(sha256sum "$temporary/runtime/orchestrator.json")
if "$control" init-platform --root "$root" --data-dir "$temporary/runtime"; then
  echo 'Existing runtime was incorrectly accepted for replacement' >&2; exit 1
fi
[[ $(sha256sum "$temporary/runtime/orchestrator.json") == "$before" ]]
printf 'Native Linux package extraction, three-component initialization, configuration and data preservation passed. No media service started.\n'

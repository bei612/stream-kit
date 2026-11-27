#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]

# Official Google archive entries: https://developer.android.com/studio/emulator_archive
# Install only into the disposable job's scratch directory. Android Studio,
# the host's installed SDK, and product build components remain independent.
case "$ANDROID_AUDIO_EMULATOR_VERSION" in
  37.3.10) build=16970787; sha256=a4405349d8a9c52136ab7861e5331dc40e85574bd91cb8889a298a2ff4c52e26 ;;
  37.2.13) build=16740729; sha256=cbc7c3cfb83220b8a0f9c513fdab557712e74d339ec19ddffa43f23350ae9bdd ;;
  *) echo 'Unsupported Android audio emulator version' >&2; exit 1 ;;
esac
root=$(mktemp -d "$RUNNER_TEMP/streamkit-android-sdk.XXXXXXXX")
archive="$root/emulator.zip"
curl --proto '=https' --proto-redir '=https' --fail --location --silent --show-error --retry 3 \
  "https://redirector.gvt1.com/edgedl/android/repository/emulator-linux_x64-$build.zip" --output "$archive"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --status
unzip -q "$archive" -d "$root"
rm -- "$archive"
version=$("$root/emulator/emulator" -version 2>&1)
[[ "$version" == *"version $ANDROID_AUDIO_EMULATOR_VERSION.0 (build_id $build)"* ]]
test -r "$root/emulator/lib/emulator_controller.proto"
printf 'STREAM_KIT_AUDIO_EMULATOR_DIR=%s\n' "$root/emulator" >> "$GITHUB_ENV"
mkdir -p artifacts/android-audio-evidence
jq -n --arg version "$ANDROID_AUDIO_EMULATOR_VERSION" --arg build "$build" --arg sha "$sha256" \
  '{version: $version, build_id: $build, archive_sha256: $sha, platform: "linux-x64"}' > artifacts/android-audio-evidence/emulator-sdk.json

#!/usr/bin/env bash
# Standalone, testOnly observer; never modifies, signs or packages the client.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
case "${1:-input}" in
  input)
    source_dir="$GITHUB_WORKSPACE/tools/input-acceptance/android"
    output="$GITHUB_WORKSPACE/artifacts/input-example/android" ;;
  focus)
    source_dir="$GITHUB_WORKSPACE/tools/audio-acceptance/android-focus"
    output="$GITHUB_WORKSPACE/artifacts/input-example/android-focus" ;;
  *) echo 'Expected input or focus observer profile' >&2; exit 1 ;;
esac
sdk_tools="$ANDROID_HOME/build-tools/36.0.0"
platform="$ANDROID_HOME/platforms/android-36/android.jar"
mkdir -p "$output/classes" "$output/dex"
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$platform" -d "$output/classes" "$source_dir/"*.java
mapfile -d '' classes < <(find "$output/classes" -type f -name '*.class' -print0)
"$sdk_tools/d8" --lib "$platform" --output "$output/dex" "${classes[@]}"
"$sdk_tools/aapt2" link --manifest "$source_dir/AndroidManifest.xml" -I "$platform" -o "$output/unsigned.apk"
zip -q -j "$output/unsigned.apk" "$output/dex/classes.dex"
"$sdk_tools/zipalign" -f 4 "$output/unsigned.apk" "$output/aligned.apk"
# Disposable test identity; unrelated to the persistent release signing key.
keytool -genkeypair -keystore "$output/observer.jks" -storepass ci-observer-only -keypass ci-observer-only \
  -alias observer -keyalg RSA -keysize 2048 -validity 2 -dname 'CN=Isolated CI observer' >/dev/null 2>&1
"$sdk_tools/apksigner" sign --ks "$output/observer.jks" --ks-pass pass:ci-observer-only --out "$output/observer.apk" "$output/aligned.apk"

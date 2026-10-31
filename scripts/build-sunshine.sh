#!/usr/bin/env bash
# Source build only: installs dependency outputs into .local, never the host OS.
# Additional arguments are forwarded unchanged to the Sunshine CMake configure step.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
jobs=${BUILD_JOBS:-2}
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo 'BUILD_JOBS must be a positive integer' >&2; exit 1; }
build_name=${SUNSHINE_BUILD_NAME:-cmake-build-sunshine}
[[ "$build_name" =~ ^cmake-build-[A-Za-z0-9_-]+$ ]] || { echo 'SUNSHINE_BUILD_NAME must be a cmake-build- directory name' >&2; exit 1; }
case "$(uname -s)" in
  MINGW*|MSYS*)
    [[ "${MSYSTEM:-}" == UCRT64 ]] || { echo 'Use the native MSYS2 UCRT64 environment' >&2; exit 1; }
    native_path() { cygpath -m "$1"; }
    ;;
  Linux*) native_path() { printf '%s\n' "$1"; } ;;
  *) echo 'Supported server build hosts: Windows UCRT64 and Linux' >&2; exit 1 ;;
esac
for tool in cmake ninja git patch make pkg-config node npm; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
node tools/check-sunshine-vendor.cjs
cmake -P tools/test-source-patching.cmake
cmake -P tools/test-sunshine-sdk.cmake

deps="$root/.local/cmake-build-sunshine-deps"
build="$root/.local/$build_name"
cmake -S third_party/sunshine/third-party/build-deps -B "$deps" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$(native_path "$deps/install")" \
  -DPARALLEL_BUILDS="$jobs"
cmake --build "$deps" --parallel "$jobs"
cmake --install "$deps"
export PKG_CONFIG_PATH="$deps/install/ffmpeg/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
cmake -S tools/sunshine-codec-probe -B "$deps/cmake-build-codec-probe" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$deps/cmake-build-codec-probe" --parallel "$jobs"
"$deps/cmake-build-codec-probe/codec-probe"

export BRANCH
BRANCH=$(git branch --show-current)
export COMMIT
COMMIT=$(git rev-parse HEAD)
export BUILD_VERSION
BUILD_VERSION=$(node -p "require('./third_party-manifests/upstream-lock.json').components.sunshine.version.replace(/^v/, '')")
cmake -S third_party/sunshine -B "$build" -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_TESTS=ON -DBUILD_DOCS=ON -DBUILD_WERROR=ON \
  -DSUNSHINE_BUILD_WINDOWS_INSTALLERS=OFF \
  -DFFMPEG_PREPARED_BINARIES="$(native_path "$deps/install/ffmpeg")" \
  -DCMAKE_PREFIX_PATH="$(native_path "$deps/install/ffmpeg")" \
  -DSUNSHINE_ASSETS_DIR=assets -DSUNSHINE_PUBLISHER_NAME=Stream-Kit \
  -DSUNSHINE_PUBLISHER_WEBSITE=https://github.com/bei612/stream-kit \
  -DSUNSHINE_PUBLISHER_ISSUE_URL=https://github.com/bei612/stream-kit/issues "$@"
cmake --build "$build" --parallel "$jobs"
echo "Source build completed: $build"

#!/usr/bin/env bash
set -euo pipefail
[[ ${SOURCE_RUN_ID:-} =~ ^[1-9][0-9]*$ ]] || { echo 'Expected a successful product run ID' >&2; exit 1; }
[[ ${RELEASE_TAG:-} =~ ^v[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]+(\.[0-9]+)*$ ]] || { echo 'Expected a new preview version tag' >&2; exit 1; }
mkdir -p artifacts/promotion
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID" > artifacts/promotion/source-run.json
jq -e --arg repo "$GITHUB_REPOSITORY" '
  .status == "completed" and .conclusion == "success" and
  .path == ".github/workflows/windows-product-release.yml" and
  .head_repository.full_name == $repo and .head_branch == "main" and
  .event == "workflow_dispatch" and (.head_sha | test("^[a-f0-9]{40}$"))
' artifacts/promotion/source-run.json > /dev/null
source_commit=$(jq -r .head_sha artifacts/promotion/source-run.json)
for name in windows-product-installer linux-product-installer windows-product-sbom; do
  gh run download "$SOURCE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "$name-$source_commit" --dir "artifacts/promotion/$name"
done
windows=artifacts/promotion/windows-product-installer
# The Linux artifact has a common parent containing installer/ and the native
# acceptance log. Preserve that producer layout when locating the signed-off
# payload instead of assuming upload-artifact flattened both directories.
linux=artifacts/promotion/linux-product-installer/installer
sbom=artifacts/promotion/windows-product-sbom/stream-kit-sbom.spdx.json
jq -e --arg commit "$source_commit" '
  .commit == $commit and .installer_source_commit == $commit and
  .reused_payload == false and .platform == "windows" and .architecture == "amd64" and
  .release_channel == "preview" and (.file.name | test("^stream-kit-preview-[a-f0-9]{12}-windows-amd64-setup\\.exe$"))
' "$windows/installer-manifest.json" > /dev/null
jq -e --arg commit "$source_commit" '
  .commit == $commit and .platform == "linux" and .architecture == "amd64" and
  .distribution == "ubuntu-24.04" and .release_channel == "preview" and
  (.installer.file | test("^stream-kit-preview-[a-f0-9]{12}-ubuntu24\\.04-amd64-setup\\.run$"))
' "$linux/installer-manifest.json" > /dev/null
(cd "$windows" && sha256sum -c SHA256SUMS.txt)
(cd "$linux" && sha256sum -c SHA256SUMS)
# Match the binary bytes against the source-bound manifests as well as the
# detached checksum files. No cancelled/partial run or mixed revision is promoted.
win_file=$(jq -r .file.name "$windows/installer-manifest.json")
linux_file=$(jq -r .installer.file "$linux/installer-manifest.json")
[[ $(sha256sum "$windows/$win_file" | cut -d ' ' -f 1) == $(jq -r .file.sha256 "$windows/installer-manifest.json") ]]
[[ $(sha256sum "$linux/$linux_file" | cut -d ' ' -f 1) == $(jq -r .installer.sha256 "$linux/installer-manifest.json") ]]
jq -e '.spdxVersion | startswith("SPDX-")' "$sbom" > /dev/null
git fetch --no-tags origin "$source_commit"
git show "$source_commit:deploy/windows/CI-RELEASE.md" > artifacts/promotion/release-notes.md
# Version refs are created through the release operator's existing Git write
# transport. GITHUB_TOKEN can upload releases but cannot tag an older revision
# whose workflow files differ from main without a separate workflows grant.
# Keep that credential boundary explicit; promotion never widens permissions,
# stores a deploy key, changes the target revision, or starts another build.
git ls-remote --exit-code origin "refs/tags/$RELEASE_TAG" > /dev/null || { echo 'Push the release tag at the verified source revision before promotion' >&2; exit 1; }
git fetch --no-tags origin "refs/tags/$RELEASE_TAG"
[[ $(git rev-parse 'FETCH_HEAD^{commit}') == "$source_commit" ]] || { echo 'Release tag points to another revision' >&2; exit 1; }
mv "$linux/installer-manifest.json" "$linux/linux-installer-manifest.json"
mv "$linux/SHA256SUMS" "$linux/Linux-SHA256SUMS.txt"
gh release create "$RELEASE_TAG" "$windows/$win_file" "$windows/installer-manifest.json" "$windows/SHA256SUMS.txt" "$linux/$linux_file" "$linux/linux-installer-manifest.json" "$linux/Linux-SHA256SUMS.txt" "$sbom" --repo "$GITHUB_REPOSITORY" --verify-tag --prerelease --title "$RELEASE_TAG" --notes-file artifacts/promotion/release-notes.md

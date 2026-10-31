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
linux=artifacts/promotion/linux-product-installer
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
if git ls-remote --exit-code origin "refs/tags/$RELEASE_TAG" > /dev/null; then
  git fetch --no-tags origin "refs/tags/$RELEASE_TAG"
  [[ $(git rev-parse 'FETCH_HEAD^{commit}') == "$source_commit" ]] || { echo 'Release tag points to another revision' >&2; exit 1; }
else
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  git tag -a "$RELEASE_TAG" "$source_commit" -m "Verified product run $SOURCE_RUN_ID"
  # The repository GITHUB_TOKEN creates this ref without recursively triggering
  # another build. No PAT, deploy key change or extra OAuth authorization is needed.
  git push origin "refs/tags/$RELEASE_TAG"
fi
mv "$linux/installer-manifest.json" "$linux/linux-installer-manifest.json"
mv "$linux/SHA256SUMS" "$linux/Linux-SHA256SUMS.txt"
gh release create "$RELEASE_TAG" "$windows/$win_file" "$windows/installer-manifest.json" "$windows/SHA256SUMS.txt" "$linux/$linux_file" "$linux/linux-installer-manifest.json" "$linux/Linux-SHA256SUMS.txt" "$sbom" --repo "$GITHUB_REPOSITORY" --verify-tag --prerelease --title "$RELEASE_TAG" --notes-file artifacts/promotion/release-notes.md

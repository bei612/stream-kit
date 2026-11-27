#!/usr/bin/env bash
set -euo pipefail
[[ ${SOURCE_RUN_ID:-} =~ ^[1-9][0-9]*$ ]] || { echo 'Expected a successful product run ID' >&2; exit 1; }
[[ ${INSTALLER_ACCEPTANCE_RUN_ID:-} =~ ^[1-9][0-9]*$ ]] || { echo 'Expected the successful Windows installer acceptance run ID' >&2; exit 1; }
[[ ${RELEASE_TAG:-} =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]+(\.[0-9]+)*|-rc\.[1-9][0-9]*)?$ ]] || { echo 'Expected a new stable, candidate or preview version tag' >&2; exit 1; }
if [[ -n ${LINUX_RUN_ID:-} ]]; then
  [[ $LINUX_RUN_ID =~ ^[1-9][0-9]*$ && -n ${ANDROID_RUN_ID:-} ]] || {
    echo 'A separate Linux run ID is supported only when promoting a signed Android build' >&2
    exit 1
  }
fi
mkdir -p artifacts/promotion
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID" > artifacts/promotion/source-run.json
jq -e --arg repo "$GITHUB_REPOSITORY" '
  .path == ".github/workflows/windows-product-release.yml" and
  .head_repository.full_name == $repo and .head_branch == "main" and
  .event == "workflow_dispatch" and (.head_sha | test("^[a-f0-9]{40}$"))
' artifacts/promotion/source-run.json > /dev/null
source_commit=$(jq -r .head_sha artifacts/promotion/source-run.json)
if [[ -n ${ANDROID_RUN_ID:-} ]]; then
  gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID/jobs?filter=latest&per_page=100" > artifacts/promotion/source-jobs.json
  jq -e '
    def passed($name): [.jobs[] | select(.name == $name and .status == "completed" and .conclusion == "success")] | length == 1;
    passed("Source-built Windows unified installer") and passed("Source SBOM")
  ' artifacts/promotion/source-jobs.json > /dev/null
else
  jq -e '.status == "completed" and .conclusion == "success"' artifacts/promotion/source-run.json > /dev/null
fi
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$INSTALLER_ACCEPTANCE_RUN_ID" > artifacts/promotion/acceptance-run.json
jq -e --arg repo "$GITHUB_REPOSITORY" '
  .status == "completed" and .conclusion == "success" and
  .path == ".github/workflows/windows-installer-acceptance.yml" and
  .head_repository.full_name == $repo and .head_branch == "main" and
  (.event == "workflow_run" or .event == "workflow_dispatch")
' artifacts/promotion/acceptance-run.json > /dev/null
gh run download "$INSTALLER_ACCEPTANCE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name windows-installed-service-acceptance --dir artifacts/promotion/acceptance
for name in windows-product-installer windows-product-sbom; do
  gh run download "$SOURCE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "$name-$source_commit" --dir "artifacts/promotion/$name"
done
windows=artifacts/promotion/windows-product-installer
sbom=artifacts/promotion/windows-product-sbom/stream-kit-sbom.spdx.json
jq -e --arg commit "$source_commit" '
  .commit == $commit and .installer_source_commit == $commit and
  .reused_payload == false and .platform == "windows" and .architecture == "amd64" and
  .payload_profile == "runtime"
' "$windows/installer-manifest.json" > /dev/null
jq -e '.spdxVersion | startswith("SPDX-")' "$sbom" > /dev/null
acceptance=artifacts/promotion/acceptance/installer-acceptance/result.json
reviewed_notes="deploy/releases/${RELEASE_TAG#v}.md"

if [[ -n ${ANDROID_RUN_ID:-} ]]; then
  [[ $ANDROID_RUN_ID =~ ^[0-9]+$ ]] || { echo 'Expected a signed Android run ID' >&2; exit 1; }
  gh api "repos/$GITHUB_REPOSITORY/actions/runs/$ANDROID_RUN_ID" > artifacts/promotion/android-run.json
  jq -e --arg repo "$GITHUB_REPOSITORY" --arg commit "$source_commit" '
    .status == "completed" and .conclusion == "success" and
    .path == ".github/workflows/android-release.yml" and .head_sha == $commit and
    .head_repository.full_name == $repo and .head_branch == "main" and .event == "workflow_dispatch"
  ' artifacts/promotion/android-run.json > /dev/null
  android=artifacts/promotion/android-candidate
  gh run download "$ANDROID_RUN_ID" --repo "$GITHUB_REPOSITORY" --name stream-kit-android-release-candidate --dir "$android"
  release_assets=artifacts/promotion/windows-android-assets
  linux_args=()
  if [[ -n ${LINUX_RUN_ID:-} ]]; then
    linux_artifact=artifacts/promotion/linux-product-installer
    gh api "repos/$GITHUB_REPOSITORY/actions/runs/$LINUX_RUN_ID" > artifacts/promotion/linux-run.json
    gh api "repos/$GITHUB_REPOSITORY/actions/runs/$LINUX_RUN_ID/jobs?filter=latest&per_page=100" > artifacts/promotion/linux-jobs.json
    node scripts/verify-windows-android-promotion.mjs --linux-run artifacts/promotion/linux-run.json \
      artifacts/promotion/linux-jobs.json "$GITHUB_REPOSITORY" "$LINUX_RUN_ID" "$source_commit" "$RELEASE_TAG"
    gh run download "$LINUX_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "linux-product-installer-$source_commit" --dir "$linux_artifact"
    linux_args=("$linux_artifact/installer")
  fi
  publication=$(node scripts/verify-windows-android-promotion.mjs "$windows" "$android" "$sbom" "$acceptance" "$RELEASE_TAG" "$release_assets" "${linux_args[@]}")
  draft_args=()
  final_args=(--latest)
  if jq -e '.prerelease == true' <<< "$publication" > /dev/null; then
    draft_args=(--prerelease)
    final_args=(--prerelease --latest=false)
  fi
  test -f "$reviewed_notes"
  git fetch --no-tags origin "refs/tags/$RELEASE_TAG"
  [[ $(git rev-parse 'FETCH_HEAD^{commit}') == "$source_commit" ]] || { echo 'Release tag points to another revision' >&2; exit 1; }
  assets=("$release_assets"/*)
  if gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft > artifacts/promotion/draft.json 2>/dev/null; then
    jq -e '.isDraft == true' artifacts/promotion/draft.json > /dev/null
    gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY" --clobber
  else
    gh release create "$RELEASE_TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY" --verify-tag --draft "${draft_args[@]}" --title "$RELEASE_TAG" --notes-file "$reviewed_notes"
  fi
  release_id=$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json databaseId --jq .databaseId)
  gh api "repos/$GITHUB_REPOSITORY/releases/$release_id/assets" > artifacts/promotion/draft-assets.json
  node scripts/verify-windows-android-promotion.mjs --uploaded artifacts/promotion/draft-assets.json "${assets[@]}"
  gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false "${final_args[@]}" --notes-file "$reviewed_notes"
  exit 0
fi

gh run download "$SOURCE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "linux-product-installer-$source_commit" --dir artifacts/promotion/linux-product-installer
# The Linux artifact has a common parent containing installer/ and the native
# acceptance log. Preserve that producer layout when locating the signed-off
# payload instead of assuming upload-artifact flattened both directories.
linux=artifacts/promotion/linux-product-installer/installer
jq -e --arg commit "$source_commit" '
  .commit == $commit and .platform == "linux" and .architecture == "amd64" and
  .distribution == "ubuntu-24.04" and .payload_profile == "runtime"
' "$linux/installer-manifest.json" > /dev/null
node scripts/verify-product-promotion.mjs "$windows/installer-manifest.json" "$linux/installer-manifest.json" "$RELEASE_TAG" "$acceptance" > artifacts/promotion/product-release.json
(cd "$windows" && sha256sum -c SHA256SUMS.txt)
(cd "$linux" && sha256sum -c SHA256SUMS)
# Match the binary bytes against the source-bound manifests as well as the
# detached checksum files. No cancelled/partial run or mixed revision is promoted.
win_file=$(jq -r .file.name "$windows/installer-manifest.json")
linux_file=$(jq -r .installer.file "$linux/installer-manifest.json")
[[ $(sha256sum "$windows/$win_file" | cut -d ' ' -f 1) == $(jq -r .file.sha256 "$windows/installer-manifest.json") ]]
[[ $(sha256sum "$linux/$linux_file" | cut -d ' ' -f 1) == $(jq -r .installer.sha256 "$linux/installer-manifest.json") ]]
git fetch --no-tags origin "$source_commit"
notes_path=$(jq -r .notes artifacts/promotion/product-release.json)
# Deployment evidence is available after the immutable build. Reviewed notes
# belong to this publication revision; the tag and both payloads remain bound
# to the original source commit. Candidates require explicit release scope.
if [[ -f "$reviewed_notes" ]]; then
  cp "$reviewed_notes" artifacts/promotion/release-notes.md
elif [[ $(jq -r .publication_channel artifacts/promotion/product-release.json) == candidate ]]; then
  echo 'Candidate publication requires committed version-specific release notes' >&2; exit 1
else
  git show "$source_commit:$notes_path" > artifacts/promotion/release-notes.md
fi
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
channel_args=()
if [[ $(jq -r .prerelease artifacts/promotion/product-release.json) == true ]]; then channel_args+=(--prerelease); fi
gh release create "$RELEASE_TAG" "$windows/$win_file" "$windows/installer-manifest.json" "$windows/SHA256SUMS.txt" "$linux/$linux_file" "$linux/linux-installer-manifest.json" "$linux/Linux-SHA256SUMS.txt" "$sbom" --repo "$GITHUB_REPOSITORY" --verify-tag "${channel_args[@]}" --title "$RELEASE_TAG" --notes-file artifacts/promotion/release-notes.md

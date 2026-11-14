#!/usr/bin/env bash
# Download one explicitly selected runtime/APK pair. Never rebuild or select an
# old release implicitly; source, signature and content checks are shared with
# the input/audio acceptance consumers.
set -euo pipefail
[[ "${PRODUCT_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]]
if [[ -n "${ANDROID_RUN_ID:-}" ]]; then
  [[ "$ANDROID_RUN_ID" =~ ^[1-9][0-9]*$ && -z "${ANDROID_RELEASE_TAG:-}" ]]
else
  [[ "${ANDROID_RELEASE_TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+|-android(-preview\.[0-9]+(\.[0-9]+)*)?)?$ ]]
fi
mkdir -p artifacts/input-download
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PRODUCT_RUN_ID" > artifacts/input-download/product-run.json
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$PRODUCT_RUN_ID/jobs?filter=latest&per_page=100" > artifacts/input-download/product-jobs.json
commit=$(node scripts/verify-input-acceptance-sources.mjs product-run)
gh run download "$PRODUCT_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "linux-product-installer-$commit" --dir artifacts/input-product
cp artifacts/input-product/installer/installer-manifest.json artifacts/input-download/
cp artifacts/input-product/installer/*-setup.run artifacts/input-download/
if [[ -n "${ANDROID_RUN_ID:-}" ]]; then
  gh api "repos/$GITHUB_REPOSITORY/actions/runs/$ANDROID_RUN_ID" > artifacts/input-download/android-run.json
  android_commit=$(node scripts/verify-input-acceptance-sources.mjs android-run)
  [[ "$android_commit" == "$commit" ]]
  gh run download "$ANDROID_RUN_ID" --repo "$GITHUB_REPOSITORY" --name stream-kit-android-release-candidate --dir artifacts/input-download
else
  gh api "repos/$GITHUB_REPOSITORY/releases/tags/$ANDROID_RELEASE_TAG" > artifacts/input-download/android-release.json
  gh api "repos/$GITHUB_REPOSITORY/commits/$ANDROID_RELEASE_TAG" > artifacts/input-download/android-source.json
  gh release download "$ANDROID_RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --pattern '*.apk' --pattern provenance.json --pattern sbom.cdx.json --dir artifacts/input-download
fi
node scripts/verify-input-acceptance-sources.mjs downloads
dpkg-deb -x artifacts/input-download/runtime.deb artifacts/input-runtime
node -e "const fs=require('fs'),a=require('assert/strict');a.equal(JSON.parse(fs.readFileSync('artifacts/input-runtime/opt/stream-kit/platform-manifest.json')).commit,JSON.parse(fs.readFileSync('artifacts/input-download/installer-manifest.json')).commit)"

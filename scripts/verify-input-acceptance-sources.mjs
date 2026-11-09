import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const directory = 'artifacts/input-download'
const evidence = 'artifacts/android-input-evidence'
const file = name => path.join(directory, name)

export function productSource(run, jobs, repository, runID) {
  assert.match(runID, /^[1-9][0-9]*$/)
  assert.equal(String(run.id), runID)
  assert.ok(run.status === 'in_progress' || (run.status === 'completed' && run.conclusion === 'success'))
  assert.equal(run.path, '.github/workflows/windows-product-release.yml')
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.head_branch, 'main')
  assert.equal(run.event, 'workflow_dispatch')
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  const linux = jobs.jobs.filter(job => job.name === 'Linux product / Source-built Linux unified installer')
  assert.equal(linux.length, 1)
  assert.equal(linux[0].status, 'completed')
  assert.equal(linux[0].conclusion, 'success')
  assert.equal(linux[0].head_sha, run.head_sha)
  assert.equal(linux[0].run_id, run.id)
  return run.head_sha
}

export function releaseIdentity(release, provenance, signing, source, tag) {
  assert.match(tag, /^v[0-9]+\.[0-9]+\.[0-9]+-android-preview\.[0-9]+(?:\.[0-9]+)*$/)
  assert.equal(release.tag_name, tag)
  assert.equal(release.draft, false)
  assert.ok(release.published_at)
  assert.equal(provenance.schema_version, 1)
  assert.equal(provenance.application_id, 'io.github.bei612.streamkit')
  assert.equal(signing.application_id, provenance.application_id)
  assert.equal(provenance.source_commit, source.sha)
  assert.match(provenance.source_commit, /^[a-f0-9]{40}$/)
  assert.match(provenance.apk_sha256, /^[a-f0-9]{64}$/)
  assert.equal(provenance.signing_certificate_sha256, signing.certificate_sha256.replace(/[\s:]/g, '').toLowerCase())
  const apk = release.assets.filter(asset => asset.name.endsWith('.apk'))
  assert.equal(apk.length, 1)
  assert.match(apk[0].name, /^stream-kit-[a-zA-Z0-9.-]+\.apk$/)
  return apk[0]
}

function verifiedAsset(release, name) {
  const found = release.assets.filter(asset => asset.name === name)
  assert.equal(found.length, 1)
  const asset = found[0], bytes = fs.readFileSync(file(name))
  assert.equal(asset.state, 'uploaded')
  assert.equal(bytes.length, asset.size)
  assert.equal(asset.digest, 'sha256:' + digest(bytes))
  return bytes
}

function verifyDownloads() {
  const run = read(file('product-run.json'))
  const commit = productSource(run, read(file('product-jobs.json')), process.env.GITHUB_REPOSITORY, process.env.PRODUCT_RUN_ID)
  const manifest = read(file('installer-manifest.json'))
  assert.equal(manifest.commit, commit)
  assert.equal(manifest.platform, 'linux')
  assert.equal(manifest.architecture, 'amd64')
  assert.equal(manifest.distribution, 'ubuntu-24.04')
  assert.equal(manifest.payload_profile, 'runtime')
  assert.match(manifest.installer.file, /^stream-kit-[a-z0-9.-]+-ubuntu24\.04-amd64-setup\.run$/)
  assert.match(manifest.installer.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.payload.sha256, /^[a-f0-9]{64}$/)
  const installer = fs.readFileSync(file(manifest.installer.file))
  assert.equal(installer.length, manifest.installer.bytes)
  assert.equal(digest(installer), manifest.installer.sha256)
  const marker = Buffer.from('\n__STREAM_KIT_PAYLOAD__\n'), offset = installer.indexOf(marker)
  assert.ok(offset > 0)
  const payload = installer.subarray(offset + marker.length)
  assert.equal(digest(payload), manifest.payload.sha256)
  fs.writeFileSync(file('runtime.deb'), payload)
  const release = read(file('android-release.json'))
  const provenanceBytes = verifiedAsset(release, 'provenance.json')
  const provenance = JSON.parse(provenanceBytes)
  const apk = releaseIdentity(release, provenance, read('third_party-manifests/android-signing.json'), read(file('android-source.json')), process.env.ANDROID_RELEASE_TAG)
  assert.equal(digest(verifiedAsset(release, apk.name)), provenance.apk_sha256)
  const sbom = JSON.parse(verifiedAsset(release, 'sbom.cdx.json'))
  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.ok(sbom.metadata.component.hashes.some(h => h.alg === 'SHA-256' && h.content === provenance.apk_sha256))
  assert.ok(sbom.metadata.properties.some(p => p.name === 'stream-kit:source-commit' && p.value === provenance.source_commit))
  fs.mkdirSync(evidence, { recursive: true })
  fs.writeFileSync(path.join(evidence, 'provenance.json'), JSON.stringify({
    runtime_commit: commit, installer_sha256: manifest.installer.sha256, payload_sha256: manifest.payload.sha256,
    product_run_id: run.id, product_linux_job_id: read(file('product-jobs.json')).jobs.find(j => j.name === 'Linux product / Source-built Linux unified installer').id,
    android_release_tag: release.tag_name, android_release_id: release.id, apk_file: apk.name,
    apk_source_commit: provenance.source_commit, apk_sha256: provenance.apk_sha256,
    apk_signer_sha256: provenance.signing_certificate_sha256, apk_signature_verified: false,
    acceptance_commit: process.env.GITHUB_SHA, runtime_rebuilt: false, apk_rebuilt: false,
  }, null, 2) + '\n')
}

function verifyAPK() {
  const report = read(path.join(evidence, 'provenance.json'))
  const apk = file(report.apk_file), tools = path.join(process.env.ANDROID_HOME, 'build-tools/36.0.0')
  assert.equal(digest(fs.readFileSync(apk)), report.apk_sha256)
  const signature = execFileSync(path.join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk], { encoding: 'utf8' })
  const signers = [...signature.matchAll(/(?:Signer #\d+|V[0-9.]+ Signer):? certificate SHA-256 digest: ([0-9a-f]+)/gi)].map(m => m[1].toLowerCase())
  assert.deepEqual([...new Set(signers)], [report.apk_signer_sha256])
  assert.match(signature, /Number of signers: 1/)
  assert.match(signature, /Verified using v2 scheme \(APK Signature Scheme v2\): true/)
  const provenance = read(file('provenance.json'))
  const badging = execFileSync(path.join(tools, 'aapt2'), ['dump', 'badging', apk], { encoding: 'utf8' })
  assert.ok(badging.includes(`package: name='${provenance.application_id}' versionCode='${provenance.version_code}' versionName='${provenance.version}'`))
  assert.ok(!badging.includes('application-debuggable'))
  const embedded = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read("assets/stream-kit-build.json").decode())', apk], { encoding: 'utf8' }))
  assert.deepEqual(embedded, { version: provenance.version, version_code: provenance.version_code, source_commit: report.apk_source_commit, source_dirty: false })
  report.apk_signature_verified = true
  fs.writeFileSync(path.join(evidence, 'provenance.json'), JSON.stringify(report, null, 2) + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode === 'product-run') console.log(productSource(read(file('product-run.json')), read(file('product-jobs.json')), process.env.GITHUB_REPOSITORY, process.env.PRODUCT_RUN_ID))
  else if (mode === 'downloads') verifyDownloads()
  else if (mode === 'apk') verifyAPK()
  else throw Error('Expected product-run, downloads or apk')
}

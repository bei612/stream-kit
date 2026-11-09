import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { productSource } from './verify-input-acceptance-sources.mjs'

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
// Shared download verification only. The caller supplies its own truthful
// acceptance provenance; importing this function does not run native-exit.
export function verifyLinuxRuntimeDownloads(directory, commit) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
  const manifest = read('installer-manifest.json')
  assert.equal(manifest.commit, commit)
  assert.equal(manifest.platform, 'linux')
  assert.equal(manifest.architecture, 'amd64')
  assert.equal(manifest.distribution, 'ubuntu-24.04')
  assert.equal(manifest.payload_profile, 'runtime')
  assert.match(manifest.installer.file, /^stream-kit-[a-z0-9.-]+-ubuntu24\.04-amd64-setup\.run$/)
  assert.match(manifest.installer.sha256, /^[a-f0-9]{64}$/)
  assert.match(manifest.payload.sha256, /^[a-f0-9]{64}$/)
  const installer = fs.readFileSync(path.join(directory, manifest.installer.file))
  assert.equal(installer.length, manifest.installer.bytes)
  assert.equal(digest(installer), manifest.installer.sha256)
  const marker = Buffer.from('\n__STREAM_KIT_PAYLOAD__\n'), offset = installer.indexOf(marker)
  assert.ok(offset > 0)
  const payload = installer.subarray(offset + marker.length)
  assert.equal(digest(payload), manifest.payload.sha256)
  fs.writeFileSync(path.join(directory, 'runtime.deb'), payload)
  return manifest
}

function main() {
  const directory = 'artifacts/input-download'
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
  const run = read('product-run.json'), jobs = read('product-jobs.json')
  const commit = productSource(run, jobs, process.env.GITHUB_REPOSITORY, process.env.PRODUCT_RUN_ID)
  assert.match(process.env.EXPECTED_RUNTIME_COMMIT ?? '', /^[a-f0-9]{40}$/)
  assert.equal(commit, process.env.EXPECTED_RUNTIME_COMMIT, 'Selected product run differs from explicitly requested runtime')
  if (process.argv[2] === 'product-run') { console.log(commit); return }
  if (process.argv[2] !== 'downloads') throw Error('Expected product-run or downloads')
  const manifest = verifyLinuxRuntimeDownloads(directory, commit)
  fs.mkdirSync('artifacts/native-exit-evidence', { recursive: true })
  fs.writeFileSync('artifacts/native-exit-evidence/provenance.json', JSON.stringify({
    runtime_commit: commit, installer_sha256: manifest.installer.sha256, payload_sha256: manifest.payload.sha256,
    product_run_id: run.id, product_linux_job_id: jobs.jobs.find(j => j.name === 'Linux product / Source-built Linux unified installer').id,
    acceptance_commit: process.env.GITHUB_SHA, runtime_rebuilt: false,
    scope: 'Owned Linux runtime reuse and test-only X11 target; no Android download/build or audio/input/stability rerun',
  }, null, 2) + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

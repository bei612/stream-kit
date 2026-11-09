import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { productSource } from './verify-input-acceptance-sources.mjs'
import { verifyLinuxRuntimeDownloads } from './verify-native-exit-sources.mjs'

const directory = 'artifacts/input-download'
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
const run = read('product-run.json'), jobs = read('product-jobs.json')
const commit = productSource(run, jobs, process.env.GITHUB_REPOSITORY, process.env.PRODUCT_RUN_ID)
assert.match(process.env.EXPECTED_RUNTIME_COMMIT ?? '', /^[a-f0-9]{40}$/)
assert.equal(commit, process.env.EXPECTED_RUNTIME_COMMIT, 'Selected product differs from requested management runtime')

if (process.argv[2] === 'product-run') console.log(commit)
else if (process.argv[2] === 'downloads') {
  const manifest = verifyLinuxRuntimeDownloads(directory, commit)
  const cli = JSON.parse(fs.readFileSync('tools/management-cli/package.json', 'utf8'))
  assert.equal(cli.dependencies['@playwright/cli'], '0.1.22')
  const evidence = 'artifacts/management-live-evidence'
  fs.mkdirSync(evidence, { recursive: true })
  fs.writeFileSync(path.join(evidence, 'provenance.json'), JSON.stringify({
    runtime_commit: commit, installer_sha256: manifest.installer.sha256, payload_sha256: manifest.payload.sha256,
    product_run_id: run.id, product_run_status: run.status, product_run_conclusion: run.conclusion,
    product_linux_job_id: jobs.jobs.find(job => job.name === 'Linux product / Source-built Linux unified installer').id,
    acceptance_commit: process.env.GITHUB_SHA, runtime_rebuilt: false, playwright_cli: cli.dependencies['@playwright/cli'],
    scope: 'Existing real playwright-cli management acceptance against an isolated Linux deployment of verified production runtime; no local Windows, native-exit, Android, audio, target-input or stability acceptance',
  }, null, 2) + '\n')
} else throw Error('Expected product-run or downloads')

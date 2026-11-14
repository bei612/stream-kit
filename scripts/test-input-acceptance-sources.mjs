import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productSource, releaseIdentity, androidCandidateSource } from './verify-input-acceptance-sources.mjs'

const sha = 'a'.repeat(40)
const run = () => ({ id: 123, status: 'in_progress', path: '.github/workflows/windows-product-release.yml', head_repository: { full_name: 'bei612/stream-kit' }, head_branch: 'main', event: 'workflow_dispatch', head_sha: sha })
const jobs = () => ({ jobs: [{ id: 42, run_id: 123, head_sha: sha, name: 'Linux product / Source-built Linux unified installer', status: 'completed', conclusion: 'success' }] })
test('runtime source requires the exact owned main product run and successful Linux job', () => {
  assert.equal(productSource(run(), jobs(), 'bei612/stream-kit', '123'), sha)
  for (const change of [r => { r.head_repository.full_name = 'fork/stream-kit' }, r => { r.head_branch = 'other' }, r => { r.status = 'completed'; r.conclusion = 'failure' }, r => { r.id = 124 }, r => { r.path = '.github/workflows/other.yml' }]) {
    const candidate = run(); change(candidate)
    assert.throws(() => productSource(candidate, jobs(), 'bei612/stream-kit', '123'))
  }
  for (const change of [j => { j.jobs[0].conclusion = 'failure' }, j => { j.jobs[0].status = 'in_progress' }, j => { j.jobs[0].head_sha = 'b'.repeat(40) }, j => { j.jobs[0].run_id = 456 }, j => { j.jobs.push({ ...j.jobs[0] }) }]) {
    const candidate = jobs(); change(candidate)
    assert.throws(() => productSource(run(), candidate, 'bei612/stream-kit', '123'))
  }
  assert.throws(() => productSource(run(), jobs(), 'bei612/stream-kit', ''))
})

test('APK metadata binds a published tag, source commit and persistent signing identity', () => {
  const tag = 'v0.1.0-android-preview.20261109.2'
  const release = { tag_name: tag, draft: false, published_at: '2026-11-09', assets: [{ name: 'stream-kit-android.apk' }] }
  const provenance = { schema_version: 1, application_id: 'io.github.bei612.streamkit', source_commit: sha, apk_sha256: 'd'.repeat(64), signing_certificate_sha256: 'c'.repeat(64) }
  const signing = { application_id: provenance.application_id, certificate_sha256: 'c'.repeat(64) }
  assert.equal(releaseIdentity(release, provenance, signing, { sha }, tag).name, 'stream-kit-android.apk')
  assert.throws(() => releaseIdentity({ ...release, draft: true }, provenance, signing, { sha }, tag))
  assert.throws(() => releaseIdentity(release, provenance, signing, { sha: 'b'.repeat(40) }, tag))
  assert.throws(() => releaseIdentity(release, provenance, { ...signing, certificate_sha256: 'e'.repeat(64) }, { sha }, tag))
  assert.throws(() => releaseIdentity({ ...release, assets: [...release.assets, ...release.assets] }, provenance, signing, { sha }, tag))
})

test('candidate APK requires a successful owned signing workflow, not an arbitrary artifact producer', () => {
  const candidate = {...run(),status:'completed',conclusion:'success',path:'.github/workflows/android-release.yml'}
  assert.equal(androidCandidateSource(candidate, 'bei612/stream-kit', '123'), sha)
  for (const patch of [{status:'in_progress'}, {conclusion:'failure'}, {id:124}, {event:'pull_request'},
    {path:'.github/workflows/android-client.yml'}, {head_branch:'other'}, {head_repository:{full_name:'fork/stream-kit'}}, {head_sha:'invalid'}]) {
    assert.throws(() => androidCandidateSource({...candidate,...patch}, 'bei612/stream-kit', '123'))
  }
})

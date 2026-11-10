import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequestScope } from '../orchestrator/web/src/lib/request-scope.ts'
test('newer response owns data and pagination; obsolete success/error cannot overwrite it', async () => {
  const scope = createRequestScope()
  let published
  let error = ''
  let resolveOld, rejectOld
  const old = scope.begin(), failed = scope.begin()
  const olderSuccess = new Promise(resolve => { resolveOld = resolve }).then(value => { if (old()) published = value })
  const olderFailure = new Promise((_, reject) => { rejectOld = reject }).catch(cause => { if (failed()) error = cause.message })
  const latest = scope.begin()
  const value = { data: ['stopped'], pagination: { page: 2, size: 20, total: 21 } }
  await Promise.resolve(value).then(response => { if (latest()) published = response })
  resolveOld({ data: ['running'], pagination: { page: 1, size: 20, total: 100 } })
  rejectOld(new Error('obsolete failure'))
  await Promise.all([olderSuccess, olderFailure])
  assert.equal(published, value)
  assert.equal(error, '')
})

test('retired consumers reject late results and cannot start another request', async () => {
  const scope = createRequestScope()
  const current = scope.begin()
  let published = false
  scope.retire()
  await Promise.resolve().then(() => { if (current()) published = true })
  assert.equal(published, false)
  assert.equal(scope.begin(), null)
})

test('reactivating a consumer cannot revive a previous lifetime', () => {
  const scope = createRequestScope()
  const previous = scope.begin()
  scope.retire()
  scope.activate()
  const next = scope.begin()
  assert.equal(previous(), false)
  assert.equal(next(), true)
  scope.retire()
  assert.equal(next(), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { managementKeys, managementQueryClient } from '../orchestrator/web/src/api/query-client.ts'

const require = createRequire(new URL('../orchestrator/web/package.json', import.meta.url))
const { QueryClient, QueryObserver } = require('@tanstack/query-core')
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })

test('actual query observer separates resource data and pagination before late prior completion', async () => {
  const cache = client()
  let finishOld
  const observer = new QueryObserver(cache, { queryKey: managementKeys.logs(1, ''), queryFn: () => new Promise(resolve => { finishOld = resolve }) })
  const unsubscribe = observer.subscribe(() => {})
  try {
    observer.setOptions({ queryKey: managementKeys.logs(2, ''), queryFn: async () => ({ data: ['second page'], pagination: { page: 2, size: 20, total: 21 } }) })
    assert.equal(observer.getCurrentResult().data, undefined)
    const current = await observer.refetch({ throwOnError: true })
    finishOld({ data: ['old page'], pagination: { page: 1, size: 20, total: 100 } })
    await new Promise(setImmediate)
    assert.equal(current.data.pagination.page, 2)
    assert.deepEqual(observer.getCurrentResult().data, current.data)
    assert.equal(observer.getCurrentResult().error, null)
  } finally { unsubscribe(); cache.clear() }
})

test('actual query observer never publishes a previous resource error into the current resource', async () => {
  const cache = client()
  let rejectOld
  const observer = new QueryObserver(cache, { queryKey: managementKeys.app('A'), queryFn: () => new Promise((_, reject) => { rejectOld = reject }) })
  const unsubscribe = observer.subscribe(() => {})
  try {
    observer.setOptions({ queryKey: managementKeys.app('B'), queryFn: async () => ({ data: 'B' }) })
    await observer.refetch({ throwOnError: true })
    rejectOld(new Error('previous resource failed'))
    await new Promise(setImmediate)
    assert.equal(observer.getCurrentResult().status, 'success')
    assert.equal(observer.getCurrentResult().error, null)
    assert.deepEqual(observer.getCurrentResult().data, { data: 'B' })
  } finally { unsubscribe(); cache.clear() }
})

test('actual query subscription cancels a consumed AbortSignal on retirement', () => {
  const cache = client()
  let aborted = false
  const observer = new QueryObserver(cache, {
    queryKey: managementKeys.app('owned'),
    queryFn: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })),
  })
  const unsubscribe = observer.subscribe(() => {})
  unsubscribe()
  assert.equal(aborted, true)
  cache.clear()
})

test('superseded confirming refetch waits for its successor rather than returning cached success', async () => {
  const cache = client()
  let calls = 0, finishOld
  const observer = new QueryObserver(cache, {
    queryKey: managementKeys.apps,
    queryFn: async () => ++calls === 2 ? new Promise(resolve => { finishOld = resolve }) : { data: calls },
  })
  const unsubscribe = observer.subscribe(() => {})
  try {
    await observer.refetch({ throwOnError: true })
    const superseded = observer.refetch({ throwOnError: true })
    const current = await observer.refetch({ throwOnError: true })
    assert.equal((await superseded).data.data, 3)
    finishOld({ data: -1 })
    await new Promise(setImmediate)
    assert.equal(current.data.data, 3)
    assert.equal(observer.getCurrentResult().data.data, 3)
  } finally { unsubscribe(); cache.clear() }
})

test('failed confirming refresh rejects even when previous data remains cached', async () => {
  const cache = client()
  let fail = false
  const observer = new QueryObserver(cache, {
    queryKey: managementKeys.apps,
    queryFn: async () => { if (fail) throw Error('authoritative refresh failed'); return { data: 'last confirmed' } },
  })
  const unsubscribe = observer.subscribe(() => {})
  try {
    await observer.refetch({ throwOnError: true })
    fail = true
    await assert.rejects(observer.refetch({ throwOnError: true }), /authoritative refresh failed/)
    assert.equal(observer.getCurrentResult().isSuccess, false)
    assert.deepEqual(observer.getCurrentResult().data, { data: 'last confirmed' })
  } finally { unsubscribe(); cache.clear() }
})

test('active consumers of the same managed resource share one pending query', async () => {
  const cache = client()
  let calls = 0, finish
  const options = { queryKey: managementKeys.apps, queryFn: () => { calls++; return new Promise(resolve => { finish = resolve }) } }
  const first = new QueryObserver(cache, options), second = new QueryObserver(cache, options)
  const unsubscribeFirst = first.subscribe(() => {}), unsubscribeSecond = second.subscribe(() => {})
  try {
    assert.equal(calls, 1)
    const pending = first.refetch({ throwOnError: true })
    finish({ data: ['shared application'] })
    await pending
    assert.deepEqual(first.getCurrentResult().data, second.getCurrentResult().data)
    assert.equal(calls, 1)
  } finally { unsubscribeFirst(); unsubscribeSecond(); cache.clear() }
})

test('management cache uses explicit complete keys and bounded non-persistent defaults', () => {
  assert.notDeepEqual(managementKeys.logs(1, ''), managementKeys.logs(2, ''))
  assert.notDeepEqual(managementKeys.logs(1, ''), managementKeys.logs(1, 'app'))
  assert.notDeepEqual(managementKeys.app('A'), managementKeys.app('B'))
  assert.notDeepEqual(managementKeys.app('A'), managementKeys.candidates('A'))
  const defaults = managementQueryClient.getDefaultOptions().queries
  assert.equal(defaults.retry, false)
  assert.equal(defaults.gcTime, 0)
  const cache = client()
  let calls = 0
  const observer = new QueryObserver(cache, { queryKey: managementKeys.candidates('disabled'), enabled: false, queryFn: async () => { calls++ } })
  const unsubscribe = observer.subscribe(() => {})
  assert.equal(calls, 0)
  unsubscribe(); cache.clear()
})

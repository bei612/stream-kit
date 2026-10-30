import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/media_access.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

function browser(replies, config = { managed_streaming: true, control_plane_url: 'https://control.example' }) {
  const calls = []
  const window = {
    location: new URL('https://gateway.example/stream.html?hostId=1&appId=2&mediaControlToken=old-admin&mediaControlUrl=https://attacker.example#join=short-invitation'),
    setTimeout, clearTimeout,
    history: { replaceState(_state, _title, url) { window.location = new URL(url) } },
  }
  const exports = {}
  const sandbox = { exports, URL, URLSearchParams, AbortController, window,
    require(name) { assert.equal(name, '../config_'); return { CONFIG: config } },
    async fetch(url, options) {
      calls.push({ url, options })
      const next = replies.shift()
      assert.ok(next, 'unexpected HTTP request')
      return { ok: next.status < 400, status: next.status, async json() { return next.body } }
    },
  }
  vm.runInNewContext(compiled, sandbox)
  return { api: exports, window, calls }
}
const joined = { status: 200, body: { status: 'ok', data: { session_id: 'session', host_id: 1, app_id: 2, connection_token: 'own-connection', connection: { connection_id: 'client', role: 'viewer' } } } }
const ticket = { status: 200, body: { status: 'ok', data: { ticket: 'media-admission', expires_at: 'later', role: 'viewer' } } }

test('admission uses configured origin and distinct credentials, scrubs URL secrets', async () => {
  const { api, window, calls } = browser([joined, ticket])
  const access = await api.acquireMediaAccess(1, 2)
  assert.equal(access.bearer, 'own-connection')
  assert.equal(access.ticket, 'media-admission')
  assert.equal(calls[0].url, 'https://control.example/api/v1/client-sessions/join')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer short-invitation')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer own-connection')
  assert.equal(calls[1].options.cache, 'no-store')
  assert.equal(window.location.hash, '')
  assert.equal(window.location.searchParams.has('mediaControlToken'), false)
  assert.equal(window.location.searchParams.has('mediaControlUrl'), false)
  assert.equal(JSON.stringify(calls).includes('old-admin'), false)
})

test('wrong application invitation releases the newly allocated connection', async () => {
  const { api, calls } = browser([joined, { status: 200, body: { status: 'ok', data: {} } }])
  await assert.rejects(api.acquireMediaAccess(99, 2), /does not match/)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.method, 'DELETE')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer own-connection')
})

test('heartbeat rotates connection credential and reflects authoritative role', async () => {
  const renewed = structuredClone(joined)
  renewed.body.data.connection_token = 'renewed-connection'
  renewed.body.data.connection.role = 'controller'
  const { api, calls } = browser([joined, ticket, renewed, ticket])
  const access = await api.acquireMediaAccess(1, 2)
  await api.mediaHeartbeat(access, true, true)
  assert.equal(access.bearer, 'renewed-connection')
  assert.equal(access.role, 'controller')
  await api.refreshMediaTicket(access)
  assert.equal(calls[3].options.headers.Authorization, 'Bearer renewed-connection')
  assert.equal(calls.filter(call => call.url.endsWith('/join')).length, 1)
})

test('revocation remains a typed terminal authorization failure', async () => {
  const { api } = browser([joined, ticket, { status: 410, body: { status: 'error', message: 'revoked' } }])
  const access = await api.acquireMediaAccess(1, 2)
  await assert.rejects(api.mediaHeartbeat(access, false, false), error => error instanceof api.MediaAccessError && error.status === 410)
})

test('missing invitation or insecure control configuration never forwards credentials', async () => {
  for (const control of [null, 'http://control.example', 'https://user:secret@control.example']) {
    const { api, calls } = browser([], { managed_streaming: true, control_plane_url: control })
    await assert.rejects(api.acquireMediaAccess(1, 2))
    assert.equal(calls.length, 0)
  }
  const { api, window, calls } = browser([])
  window.location.hash = ''
  await assert.rejects(api.acquireMediaAccess(1, 2), /new viewing invitation/)
  assert.equal(calls.length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const mediaCode = compile('../third_party/moonlight-web-stream/web/stream/media_access.ts')
const apiCode = compile('../third_party/moonlight-web-stream/web/api.ts')
const joined = { status: 'ok', data: { session_id: 'session', host_id: 1, app_id: 2,
  revision: 1, control_epoch: 0, audio: { microphone_enabled: false },
  connection_token: 'own-connection', connection: { connection_id: 'client', role: 'viewer' } } }
const ticket = token => ({ status: 'ok', data: { ticket: token, expires_at: new Date(Date.now() + 60000).toISOString(), role: 'viewer' } })
const profile = { default_settings: {}, permissions: { allow_transport_webrtc: true, allow_transport_websockets: false } }

function browser(replies, managed = true) {
  const calls = []
  const window = { location: new URL('https://gateway.example/gateway/stream.html?hostId=1&appId=2#join=invitation'),
    addEventListener() {}, setTimeout, clearTimeout,
    history: { replaceState(_state, _title, url) { window.location = new URL(url) } } }
  const config = { CONFIG: { managed_streaming: managed, control_plane_url: 'https://control.example' },
    buildUrl: path => '/gateway' + path }
  const base = { window, URL, URLSearchParams, AbortController, AbortSignal, Response, setTimeout, clearTimeout,
    async fetch(url, options) {
      calls.push({ url, options })
      const next = replies.shift()
      assert.ok(next, 'unexpected HTTP request: ' + url)
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } })
    } }
  const media = {}
  vm.runInNewContext(mediaCode, { ...base, exports: media, require(name) { assert.equal(name, '../config_'); return config } })
  const api = {}
  vm.runInNewContext(apiCode, { ...base, exports: api, require(name) {
    if (name === './stream/media_access') return media
    if (name === './config_') return config
    if (name.includes('uniffi')) return { webrtcLinkHeaderParse: () => [] }
    if (name.includes('component')) return { showModal() { throw new Error('Unexpected gateway login') }, showMessage() {}, showNotification() {} }
    throw new Error('Unexpected import: ' + name)
  } })
  return { api, calls, window }
}

test('managed viewer bootstrap uses only invitation and connection capabilities', async () => {
  const { api, calls, window } = browser([{ body: joined }, { body: ticket('media') }, { body: profile }])
  const result = await api.getViewerBootstrap(1, 2)
  assert.equal(result.api.user, null)
  assert.equal(result.api.bearer, null)
  assert.equal(result.profile.permissions.allow_transport_webrtc, true)
  assert.equal(calls.length, 3)
  assert.equal(window.location.hash, '')
  assert.equal(calls[2].url, '/gateway/api/host/stream/profile')
  assert.equal(calls[2].options.headers['X-Stream-Media-Ticket'], 'media')
  assert.equal(calls[2].options.headers.Authorization, undefined)
  assert.equal(calls[2].options.credentials, 'omit')
  assert.equal(calls[2].options.redirect, 'error')
  for (const target of ['https://attacker.example/gateway/api/host/stream/webrtc/1', '/gateway/api/user',
    '/gateway/api/host/stream/webrtc/1?token=leak', '/gateway/api/host/stream/../user']) {
    await assert.rejects(api.fetchApi(result.api, target, 'DELETE', { noUrlModify: true }), /cannot access/)
  }
  assert.equal(calls.length, 3, 'out-of-scope locations must not cause any network request')
  result.api.mediaAccess = null
  await assert.rejects(api.fetchApi(result.api, '/host/stream/webrtc/1', 'DELETE'), /connection is closed/)
  assert.equal(calls.length, 3, 'closed viewers cannot fall back to native account cookies')
})

test('late ICE and close requests renew admission without borrowing a gateway cookie', async () => {
  const { api, calls } = browser([{ body: joined }, { body: ticket('old') }, { body: profile },
    { body: ticket('fresh') }, { body: {} }])
  const result = await api.getViewerBootstrap(1, 2)
  result.api.mediaAccess.expiresAt = new Date(0).toISOString()
  await api.fetchApi(result.api, '/gateway/api/host/stream/webrtc/1', 'DELETE', { noUrlModify: true, response: 'ignore' })
  assert.equal(calls[3].options.headers.Authorization, 'Bearer own-connection')
  assert.equal(calls[4].options.headers['X-Stream-Media-Ticket'], 'fresh')
  assert.equal(calls[4].options.credentials, 'omit')
})

test('bootstrap rejection releases its logical connection and never falls back to login', async () => {
  const { api, calls } = browser([{ body: joined }, { body: ticket('media') }, { status: 403 }, { body: { status: 'ok' } }])
  await assert.rejects(api.getViewerBootstrap(1, 2), /403/)
  assert.equal(calls.length, 4)
  assert.equal(calls[3].options.method, 'DELETE')
  assert.equal(calls[3].options.headers.Authorization, 'Bearer own-connection')
})

test('native installations preserve their authenticated viewer bootstrap', async () => {
  const { api, calls } = browser([{ body: {} }, { body: { role: profile } }], false)
  const result = await api.getViewerBootstrap(1, 2)
  assert.equal(result.api.mediaAccess, undefined)
  assert.equal(calls[0].url, '/gateway/api/authenticate')
  assert.equal(calls[1].url, '/gateway/api/role')
})

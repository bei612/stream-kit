import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findSessionApplication, sessionOverview } from '../orchestrator/web/src/lib/session-overview.ts'

const connection = (id, expires, state = 'connected') => ({ connection_id: id, expires_at: new Date(expires).toISOString(), state })
const session = (id, state, connections = {}, controller = '') => ({ session_id: id, state, connections, controller_connection_id: controller, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' })

test('application display association requires both renderer and application identity', () => {
  const app = { id: 'local', sunshine_app_id: 8, stream_url: '8080/stream.html?hostId=7&appId=8' }
  assert.equal(findSessionApplication([app], { host_id: 7, app_id: 8 }), app)
  assert.equal(findSessionApplication([app], { host_id: 9, app_id: 8 }), undefined)
  assert.equal(findSessionApplication([{ ...app, stream_url: '' }], { host_id: 7, app_id: 8 }), undefined)
  assert.equal(findSessionApplication([app, { ...app, id: 'ambiguous' }], { host_id: 7, app_id: 8 }), undefined)
  assert.equal(findSessionApplication([{ ...app, stream_url: 'https://host/stream.html?hostId=7&appId=8&hostId=9' }], { host_id: 7, app_id: 8 }), undefined)
})

test('ended application generations never inflate current audience or controller totals', () => {
  const history = Array.from({ length: 42 }, (_, i) => session(`old-${i}`, 'stopped', { old: connection('old', 99999) }, 'old'))
  const active = session('current', 'starting', { live: connection('live', 2000), stale: connection('stale', 1000), invalid: connection('invalid', 3000, 'expired') }, 'stale')
  const result = sessionOverview([...history, active], 1000)
  assert.equal(result.current.length, 1)
  assert.equal(result.history.length, 42)
  assert.equal(result.clients, 1)
  assert.equal(result.controllers, 0)
  assert.equal(sessionOverview([active], 2000).clients, 0)
})

test('an application without viewers remains current until its generation is stopped', () => {
  const result = sessionOverview(['starting', 'running', 'degraded', 'stopping', 'stopped'].map(state => session(state, state)), 1000)
  assert.deepEqual(result.current.map(s => s.state), ['starting', 'running', 'degraded', 'stopping'])
  assert.equal(result.clients, 0)
  assert.equal(result.history.length, 1)
})

test('only a live controller counts and history is newest first without mutating source', () => {
  const older = session('old', 'stopped')
  const newer = { ...session('new', 'stopped'), updated_at: '2026-11-09T00:00:00Z' }
  const current = session('current', 'running', { live: connection('live', 2000) }, 'live')
  const source = [older, newer, current]
  const result = sessionOverview(source, 1000)
  assert.equal(result.controllers, 1)
  assert.deepEqual(result.history.map(s => s.session_id), ['new', 'old'])
  assert.deepEqual(source.map(s => s.session_id), ['old', 'new', 'current'])
})

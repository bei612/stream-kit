import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentMediaObservation } from '../orchestrator/web/src/api/sessions.ts'

test('management never presents stale or mismatched runtime state as current', () => {
  const session = { session_id: 's', revision: 7 }
  const observation = { ...session, upstream_active: true, subscribers: 2, microphone_target: { state: 'unconfigured', device: null } }
  const status = { reachable: true, lease_valid: true, observations_valid: true, acknowledged_at_ms: 1000, lease_expires_at_ms: 11000, observations_expires_at_ms: 4000, observations: { s: observation } }
  assert.equal(currentMediaObservation(status, session, 3999), observation)
  for (const now of [999, 4000, 11000]) assert.equal(currentMediaObservation(status, session, now), undefined)
  for (const key of ['reachable', 'lease_valid', 'observations_valid']) assert.equal(currentMediaObservation({ ...status, [key]: false }, session, 2000), undefined)
  assert.equal(currentMediaObservation(status, { ...session, revision: 8 }, 2000), undefined)
  assert.equal(currentMediaObservation(status, { ...session, session_id: 'other' }, 2000), undefined)
  assert.equal(currentMediaObservation(null, session, 2000), undefined)
})

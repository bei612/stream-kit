import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeApiResponse } from '../orchestrator/web/src/api/response.ts'

test('shared envelope preserves real data, error codes and authoritative pagination', () => {
  const value = JSON.parse('{"status":"ok","data":[],"pagination":{"page":2,"size":20,"total":20},"request_id":"request-1"}')
  assert.equal(decodeApiResponse(value), value)
  assert.equal(decodeApiResponse({ status: 'ok', data: null }).data, null)
  const error = decodeApiResponse(JSON.parse('{"status":"error","code":"SESSION_CONFLICT","message":"conflict"}'))
  assert.equal(error.code, 'SESSION_CONFLICT')
  assert.equal(error.message, 'conflict')
})

test('malformed envelopes cannot masquerade as successful responses or leak their body', () => {
  const privateBody = 'private-response-canary'
  for (const value of [null, [], privateBody, {}, { status: 'success' }, { status: 'ok', message: { privateBody } }, { status: 'ok', code: 401 }, { status: 'ok', request_id: [] }]) {
    assert.throws(() => decodeApiResponse(value), error => error.message === '服务器响应格式无效' && !error.message.includes(privateBody))
  }
})

test('invalid pagination is rejected rather than estimated from row count', () => {
  for (const pagination of [null, {}, { page: 0, size: 20, total: 20 }, { page: 1, size: -1, total: 20 }, { page: 1, size: 20, total: -1 }, { page: 1, size: 20, total: 0.5 }, { page: 1, size: 20, total: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => decodeApiResponse({ status: 'ok', data: [], pagination }), /服务器分页信息无效/)
  }
})

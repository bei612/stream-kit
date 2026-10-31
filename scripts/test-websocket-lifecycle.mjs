import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/transport/web_socket.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function fixture() {
  const exports = {}, timers = new Map(), closed = []
  let socket, nextTimer = 0
  class Socket {
    static OPEN = 1
    readyState = 0; listeners = new Map(); sent = []; closes = 0
    constructor() { socket = this }
    addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]) }
    emit(name, event) { for (const fn of this.listeners.get(name) ?? []) fn(event) }
    send(value) { assert.equal(this.readyState, 1); this.sent.push(value) }
    close() { this.closes++; this.readyState = 3; this.emit('close') }
  }
  vm.runInNewContext(compiled, { exports, WebSocket: Socket, performance, console,
    require(name) {
      if (name === '../../util') return { globalObject: () => ({ setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) } }) }
      if (name === './index') return { generateControlPacketConfig: () => ({}) }
      if (name === '../video') return { createSupportedVideoFormatsBits: () => 0, getSelectedVideoCodec: () => 'h264' }
      if (name.endsWith('moonlight_common_bindings')) return { InputBatcher: class { batchInput() { return [] } removeBatchedInputs() { return [] } } }
      return {}
    },
  })
  const transport = new exports.WebSocketTransport({ host_url: 'http://localhost' })
  transport.onclose = reason => closed.push(reason)
  return { transport, socket, timers, closed }
}

for (const event of ['local', 'error', 'close']) {
  test(`${event} shutdown settles opening and stats without duplicate close or late requests`, async () => {
    const f = fixture()
    const starting = f.transport.startStream({})
    const stats = f.transport.getStats()
    if (event === 'local') await f.transport.close()
    else f.socket.emit(event)
    await starting
    assert.equal((await stats).relayToClientRttMs, 0)
    f.socket.emit('open')
    await f.transport.startStream({})
    await f.transport.close()
    assert.equal(f.socket.sent.length, 0)
    assert.equal(f.socket.closes, 1)
    assert.deepEqual(f.closed, ['failednoconnect'])
  })
}

test('shutdown settles an outstanding ping and discards delayed response and input', async () => {
  const f = fixture()
  f.socket.readyState = 1; f.socket.emit('open')
  await f.transport.startStream({})
  let connections = 0
  f.transport.onconnect = () => connections++
  const response = { data: JSON.stringify({ Response: {} }) }
  f.socket.emit('message', response)
  const stats = f.transport.getStats()
  await Promise.resolve()
  assert.equal(f.socket.sent.length, 2)
  f.transport.controlStream.send({})
  f.transport.controlStream.send({})
  assert.equal(f.timers.size, 1, 'Input events share a single scheduled flush')
  const lateFlush = [...f.timers.values()][0]
  await f.transport.close()
  await stats
  f.socket.emit('message', response)
  f.transport.controlStream.send({})
  f.transport.controlStream.sendRaw({})
  lateFlush()
  assert.equal(f.timers.size, 0)
  assert.equal(f.socket.sent.length, 2)
  assert.equal(connections, 1)
  assert.deepEqual(f.closed, ['failed'])
})

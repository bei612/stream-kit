import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/input.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

function input() {
  const exports = {}, packets = []
  const constructors = new Proxy({}, { get: (_target, type) => class { constructor(value) { this.type = type; this.value = value } } })
  vm.runInNewContext(compiled, {
    exports, EventTarget, TextEncoder, Uint8Array, performance, console: { debug() {} },
    navigator: { getGamepads: () => [] },
    require(name) {
      if (name.includes('moonlight_common_bindings')) return { ClientInputEvent: constructors, ControlPacket: constructors, KeyAction: { Down: 1, Up: 0 }, MouseButtonAction: { Press: 1, Release: 0 } }
      if (name === './keyboard') return { convertToKey: event => event.keyCode, convertToModifiers: () => ({}), emptyKeyModifiers: () => ({}) }
      return {}
    },
  })
  const input = new exports.StreamInput()
  input.setControlStream({ send: packet => packets.push(packet), sendRaw: packet => packets.push(packet) })
  return { input, packets }
}

test('viewers cannot send keys, text, mouse, wheel or controller state; a fresh grant enables input', () => {
  const { input: target, packets } = input()
  const send = () => {
    target.sendKey(true, 65, {})
    target.sendText('你好')
    target.sendMouseMove(10, 20)
    target.sendMouseButton(true, 1)
    target.sendMouseWheel(1, 1)
    target.sendControllerRemove(0)
  }
  target.setAuthority(null)
  send()
  assert.equal(packets.length, 0)
  target.setAuthority('session:connection:epoch-2')
  send()
  assert.equal(packets.length, 7)
  target.setAuthority(null)
  send()
  assert.equal(packets.length, 7)
})

test('handoff discards old pressed keys and stream replacement cannot reenable a viewer', () => {
  const { input: target, packets } = input()
  target.setAuthority('epoch-1')
  target.onKeyDown({ keyCode: 65 })
  assert.equal(packets.length, 1)
  target.setAuthority(null)
  target.setControlStream({ send: packet => packets.push(packet), sendRaw: packet => packets.push(packet) })
  target.sendKey(true, 66, {})
  assert.equal(packets.length, 1)
  target.setAuthority('epoch-3')
  target.onKeyUp({ keyCode: 65 })
  assert.equal(packets.length, 1, 'old key-up must not leak into a later authority generation')
  target.onKeyDown({ keyCode: 66 })
  assert.equal(packets.length, 2)
})

test('stream projects server grants and fails closed while authority is unverified', () => {
  const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/index.ts', import.meta.url), 'utf8')
  const exports = {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, CustomEvent, require: name => name === '../api' ? { managedStreaming: () => true } : {} })
  const stream = Object.create(exports.Stream.prototype)
  const keys = [], events = []
  Object.assign(stream, { stopped: false, authorityVerified: true, input: { setAuthority: key => keys.push(key) },
    eventTarget: { dispatchEvent: event => events.push(event.detail) },
    mediaAccess: { role: 'viewer', sessionId: 's', connectionId: 'c', controlEpoch: 2, microphoneEnabled: true } })
  stream.publishAuthority()
  assert.equal(keys.at(-1), null)
  assert.equal(events.at(-1).authority.control, false)
  stream.mediaAccess.role = 'controller'
  stream.publishAuthority()
  assert.equal(events.at(-1).authority.control, true)
  assert.equal(events.at(-1).authority.microphone, true)
  stream.mediaAccess.microphoneEnabled = false
  stream.publishAuthority()
  assert.equal(events.at(-1).authority.control, true)
  assert.equal(events.at(-1).authority.microphone, false)
  stream.authorityVerified = false
  stream.publishAuthority()
  assert.equal(keys.at(-1), null)
  assert.equal(events.at(-1).authority.control, false)
})

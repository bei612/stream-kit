import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/transport/webrtc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function fixture(fetchApi) {
  const timers = new Map(), frames = new Map(), requests = [], exports = {}
  let nextTimer = 0, peer
  const clock = { setTimeout(fn) { const id=++nextTimer; timers.set(id,fn); return id }, clearTimeout(id) { timers.delete(id) },
    requestAnimationFrame(fn) { const id=++nextTimer; frames.set(id,fn); return id }, cancelAnimationFrame(id) { frames.delete(id) } }
  class Peer {
    connectionState = 'new'
    iceGatheringState = 'complete'
    listeners = new Map()
    constructor() { peer=this }
    addEventListener(name, fn) { this.listeners.set(name,fn) }
    addTransceiver() {}
    createDataChannel() { return {} }
    setRemoteDescription() { return Promise.resolve() }
    close() { this.connectionState='closed'; this.listeners.get('connectionstatechange')?.() }
    candidate(value) { this.listeners.get('icecandidate')({candidate:{toJSON:()=>({candidate:value})}}) }
  }
  vm.runInNewContext(compiled, { exports, RTCPeerConnection:Peer, console:{debug(){}}, requestAnimationFrame() {},
    require(name) {
      if(name==='../../api') return { fetchApi(...args) { requests.push(args); return fetchApi(...args) } }
      if(name==='../../util') return { globalObject:()=>clock }
      if(name==='../../api_bindings') return { StreamKeys:{} }
      if(name.endsWith('moonlight_common_bindings')) return { webrtcSessionAnswerParse:()=>({}), keyStatesEmpty:()=>[], ControlPacket:{WebState:class{}} }
      return {}
    },
  })
  const transport = new exports.WebRTCTransport({}, {})
  return { transport, peer, requests, timers, frames, async flush() { const batch=[...timers.values()]; timers.clear(); await Promise.all(batch.map(fn=>fn())) } }
}

test('ICE gathered before the answer is delivered, including candidates arriving in flight', async () => {
  let finish
  const f=fixture((_api,_url,method)=>method==='PATCH' ? new Promise(resolve=>{finish=resolve}) : Promise.resolve())
  f.peer.candidate('first')
  assert.equal(f.timers.size,0)
  await f.transport.setAnswer({location:'/api/host/stream/webrtc/1',answerSdp:''})
  const pending=f.flush()
  f.peer.candidate('second')
  finish(); await pending
  assert.equal(f.requests[0][3].trickleIceSdpFrag,'a=first')
  assert.equal(f.timers.size,1)
  const next=f.flush(); finish(); await next
  assert.equal(f.requests[1][3].trickleIceSdpFrag,'a=second')
  assert.equal(f.timers.size,0,'No continuous ICE polling')
  await f.transport.close()
})

test('a lost WHEP resource closes one transport and reports failure without an unhandled rejection', async () => {
  const f=fixture((_api,_url,method)=>method==='PATCH' ? Promise.reject(new Error('404 resource gone')) : Promise.resolve())
  const closed=[]; f.transport.onclose=reason=>closed.push(reason)
  await f.transport.setAnswer({location:'/api/host/stream/webrtc/1',answerSdp:''})
  f.peer.candidate('first'); await f.flush()
  assert.deepEqual(closed,['failednoconnect'])
  assert.equal(f.peer.connectionState,'closed')
  f.peer.candidate('late')
  await f.transport.close()
  assert.equal(f.timers.size,0)
  assert.equal(f.requests.filter(r=>r[2]==='DELETE').length,1)
  assert.equal(f.frames.size,0,'A failure before the server data channel opens must cancel input animation frames')
})

test('closing during an ICE request drops late candidates and cannot signal a new failure', async () => {
  let reject
  const f=fixture((_api,_url,method)=>method==='PATCH' ? new Promise((_resolve,fail)=>{reject=fail}) : Promise.resolve())
  const closed=[]; f.transport.onclose=reason=>closed.push(reason)
  await f.transport.setAnswer({location:'/api/host/stream/webrtc/1',answerSdp:''})
  f.peer.candidate('first'); const pending=f.flush()
  f.peer.candidate('second'); await f.transport.close()
  reject(new Error('late network failure')); await pending
  assert.deepEqual(closed,['disconnect'])
  assert.equal(f.timers.size,0)
  assert.equal(f.requests.filter(r=>r[2]==='PATCH').length,1)
  assert.equal(f.frames.size,0)
})

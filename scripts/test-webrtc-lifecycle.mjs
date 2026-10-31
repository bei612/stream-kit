import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/transport/webrtc.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function fixture(fetchApi, failAt) {
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
    addTransceiver(kind) { if(failAt===kind)throw constructionFailure }
    createDataChannel(label) { if(failAt===label)throw constructionFailure; return {} }
    setRemoteDescription() { return Promise.resolve() }
    close() { this.connectionState='closed'; this.listeners.get('connectionstatechange')?.() }
    candidate(value) { this.listeners.get('icecandidate')({candidate:{toJSON:()=>({candidate:value})}}) }
  }
  const constructionFailure=new Error('fixture native initialization failure')
  vm.runInNewContext(compiled, { exports, RTCPeerConnection:Peer, console:{debug(){}}, requestAnimationFrame() {},
    require(name) {
      if(name==='../../api') return { fetchApi(...args) { requests.push(args); return fetchApi(...args) } }
      if(name==='../../util') return { globalObject:()=>clock }
      if(name==='../../api_bindings') return { StreamKeys:{} }
      if(name.endsWith('moonlight_common_bindings')) return { webrtcSessionAnswerParse:()=>({}), keyStatesEmpty:()=>[], ControlPacket:{WebState:class{}} }
      return {}
    },
  })
  let transport, constructionError
  try { transport = new exports.WebRTCTransport({}, {}) }
  catch(error) { if(!failAt)throw error;constructionError=error }
  return { transport, peer, requests, timers, frames, constructionError, constructionFailure, async flush() { const batch=[...timers.values()]; timers.clear(); await Promise.all(batch.map(fn=>fn())) } }
}

for(const failAt of ['moonlight.control.mouse','video','audio','dummy']) {
  test(`construction failure at ${failAt} closes the peer and cancels input scheduling`,()=>{
    const f=fixture(()=>Promise.resolve(),failAt)
    assert.equal(f.transport,undefined)
    assert.equal(f.constructionError,f.constructionFailure)
    assert.equal(f.peer.connectionState,'closed')
    assert.equal(f.frames.size,0)
    assert.equal(f.timers.size,0)
    assert.equal(f.requests.length,0)
  })
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

test('a late answer after close reclaims its server resource without reopening the peer', async () => {
  let finishDelete, descriptions=0
  const f=fixture((_api,_url,method)=>method==='DELETE'?new Promise(resolve=>{finishDelete=resolve}):Promise.resolve())
  f.peer.setRemoteDescription=()=>{descriptions++;return Promise.resolve()}
  const closed=[];f.transport.onclose=reason=>closed.push(reason)
  await f.transport.close()
  const answer={location:'/api/host/stream/webrtc/late',answerSdp:'unused'}
  const first=f.transport.setAnswer(answer), duplicate=f.transport.setAnswer(answer)
  assert.equal(f.requests.filter(r=>r[2]==='DELETE').length,1)
  assert.equal(f.requests[0][1],answer.location)
  finishDelete();await Promise.all([first,duplicate])
  assert.equal(descriptions,0)
  assert.equal(f.peer.connectionState,'closed')
  assert.deepEqual(closed,['disconnect'])
  assert.equal(f.timers.size,0)
})

test('close during local offer creation prevents applying the offer', async () => {
  let finish, applied=0
  const f=fixture(()=>Promise.resolve())
  f.peer.createOffer=()=>new Promise(resolve=>{finish=resolve})
  f.peer.setLocalDescription=()=>{applied++;return Promise.resolve()}
  const pending=f.transport.createOffer({microphone:false})
  await f.transport.close()
  finish({type:'offer',sdp:''})
  await assert.rejects(pending,/closed during offer/)
  assert.equal(applied,0)
  assert.equal(f.requests.length,0)
})

test('close while applying an answer deletes once and does not restart ICE batching', async () => {
  let finish
  const f=fixture(()=>Promise.resolve())
  f.peer.setRemoteDescription=()=>new Promise(resolve=>{finish=resolve})
  f.peer.candidate('before-answer')
  const applying=f.transport.setAnswer({location:'/api/host/stream/webrtc/owned',answerSdp:''})
  await f.transport.close()
  finish();await applying
  await f.transport.close()
  assert.equal(f.requests.filter(r=>r[2]==='DELETE').length,1)
  assert.equal(f.requests.filter(r=>r[2]==='PATCH').length,0)
  assert.equal(f.timers.size,0)
})

test('close during local description prevents publishing an offer to the caller', async () => {
  let finish, entered
  const ready=new Promise(resolve=>{entered=resolve})
  const f=fixture(()=>Promise.resolve())
  f.peer.createOffer=async()=>({type:'offer',sdp:''})
  f.peer.setLocalDescription=()=>{entered();return new Promise(resolve=>{finish=resolve})}
  const pending=f.transport.createOffer({microphone:false})
  await ready;await f.transport.close();finish()
  await assert.rejects(pending,/closed during local description/)
  assert.equal(f.requests.length,0)
})

test('denied cleanup after revocation never reopens the peer or rejects a late answer', async () => {
  const f=fixture(()=>Promise.reject(new Error('Managed media connection is closed')))
  await f.transport.close()
  await f.transport.setAnswer({location:'/api/host/stream/webrtc/revoked',answerSdp:''})
  assert.equal(f.peer.connectionState,'closed')
  assert.equal(f.timers.size,0)
})

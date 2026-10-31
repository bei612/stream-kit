import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'
import { MicrophoneCapture, microphoneInputOptions } from '../third_party/moonlight-web-stream/web/stream/audio/microphone_capture.ts'

function track() {
  return { readyState: 'live', enabled: true, muted: false, stops: 0,
    stop() { this.stops++; this.readyState = 'ended' } }
}
function stream(audio, extra = []) {
  return { getAudioTracks: () => audio, getTracks: () => [...audio, ...extra] }
}

test('legacy microphone settings preserve processing defaults and reject invalid option values',()=>{
  assert.deepEqual(microphoneInputOptions(),{deviceId:'',echoCancellation:true,noiseSuppression:true,autoGainControl:true})
  assert.deepEqual(microphoneInputOptions({deviceId:'x'.repeat(4097),echoCancellation:'false',noiseSuppression:false}),{deviceId:'',echoCancellation:true,noiseSuppression:false,autoGainControl:true})
})

test('selected microphone uses exact native constraints and cannot silently switch devices',async()=>{
  const exports={},requests=[],audio=track()
  let unavailable=false
  const source=readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/audio/microphone_capture.ts',import.meta.url),'utf8')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
    exports,navigator:{mediaDevices:{getUserMedia:async constraints=>{
      requests.push(JSON.parse(JSON.stringify(constraints)))
      if(unavailable)throw new Error('OverconstrainedError: selected microphone unavailable')
      return stream([audio])
    }}}
  })
  const capture=new exports.MicrophoneCapture()
  capture.configure({deviceId:'physical-input',echoCancellation:false,noiseSuppression:false,autoGainControl:false})
  await capture.acquire()
  assert.deepEqual(requests[0],{audio:{deviceId:{exact:'physical-input'},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false})
  assert.throws(()=>capture.configure({deviceId:'other-device'}),/new connection/)
  capture.setAllowed(false);capture.setAllowed(true)
  unavailable=true
  await assert.rejects(capture.acquire(),/selected microphone unavailable/)
  assert.equal(requests.length,2,'failed exact selection must not retry the system default')
  capture.dispose()
})

function pipeFixture(request, bind) {
  let capture, cleanups = 0, gestures = 0, detachments = 0
  const attached = [], notifications = []
  const exports = {}
  const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/audio/microphone_pipe.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText, {
    exports,
    require: () => ({
      MicrophoneCapture: class extends MicrophoneCapture {
        constructor() { super(request); capture = this }
      },
      addPipePassthrough() {},
      showNotification(message) { notifications.push(message) },
    }),
  })
  const pipe = new exports.MicrophonePipe({implementationName:'test',setTrack:async t=>{attached.push(t);await bind?.(t)},clearTrack(){detachments++},cleanup(){cleanups++},onUserInteraction(){gestures++}})
  return {pipe, attached, notifications, capture, detachments:()=>detachments, counts:()=>({cleanups,gestures})}
}

test('microphone pipe never attaches a cached track after teardown or revoke/regrant', async () => {
  for (const action of ['cleanup', 'revoke']) {
    const audio = track(), f = pipeFixture(async()=>stream([audio]))
    await f.capture.acquire()
    const pending = f.pipe.resumeCapture()
    if (action === 'cleanup') f.pipe.cleanup()
    else { f.pipe.setAllowed(false); f.pipe.setAllowed(true) }
    await pending
    assert.deepEqual(f.attached, [])
    assert.equal(audio.stops, 1)
    f.pipe.cleanup()
    f.pipe.onUserInteraction()
    assert.deepEqual(f.counts(), {cleanups:1, gestures:0})
  }
})

test('microphone becomes live only after sender acknowledgement and failed binding releases capture for an explicit retry',async()=>{
  const tracks=[];let finish
  const f=pipeFixture(async()=>{const audio=track();tracks.push(audio);return stream([audio])},()=>new Promise((resolve,reject)=>{finish={resolve,reject}}))
  const pending=f.pipe.resumeCapture()
  assert.equal(f.pipe.resumeCapture(),pending,'concurrent gestures must share the pending sender binding')
  for(let i=0;i<8;i++)await Promise.resolve()
  assert.equal(f.pipe.isLive(),false)
  finish.reject(new Error('replaceTrack rejected'))
  await pending
  assert.equal(f.notifications.length,1);assert.equal(f.detachments(),1)
  assert.equal(tracks[0].readyState,'ended');assert.equal(f.pipe.isLive(),false)
  for(let i=0;i<8;i++)await Promise.resolve()
  assert.equal(tracks.length,1,'binding failure must not automatically reopen a microphone')
  const retry=f.pipe.resumeCapture()
  for(let i=0;i<8;i++)await Promise.resolve()
  finish.resolve();await retry
  assert.equal(tracks.length,2);assert.equal(f.pipe.isLive(),true)
  f.pipe.cleanup();assert.equal(tracks[1].readyState,'ended')
})

test('a late sender error after revoke and regrant cannot stop the next authority or notify',async()=>{
  const audio=track();let fail
  const f=pipeFixture(async()=>stream([audio]),()=>new Promise((_,reject)=>{fail=reject}))
  const pending=f.pipe.resumeCapture()
  for(let i=0;i<8;i++)await Promise.resolve()
  f.pipe.setAllowed(false);f.pipe.setAllowed(true)
  fail(new Error('old sender failed'));await pending
  assert.equal(audio.stops,1);assert.equal(f.notifications.length,0)
  assert.equal(f.pipe.isLive(),false);f.pipe.cleanup()
})

test('concurrent microphone gestures attach once and a new authority can attach a fresh track', async () => {
  const tracks = [], f = pipeFixture(async()=>{ const audio=track();tracks.push(audio);return stream([audio]) })
  await Promise.all([f.pipe.resumeCapture(),f.pipe.resumeCapture(),f.pipe.resumeCapture()])
  assert.equal(tracks.length, 1)
  assert.deepEqual(f.attached, [tracks[0]])
  f.pipe.setAllowed(false);f.pipe.setAllowed(true)
  assert.equal(f.detachments(), 1)
  assert.equal(tracks[0].readyState, 'ended')
  await f.pipe.resumeCapture()
  assert.equal(tracks.length, 2)
  assert.deepEqual(f.attached, tracks)
  f.pipe.cleanup()
  assert.deepEqual(tracks.map(t=>t.stops), [1,1])
})

test('late microphone permission failure cannot notify for a disposed or superseded request', async () => {
  for (const action of ['cleanup', 'revoke', 'active']) {
    let reject
    const f = pipeFixture(()=>new Promise((_, fail)=>{reject=fail}))
    const pending=f.pipe.resumeCapture()
    if(action==='cleanup')f.pipe.cleanup()
    if(action==='revoke'){f.pipe.setAllowed(false);f.pipe.setAllowed(true)}
    reject(new Error('permission denied'))
    await pending
    assert.equal(f.notifications.length, action==='active'?1:0)
    f.pipe.cleanup()
  }
})

test('mobile microphone requires secure audio capture, not screen sharing', () => {
  const browser = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } }
  assert.equal(MicrophoneCapture.supported(browser), true)
  assert.equal(MicrophoneCapture.supported({ ...browser, isSecureContext: false }), false)
  assert.equal(MicrophoneCapture.supported({ isSecureContext: true }), false)
})

test('concurrent gestures share capture and close releases the resource once', async () => {
  const audio = track(), extra = track()
  let requests = 0
  const capture = new MicrophoneCapture(async () => { requests++; return stream([audio], [extra]) })
  const [a, b] = await Promise.all([capture.acquire(), capture.acquire()])
  assert.equal(requests, 1)
  assert.equal(a, audio)
  assert.equal(a, b)
  assert.equal(extra.stops, 1)
  assert.equal(capture.isLive(), true)
  audio.muted = true
  assert.equal(capture.isLive(), false)
  capture.dispose(); capture.dispose()
  assert.equal(audio.stops, 1)
  assert.equal(capture.isLive(), false)
  assert.equal(await capture.acquire(), null)
})

test('closing while permission dialog is pending stops every late track', async () => {
  let resolve
  const capture = new MicrophoneCapture(() => new Promise(done => { resolve = done }))
  const pending = capture.acquire()
  capture.dispose()
  const audio = track(), extra = track()
  resolve(stream([audio], [extra]))
  assert.equal(await pending, null)
  assert.equal(audio.stops, 1)
  assert.equal(extra.stops, 1)
})

test('permission failure allows a later explicit gesture to retry', async () => {
  let requests = 0
  const audio = track()
  const capture = new MicrophoneCapture(async () => {
    if (++requests === 1) throw new Error('denied')
    return stream([audio])
  })
  await assert.rejects(capture.acquire(), /denied/)
  assert.equal(await capture.acquire(), audio)
  capture.dispose()
})

test('viewer gestures do not capture and revocation stops the device without automatic restart', async () => {
  let requests = 0
  const capture = new MicrophoneCapture(async () => { requests++; return stream([track()]) })
  capture.setAllowed(false)
  assert.equal(await capture.acquire(), null)
  assert.equal(requests, 0)
  capture.setAllowed(true)
  assert.equal(requests, 0)
  const first = await capture.acquire()
  capture.setAllowed(false)
  assert.equal(first.stops, 1)
  assert.equal(capture.isLive(), false)
  capture.setAllowed(true)
  assert.equal(requests, 1, 'grant must wait for a new gesture')
  const second = await capture.acquire()
  assert.notEqual(second, first)
  capture.dispose()
  assert.equal(second.stops, 1)
})

test('a pending permission request cannot survive revoke and regrant', async () => {
  let resolve
  const capture = new MicrophoneCapture(() => new Promise(done => { resolve = done }))
  const pending = capture.acquire()
  capture.setAllowed(false)
  capture.setAllowed(true)
  const audio = track()
  resolve(stream([audio]))
  assert.equal(await pending, null)
  assert.equal(audio.stops, 1)
  assert.equal(capture.isLive(), false)
  capture.dispose()
})

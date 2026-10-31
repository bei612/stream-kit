import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'
import { MicrophoneCapture } from '../third_party/moonlight-web-stream/web/stream/audio/microphone_capture.ts'

function track() {
  return { readyState: 'live', enabled: true, muted: false, stops: 0,
    stop() { this.stops++; this.readyState = 'ended' } }
}
function stream(audio, extra = []) {
  return { getAudioTracks: () => audio, getTracks: () => [...audio, ...extra] }
}

function pipeFixture(request) {
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
  const pipe = new exports.MicrophonePipe({implementationName:'test',setTrack:t=>attached.push(t),clearTrack(){detachments++},cleanup(){cleanups++},onUserInteraction(){gestures++}})
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

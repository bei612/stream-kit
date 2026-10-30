import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MicrophoneCapture } from '../third_party/moonlight-web-stream/web/stream/audio/microphone_capture.ts'

function track() {
  return { readyState: 'live', enabled: true, muted: false, stops: 0,
    stop() { this.stops++; this.readyState = 'ended' } }
}
function stream(audio, extra = []) {
  return { getAudioTracks: () => audio, getTracks: () => [...audio, ...extra] }
}

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

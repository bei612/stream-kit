import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const exports = {}, selection = deferred(), construction = deferred(), setup = deferred(), building = deferred(), mounting = deferred()
  let builds = 0, mounts = 0, unmounts = 0, cleanups = 0, closes = 0, releases = 0
  const output = { mount() { mounts++; mounting.resolve() }, unmount() { unmounts++ }, cleanup() { cleanups++ }, setup() { return setup.promise } }
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === './video/pipeline') return { selectVideoPipeline: () => selection.promise }
    if (name === './audio/pipeline') return { selectAudioPipeline: () => selection.promise }
    if (name === './video') return { emptyVideoCodecs: () => ({}) }
    if (name === './pipeline/index') return { pipelineToString: () => 'test' }
    return {}
  } })
  const stream = Object.create(exports.Stream.prototype)
  const transport = { async close() { closes++ }, connectVideoPipeline() { builds++; building.resolve(); return construction.promise }, connectAudioPipeline() { builds++; building.resolve(); return construction.promise } }
  Object.assign(stream, { transport, stopped: false, pipelineGeneration: 0, videoRenderer: null, audioPlayer: null, microphoneListener: null,
    settings: {}, divElement: {}, logger: { debug() {} }, debugLog() {}, stats: { setVideoPipeline() {}, setAudioPipeline() {} },
    async releaseMediaAccess() { releases++ } })
  return { stream, transport, output, selection, construction, setup, building, mounting,
    counts: () => ({ builds, mounts, unmounts, cleanups, closes, releases }) }
}
for (const [method, property] of [['createVideoRenderer', 'videoRenderer'], ['createAudioPlayer', 'audioPlayer']]) {
  test(`${method}: stop while selecting never builds an output`, async () => {
    const f = fixture(), pending = f.stream[method]('data', { codec: 'h264' })
    await f.stream.stop(); f.selection.resolve({})
    assert.equal(await pending, false); assert.equal(f.counts().builds, 0)
  })
  test(`${method}: late construction is released without mounting`, async () => {
    const f = fixture(); f.selection.resolve({})
    const pending = f.stream[method]('data', { codec: 'h264' }); await f.building.promise
    await f.stream.stop(); f.construction.resolve(f.output)
    assert.equal(await pending, false)
    assert.equal(f.counts().mounts, 0); assert.equal(f.counts().cleanups, 1)
    assert.equal(f.stream[property], null)
  })
  test(`${method}: disconnect during setup releases the mounted output`, async () => {
    const f = fixture(); f.selection.resolve({}); f.construction.resolve(f.output)
    const pending = f.stream[method]('data', { codec: 'h264' }); await f.mounting.promise
    assert.equal(f.stream[property], f.output)
    f.stream.cleanupPipelines(); f.setup.resolve()
    assert.equal(await pending, false); assert.equal(f.stream[property], null)
    assert.equal(f.counts().cleanups, 1); assert.equal(f.counts().unmounts, 1)
  })
  test(`${method}: a superseded generation cannot publish into the same transport`, async () => {
    const f = fixture(); f.selection.resolve({})
    const pending = f.stream[method]('data', { codec: 'h264' }); await f.building.promise
    f.stream.cleanupPipelines(); f.construction.resolve(f.output)
    assert.equal(await pending, false); assert.equal(f.counts().mounts, 0); assert.equal(f.counts().cleanups, 1)
  })
  test(`${method}: ready output is released once across repeated cleanup`, async () => {
    const f = fixture(); f.selection.resolve({}); f.construction.resolve(f.output); f.setup.resolve()
    assert.equal(await f.stream[method]('data', { codec: 'h264' }), true)
    await f.stream.stop(); f.stream.cleanupPipelines()
    assert.equal(f.counts().cleanups, 1); assert.equal(f.counts().unmounts, 1)
    assert.equal(f.counts().closes, 1); assert.equal(f.counts().releases, 1)
  })
}
test('one failing output cannot prevent the other output from being released', () => {
  const f = fixture()
  f.stream.videoRenderer = { unmount() { throw new Error('detached') }, cleanup() { throw new Error('decoder failed') } }
  f.stream.audioPlayer = f.output
  f.stream.cleanupPipelines()
  assert.equal(f.counts().cleanups, 1); assert.equal(f.stream.videoRenderer, null); assert.equal(f.stream.audioPlayer, null)
})
test('microphone cleanup failure cannot prevent transport and outputs from closing', async () => {
  const f = fixture()
  f.stream.microphoneListener = { cleanup() { throw new Error('sender failed') } }
  f.stream.audioPlayer = f.output
  await f.stream.stop()
  assert.equal(f.stream.microphoneListener, null)
  assert.equal(f.counts().cleanups, 1); assert.equal(f.counts().closes, 1); assert.equal(f.counts().releases, 1)
})

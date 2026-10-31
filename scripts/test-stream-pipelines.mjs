import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source = readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('automatic transport selection falls back when native WebRTC initialization throws', async () => {
  const exports={};let websocket=0,releases=0,attempts=0
  vm.runInNewContext(compiled,{exports,require(name){
    if(name==='./transport/webrtc')return {WebRTCTransport:class{constructor(){attempts++;throw new Error('WebRTC unavailable')}}}
    if(name==='../api')return {apiEnsureMediaAccess:async()=>null,apiWebRTCConfiguration:async()=>({iceServers:[]})}
    return {}
  }})
  const stream=Object.create(exports.Stream.prototype)
  Object.assign(stream,{api:{},permissions:{allow_transport_webrtc:true},settings:{dataTransport:'auto'},stopped:false,transport:null,
    debugLog(){},startMediaHeartbeat(){},cleanupPipelines(){},cleanupMicrophone(){},
    async releaseMediaAccess(){releases++},
    async tryWebSocketTransport(){websocket++;return 'disconnect'},
  })
  await stream.startConnection()
  assert.equal(attempts,1)
  assert.equal(websocket,1)
  assert.equal(releases,1)
})

for (const phase of ['capability-probe','offer-request']) {
  test(`stop owns and closes the WebRTC peer during ${phase}`, async () => {
    const exports={},entered=deferred(),resume=deferred()
    let peer,posts=0
    class Transport {
      controlStream={};closed=false
      constructor(){peer=this}
      async createOffer(){if(this.closed)throw new Error('closed');return 'offer'}
      async setAnswer(){}
      async close(){if(this.closed)return;this.closed=true;this.onclose?.('disconnect')}
    }
    vm.runInNewContext(compiled,{exports,require(name){
      if(name==='./transport/webrtc')return {WebRTCTransport:Transport}
      if(name==='../api')return {
        apiEnsureMediaAccess:async()=>null,apiWebRTCConfiguration:async()=>({iceServers:[]}),
        apiWebRTCOffer:async()=>{posts++;entered.resolve();await resume.promise;return {location:'/owned',answerSdp:''}},
      }
      return {}
    }})
    const stream=Object.create(exports.Stream.prototype)
    Object.assign(stream,{api:{},permissions:{allow_transport_webrtc:true},stopped:false,transport:null,
      debugLog(){},startMediaHeartbeat(){},cleanupPipelines(){},cleanupMicrophone(){},releaseMediaAccess:async()=>{},
      input:{setControlStream(){}},stats:{setTransport(){}},
      async createTransportOptions(){if(phase==='capability-probe'){entered.resolve();await resume.promise}return {microphone:false}},
    })
    const connecting=stream.tryWebRTCTransport()
    await entered.promise
    assert.equal(stream.transport,peer,'The stream must own a negotiating peer')
    await stream.stop()
    assert.equal(peer.closed,true)
    resume.resolve();await connecting
    assert.equal(stream.transport,null)
    assert.equal(posts,phase==='offer-request'?1:0)
  })
}

function builderFixture() {
  const source=readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/pipeline/index.ts',import.meta.url),'utf8')
  const exports={}
  const stub=class { static pipeName='fixture'; static getInfo(){return Promise.resolve({environmentSupported:true})} }
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:()=>new Proxy({}, {get:()=>stub}),console:{warn(){}}})
  return exports
}

test('pipeline shape errors are rejected before constructing any output resources', () => {
  const builder=builderFixture();let created=0
  class Output {static type='sample';static pipeName='output';constructor(){created++}}
  class Bad {static baseType='frame';static type='data';static pipeName='bad';constructor(){created++}}
  for(const pipes of [[Bad],['unregistered']]) {
    assert.equal(builder.buildPipelineNoCheck({pipes,output:Output}),null)
    assert.equal(created,0)
  }
})

test('construction failure releases the owned chain once and preserves the original error', () => {
  const builder=builderFixture(),failure=new Error('native decoder unavailable')
  for(const cleanupThrows of [false,true]) {
    const events=[]
    class Output {
      static type='sample';static pipeName='output'
      constructor(){events.push('output-open')}
      cleanup(){events.push('output-close');if(cleanupThrows)throw new Error('cleanup failed')}
    }
    class Adapter {
      static type='decoded';static baseType='sample';static pipeName='adapter'
      constructor(base){this.base=base;events.push('adapter-open')}
      cleanup(){events.push('adapter-close');this.base.cleanup()}
    }
    class Broken {
      static type='data';static baseType='decoded';static pipeName='broken'
      constructor(){throw failure}
    }
    assert.throws(()=>builder.buildPipelineNoCheck({pipes:[Broken,Adapter],output:Output}),error=>error===failure)
    assert.deepEqual(events,['output-open','adapter-open','adapter-close','output-close'])
  }
})

test('unsupported or failed output capability cannot construct a pipeline', async () => {
  for(const mode of ['unsupported','rejected']) {
    const builder=builderFixture();let created=0
    class Output {
      static type='sample';static pipeName='output'
      static async getInfo(){if(mode==='rejected')throw new Error('not available');return {environmentSupported:false}}
      constructor(){created++}
    }
    assert.equal(await builder.buildPipeline({pipes:[],output:Output}),null)
    assert.equal(created,0)
  }
})

test('valid pipeline retains ownership and forwards output options until explicit cleanup', () => {
  const builder=builderFixture(),events=[],options={width:1280},logger={debug(){}}
  class Output {
    static type='sample';static pipeName='output'
    constructor(receivedLogger,receivedOptions){assert.equal(receivedLogger,logger);assert.equal(receivedOptions,options);events.push('output-open')}
    getBase(){return null}
    cleanup(){events.push('output-close')}
  }
  class Input {
    static type='data';static baseType='sample';static pipeName='input'
    constructor(base,receivedLogger){this.base=base;assert.equal(receivedLogger,logger);events.push('input-open')}
    getBase(){return this.base}
    cleanup(){events.push('input-close');this.base.cleanup()}
  }
  const pipe=builder.buildPipelineNoCheck({pipes:[Input],output:Output},logger,options)
  assert.ok(pipe instanceof Input)
  assert.ok(builder.getRootPipe(pipe) instanceof Output)
  assert.deepEqual(events,['output-open','input-open'])
  pipe.cleanup()
  assert.deepEqual(events,['output-open','input-open','input-close','output-close'])
})
function fixture(heartbeat = async () => {}) {
  const exports = {}, selection = deferred(), construction = deferred(), setup = deferred(), building = deferred(), mounting = deferred()
  let builds = 0, mounts = 0, unmounts = 0, cleanups = 0, closes = 0, releases = 0
  const output = { mount() { mounts++; mounting.resolve() }, unmount() { unmounts++ }, cleanup() { cleanups++ }, setup() { return setup.promise } }
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === '../api') return { managedStreaming: () => true, apiMediaHeartbeat: heartbeat }
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

for (const outcome of ['same', 'epoch', 'viewer', 'failure', 'stop', 'no-consent']) {
  test(`microphone recovery requires current consent and refreshed authority: ${outcome}`, async () => {
    const gate = deferred()
    const f = fixture(async access => {
      await gate.promise
      if (outcome === 'failure') throw new Error('unavailable')
      if (outcome === 'epoch') access.controlEpoch++
      if (outcome === 'viewer') access.role = 'viewer'
    })
    f.stream.settings.microphone = true
    f.stream.mediaAccess = { sessionId: 's', connectionId: 'c', role: 'controller', microphoneEnabled: true, controlEpoch: 7 }
    let disposed = 0, resumed = 0
    f.stream.microphoneListener = { isLive: () => outcome !== 'no-consent', cleanup() { disposed++ } }
    f.stream.microphoneResumeKey = null
    f.stream.microphoneSourceKey = f.stream.microphoneAuthorityKey()
    f.stream.cleanupMicrophone()
    assert.equal(disposed, 1)
    assert.equal(!!f.stream.microphoneResumeKey, outcome !== 'no-consent')
    const source = { setAllowed() {}, cleanup() {}, async resumeCapture() { resumed++ } }
    f.transport.connectMicrophonePipeline = async () => source
    const pending = f.stream.configureMicrophone('audiotrack')
    await Promise.resolve()
    if (outcome === 'stop') await f.stream.stop()
    gate.resolve()
    await pending
    assert.equal(resumed, outcome === 'same' ? 1 : 0)
    assert.equal(f.stream.microphoneResumeKey, null)
  })
}
test('microphone cleanup failure cannot prevent transport and outputs from closing', async () => {
  const f = fixture()
  f.stream.microphoneListener = { cleanup() { throw new Error('sender failed') } }
  f.stream.audioPlayer = f.output
  await f.stream.stop()
  assert.equal(f.stream.microphoneListener, null)
  assert.equal(f.counts().cleanups, 1); assert.equal(f.counts().closes, 1); assert.equal(f.counts().releases, 1)
})

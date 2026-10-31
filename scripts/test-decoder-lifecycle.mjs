import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

function compile(file) {
  return ts.transpileModule(readFileSync(new URL(`../third_party/moonlight-web-stream/web/stream/video/${file}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
}

test('capability collection isolates synchronous and asynchronous candidate failures and caches successful results', async () => {
  const source=readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/pipeline/index.ts',import.meta.url),'utf8')
  const exports={},classes=new Map(),calls=new Map(),warnings=[]
  const module=new Proxy({}, {get(_,name){
    if(!classes.has(name))classes.set(name,class {
      static pipeName=name
      static getInfo(){
        calls.set(name,(calls.get(name)||0)+1)
        if(name==='AudioDecoderPipe')throw new Error('query unavailable')
        if(name==='VideoDecoderPipe')return Promise.reject(new Error('codec query failed'))
        return Promise.resolve({environmentSupported:true})
      }
    })
    return classes.get(name)
  }})
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:()=>module,console:{warn:(...args)=>warnings.push(args)}})
  const [first,second]=await Promise.all([exports.gatherPipeInfo(),exports.gatherPipeInfo()])
  assert.equal(first,second)
  assert.equal(first.get(classes.get('AudioDecoderPipe')).environmentSupported,false)
  assert.equal(first.get(classes.get('VideoDecoderPipe')).environmentSupported,false)
  assert.ok([...first.values()].filter(info=>info.environmentSupported).length>2)
  assert.ok([...calls.values()].every(count=>count===1))
  assert.equal(warnings.length,2)
})

test('one rejected video codec probe does not erase supported alternatives', async () => {
  const exports={},queried=[]
  class Decoder {
    static async isConfigSupported(config){
      queried.push(config.codec)
      if(config.codec.startsWith('avc3.'))throw new TypeError('unsupported in-band identifier')
      return {supported:config.codec==='out-h264'}
    }
  }
  vm.runInNewContext(compile('video_decoder_pipe'),{exports,VideoDecoder:Decoder,require(name){
    if(name==='../../util')return {globalObject:()=>({VideoDecoder:Decoder})}
    if(name==='../video')return {emptyVideoCodecs:()=>({h264:false,h265:false,h264High8444:false})}
    if(name==='./annex_b_translator')return {VIDEO_DECODER_CODECS_OUT_OF_BAND:{h264:'out-h264',h265:'out-h265',h264High8444:'out-444'}}
    return {}
  }})
  const info=await exports.VideoDecoderPipe.getInfo()
  assert.equal(info.environmentSupported,true)
  assert.equal(info.supportedVideoCodecs.h264,true)
  assert.equal(info.supportedVideoCodecs.h265,false)
  assert.ok(queried.includes('out-h264'))
  Decoder.isConfigSupported=undefined
  const unknown=await exports.VideoDecoderPipe.getInfo()
  assert.ok(Object.values(unknown.supportedVideoCodecs).every(value=>value===false))
})

test('rejected hardware preference still allows a supported default video configuration', async () => {
  const exports={},queries=[],configured=[]
  class Decoder {
    state='unconfigured'
    static async isConfigSupported(config){
      queries.push(config)
      if(config.hardwareAcceleration)throw new Error('hardware unavailable')
      return {supported:true}
    }
    configure(config){configured.push(config);this.state='configured'}
    reset(){this.state='unconfigured'}
    close(){this.state='closed'}
  }
  vm.runInNewContext(compile('video_decoder_pipe'),{exports,VideoDecoder:Decoder,require(name){
    if(name==='../pipeline/pipes')return {addPipePassthrough(){}}
    if(name==='./codec_level')return {videoDecoderCodecInBand:()=> 'avc3.42E01E'}
    return {}
  }})
  const pipe=new exports.VideoDecoderPipe({implementationName:'test',setup(){},cleanup(){}})
  await pipe.setup({width:1280,height:720,fps:60,codec:'h264'})
  assert.equal(queries.length,2)
  assert.equal(configured.length,1)
  assert.equal(configured[0].hardwareAcceleration,undefined)
  pipe.cleanup()
})
function startupFixture() {
  let resolve
  const pending = new Promise(r => { resolve = r }), exports = {}, decoded = []
  class Decoder {
    state = 'unconfigured'
    decodeQueueSize = 0
    static isConfigSupported() { return pending }
    reset() {}
    configure() { this.state = 'configured' }
    decode(chunk) { decoded.push(chunk.timestamp) }
    close() { this.state = 'closed' }
  }
  vm.runInNewContext(compile('video_decoder_pipe'), { exports, VideoDecoder: Decoder,
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value) } }, require(name) {
      if (name === '../pipeline/pipes') return { addPipePassthrough() {} }
      if (name === './codec_level') return { videoDecoderCodecInBand: () => 'avc3.42E01E' }
      return {}
    } })
  const pipe = new exports.VideoDecoderPipe({ implementationName: 'test', setup() {}, cleanup() {} })
  const setup = pipe.setup({ width: 1280, height: 720, fps: 60, codec: 'h264' })
  return { pipe, decoded, ready: async () => { resolve({ supported: true }); await setup },
    unit: (type, timestamp, size = 1) => ({ type, timestampMicroseconds: timestamp, durationMicroseconds: 16667, data: new Uint8Array(size) }) }
}
test('startup frame overflow discards dependent frames and requests recovery only once ready', async () => {
  const f = startupFixture()
  f.pipe.submitDecodeUnit(f.unit('key', 0))
  for (let i = 1; i <= 1000; i++) f.pipe.submitDecodeUnit(f.unit('delta', i))
  assert.equal(f.pipe.bufferedUnits.length, 0); assert.equal(f.pipe.bufferedBytes, 0)
  assert.equal(f.pipe.pollRequestIdr(), false)
  await f.ready()
  assert.equal(f.pipe.pollRequestIdr(), true); assert.equal(f.pipe.pollRequestIdr(), false)
  f.pipe.submitDecodeUnit(f.unit('delta', 1001)); assert.deepEqual(f.decoded, [])
  f.pipe.submitDecodeUnit(f.unit('key', 1002)); f.pipe.submitDecodeUnit(f.unit('delta', 1003))
  assert.deepEqual(f.decoded, [1002, 1003]); f.pipe.cleanup()
})
test('startup retains only the newest valid keyframe chain and drains immediately at readiness', async () => {
  const f = startupFixture()
  for (const [type, time] of [['delta', 0], ['key', 1], ['delta', 2], ['key', 3], ['delta', 4]]) f.pipe.submitDecodeUnit(f.unit(type, time))
  assert.equal(f.pipe.bufferedUnits.length, 2)
  await f.ready()
  assert.deepEqual(f.decoded, [3, 4]); assert.equal(f.pipe.bufferedBytes, 0)
  assert.equal(f.pipe.pollRequestIdr(), false); f.pipe.cleanup()
})
test('startup compressed-byte limit rejects oversized frames and cumulative overflow', async () => {
  const f = startupFixture(), limit = f.pipe.constructor.startupByteLimit
  f.pipe.submitDecodeUnit(f.unit('key', 0, limit + 1))
  assert.equal(f.pipe.bufferedBytes, 0)
  const subarray = f.unit('key', 0, limit + 1); subarray.data = subarray.data.subarray(0, 1)
  f.pipe.submitDecodeUnit(subarray)
  assert.equal(f.pipe.bufferedUnits.length, 0, 'a small view must not retain an oversized allocation')
  f.pipe.submitDecodeUnit(f.unit('key', 1, limit)); assert.equal(f.pipe.bufferedBytes, limit)
  f.pipe.submitDecodeUnit(f.unit('delta', 2)); assert.equal(f.pipe.bufferedBytes, 0)
  f.pipe.submitDecodeUnit(f.unit('delta', 3)); assert.equal(f.pipe.bufferedUnits.length, 0)
  f.pipe.submitDecodeUnit(f.unit('key', 4)); await f.ready()
  assert.deepEqual(f.decoded, [4]); assert.equal(f.pipe.pollRequestIdr(), false)
  f.pipe.cleanup(); assert.equal(f.pipe.pollRequestIdr(), false)
})
test('WebCodecs cleanup during format detection cannot configure a closed decoder', async () => {
  let resolve, callback, closes = 0, cleanups = 0, setups = 0, submissions = 0
  const pending = new Promise(r => { resolve = r }), exports = {}
  class Decoder {
    state = 'unconfigured'
    constructor(options) { callback = options.output }
    static isConfigSupported() { return pending }
    close() { closes++; this.state = 'closed' }
    configure() { throw new Error('must not configure after cleanup') }
  }
  vm.runInNewContext(compile('video_decoder_pipe'), { exports, VideoDecoder: Decoder, require(name) {
    if (name === '../pipeline/pipes') return { addPipePassthrough() {} }
    if (name === './codec_level') return { videoDecoderCodecInBand: () => 'avc3.42E01E' }
    return {}
  } })
  const pipe = new exports.VideoDecoderPipe({ implementationName: 'test', cleanup() { cleanups++ }, setup() { setups++ }, submitFrame() { submissions++ } })
  const setup = pipe.setup({ width: 1280, height: 720, fps: 60, codec: 'h264' })
  pipe.submitDecodeUnit({ type: 'key', data: new Uint8Array(1) }); assert.equal(pipe.bufferedUnits.length, 1)
  pipe.cleanup(); pipe.cleanup(); resolve({ supported: true }); await setup
  let frameCloses = 0; callback({ close() { frameCloses++ } }); pipe.submitDecodeUnit({})
  assert.equal(closes, 1); assert.equal(cleanups, 1); assert.equal(setups, 0)
  assert.equal(submissions, 0); assert.equal(frameCloses, 1); assert.equal(pipe.bufferedUnits.length, 0)
})
test('late OpenH264 module loading cannot allocate a decoder after cleanup', async () => {
  let resolve, loaded, allocations = 0, cleanups = 0, setups = 0
  const pending = new Promise(r => { resolve = r }), loading = new Promise(r => { loaded = r }), exports = {}
  vm.runInNewContext(compile('openh264_decoder_pipe'), { exports, require(name) {
    if (name === '../../libopenh264/decoder.js') return { default() { loaded(); return pending } }
    if (name === '../../libopenh264/index') return { OpenH264Decoder: class { constructor() { allocations++ } } }
    if (name === '../pipeline/pipes') return { addPipePassthrough() {} }
    return {}
  } })
  const pipe = new exports.OpenH264DecoderPipe({ implementationName: 'test', cleanup() { cleanups++ }, setup() { setups++ } })
  const setup = pipe.setup(); await loading
  pipe.cleanup(); pipe.cleanup(); resolve({}); await setup
  assert.equal(allocations, 0); assert.equal(cleanups, 1); assert.equal(setups, 0)
})
test('MediaSource readiness after cleanup cannot restart its output', async () => {
  let resolve, cleanups = 0, setups = 0, revoked = 0
  const exports = {}, ready = new Promise(r => { resolve = r })
  vm.runInNewContext(compile('media_source_decoder'), { exports,
    document: { removeEventListener() {} }, URL: { revokeObjectURL() { revoked++ } }, require() { return {} } })
  const pipe = Object.create(exports.MediaSourceDecoder.prototype)
  Object.assign(pipe, { disposed: false, onReadyPromise: ready, url: 'blob:test',
    base: { setUrl() {}, setup() { setups++ }, cleanup() { cleanups++ } } })
  const setup = pipe.setup({ width: 1280, height: 720, fps: 60 })
  pipe.cleanup(); pipe.cleanup(); resolve(); await setup
  pipe.submitDecodeUnit({})
  assert.equal(cleanups, 1); assert.equal(setups, 0); assert.equal(revoked, 1)
})

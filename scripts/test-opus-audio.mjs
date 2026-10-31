import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'
import loadOpus from '../third_party/moonlight-web-stream/web/libopus/libopus.js'

function compile(file,require=()=>({})) {
  const exports={}
  const source=readFileSync(new URL(`../third_party/moonlight-web-stream/web/${file}.ts`,import.meta.url),'utf8')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require})
  return exports
}
const {OpusMultistreamDecoder}=compile('libopus/index')
const tick=()=>new Promise(resolve=>setImmediate(resolve))

test('real Opus WASM creates stereo and six-channel decoders and handles changing frame capacity',async()=>{
  const module=await loadOpus()
  for(const config of [{channels:2,streams:1,coupled:1,mapping:[0,1]},{channels:6,streams:4,coupled:2,mapping:[0,4,1,2,3,5]}]) {
    const decoder=new OpusMultistreamDecoder(module,48000,config.channels,config.streams,config.coupled,config.mapping)
    try {
      for(const frames of [960,240,480,120,960]) {
        const output=new Float32Array(5760*config.channels).fill(42)
        const count=decoder.decodeFloat(null,output,frames,false)
        assert.equal(count,frames)
        assert.ok(output.subarray(0,count*config.channels).every(Number.isFinite))
        assert.ok(output.subarray(count*config.channels).every(value=>value===42),'do not copy unused native capacity')
      }
    }finally{decoder.destroy();decoder.destroy()}
  }
})

test('Opus native setup always restores the stack and allocator failure is explicit',async()=>{
  let restored=0
  const failed={stackSave:()=>17,stackAlloc:()=>32,HEAPU8:new Uint8Array(100),stackRestore:value=>{assert.equal(value,17);restored++},_opus_multistream_decoder_create(){throw new Error('native failure')}}
  assert.throws(()=>new OpusMultistreamDecoder(failed,48000,2,1,1,[0,1]),/native failure/);assert.equal(restored,1)
  const module=await loadOpus(),decoder=new OpusMultistreamDecoder({...module,_malloc:()=>0},48000,2,1,1,[0,1])
  try{assert.throws(()=>decoder.decodeFloat(null,new Float32Array(1920),960,false),/Memory Allocation Failed/)}finally{decoder.destroy()}
})

function fixture(){
  let resolve,reject,created=0,destroyed=0,cleanups=0
  const ready=new Promise((a,b)=>{resolve=a;reject=b}),frames=[],logs=[]
  class Decoder {
    constructor(){created++}
    decodeFloat(data,buffer){const count=data[0];for(let i=0;i<count*2;i++)buffer[i]=i;return count}
    destroy(){destroyed++}
  }
  const {OpusAudioDecoderPipe}=compile('stream/audio/opus_decoder_pipe',name=>name==='../../libopus/index'?{OpusMultistreamDecoder:Decoder}:name==='../../libopus/libopus'?{default:()=>ready}:{addPipePassthrough(){}})
  const pipe=new OpusAudioDecoderPipe({implementationName:'fixture',setup(){},playPcm:unit=>frames.push(unit.channelData.map(channel=>Array.from(channel))),cleanup(){cleanups++}},{debug:text=>logs.push(text)})
  pipe.setup({sampleRate:48000,channels:2,streams:1,coupledStreams:1,mapping:[0,1],samplesPerFrame:16})
  return {pipe,resolve,reject,frames,logs,counts:()=>({created,destroyed,cleanups}),unit:count=>({data:new Uint8Array([count]),timestampMicroseconds:0,durationMicroseconds:20000})}
}

test('deinterleaved PCM grows by samples and shorter packets exclude stale tails',async()=>{
  const f=fixture();f.resolve({});await tick()
  for(const count of [2,6,1])f.pipe.decodeAndPlay(f.unit(count))
  assert.deepEqual(f.frames.map(frame=>frame[0].length),[2,6,1])
  assert.deepEqual(Array.from(f.frames[1][0]),[0,2,4,6,8,10]);assert.deepEqual(Array.from(f.frames[2][1]),[1])
  f.pipe.cleanup();f.pipe.cleanup();f.pipe.decodeAndPlay(f.unit(2))
  assert.deepEqual(f.counts(),{created:1,destroyed:1,cleanups:1})
})

test('late module load and module rejection are handled without reviving a stopped pipe',async()=>{
  const late=fixture();late.pipe.cleanup();late.resolve({});await tick();late.pipe.decodeAndPlay(late.unit(2))
  assert.deepEqual(late.counts(),{created:0,destroyed:0,cleanups:1})
  const failed=fixture();failed.reject(new Error('load failed'));await tick();failed.pipe.decodeAndPlay(failed.unit(2))
  assert.equal(failed.logs.length,1);assert.equal(failed.counts().created,0);failed.pipe.cleanup()
})

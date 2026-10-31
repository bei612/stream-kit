import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

function compile(file,require,globals={}){
  const exports={}
  const source=readFileSync(new URL(`../third_party/moonlight-web-stream/web/stream/${file}.ts`,import.meta.url),'utf8')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require,...globals})
  return exports
}
const {RealtimeTrackWriter}=compile('pipeline/realtime_track_writer',()=>({}))
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function sample(){return {closes:0,close(){this.closes++}}}
function fixture(){
  const writes=[],errors=[];let stops=0,aborts=0,releases=0
  const writer={desiredSize:1,closed:Promise.resolve(),write(value){return new Promise((resolve,reject)=>writes.push({value,resolve,reject}))},abort(){aborts++;return Promise.resolve()},releaseLock(){releases++}}
  const output=new RealtimeTrackWriter(writer,{stop(){stops++}},error=>errors.push(error))
  return {output,writer,writes,errors,counts:()=>({stops,aborts,releases})}
}

test('slow output retains only one media sample and drops excess samples immediately',async()=>{
  const f=fixture(),first=sample();f.output.submit(first)
  for(let i=0;i<1000;i++){const dropped=sample();f.output.submit(dropped);assert.equal(dropped.closes,1)}
  assert.equal(f.writes.length,1);assert.equal(first.closes,0)
  f.writes[0].resolve();await tick();assert.equal(first.closes,1)
  const next=sample();f.output.submit(next);assert.equal(f.writes.length,2)
  f.writes[1].resolve();await tick();f.output.close();await tick()
  assert.equal(next.closes,1);assert.deepEqual(f.counts(),{stops:1,aborts:1,releases:1})
})

test('cleanup releases pending data once and late rejection cannot resurrect output',async()=>{
  const f=fixture(),pending=sample();f.output.submit(pending);f.output.close();f.output.close()
  assert.equal(pending.closes,1)
  f.writes[0].reject(new Error('cancelled'));await tick()
  const late=sample();f.output.submit(late)
  assert.equal(pending.closes,1);assert.equal(late.closes,1);assert.equal(f.errors.length,0)
  assert.deepEqual(f.counts(),{stops:1,aborts:1,releases:1})
})

test('write rejection or synchronous failure closes the track and consumes the sample',async()=>{
  for(const synchronous of [false,true]){
    const f=fixture(),value=sample()
    if(synchronous)f.writer.write=()=>{throw new Error('closed writer')}
    f.output.submit(value)
    if(!synchronous)f.writes[0].reject(new Error('sink failed'))
    await tick();assert.equal(value.closes,1);assert.equal(f.errors.length,1)
    assert.deepEqual(f.counts(),{stops:1,aborts:1,releases:1})
  }
})

test('browser backpressure prevents enqueuing even with no outstanding local write',()=>{
  const f=fixture()
  for(const capacity of [0,null,-1]){f.writer.desiredSize=capacity;const value=sample();f.output.submit(value);assert.equal(value.closes,1)}
  assert.equal(f.writes.length,0);f.output.close()
})

for(const [file,name,method] of [
  ['audio/media_stream_track_generator_pipe','AudioMediaStreamTrackGeneratorPipe','submitSample'],
  ['video/media_stream_track_generator_pipe','VideoMediaStreamTrackGeneratorPipe','submitFrame'],
  ['video/video_track_generator','VideoTrackGeneratorPipe','submitFrame'],
])test(`${name} stops its owned track and propagates cleanup once`,async()=>{
  const f=fixture();let stops=0,binds=0,cleanups=0
  class Generator {
    writable={getWriter:()=>f.writer};track=this
    stop(){stops++}
  }
  const classes=compile(file,()=>({RealtimeTrackWriter,addPipePassthrough(){}}),{MediaStreamTrackGenerator:Generator,VideoTrackGenerator:Generator})
  const pipe=new classes[name]({implementationName:'fixture',setTrack(){binds++},cleanup(){cleanups++}})
  const value=sample();pipe[method](value);pipe.cleanup();pipe.cleanup()
  const late=sample();pipe[method](late);f.writes[0].resolve();await tick()
  assert.equal(stops,1);assert.equal(binds,1);assert.equal(cleanups,1);assert.equal(value.closes,1);assert.equal(late.closes,1)
})

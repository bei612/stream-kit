import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
function load(file,globals={}) {
  const exports={}
  const source=readFileSync(new URL(`../third_party/moonlight-web-stream/web/stream/audio/${file}.ts`,import.meta.url),'utf8')
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,...globals,require:()=>({addPipePassthrough(){}})})
  return exports
}
function elementFixture() {
  const pending=[],logs=[],tracks=new Set()
  let pauses=0
  const element={classList:{add(){}},paused:true,play(){return new Promise((resolve,reject)=>pending.push({resolve,reject}))},pause(){pauses++}}
  const {AudioElementPlayer}=load('audio_element',{document:{createElement:()=>element},MediaStream:class{addTrack(t){tracks.add(t)}removeTrack(t){tracks.delete(t)}}})
  const player=new AudioElementPlayer({debug:text=>logs.push(text)})
  return {player,element,pending,tracks,logs,pauses:()=>pauses}
}

function pcmFixture() {
  const sources=[],gain={disconnects:0,disconnect(){this.disconnects++}}
  let buffers=0,cleanups=0
  const context={state:'running',currentTime:0,createGain:()=>gain,
    createBuffer(channels,length,rate){buffers++;return {duration:length/rate,copyToChannel(){}}},
    createBufferSource(){const source={stopped:0,disconnected:0,connect(){},start(time){this.time=time},stop(){this.stopped++},disconnect(){this.disconnected++}};sources.push(source);return source}}
  const {AudioBufferPipe}=load('audio_buffer_pipe')
  const pipe=new AudioBufferPipe({implementationName:'fixture',setup(){},setSource(){},getAudioContext:()=>context,cleanup(){cleanups++}})
  pipe.setup({channels:2,sampleRate:48000});pipe.onUserInteraction()
  const unit=(samples=960)=>({channelData:[new Float32Array(samples),new Float32Array(samples)]})
  return {pipe,context,sources,gain,unit,buffers:()=>buffers,cleanups:()=>cleanups}
}

test('PCM pause discards queued speech and no buffers accumulate against a frozen clock',()=>{
  const f=pcmFixture();f.pipe.playPcm(f.unit());const first=f.sources[0]
  f.context.state='suspended'
  for(let i=0;i<1000;i++)f.pipe.playPcm(f.unit())
  assert.equal(f.buffers(),1);assert.equal(first.stopped,1);assert.equal(first.disconnected,1)
  f.context.state='running';f.context.currentTime=10;f.pipe.playPcm(f.unit())
  assert.equal(f.sources[1].time,10.12)
  f.pipe.cleanup();assert.equal(f.sources[1].stopped,1);assert.equal(f.cleanups(),1)
  f.pipe.playPcm(f.unit());assert.equal(f.buffers(),2)
})

test('PCM latency reset cancels old schedules and tiny units cannot create unbounded nodes',()=>{
  const f=pcmFixture()
  for(let i=0;i<1000;i++)f.pipe.playPcm(f.unit())
  assert.ok(f.sources[0].stopped>0)
  let live=f.sources.filter(source=>!source.stopped)
  assert.ok(live.length<=7)
  assert.ok(live.every(source=>source.time+source.buffer.duration<=0.250001))
  f.pipe.cleanup()
  const tiny=pcmFixture();for(let i=0;i<1000;i++)tiny.pipe.playPcm(tiny.unit(1))
  live=tiny.sources.filter(source=>!source.stopped);assert.ok(live.length<=128)
  live[0].onended();assert.equal(live[0].disconnected,1)
  tiny.pipe.cleanup()
})

test('PCM rejects malformed or oversized frames before creating audio buffers',()=>{
  const f=pcmFixture()
  for(const unit of [f.unit(0),f.unit(12001),{channelData:[new Float32Array(1)]},{channelData:[new Float32Array(1),new Float32Array(2)]}])f.pipe.playPcm(unit)
  assert.equal(f.buffers(),0)
  f.pipe.playPcm(f.unit(12000));assert.equal(f.sources[0].time,0)
  f.pipe.cleanup()
})

test('gesture starts playback; denied autoplay is handled and the next gesture retries',async()=>{
  const f=elementFixture()
  f.player.onUserInteraction();assert.equal(f.element.muted,false);assert.equal(f.pending.length,1)
  f.player.onUserInteraction();assert.equal(f.pending.length,1,'coalesce pending play')
  f.pending[0].reject(new Error('NotAllowedError'));await tick()
  assert.equal(f.logs.length,1)
  f.player.onUserInteraction();assert.equal(f.pending.length,2)
  f.element.paused=false;f.pending[1].resolve();await tick()
  f.player.onUserInteraction();assert.equal(f.pending.length,2,'do not restart playing media')
})

test('cleanup detaches borrowed tracks and stale play completion cannot affect reused player',async()=>{
  const f=elementFixture(),track={stop(){assert.fail('borrowed remote track must not be stopped')}}
  f.player.setTrack(track);f.player.onUserInteraction();f.player.cleanup()
  assert.equal(f.tracks.size,0);assert.equal(f.element.srcObject,null);assert.equal(f.element.muted,true);assert.equal(f.pauses(),1)
  f.player.setTrack(track);f.player.onUserInteraction();assert.equal(f.tracks.size,0);assert.equal(f.pending.length,1)
  f.player.setup({});f.player.setTrack(track);f.player.onUserInteraction()
  assert.equal(f.pending.length,2);assert.notEqual(f.element.srcObject,null)
  f.pending[0].reject(new Error('aborted old playback'));await tick()
  assert.equal(f.logs.length,0);f.player.onUserInteraction();assert.equal(f.pending.length,2)
  f.pending[1].resolve();await tick();f.player.cleanup()
})

test('suspended context and downstream element resume in the same gesture; cleanup is propagated',async()=>{
  const events=[],logs=[];let resumeReject
  class Context {
    state='suspended';baseLatency=0.01;outputLatency=0.025
    resume(){events.push('resume');return new Promise((_,reject)=>{resumeReject=reject})}
    close(){events.push('close');this.state='closed';return Promise.resolve()}
  }
  const {AudioContextBasePipe}=load('audio_context_base',{AudioContext:Context})
  const pipe=new AudioContextBasePipe('fixture',{setup(){},onUserInteraction(){events.push('play')},cleanup(){events.push('cleanup')}},{debug:t=>logs.push(t)})
  pipe.setup({sampleRate:48000});pipe.onUserInteraction()
  assert.deepEqual(events,['resume','play'],'downstream play must not await context resume')
  resumeReject(new Error('activation required'));await tick();assert.equal(logs.length,1)
  const stats={};await pipe.reportStats(stats);assert.equal(stats.audioContextBaseLatencyMs,10);assert.equal(stats.audioContextOutputLatencyMs,25)
  pipe.onUserInteraction();pipe.cleanup();resumeReject(new Error('old context'));await tick()
  assert.equal(logs.length,1);assert.equal(events.filter(e=>e==='close').length,1);assert.ok(events.includes('cleanup'))
  pipe.cleanup();assert.equal(events.filter(e=>e==='close').length,1)
})

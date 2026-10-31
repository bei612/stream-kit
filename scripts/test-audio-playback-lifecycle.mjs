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

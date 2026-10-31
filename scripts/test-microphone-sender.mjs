import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source=readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/audio/rtp_track_sender_pipe.ts',import.meta.url),'utf8')
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
function fixture(){
  const exports={},errors=[]
  vm.runInNewContext(code,{exports,require(name){return name==='../pipeline/pipes'?{addPipePassthrough(){}}:{}}})
  const pipe=new exports.RtpTrackSenderPipe({debug(message){errors.push(message)}})
  return {pipe,errors,async settle(){while(pipe.updating)await pipe.updating}}
}
const track=name=>({name,readyState:'live'})
test('revocation detaches an in-flight track without disposing the sender',async()=>{
  const f=fixture(),calls=[];let finish
  const first=track('first'),next=track('next')
  const sender={replaceTrack(value){calls.push(value);return value===first?new Promise(resolve=>{finish=resolve}):Promise.resolve()}}
  f.pipe.setRtpSender(sender);await f.settle();calls.length=0
  f.pipe.setTrack(first);f.pipe.clearTrack()
  f.pipe.clearTrack()
  finish();await f.settle()
  assert.deepEqual(calls,[first,null]);assert.equal(f.pipe.track,null)
  assert.equal(f.pipe.disposed,false)
  f.pipe.setTrack(next);await f.settle()
  assert.deepEqual(calls,[first,null,next])
  f.pipe.cleanup();await f.settle();f.pipe.clearTrack()
  assert.deepEqual(calls,[first,null,next,null])
})

test('cleanup waits for in-flight attachment then detaches once and clears references',async()=>{
  const f=fixture(),calls=[];let finish
  const sender={replaceTrack(value){calls.push(value);return value?new Promise(resolve=>{finish=resolve}):Promise.resolve()}}
  f.pipe.setRtpSender(sender);await f.settle();calls.length=0
  const mic=track('first');f.pipe.setTrack(mic)
  f.pipe.cleanup();f.pipe.cleanup();f.pipe.setTrack(track('late'));f.pipe.setRtpSender(sender)
  assert.deepEqual(calls,[mic]);finish();await f.settle()
  assert.deepEqual(calls,[mic,null]);assert.equal(f.pipe.track,null);assert.equal(f.pipe.boundSender,null)
})
test('rapid changes coalesce to the latest track instead of accumulating operations',async()=>{
  const f=fixture(),calls=[];let finish
  const first=track('first'),last=track('last')
  const sender={replaceTrack(value){calls.push(value);return value===first?new Promise(resolve=>{finish=resolve}):Promise.resolve()}}
  f.pipe.setRtpSender(sender);await f.settle();calls.length=0
  f.pipe.setTrack(first);for(let i=0;i<1000;i++)f.pipe.setTrack(track(String(i)));f.pipe.setTrack(last)
  finish();await f.settle();assert.deepEqual(calls,[first,last]);f.pipe.cleanup();await f.settle()
})
test('sender replacement detaches old sender before attaching to the new one',async()=>{
  const f=fixture(),calls=[]
  const sender=name=>({async replaceTrack(value){calls.push([name,value])}})
  const old=sender('old'),next=sender('new'),mic=track('mic')
  f.pipe.setRtpSender(old);await f.settle();f.pipe.setTrack(mic);await f.settle();calls.length=0
  f.pipe.setRtpSender(next);await f.settle()
  assert.deepEqual(calls,[['old',null],['new',mic]])
  f.pipe.cleanup();await f.settle()
})
test('closed-peer failures reach the capture owner without retries or retained capture',async()=>{
  const f=fixture();let calls=0
  const sender={async replaceTrack(){calls++;throw Error('peer closed')}}
  f.pipe.setRtpSender(sender);await assert.rejects(f.settle(),/peer closed/)
  await assert.rejects(f.pipe.setTrack(track('mic')),/peer closed/)
  f.pipe.cleanup();await assert.rejects(f.settle(),/peer closed/)
  assert.equal(calls,3);assert.equal(f.errors.length,3);assert.equal(f.pipe.track,null);assert.equal(f.pipe.boundSender,null)
})

test('capture attachment waits for an update submitted during the previous finalizer',async()=>{
  const f=fixture(),calls=[];let apply
  const mic=track('mic')
  const sender={replaceTrack(value){calls.push(value);return value?new Promise(resolve=>{apply=resolve}):Promise.resolve()}}
  f.pipe.setRtpSender(sender)
  // The initial null replace completes before its owner's finalizer runs.
  await Promise.resolve()
  let complete=false
  const binding=f.pipe.setTrack(mic).then(()=>{complete=true})
  for(let i=0;i<8;i++)await Promise.resolve()
  assert.equal(complete,false);assert.deepEqual(calls,[null,mic])
  apply();await binding;assert.equal(complete,true)
  f.pipe.cleanup();await f.settle()
})

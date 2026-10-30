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
test('closed-peer failures are consumed and do not retain capture or trigger retries',async()=>{
  const f=fixture();let calls=0
  const sender={async replaceTrack(){calls++;throw Error('peer closed')}}
  f.pipe.setRtpSender(sender);await f.settle();f.pipe.setTrack(track('mic'));await f.settle()
  f.pipe.cleanup();await f.settle()
  assert.equal(calls,3);assert.equal(f.errors.length,3);assert.equal(f.pipe.track,null);assert.equal(f.pipe.boundSender,null)
})

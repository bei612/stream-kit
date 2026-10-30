import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const source=readFileSync(new URL('../third_party/moonlight-web-stream/web/stream/video/canvas_frame.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
function fixture(){
  const exports={},callbacks=new Map();let id=0,cleanups=0,draws=0
  const base={implementationName:'test',setup(){},cleanup(){cleanups++},useCanvasContext(){return {context:null,error:'noCanvas'}}}
  vm.runInNewContext(compiled,{exports,requestAnimationFrame(fn){callbacks.set(++id,fn);return id},cancelAnimationFrame(id){callbacks.delete(id)},
    ImageData:class{constructor(buffer,width,height){Object.assign(this,{buffer,width,height})}},
    require(name){
      if(name==='../pipeline/pipes')return {addPipePassthrough(){}}
      if(name==='../../libopenh264/index')return {yuvBufferSize:()=>6,copyIntoYuv(){}}
      return {}
    }})
  return {exports,base,callbacks,get cleanups(){return cleanups},get draws(){return draws},draw(){draws++}}
}
function frame(){return {closes:0,close(){this.closes++}}}

test('canvas cleanup cancels animation and releases the final frame exactly once',async()=>{
  const f=fixture(),pipe=new f.exports.CanvasFrameDrawPipe(f.base,null,{drawOnSubmit:false})
  pipe.drawCurrentFrameIfReady=()=>f.draw()
  await pipe.setup({});await pipe.setup({});assert.equal(f.callbacks.size,1)
  const late=[...f.callbacks.values()][0],first=frame(),last=frame()
  pipe.submitFrame(first);pipe.submitFrame(last);assert.equal(first.closes,1)
  pipe.cleanup();pipe.cleanup();late();await pipe.setup({})
  assert.equal(last.closes,1);assert.equal(f.cleanups,1);assert.equal(f.callbacks.size,0);assert.equal(f.draws,0)
  const after=frame();pipe.submitFrame(after);assert.equal(after.closes,1);assert.equal(pipe.currentFrame,null)
})
test('draw-on-submit does not schedule an unused animation loop',async()=>{
  const f=fixture(),pipe=new f.exports.CanvasFrameDrawPipe(f.base)
  pipe.drawCurrentFrameIfReady=()=>f.draw()
  await pipe.setup({});pipe.submitFrame(frame())
  assert.equal(f.callbacks.size,0);assert.equal(f.draws,1);pipe.cleanup()
})
test('cleanup during drawing cannot queue another animation callback',async()=>{
  const f=fixture(),pipe=new f.exports.CanvasFrameDrawPipe(f.base,null,{drawOnSubmit:false})
  pipe.drawCurrentFrameIfReady=()=>pipe.cleanup()
  await pipe.setup({})
  const callback=[...f.callbacks.values()][0];f.callbacks.clear();callback()
  assert.equal(f.callbacks.size,0);assert.equal(f.cleanups,1)
})
test('raw canvas buffers are released and late frames are ignored',async()=>{
  for(const name of ['CanvasRgbaFrameDrawPipe','CanvasYuv420FrameDrawPipe']){
    const f=fixture(),pipe=new f.exports[name](f.base,null,{drawOnSubmit:false})
    await pipe.setup({})
    const input={buffer:new Uint8ClampedArray(16),width:2,height:2,yPlane:[],uPlane:[],vPlane:[],yStride:2,uvStride:1}
    pipe.submitRawFrame(input);assert.ok(pipe.currentFrame)
    pipe.cleanup();pipe.cleanup();pipe.submitRawFrame(input)
    assert.equal(pipe.currentFrame,null);assert.equal(f.callbacks.size,0);assert.equal(f.cleanups,1)
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'
const require = createRequire(new URL('../orchestrator/web/package.json',import.meta.url))
const source=readFileSync(new URL('../orchestrator/web/src/stores/websocket.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText

function fixture() {
  const sockets=[],timers=new Map(),events=[],exports={}
  let id=0
  const auth={token:'valid.fixture.token',valid:true,throwConstructor:false}
  class Socket {
    static OPEN=1
    readyState=0
    constructor(url,protocols) { if(auth.throwConstructor) throw new Error('transport unavailable'); this.url=url;this.protocols=protocols;sockets.push(this) }
    close() { this.readyState=2 }
    open() { this.readyState=1;this.onopen?.() }
    end() { this.readyState=3;this.onclose?.() }
    message(data) { this.onmessage?.({data:JSON.stringify(data)}) }
  }
  vm.runInNewContext(compiled,{exports,WebSocket:Socket,location:{protocol:'https:',host:'control.example'},
    window:{dispatchEvent:event=>{if(event.type==='ws-event')events.push(event)}},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},
    setTimeout(fn,delay){const next=++id;timers.set(next,{fn,delay});return next},clearTimeout(timer){timers.delete(timer)},
    require(name){ if(name==='zustand')return require(name);if(name==='@/lib/utils')return{getToken:()=>auth.token,isLoggedIn:()=>auth.valid};throw new Error(name) },
  })
  return {store:exports.useWSStore,auth,sockets,timers,events,tick(){const next=timers.entries().next().value;assert.ok(next);timers.delete(next[0]);next[1].fn()} }
}

test('one active management socket; credentials stay out of URLs',()=>{
  const f=fixture(),state=()=>f.store.getState()
  state().connect();state().connect()
  assert.equal(f.sockets.length,1)
  assert.equal(f.sockets[0].url,'wss://control.example/api/v1/ws')
  assert.deepEqual([...f.sockets[0].protocols],['stream-kit.events.v1','stream-kit.auth.valid.fixture.token'])
  f.sockets[0].open();state().connect()
  assert.equal(state().connected,true)
  assert.equal(f.sockets.length,1)
  state().disconnect();f.sockets[0].end()
  assert.equal(f.timers.size,0)
})

test('late events from a replaced credential cannot change the current connection',()=>{
  const f=fixture(),state=()=>f.store.getState()
  state().connect();const old=f.sockets[0];old.open()
  f.auth.token='rotated.fixture.token';state().connect()
  const current=f.sockets[1];current.open()
  old.end();old.open();old.message({type:'stale'})
  assert.equal(state().ws,current)
  assert.equal(state().connected,true)
  assert.equal(f.events.length,0)
  assert.equal(f.timers.size,0)
  current.message({type:'stream_controller_changed'})
  assert.equal(f.events.length,1)
  state().disconnect();current.message({type:'after_logout'});current.end()
  assert.equal(f.events.length,1)
  assert.equal(f.timers.size,0)
})

test('retry has one owner, bounded backoff and stops after credential expiry',()=>{
  const f=fixture(),state=()=>f.store.getState()
  state().connect();f.sockets[0].end();f.sockets[0].end()
  assert.equal(f.timers.size,1)
  assert.equal([...f.timers.values()][0].delay,1000)
  f.tick();f.sockets[1].end()
  assert.equal([...f.timers.values()][0].delay,2000)
  f.auth.valid=false;f.tick()
  assert.equal(f.sockets.length,2)
  assert.equal(state().reconnecting,false)
  assert.equal(f.timers.size,0)
})

test('logout cancels scheduled recovery; constructor failure remains recoverable',()=>{
  const f=fixture(),state=()=>f.store.getState()
  f.auth.throwConstructor=true;state().connect()
  assert.equal(f.timers.size,1)
  f.auth.throwConstructor=false;f.tick();f.sockets[0].open()
  assert.equal(state().connected,true)
  f.sockets[0].end();state().disconnect()
  assert.equal(f.timers.size,0)
  state().connect();f.auth.valid=false;f.sockets[1].open()
  assert.equal(state().connected,false)
  assert.equal(state().ws,null)
})

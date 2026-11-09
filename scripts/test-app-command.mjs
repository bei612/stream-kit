// Historical fake-React/VM harness. Retained for provenance, excluded from current
// acceptance: component commands use accept-management-native.cjs with real React,
// HTTP, SQLite and owned processes; application/popup scope has its own live gate.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'
const code=ts.transpileModule(fs.readFileSync(new URL('../orchestrator/web/src/hooks/useAppCommand.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
function harness(refresh){
 const states=[],exports={};const react={useRef:value=>({current:value}),useState(value){const i=states.push(value)-1;return[value,next=>{states[i]=next}]}}
 vm.runInNewContext(code,{exports,Error,require:()=>react});return {command:exports.useAppCommand(refresh),states}
}
test('one application command stays locked through authoritative refresh',async()=>{
 let finish,confirm,calls=0
 const h=harness(()=>new Promise(r=>{confirm=r}))
 const first=h.command.run('app','launch',()=>{calls++;return new Promise(r=>{finish=r})})
 assert.equal(calls,1,'task must start in browser gesture turn')
 assert.equal(await h.command.run('app','stop',async()=>{calls++}),false)
 finish();await Promise.resolve();await Promise.resolve()
 assert.equal(await h.command.run('app','save',async()=>{calls++}),false)
 assert.equal(calls,1);confirm();assert.equal(await first,true)
 assert.equal(Object.keys(h.states[0]).length,0)
})
test('failed command refreshes state and permits explicit retry',async()=>{
 let refreshes=0;const h=harness(async()=>{refreshes++})
 assert.equal(await h.command.run('app','stop',async()=>{throw Error('native stop unconfirmed')}),false)
 assert.equal(h.states[1],'native stop unconfirmed');assert.equal(refreshes,1)
 assert.equal(await h.command.run('app','stop',async()=>{}),true)
 assert.equal(h.states[1],'');assert.equal(refreshes,2)
})

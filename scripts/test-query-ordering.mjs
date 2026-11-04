import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from '../orchestrator/web/node_modules/typescript/lib/typescript.js'

const code=ts.transpileModule(fs.readFileSync(new URL('../orchestrator/web/src/hooks/useQuery.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
function harness(){
 const states=[],effects=[],pending=[]
 const react={useState(value){const i=states.push(value)-1;return[value,next=>{states[i]=next}]},useRef:value=>({current:value}),useCallback:fn=>fn,useEffect:fn=>effects.push(fn)}
 const exports={};vm.runInNewContext(code,{exports,require:()=>react,setInterval:()=>1,clearInterval(){},window:{addEventListener(){},removeEventListener(){}}})
 const query=exports.useQuery({queryFn:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))})
 const cleanup=effects.map(fn=>fn())
 return {query,states,pending,cleanup}
}
test('newer query result wins over older poll response and error',async()=>{
 const h=harness();const latest=h.query.refresh()
 h.pending[1].resolve({data:'new status'});await latest
 h.pending[0].reject(new Error('obsolete failure'));await Promise.resolve();await Promise.resolve()
 assert.equal(h.states[0],'new status');assert.equal(h.states[2],'')
 const old=h.query.refresh(),fresh=h.query.refresh()
 h.pending[3].resolve({data:'stopped'});await fresh
 h.pending[2].resolve({data:'running'});await old
 assert.equal(h.states[0],'stopped')
})
test('unmounted query cannot publish late data',async()=>{
 const h=harness();h.cleanup.forEach(fn=>fn?.());h.pending[0].resolve({data:'old application'})
 await Promise.resolve();await Promise.resolve();assert.equal(h.states[0],null)
})

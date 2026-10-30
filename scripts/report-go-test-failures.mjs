import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export function failureAnnotations(jsonl){
  const failed=new Map()
  for(const line of jsonl.split(/\r?\n/)){
    if(!line.trim())continue
    let event
    try{event=JSON.parse(line)}catch{continue}
    if(event.Action!=='fail'||typeof event.Package!=='string')continue
    const test=typeof event.Test==='string'?event.Test:''
    failed.set(`${event.Package}/${test}`,{package:event.Package,test})
  }
  const escape=value=>value.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')
  return [...failed.values()].map(event=>`::error title=Go test failure::${escape(event.package+(event.test?' / '+event.test:' (package failed; see structured test artifact)'))}`)
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const input=process.argv[2]
  if(!input)throw new Error('Usage: report-go-test-failures.mjs TEST-RESULTS.jsonl')
  if(fs.existsSync(input))for(const annotation of failureAnnotations(fs.readFileSync(input,'utf8')))console.log(annotation)
  else console.log('No structured Go test results were produced before failure.')
}

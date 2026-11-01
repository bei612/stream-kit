import test from 'node:test'
import assert from 'node:assert/strict'
import {requireRuntimeInstallerPayload} from './lib/installer-payload.mjs'

function runtime(platform){
  return {platform,components:['orchestrator','media-gateway','sunshine'].map(component=>({component})),files:[{path:'README.md'},{path:'orchestrator/dist/index.html'},{path:`media-gateway/web-server${platform==='windows'?'.exe':''}`},{path:`sunshine/${platform==='windows'?'sunshine.exe':'bin/sunshine'}`}]}
}
test('both installers accept only the shared runtime component set',()=>{
  for(const platform of ['windows','linux'])assert.doesNotThrow(()=>requireRuntimeInstallerPayload(runtime(platform)))
  const development=runtime('windows');development.components.push({component:'example'})
  assert.throws(()=>requireRuntimeInstallerPayload(development),/exactly the three runtime components/)
  const duplicate=runtime('windows');duplicate.components[2]={component:'orchestrator'}
  assert.throws(()=>requireRuntimeInstallerPayload(duplicate),/exactly the three runtime components/)
})
test('a self-consistent inventory cannot smuggle acceptance tooling into an installer',()=>{
  for(const entry of ['example/checkerboard.exe','scripts/accept-source-stream.cjs','orchestrator/tests/result.json','media-gateway/node_modules/a/index.js','sunshine/.local/config.json','orchestrator/node.exe','orchestrator/UnrealEditor-Cmd.exe','sunshine/bin/UnrealEditor','orchestrator/npm.cmd','media-gateway/node','sunshine/bin/audio-probe']){
    const payload=runtime('windows');payload.files.push({path:entry})
    assert.throws(()=>requireRuntimeInstallerPayload(payload),/Non-runtime|Development-only/,entry)
  }
})

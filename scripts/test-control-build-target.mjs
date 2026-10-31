import assert from 'node:assert/strict'
import test from 'node:test'
import {controlBuildTarget,verifyControlBuildInfo} from './lib/control-build-target.mjs'

test('bundle names follow targets and foreign targets are not executed',()=>{
  const host={GOHOSTOS:'windows',GOHOSTARCH:'amd64'}
  assert.deepEqual(controlBuildTarget({...host,GOOS:'linux',GOARCH:'amd64'}),{platform:'linux',architecture:'amd64',binary:'orchestrator',canExecute:false})
  assert.deepEqual(controlBuildTarget({...host,GOOS:'windows',GOARCH:'amd64'}),{platform:'windows',architecture:'amd64',binary:'orchestrator.exe',canExecute:true})
  assert.equal(controlBuildTarget({...host,GOOS:'windows',GOARCH:'arm64'}).canExecute,false)
  assert.throws(()=>controlBuildTarget({...host,GOOS:'darwin',GOARCH:'amd64'}),/Unsupported/)
  assert.throws(()=>controlBuildTarget({GOOS:'linux',GOARCH:'amd64'}),/host identity/)
})

test('compiled target and embedded source identity are verified before manifest creation',()=>{
  const target={platform:'linux',architecture:'amd64'},flags='a'.repeat(40)
  const info={Path:'github.com/stream-kit/orchestrator/cmd/orchestrator',Settings:[{Key:'GOOS',Value:'linux'},{Key:'GOARCH',Value:'amd64'},{Key:'vcs.revision',Value:flags},{Key:'-trimpath',Value:'true'}]}
  verifyControlBuildInfo(info,target,flags)
  assert.throws(()=>verifyControlBuildInfo(info,{...target,platform:'windows'},flags),/target/)
  assert.throws(()=>verifyControlBuildInfo(info,target,flags+' changed'),/source identity/)
  assert.throws(()=>verifyControlBuildInfo({...info,Path:'other'},target,flags),/command/)
  assert.throws(()=>verifyControlBuildInfo({...info,Settings:[]},target,flags),/target/)
})

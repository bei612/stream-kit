import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import {releaseRendererIntermediates} from './release-renderer-intermediates.mjs'
import {platformLayout} from '../../scripts/lib/platform-layout.mjs'

const commit='a'.repeat(40)
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'stream-kit-renderer-cleanup-')))
  t.after(()=>{assert.equal(fs.realpathSync(root),root);fs.rmSync(root,{recursive:true,force:true})})
  const stage=path.join(root,'artifacts/linux-sunshine/renderer')
  const layout=platformLayout('linux','sunshine')
  for(const name of [layout.executable,...layout.required_files]) {
    const file=path.join(stage,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'retained renderer payload')
  }
  fs.writeFileSync(path.join(stage,'bundle-manifest.json'),JSON.stringify({component:'sunshine',platform:'linux',commit,source_dirty:false}))
  for(const name of ['cmake-build-sunshine','cmake-build-sunshine-deps','ccache']) {
    const directory=path.join(root,'.local',name);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'temporary'),'compiler output')
  }
  return {root,stage}
}

test('release only renderer intermediates, preserving staged payload and linked source content',t=>{
  const {root,stage}=fixture(t)
  const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'keep'),'source')
  fs.symlinkSync(source,path.join(root,'.local/cmake-build-sunshine-deps/vendor-link'),process.platform==='win32'?'junction':'dir')
  const result=releaseRendererIntermediates(root,commit)
  for(const relative of result.removed)assert.equal(fs.existsSync(path.join(root,relative)),false)
  assert.equal(fs.readFileSync(path.join(source,'keep'),'utf8'),'source')
  assert.equal(fs.readFileSync(path.join(stage,'bin/sunshine'),'utf8'),'retained renderer payload')
})

test('reject linked cleanup targets before deleting any valid earlier target',t=>{
  const {root}=fixture(t)
  const linked=path.join(root,'.local/ccache')
  const moved=path.join(root,'retained-cache')
  fs.renameSync(linked,moved)
  fs.symlinkSync(moved,linked,process.platform==='win32'?'junction':'dir')
  assert.throws(()=>releaseRendererIntermediates(root,commit),/Unsafe/)
  assert.ok(fs.existsSync(path.join(root,'.local/cmake-build-sunshine/temporary')))
  assert.ok(fs.existsSync(path.join(moved,'temporary')))
})

test('refuse cleanup when staging is missing, incomplete or from a different revision',t=>{
  const {root,stage}=fixture(t)
  assert.throws(()=>releaseRendererIntermediates(root,'b'.repeat(40)),/revision/)
  fs.unlinkSync(path.join(stage,'bin/sunshine'))
  assert.throws(()=>releaseRendererIntermediates(root,commit))
  assert.ok(fs.existsSync(path.join(root,'.local/cmake-build-sunshine/temporary')))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {productRelease,manifestRelease,promotionProfile} from './lib/product-release.mjs'
const commit='a'.repeat(40)

function manifests(version=''){
  const release=productRelease(commit,version)
  const base={commit,release_channel:release.channel,release_version:release.version}
  return [{...base,file:{name:`${release.prefix}-windows-amd64-setup.exe`}},{...base,installer:{file:`${release.prefix}-ubuntu24.04-amd64-setup.run`}}]
}

test('one product identity covers stable native versions and legacy preview artifacts',()=>{
  assert.deepEqual(productRelease(commit,'2.3.4'),{channel:'stable',version:'2.3.4',prefix:'stream-kit-2.3.4-aaaaaaaaaaaa',windowsVersion:'2.3.4.0'})
  assert.equal(manifestRelease({commit,release_channel:'preview'}).prefix,'stream-kit-preview-aaaaaaaaaaaa')
  for(const version of ['01.2.3','1.2','1.2.3.4','65536.0.0','1.0.0\n','../1.0.0','1.0.0;exit',null,1])assert.throws(()=>productRelease(commit,version))
  assert.throws(()=>productRelease('a'.repeat(39),'1.0.0'))
})

test('publication cannot relabel preview bytes or mix versions, source commits or filenames',()=>{
  const [windows,linux]=manifests('1.0.0')
  assert.equal(promotionProfile(windows,linux,'v1.0.0').prerelease,false)
  assert.throws(()=>promotionProfile(windows,linux,'v1.0.1'))
  assert.throws(()=>promotionProfile(windows,{...linux,commit:'b'.repeat(40)},'v1.0.0'))
  assert.throws(()=>promotionProfile(windows,{...linux,release_version:'1.0.1'},'v1.0.0'))
  assert.throws(()=>promotionProfile({...windows,file:{name:'../setup.exe'}},linux,'v1.0.0'))
  assert.throws(()=>manifestRelease({...windows,release_channel:'preview'}))
  assert.throws(()=>manifestRelease({commit,release_channel:'stable'}))
  const [oldWindows,oldLinux]=manifests()
  delete oldWindows.release_version;delete oldLinux.release_version
  assert.equal(promotionProfile(oldWindows,oldLinux,'v0.1.0-preview.20261101.4').prerelease,true)
  assert.throws(()=>promotionProfile(oldWindows,oldLinux,'v1.0.0'))
  assert.throws(()=>promotionProfile(oldWindows,oldLinux,'v1.0.0-preview.20261101.4'))
})

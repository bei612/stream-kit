import test from 'node:test'
import assert from 'node:assert/strict'
import {productRelease,manifestRelease,promotionProfile,verifyInstallerAcceptance} from './lib/product-release.mjs'
import {verifyCombinedEvidence,verifyLinuxInstaller,verifyLinuxRun} from './verify-windows-android-promotion.mjs'
const commit='a'.repeat(40)

test('publication requires successful installation of the exact source and bytes with automatic services',()=>{
  const manifest={commit,file:{sha256:'b'.repeat(64)}}
  const service={StartMode:'Auto',StartName:'LocalSystem',State:'Running'}
  const result={passed:true,commit,installer_source_commit:commit,installer_sha256:manifest.file.sha256,
    install_exit:0,uninstall_exit:0,admin_login:true,gateway_restarted:true,scm_restarted:true,
    defaults_preserved:true,service_removed:true,data_preserved:true,pair:{passed:true},
    service,service_after_restart:service}
  assert.doesNotThrow(()=>verifyInstallerAcceptance(manifest,result))
  for(const key of Object.keys(result)){
    const missing={...result};delete missing[key]
    assert.throws(()=>verifyInstallerAcceptance(manifest,missing),`missing ${key}`)
  }
  for(const patch of [{passed:false},{error:'failed'}, {commit:'c'.repeat(40)},
    {installer_source_commit:'c'.repeat(40)},{installer_sha256:'c'.repeat(64)},
    {install_exit:3010},{uninstall_exit:1},{scm_restarted:false},{pair:{passed:false}},
    {service:{...service,StartMode:'Manual'}},{service_after_restart:{...service,State:'Stopped'}}]){
    assert.throws(()=>verifyInstallerAcceptance(manifest,{...result,...patch}))
  }
  assert.throws(()=>verifyInstallerAcceptance(manifest,null))
})

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

test('a release candidate and final release use the same immutable product version',()=>{
  const [windows,linux]=manifests('1.2.3')
  const candidate=promotionProfile(windows,linux,'v1.2.3-rc.1')
  assert.equal(candidate.publication_channel,'candidate')
  assert.equal(candidate.prerelease,true)
  assert.equal(candidate.channel,'stable','artifact metadata must remain unchanged')
  assert.equal(candidate.version,'1.2.3')
  assert.equal(promotionProfile(windows,linux,'v1.2.3').publication_channel,'stable')
  assert.equal(promotionProfile(windows,linux,'v1.2.3').prerelease,false)
  for(const tag of ['v1.2.4-rc.1','v1.2.3-rc.0','v1.2.3-rc.01','v1.2.3-rc.-1','v1.2.3-rc.1\n','v1.2.3-rc.1/other'])assert.throws(()=>promotionProfile(windows,linux,tag))
  assert.throws(()=>promotionProfile(...manifests(),'v0.1.0-rc.1'))
  assert.throws(()=>promotionProfile(windows,{...linux,commit:'b'.repeat(40)},'v1.2.3-rc.1'))
})

test('unified candidate evidence is bound to three packages and cannot satisfy the stable gate',()=>{
  const [windows,linux]=manifests('1.2.3')
  windows.file.sha256='b'.repeat(64)
  linux.installer.sha256='c'.repeat(64)
  const android={apk_sha256:'d'.repeat(64),version_code:7}
  const tag='v1.2.3-rc.1'
  const evidence='docs/evidence/candidate-observations.json'
  const checks=Object.fromEntries(['hosted_maintenance_rollback','isolated_lan_migration','android_upgrade',
    'android_input_lifecycle','android_media_input_audio','dependency_review','cleanup_verified']
    .map(key=>[key,{passed:true,evidence}]))
  const gate={tag,source_commit:commit,installer_sha256:windows.file.sha256,
    linux_installer_sha256:linux.installer.sha256,apk_sha256:android.apk_sha256,android_version_code:7,checks}
  const load=file=>{
    if(file===`docs/evidence/windows11-android-candidate-${tag.slice(1)}.json`)return gate
    if(file===evidence)return {source_commit:commit,passed:true}
    throw Error('Missing stable acceptance')
  }
  assert.equal(verifyCombinedEvidence(windows,android,tag,linux,load).prerelease,true)
  assert.throws(()=>verifyCombinedEvidence(windows,android,'v1.2.3',linux,load),/Missing stable acceptance/)
  assert.throws(()=>verifyCombinedEvidence(windows,android,tag,undefined,load),/requires the Ubuntu installer/)
  assert.throws(()=>verifyCombinedEvidence(windows,android,tag,{installer:{sha256:'e'.repeat(64)}},load),/Ubuntu candidate evidence/)
  assert.throws(()=>verifyCombinedEvidence(windows,{...android,version_code:8},tag,linux,load))
  delete checks.android_input_lifecycle
  assert.throws(()=>verifyCombinedEvidence(windows,android,tag,linux,load),/android_input_lifecycle/)
})

test('optional Ubuntu payload must match the Windows source, platform and actual bytes',()=>{
  const [windows,other]=manifests('1.2.3')
  const digest='c'.repeat(64)
  const linux={...other,platform:'linux',architecture:'amd64',distribution:'ubuntu-24.04',payload_profile:'runtime',
    installer:{...other.installer,sha256:digest}}
  verifyLinuxInstaller(windows,linux,'v1.2.3',file=>{
    assert.equal(file,other.installer.file)
    return digest
  })
  assert.throws(()=>verifyLinuxInstaller(windows,linux,'v1.2.3',()=> 'd'.repeat(64)),/bytes/)
  for(const change of [{commit:'b'.repeat(40)}, {architecture:'arm64'}, {distribution:'ubuntu-22.04'},
    {payload_profile:'test'}, {installer:{...linux.installer,file:'../setup.run'}}]){
    let read=false
    assert.throws(()=>verifyLinuxInstaller(windows,{...linux,...change},'v1.2.3',()=>{read=true;return digest}))
    assert.equal(read,false)
  }
})

test('a frozen Ubuntu build must use the matching version branch and original source commit',()=>{
  const repository='bei612/stream-kit'
  const run={id:123,status:'completed',conclusion:'success',head_repository:{full_name:repository},
    path:'.github/workflows/linux-sunshine-build.yml',head_branch:'release/1.2.3',
    event:'workflow_dispatch',head_sha:commit}
  const jobs={jobs:[{name:'Source-built Linux unified installer',status:'completed',conclusion:'success',
    head_sha:commit,run_id:123}]}
  verifyLinuxRun(run,jobs,repository,'123',commit,'v1.2.3')
  verifyLinuxRun(run,jobs,repository,'123',commit,'v1.2.3-rc.1')
  assert.throws(()=>verifyLinuxRun(run,jobs,repository,'123',commit,'v1.2.4'))
  assert.throws(()=>verifyLinuxRun(run,jobs,repository,'123','b'.repeat(40),'v1.2.3'),/release source/)
  assert.throws(()=>verifyLinuxRun({...run,event:'push'},jobs,repository,'123',commit,'v1.2.3'))
  assert.throws(()=>verifyLinuxRun({...run,head_repository:{full_name:'fork/stream-kit'}},jobs,repository,'123',commit,'v1.2.3'))
})

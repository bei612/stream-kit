import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {collectGoNotices} from './lib/go-notices.mjs'
import {collectCargoNotices} from './lib/cargo-notices.mjs'
import {bundleWindowsRuntime} from './lib/windows-runtime.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
if(process.platform!=='win32'||process.arch!=='x64'||process.argv.length!==3)throw Error('Expected native Windows x64: node build-example-release.mjs NEW_OUTPUT')
const output=path.resolve(process.argv[2])
const run=(file,args,cwd=root,env=process.env)=>execFileSync(file,args,{cwd,env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024})
const git=(...args)=>run('git',args).trim()
const commit=git('rev-parse','HEAD')
const clean=()=>{if(git('rev-parse','HEAD')!==commit||git('status','--porcelain'))throw Error('Example release requires clean matching source')}
clean()
if(fs.existsSync(output))throw Error('Example output must be a new directory')
const environment=JSON.parse(run('go',['env','-json','GOOS','GOARCH','GOROOT'],path.join(root,'example')))
if(environment.GOOS!=='windows'||environment.GOARCH!=='amd64'||process.env.CARGO_BUILD_TARGET)throw Error('Example release requires native Windows amd64 tools')
fs.mkdirSync(output,{recursive:true})
const binary=path.join(output,'checkerboard.exe')
run('go',['build','-trimpath','-ldflags','-s -w -H=windowsgui','-o',binary,'.'],path.join(root,'example'),{...process.env,CGO_ENABLED:'0'})
const info=JSON.parse(run('go',['version','-m','-json',binary]))
const settings=new Map(info.Settings.map(value=>[value.Key,value.Value]))
if(settings.get('vcs.revision')!==commit||settings.get('vcs.modified')!=='false')throw Error('Example executable source mismatch')
// The example invokes this sibling probe through its existing native protocol.
// Ship an optimized helper, never a mutable debug binary from a previous build.
const audio=path.join(root,'components/audio-target')
run('cargo',['build','--locked','--release','--bin','audio-probe'],audio)
const metadata=JSON.parse(run('cargo',['metadata','--locked','--format-version','1','--filter-platform','x86_64-pc-windows-msvc'],audio))
fs.copyFileSync(path.join(metadata.target_directory,'release/audio-probe.exe'),path.join(output,'audio-probe.exe'))
bundleWindowsRuntime(output,['audio-probe.exe'])
const idle=JSON.parse(execFileSync(path.join(output,'audio-probe.exe'),[],{input:JSON.stringify({schema_version:1,id:1,op:'status'})+'\n',encoding:'utf8',windowsHide:true,timeout:10000}))
if(idle.schema_version!==1||idle.error||idle.data?.state!=='idle')throw Error('Packaged example audio backend failed idle startup verification')
fs.copyFileSync(path.join(audio,'Cargo.lock'),path.join(output,'Cargo.lock'))
fs.writeFileSync(path.join(output,'THIRD_PARTY_NOTICES.go.json'),JSON.stringify(collectGoNotices(path.join(root,'example/vendor'),environment.GOROOT,{...info,Deps:info.Deps||[]}),null,2)+'\n')
fs.writeFileSync(path.join(output,'THIRD_PARTY_NOTICES.rust.json'),JSON.stringify(collectCargoNotices(path.join(audio,'Cargo.toml')),null,2)+'\n')
clean()
const files=fs.readdirSync(output).sort().map(name=>{
  const file=path.join(output,name),bytes=fs.readFileSync(file)
  return {path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
})
fs.writeFileSync(path.join(output,'bundle-manifest.json'),JSON.stringify({schema_version:1,component:'example',commit,source_dirty:false,platform:'windows',architecture:'amd64',files},null,2)+'\n')
console.log(JSON.stringify({output,commit,files:files.length}))

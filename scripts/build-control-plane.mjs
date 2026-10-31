import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectGoNotices } from './lib/go-notices.mjs'
import { controlBuildTarget, verifyControlBuildInfo } from './lib/control-build-target.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const options=process.argv.slice(2)
const requireClean=options.includes('--require-clean')
for(let i=0;i<options.length;i++){
  if(options[i]==='--require-clean')continue
  if(!['--output','--go'].includes(options[i])||!options[i+1]||options[i+1].startsWith('--'))throw new Error('Expected --output PATH, --go EXECUTABLE or --require-clean')
  i++
}
function option(name,fallback){const index=options.indexOf(name);return index<0?fallback:options[index+1]}
const output=path.resolve(option('--output',path.join(root,'orchestrator/bundle')))
const go=option('--go','go')
const goEnvironment=JSON.parse(execFileSync(go,['env','-json','GOROOT','GOVERSION','GOOS','GOARCH','GOHOSTOS','GOHOSTARCH'],{cwd:path.join(root,'orchestrator'),encoding:'utf8',windowsHide:true}))
const target=controlBuildTarget(goEnvironment)
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const commit=git('rev-parse','HEAD')
if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('Invalid source revision')
const sourceTime=new Date(git('show','-s','--format=%cI','HEAD')).toISOString()
const dirty=git('status','--porcelain','--untracked-files=normal')!==''
if(requireClean&&dirty)throw new Error('Release bundle requires a clean source tree')
const version=`git-${commit.slice(0,12)}${dirty?'-dirty':''}`
const web=path.join(root,'orchestrator/web')
const toolPackage=name=>JSON.parse(fs.readFileSync(path.join(web,'node_modules',name,'package.json'),'utf8'))
const lock=JSON.parse(fs.readFileSync(path.join(web,'package-lock.json'),'utf8'))
const frontendTools={typescript:toolPackage('typescript').version,vite:toolPackage('vite').version}
for(const [name,version] of Object.entries(frontendTools)){
  if(lock.packages?.[`node_modules/${name}`]?.version!==version)throw new Error(`Installed ${name} does not match package-lock.json; run npm ci in orchestrator/web`)
}
if(fs.existsSync(output))throw new Error('Output must be a new directory; existing bundles are never overwritten')
fs.mkdirSync(output,{recursive:true})
// Build directly into this new bundle. Never reuse web/dist from a prior source
// revision or empty a directory belonging to an existing deployment.
execFileSync(process.execPath,[path.join(web,'node_modules/typescript/bin/tsc'),'-b','--force'],{cwd:web,stdio:'inherit',windowsHide:true})
execFileSync(process.execPath,[path.join(web,'node_modules/vite/bin/vite.js'),'build','--outDir',path.join(output,'dist')],{cwd:web,stdio:'inherit',windowsHide:true})
if(!fs.lstatSync(path.join(output,'dist/index.html')).isFile())throw new Error('Management page build did not produce index.html')
const binary=path.join(output,target.binary)
const linkerFlags=`-s -w -X main.version=${version} -X main.commit=${commit} -X main.buildTime=${sourceTime}`
execFileSync(go,['build','-trimpath','-ldflags',linkerFlags,'-o',binary,'./cmd/orchestrator'],{cwd:path.join(root,'orchestrator'),stdio:'inherit',windowsHide:true})
const buildInfo=JSON.parse(execFileSync(go,['version','-m','-json',binary],{encoding:'utf8',windowsHide:true}))
verifyControlBuildInfo(buildInfo,target,commit)
if(goEnvironment.GOVERSION!==buildInfo.GoVersion)throw new Error('Go toolchain notices do not match compiled runtime version')
const goNotices=collectGoNotices(path.join(root,'orchestrator/vendor'),goEnvironment.GOROOT,buildInfo)
fs.writeFileSync(path.join(output,'THIRD_PARTY_NOTICES.go.json'),JSON.stringify(goNotices,null,2)+'\n')

// Inventory regular files only; linked or special entries cannot be released.
const files=[]
function inventory(directory){
  for(const name of fs.readdirSync(directory).sort()){
    const file=path.join(directory,name),stat=fs.lstatSync(file)
    if(stat.isDirectory())inventory(file)
    else if(stat.isFile())files.push({path:path.relative(output,file).split(path.sep).join('/'),bytes:stat.size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')})
    else throw new Error('Unsupported bundle entry')
  }
}
inventory(output)
let reported=null
if(target.canExecute){
  reported=execFileSync(binary,['version'],{encoding:'utf8',windowsHide:true}).trim()
  if(!reported.includes(`(commit: ${commit},`)||!reported.includes(version))throw new Error('Compiled version does not match source')
}
if(git('rev-parse','HEAD')!==commit||((requireClean||!dirty)&&git('status','--porcelain','--untracked-files=normal')!==''))throw new Error('Source changed during release build; no bundle manifest was issued')
const manifest={schema_version:1,component:'orchestrator',version,commit,source_commit_time:sourceTime,source_dirty:dirty,platform:target.platform,architecture:target.architecture,runtime_version_check:{executed:target.canExecute,output:reported,reason:target.canExecute?null:'cross_compiled_requires_target_runtime'},go_version:execFileSync(go,['version'],{encoding:'utf8',windowsHide:true}).trim(),frontend:{node_version:process.version,...frontendTools,package_lock_sha256:createHash('sha256').update(fs.readFileSync(path.join(web,'package-lock.json'))).digest('hex')},files}
fs.writeFileSync(path.join(output,'bundle-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({output,version,source_dirty:dirty,files:files.length}))

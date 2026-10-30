import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const commit=git('rev-parse','HEAD')
if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('Invalid source revision')
const sourceTime=new Date(git('show','-s','--format=%cI','HEAD')).toISOString()
const dirty=git('status','--porcelain','--untracked-files=normal')!==''
if(requireClean&&dirty)throw new Error('Release bundle requires a clean source tree')
const version=`git-${commit.slice(0,12)}${dirty?'-dirty':''}`
const web=path.join(root,'orchestrator/web/dist')
if(!fs.statSync(path.join(web,'index.html')).isFile())throw new Error('Build the management page first')
if(fs.existsSync(output))throw new Error('Output must be a new directory; existing bundles are never overwritten')
fs.mkdirSync(output,{recursive:true})
const binary=path.join(output,process.platform==='win32'?'orchestrator.exe':'orchestrator')
execFileSync(go,['build','-trimpath','-ldflags',`-s -w -X main.version=${version} -X main.commit=${commit} -X main.buildTime=${sourceTime}`,'-o',binary,'./cmd/orchestrator'],{cwd:path.join(root,'orchestrator'),stdio:'inherit',windowsHide:true})

// Enumerate regular files only: a build output must not drag linked private
// configuration or external directories into a distribution.
function copyTree(source,destination){
  fs.mkdirSync(destination)
  for(const name of fs.readdirSync(source).sort()){
    const from=path.join(source,name),to=path.join(destination,name),stat=fs.lstatSync(from)
    if(stat.isDirectory())copyTree(from,to)
    else if(stat.isFile())fs.copyFileSync(from,to)
    else throw new Error(`Unsupported linked or special asset: ${name}`)
  }
}
copyTree(web,path.join(output,'dist'))
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
const reported=execFileSync(binary,['version'],{encoding:'utf8',windowsHide:true}).trim()
if(!reported.includes(`(commit: ${commit},`)||!reported.includes(version))throw new Error('Compiled version does not match source')
const target=JSON.parse(execFileSync(go,['env','-json','GOOS','GOARCH'],{encoding:'utf8',windowsHide:true}))
const manifest={schema_version:1,component:'orchestrator',version,commit,source_commit_time:sourceTime,source_dirty:dirty,platform:target.GOOS,architecture:target.GOARCH,go_version:execFileSync(go,['version'],{encoding:'utf8',windowsHide:true}).trim(),files}
fs.writeFileSync(path.join(output,'bundle-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({output,version,source_dirty:dirty,files:files.length}))

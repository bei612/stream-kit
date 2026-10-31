import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

if(process.platform!=='win32'||process.argv.length!==5)throw Error('Expected Windows: node build-windows-installer.mjs PLATFORM_BUNDLE NEW_OUTPUT OFFICIAL_ISCC_EXE')
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const [payload,output,compiler]=process.argv.slice(2).map(value=>path.resolve(value))
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const commit=git('rev-parse','HEAD')
if(git('status','--porcelain'))throw Error('Installer requires clean committed source')
if(fs.existsSync(output))throw Error('Installer output must be a new directory')
if(output===payload||output.startsWith(payload+path.sep))throw Error('Output must be outside immutable payload')
const manifest=JSON.parse(fs.readFileSync(path.join(payload,'platform-manifest.json'),'utf8'))
if(manifest.commit!==commit||manifest.platform!=='windows'||manifest.architecture!=='amd64'||manifest.release_channel!=='preview'||manifest.schema_version!==1)throw Error('Expected matching Windows amd64 preview platform')
const control=JSON.parse(fs.readFileSync(path.join(payload,'orchestrator','bundle-manifest.json'),'utf8'))
if(control.platform_initialization_version!==1)throw Error('Payload does not declare unified native initialization support')
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const expected=new Map()
for(const file of manifest.files){
  if(typeof file.path!=='string'||file.path.includes('\\')||file.path.includes(':')||file.path.split('/').some(part=>!part||part==='.'||part==='..')||expected.has(file.path.toLowerCase()))throw Error('Invalid payload inventory')
  expected.set(file.path.toLowerCase(),file)
}
function visit(directory){
  for(const name of fs.readdirSync(directory)){
    const file=path.join(directory,name),stat=fs.lstatSync(file)
    if(stat.isSymbolicLink())throw Error('Linked payload entry')
    if(stat.isDirectory()){visit(file);continue}
    const relative=path.relative(payload,file).split(path.sep).join('/')
    if(relative==='platform-manifest.json')continue
    const wanted=expected.get(relative.toLowerCase())
    if(!stat.isFile()||!wanted||wanted.path!==relative||wanted.bytes!==stat.size||wanted.sha256!==hash(file))throw Error(`Payload integrity mismatch: ${relative}`)
    expected.delete(relative.toLowerCase())
  }
}
visit(payload)
if(expected.size)throw Error('Missing payload files')
const info=execFileSync(compiler,['--version'],{encoding:'utf8',windowsHide:true})
if(!info.includes('7.1.1'))throw Error('Expected pinned official Inno Setup 7.1.1 compiler')
fs.mkdirSync(output,{recursive:true})
execFileSync(compiler,['/Qp',`/DPayloadRoot=${payload}`,`/DArtifactDir=${output}`,`/DSourceCommit=${commit}`,path.join(root,'deploy/windows/stream-kit.iss')],{stdio:'inherit',windowsHide:true})
if(git('rev-parse','HEAD')!==commit||git('status','--porcelain'))throw Error('Source changed while building installer')
const name=`stream-kit-preview-${commit.slice(0,12)}-windows-amd64-setup.exe`
const executable=path.join(output,name)
const sha256=hash(executable)
fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),`${sha256}  ${name}\n`)
fs.writeFileSync(path.join(output,'installer-manifest.json'),JSON.stringify({schema_version:1,commit,release_channel:'preview',platform:'windows',architecture:'amd64',publisher_signed:false,payload_manifest_sha256:hash(path.join(payload,'platform-manifest.json')),compiler:{version:'7.1.1',sha256:hash(compiler)},file:{name,bytes:fs.statSync(executable).size,sha256}},null,2)+'\n')
console.log(JSON.stringify({output,commit,executable,sha256}))

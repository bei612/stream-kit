import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const args=process.argv.slice(2)
const update=args.length===3&&args[2]==='--update'
if((args.length!==2&&!update)||!['win32','linux'].includes(process.platform))throw Error('Expected native Windows/Linux: ENGINE_ROOT OUTPUT_DIRECTORY [--update]')
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const engine=fs.realpathSync(path.resolve(args[0])),output=path.resolve(args[1]),source=path.join(root,'example/ue5')
if((fs.existsSync(output)&&!update)||!fs.statSync(path.dirname(output)).isDirectory())throw Error('Use a new output directory, or --update for a verified previous build')
if(output===root||output===engine||output.startsWith(engine+path.sep)||output===source||output.startsWith(source+path.sep))throw Error('Build output must be separate from the engine and example sources')
const sdkRoot=path.join(engine,'Engine/Binaries/ThirdParty/DotNet'),host=process.platform==='win32'?'windows':'linux'
const dotnets=fs.readdirSync(sdkRoot).map(version=>path.join(sdkRoot,version,host,process.platform==='win32'?'dotnet.exe':'dotnet')).filter(file=>fs.existsSync(file))
if(dotnets.length!==1)throw Error('Expected exactly one engine-bundled .NET SDK for this host')
const tool=path.join(engine,'Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll')
if(!fs.statSync(tool).isFile())throw Error('UnrealBuildTool is missing from the selected SDK')
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function inventory(directory,prefix=''){
  return fs.readdirSync(path.join(directory,prefix),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const name=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(directory,name)
    if(entry.isDirectory())return inventory(directory,name)
    if(!entry.isFile()||entry.isSymbolicLink())throw Error('Example source must contain regular files only')
    return [{path:name,sha256:hash(file)}]
  })
}
const sources=inventory(source)
const project=path.join(output,'StreamKitAudioProbe.uproject'),platform=process.platform==='win32'?'Win64':'Linux'
if(update){
  const previous=JSON.parse(fs.readFileSync(path.join(output,'build-result.json'),'utf8'))
  if(previous.engine!==engine||previous.project!==project||hash(previous.module)!==previous.module_sha256)throw Error('Previous SDK/project/module identity does not match')
  for(const file of previous.source_files){
    const staged=path.join(output,file.path)
    if(!sources.some(item=>item.path===file.path)||fs.lstatSync(staged).isSymbolicLink()||hash(staged)!==file.sha256)throw Error('Previous source snapshot changed outside the builder; use a new output')
  }
  for(const file of sources){
    const staged=path.join(output,file.path)
    if(fs.existsSync(staged)&&!previous.source_files.some(item=>item.path===file.path))throw Error('New source would overwrite an unknown build entry')
    if(!fs.existsSync(staged)||hash(staged)!==file.sha256){fs.mkdirSync(path.dirname(staged),{recursive:true});fs.copyFileSync(path.join(source,file.path),staged)}
  }
}else fs.cpSync(source,output,{recursive:true,errorOnExist:true,force:false})
// Invoke the official installed SDK directly, without a shell, host-wide .NET
// installation, PowerShell policy changes, or edits to the business UE project.
execFileSync(dotnets[0],[tool,'StreamKitAudioProbeEditor',platform,'Development',`-Project=${project}`,'-WaitMutex','-NoHotReload','-NoEngineChanges'],{cwd:engine,env:{...process.env,DOTNET_ROOT:path.dirname(dotnets[0])},stdio:'inherit',windowsHide:true})
const module=path.join(output,'Binaries',platform,process.platform==='win32'?'UnrealEditor-StreamKitAudioProbe.dll':'libUnrealEditor-StreamKitAudioProbe.so')
if(!fs.statSync(module).isFile())throw Error('UE5 probe module was not produced')
for(const file of sources)if(hash(path.join(source,file.path))!==file.sha256||hash(path.join(output,file.path))!==file.sha256)throw Error('Example source changed during compilation')
const result={schema_version:1,scope:'Isolated UE5 AudioCaptureCore commandlet; not a platform runtime dependency',engine,project,module,module_sha256:hash(module),source_files:sources}
fs.writeFileSync(path.join(output,'build-result.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))

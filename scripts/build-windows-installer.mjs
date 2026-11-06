import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {prepareUSBAudioDriver,validateUSBAudioIdentity} from './lib/windows-usb-audio-driver.mjs'
import {requireRuntimeInstallerPayload} from './lib/installer-payload.mjs'
import {manifestRelease} from './lib/product-release.mjs'

const args=process.argv.slice(2)
const reusePayload=args.at(-1)==='--reuse-payload'
if(reusePayload)args.pop()
const usbAudio=args.length===9&&args[3]==='--usb-audio-driver'&&args[5]==='--signtool'&&args[7]==='--usb-audio-identity'
if(process.platform!=='win32'||(args.length!==3&&!usbAudio))throw Error('Expected Windows: node build-windows-installer.mjs PLATFORM_BUNDLE NEW_OUTPUT OFFICIAL_ISCC_EXE [--usb-audio-driver PACKAGE_DIR --signtool OFFICIAL_SIGNTOOL_EXE --usb-audio-identity RELEASE_IDENTITY_JSON]')
let usbIdentity=null
if(usbAudio){
  const file=path.resolve(args[8]),stat=fs.lstatSync(file)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('Expected bounded regular USB audio release identity file')
  usbIdentity=validateUSBAudioIdentity(JSON.parse(fs.readFileSync(file,'utf8')))
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const [payload,output,compiler]=args.slice(0,3).map(value=>path.resolve(value))
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim()
const installerCommit=git('rev-parse','HEAD')
if(git('status','--porcelain'))throw Error('Installer requires clean committed source')
if(fs.existsSync(output))throw Error('Installer output must be a new directory')
if(output===payload||output.startsWith(payload+path.sep))throw Error('Output must be outside immutable payload')
const manifest=JSON.parse(fs.readFileSync(path.join(payload,'platform-manifest.json'),'utf8'))
requireRuntimeInstallerPayload(manifest)
const commit=manifest.commit
const release=manifestRelease(manifest)
if(!/^[a-f0-9]{40}$/.test(commit)||(!reusePayload&&commit!==installerCommit)||manifest.platform!=='windows'||manifest.architecture!=='amd64'||manifest.schema_version!==1)throw Error('Expected matching Windows amd64 platform; immutable older payloads require explicit --reuse-payload')
const control=JSON.parse(fs.readFileSync(path.join(payload,'orchestrator','bundle-manifest.json'),'utf8'))
if(control.platform_initialization_version!==1)throw Error('Payload does not declare unified native initialization support')
if(usbAudio&&![1,2].includes(control.virtual_audio_configuration_version))throw Error('Payload does not support unified virtual audio initialization')
if(usbAudio&&control.native_audio_preparation_version!==1)throw Error('Payload does not support native pre-service audio preparation')
if(usbIdentity?.serial_prefix&&control.virtual_audio_configuration_version!==2)throw Error('Payload does not support namespaced virtual audio identity')
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
const driver=usbAudio?prepareUSBAudioDriver(path.resolve(args[4]),path.resolve(args[6]),output,path.join(payload,'orchestrator','orchestrator.exe')):null
if(usbAudio)driver.identity=usbIdentity
const installerSuffix=installerCommit===commit?'':`-r${installerCommit.slice(0,8)}`
execFileSync(compiler,['/Qp',`/DPayloadRoot=${payload}`,`/DArtifactDir=${output}`,`/DSourceCommit=${commit}`,`/DInstallerSuffix=${installerSuffix}`,`/DProductVersion=${release.version}`,`/DWindowsProductVersion=${release.windowsVersion}`,`/DProductArtifactPrefix=${release.prefix}`,...(driver?[`/DUsbAudioDriverRoot=${driver.stage}`,`/DUsbAudioVendorId=${usbIdentity.vendor_id}`,`/DUsbAudioProductId=${usbIdentity.product_id}`,...(usbIdentity.serial_prefix?[`/DUsbAudioSerialPrefix=${usbIdentity.serial_prefix}`]:[])]:[]),path.join(root,'deploy/windows/stream-kit.iss')],{stdio:'inherit',windowsHide:true})
if(driver){
  if(path.dirname(path.resolve(driver.stage))!==output)throw Error('Audio staging directory escaped installer output')
  // Remove only the exact vendor files this build staged, never recursively
  // delete an input package or unknown contents left by another process.
  for(const file of driver.files)fs.unlinkSync(path.join(driver.stage,file.path))
  fs.rmdirSync(driver.stage)
}
if(git('rev-parse','HEAD')!==installerCommit||git('status','--porcelain'))throw Error('Source changed while building installer')
const name=`${release.prefix}-windows-amd64-setup${installerSuffix}.exe`
const executable=path.join(output,name)
const sha256=hash(executable)
fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),`${sha256}  ${name}\n`)
fs.writeFileSync(path.join(output,'installer-manifest.json'),JSON.stringify({schema_version:1,commit,installer_source_commit:installerCommit,reused_payload:reusePayload,release_channel:release.channel,release_version:release.version,platform:'windows',architecture:'amd64',payload_profile:'runtime',publisher_signed:false,audio_driver:driver?{...driver,stage:undefined}:null,payload_manifest_sha256:hash(path.join(payload,'platform-manifest.json')),compiler:{version:'7.1.1',sha256:hash(compiler)},file:{name,bytes:fs.statSync(executable).size,sha256}},null,2)+'\n')
console.log(JSON.stringify({output,commit,executable,sha256}))

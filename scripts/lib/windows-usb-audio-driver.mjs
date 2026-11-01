import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {runWindowsPowerShell} from './windows-powershell.mjs'

const profile=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../orchestrator/internal/audiodevice/usbip-driver.json',import.meta.url)),'utf8'))
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export function validateUSBAudioIdentity(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='product_id,vendor_id')throw Error('Expected USB audio identity with vendor_id and product_id only')
  for(const id of [value.vendor_id,value.product_id]){
    if(!Number.isInteger(id)||id<1||id>65534)throw Error('USB audio vendor/product identity must be an integer in 1..65534')
  }
  return {vendor_id:value.vendor_id,product_id:value.product_id}
}

export function validateUSBDriverInventory(files){
  if(files.length!==profile.files.length)throw Error('USB audio driver package must contain both signed drivers and their license only')
  for(const expected of profile.files){
    const actual=files.find(file=>file.path===expected.path)
    if(!actual||actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw Error(`USB audio package integrity mismatch: ${expected.path}`)
  }
}

export function prepareUSBAudioDriver(directory,signTool,output,nativeInstaller){
  if(process.platform!=='win32')throw Error('USB audio driver packaging requires Windows')
  for(const [file,isDirectory] of [[directory,true],[signTool,false],[nativeInstaller,false]]){
    const stat=fs.lstatSync(file)
    if(stat.isSymbolicLink()||(isDirectory?!stat.isDirectory():!stat.isFile()))throw Error('Expected regular native packaging inputs')
  }
  if(path.basename(signTool).toLowerCase()!=='signtool.exe')throw Error('Expected official Windows SDK signtool.exe')
  const files=fs.readdirSync(directory).map(name=>{
    const file=path.join(directory,name),stat=fs.lstatSync(file)
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('USB audio package contains a non-file entry')
    return {path:name,bytes:stat.size,sha256:hash(file)}
  })
  validateUSBDriverInventory(files)
  const escaped=signTool.replaceAll("'","''")
  const signature=JSON.parse(runWindowsPowerShell(`$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath '${escaped}';@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`))
  if(signature.status!=='Valid'||!signature.subject.includes('O=Microsoft Corporation'))throw Error('Windows SDK signature tool publisher verification failed')
  for(const driver of ['usbip2_ude','usbip2_filter']){
    execFileSync(signTool,['verify','/kp','/c',path.join(directory,`${driver}.cat`),path.join(directory,`${driver}.sys`)],{stdio:'inherit',windowsHide:true,timeout:30000})
  }
  // Old payloads without the native install command cannot silently acquire a
  // new installer branch that they do not support. This command is read-only.
  execFileSync(nativeInstaller,['audio-driver','verify',directory],{stdio:'inherit',windowsHide:true,timeout:30000})
  const stage=path.join(output,'usb-audio-driver')
  fs.mkdirSync(stage)
  for(const file of files){
    const destination=path.join(stage,file.path)
    fs.copyFileSync(path.join(directory,file.path),destination,fs.constants.COPYFILE_EXCL)
    if(hash(destination)!==file.sha256)throw Error('USB audio package changed while staging')
  }
  return {product:profile.product,version:profile.version,driver_version:profile.driver_version,source_commit:profile.source_commit,license:profile.license,kernel_signature_verified:true,files,stage}
}

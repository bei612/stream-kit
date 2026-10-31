import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {runWindowsPowerShell} from './windows-powershell.mjs'
import {fileURLToPath} from 'node:url'

// The operator supplies the vendor's unmodified package and a private rights
// record. We retain only its hash, not invoice/customer details, in the release.
export function validateAudioDriverFiles(files,profile){
  if(files.length!==profile.files.length)throw Error('VB-CABLE package file count differs from reviewed vendor ZIP')
  for(const expected of profile.files){
    const actual=files.find(file=>file.path===expected.path)
    if(!actual||actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)throw Error(`VB-CABLE package integrity mismatch: ${expected.path}`)
  }
}

export function verifyAudioDriverPackage(directory){
  if(process.platform!=='win32')throw Error('Audio driver packaging requires Windows')
  const profile=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../third_party-manifests/windows-audio-driver.json',import.meta.url)),'utf8'))
  if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw Error('Audio driver package must be a regular directory')
  const files=fs.readdirSync(directory).sort().map(name=>{
    const file=path.join(directory,name),stat=fs.lstatSync(file)
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Audio driver package must contain regular files only')
    return {path:name,bytes:stat.size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
  })
  validateAudioDriverFiles(files,profile)
  const executable=path.join(directory,'VBCABLE_Setup_x64.exe').replaceAll("'","''")
  const certificate=JSON.parse(runWindowsPowerShell(`$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath '${executable}';@{status=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress`))
  if(certificate.status!=='Valid'||certificate.thumbprint!==profile.publisher_certificate)throw Error('VB-CABLE installer publisher validation failed')
  return {product:profile.product,package:profile.package,publisher_certificate:certificate.thumbprint,files}
}

export function prepareAudioDriver(directory,authorizationFile,output){
  if(fs.statSync(authorizationFile).size>65536)throw Error('Audio driver authorization record is too large')
  let authorization
  try{authorization=JSON.parse(fs.readFileSync(authorizationFile,'utf8'))}catch{throw Error('Invalid audio driver authorization JSON')}
  if(authorization.vendor!=='VB-Audio'||authorization.product!=='VB-CABLE'||authorization.scope!=='professional-bundle'||typeof authorization.reference!=='string'||!authorization.reference.trim())throw Error('Expected a VB-Audio professional-bundle authorization record with a reference')
  const verified=verifyAudioDriverPackage(directory)
  const stage=path.join(output,'audio-driver')
  fs.mkdirSync(stage)
  for(const file of verified.files){
    const destination=path.join(stage,file.path)
    fs.copyFileSync(path.join(directory,file.path),destination,fs.constants.COPYFILE_EXCL)
    if(createHash('sha256').update(fs.readFileSync(destination)).digest('hex')!==file.sha256)throw Error('Audio driver package changed while staging')
  }
  return {...verified,authorization_record_sha256:createHash('sha256').update(fs.readFileSync(authorizationFile)).digest('hex'),stage}
}

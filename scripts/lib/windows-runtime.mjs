import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {runWindowsPowerShell} from './windows-powershell.mjs'

// Application-local deployment of the official toolchain's release CRT.
// Never copy System32, install a host-wide runtime, or include debug binaries.
const crt=/^(?:vcruntime\d+|msvcp\d+|concrt\d+)(?:_[a-z0-9]+)*\.dll$/i
const system=new Set(['kernel32.dll','ntdll.dll','user32.dll','gdi32.dll','gdi32full.dll','ole32.dll','oleaut32.dll','combase.dll','mmdevapi.dll','avrt.dll','winmm.dll','bcrypt.dll','bcryptprimitives.dll','ncrypt.dll','crypt32.dll','advapi32.dll','ws2_32.dll','iphlpapi.dll','dnsapi.dll','secur32.dll','shell32.dll','shlwapi.dll','propsys.dll','setupapi.dll','cfgmgr32.dll','winhttp.dll','wininet.dll','version.dll','ucrtbase.dll','normaliz.dll','dwmapi.dll','d3d11.dll','dxgi.dll','dbghelp.dll','powrprof.dll','userenv.dll','kernelbase.dll','wintrust.dll','wtsapi32.dll','mswsock.dll','rpcrt4.dll'])
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function imports(file,env){
  const text=execFileSync('dumpbin.exe',['/NOLOGO','/DEPENDENTS',file],{env,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024})
  return [...text.matchAll(/^\s+([a-z0-9_.-]+\.dll)\s*$/gmi)].map(match=>match[1].toLowerCase())
}
export function bundleWindowsRuntime(directory, executables, env=process.env){
  if(process.platform!=='win32')return
  const architecture={x64:{directory:'x64',machine:0x8664},arm64:{directory:'arm64',machine:0xaa64}}[process.arch]
  if(!architecture||!env.VCToolsRedistDir)throw Error('Initialize the native MSVC developer environment with VCToolsRedistDir before packaging')
  const redist=fs.realpathSync(path.join(env.VCToolsRedistDir,architecture.directory))
  const folders=fs.readdirSync(redist,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^Microsoft\.VC\d+\.CRT$/i.test(entry.name))
  if(folders.length!==1)throw Error('Expected one release CRT in the official MSVC redistributable directory')
  const source=path.join(redist,folders[0].name)
  const pending=executables.map(name=>path.join(directory,name)),checked=new Set(),files=[]
  while(pending.length){
    const binary=pending.shift()
    if(checked.has(binary.toLowerCase()))continue
    checked.add(binary.toLowerCase())
    for(const name of imports(binary,env)){
      if(system.has(name)||/^(?:api-ms-win-|ext-ms-win-)/i.test(name))continue
      if(!crt.test(name))throw Error(`Undeclared native runtime dependency ${name} in ${path.basename(binary)}`)
      const original=path.join(source,name), destination=path.join(directory,name)
      const bytes=fs.readFileSync(original),header=bytes.readUInt32LE(0x3c)
      if(bytes.readUInt16LE(0)!==0x5a4d||header+6>bytes.length||bytes.readUInt32LE(header)!==0x4550||bytes.readUInt16LE(header+4)!==architecture.machine)throw Error(`Runtime architecture/header mismatch: ${name}`)
      if(fs.existsSync(destination)){
        if(!files.some(file=>file.file===name)||hash(destination)!==hash(original))throw Error(`Runtime dependency collision: ${name}`)
        continue
      }
      const script="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $file=[Environment]::GetEnvironmentVariable('STREAM_KIT_RUNTIME_FILE'); $signature=Get-AuthenticodeSignature -LiteralPath $file; if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)'){throw 'Expected valid Microsoft runtime signature'}; [pscustomobject]@{publisher=$signature.SignerCertificate.Subject;version=(Get-Item -LiteralPath $file).VersionInfo.FileVersion} | ConvertTo-Json -Compress"
      const signature=JSON.parse(runWindowsPowerShell(script,{env:{...env,STREAM_KIT_RUNTIME_FILE:original}}))
      fs.copyFileSync(original,destination,fs.constants.COPYFILE_EXCL)
      files.push({file:name,bytes:bytes.length,sha256:hash(destination),version:signature.version,publisher:signature.publisher})
      pending.push(destination)
    }
  }
  const license='https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution'
  fs.writeFileSync(path.join(directory,'WINDOWS-RUNTIME.json'),JSON.stringify({schema_version:1,architecture:process.arch,distribution:'application-local MSVC release CRT',license_url:license,files:files.sort((a,b)=>a.file.localeCompare(b.file))},null,2)+'\n')
  if(files.length)fs.writeFileSync(path.join(directory,'WINDOWS-RUNTIME-NOTICE.txt'),`Microsoft Visual C++ Runtime\nCopyright Microsoft Corporation. All rights reserved.\nUnmodified release redistributable files from the Microsoft Visual Studio toolchain.\nRedistribution and use are governed by the applicable Microsoft Software License Terms.\nDistributable code list: ${license}\nDeployment: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files\n`)
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {runWindowsPowerShell} from './lib/windows-powershell.mjs'

test('signature verification uses inbox Desktop modules despite an incompatible inherited module path', {skip:process.platform!=='win32'}, t=>{
  const temporaryDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'stream-kit-powershell-'))
  t.after(()=>{
    const relative=path.relative(fs.realpathSync(os.tmpdir()),fs.realpathSync(temporaryDirectory))
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))
    fs.rmSync(temporaryDirectory,{recursive:true,force:true})
  })
  const moduleDirectory=path.join(temporaryDirectory,'Microsoft.PowerShell.Security')
  fs.mkdirSync(moduleDirectory)
  // Discoverable metadata for a module that cannot load in this engine. No
  // fixture code is executed, and the real OS module is never modified.
  fs.writeFileSync(path.join(moduleDirectory,'Microsoft.PowerShell.Security.psd1'),"@{ModuleVersion='7.0.0';GUID='c02fa4ea-5813-4fee-b413-19b8c9a1d20';PowerShellVersion='3.0';RootModule='CoreOnlyMissing.dll';CmdletsToExport=@('Get-AuthenticodeSignature')}")
  const engineDirectory=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0')
  const modulePath=temporaryDirectory+';'+path.join(engineDirectory,'Modules')
  const env={...process.env,PSModulePath:modulePath}
  const script="$ErrorActionPreference='Stop';$s=Get-AuthenticodeSignature -LiteralPath (Join-Path $PSHOME 'powershell.exe');@{status=$s.Status.ToString();edition=$PSVersionTable.PSEdition;module=(Get-Module Microsoft.PowerShell.Security).Path}|ConvertTo-Json -Compress"
  const inherited=spawnSync(path.join(engineDirectory,'powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{env,encoding:'utf8',windowsHide:true,timeout:30000})
  assert.ifError(inherited.error)
  assert.notEqual(inherited.status,0,'The incompatible fixture must reproduce module loading failure')
  const isolated=JSON.parse(runWindowsPowerShell(script,{env}))
  assert.equal(isolated.edition,'Desktop')
  assert.equal(isolated.status,'Valid')
  assert.equal(isolated.module.toLowerCase(),path.join(engineDirectory,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1').toLowerCase())
  assert.equal(env.PSModulePath,modulePath,'The caller environment must remain unchanged')
})

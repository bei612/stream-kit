import path from 'node:path'
import {execFileSync} from 'node:child_process'

// Windows PowerShell 5.1 is part of the supported OS. Node may inherit a
// PowerShell 7 PSModulePath on CI; do not load Core assemblies in the Desktop
// engine or resolve security cmdlets from user/project module directories.
export function runWindowsPowerShell(script,{env=process.env,...options}={}){
  if(process.platform!=='win32')throw Error('Native Windows PowerShell requires Windows')
  const windows=env.SystemRoot||env.SYSTEMROOT||env.windir||env.WINDIR
  if(!windows)throw Error('Missing native Windows system directory')
  const engineDirectory=path.join(windows,'System32','WindowsPowerShell','v1.0')
  const childEnv={...env}
  for(const key of Object.keys(childEnv))if(key.toLowerCase()==='psmodulepath')delete childEnv[key]
  childEnv.PSModulePath=path.join(engineDirectory,'Modules')
  return execFileSync(path.join(engineDirectory,'powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{...options,env:childEnv,encoding:'utf8',windowsHide:true,timeout:options.timeout??30000})
}

export function controlBuildTarget(environment) {
  const {GOOS,GOARCH,GOHOSTOS,GOHOSTARCH}=environment
  if(!['windows','linux'].includes(GOOS)||!['amd64','arm64'].includes(GOARCH))throw new Error(`Unsupported control-plane target: ${GOOS}/${GOARCH}`)
  if(!GOHOSTOS||!GOHOSTARCH)throw new Error('Missing Go build host identity')
  return {platform:GOOS,architecture:GOARCH,binary:GOOS==='windows'?'orchestrator.exe':'orchestrator',canExecute:GOOS===GOHOSTOS&&GOARCH===GOHOSTARCH}
}

export function verifyControlBuildInfo(info,target,commit,dirty=false) {
  if(info.Path!=='github.com/stream-kit/orchestrator/cmd/orchestrator')throw new Error('Unexpected compiled command')
  const settings=new Map((info.Settings||[]).map(setting=>[setting.Key,setting.Value]))
  if(settings.get('GOOS')!==target.platform||settings.get('GOARCH')!==target.architecture)throw new Error('Compiled target does not match requested bundle target')
  if(settings.get('vcs.revision')!==commit||settings.get('-trimpath')!=='true')throw new Error('Compiled source identity does not match source build')
  if(typeof dirty!=='boolean'||settings.get('vcs.modified')!==String(dirty))throw new Error('Compiled source modification state does not match source build')
}

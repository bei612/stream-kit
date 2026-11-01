// One product identity across the platform manifest, both native installers and
// release promotion. Version selection never implies functional acceptance.
export function productRelease(commit,version=''){
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Expected full product source commit')
  const short=commit.slice(0,12),preview=`0.1.0-preview.${short}`
  if(version===''||version===preview)return {channel:'preview',version:preview,prefix:`stream-kit-preview-${short}`,windowsVersion:'0.1.0.0'}
  if(typeof version!=='string'||!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)||version.split('.').some(n=>Number(n)>65535))throw Error('Expected release version MAJOR.MINOR.PATCH with each component in 0..65535')
  return {channel:'stable',version,prefix:`stream-kit-${version}-${short}`,windowsVersion:`${version}.0`}
}

export function manifestRelease(manifest){
  if(manifest.release_version===undefined&&manifest.release_channel!=='preview')throw Error('Stable payload requires an explicit release version')
  const release=productRelease(manifest.commit,manifest.release_version===undefined?'':manifest.release_version)
  if(release.channel!==manifest.release_channel)throw Error('Product version and release channel disagree')
  return release
}

export function promotionProfile(windows,linux,tag){
  const release=manifestRelease(windows),other=manifestRelease(linux)
  if(windows.commit!==linux.commit||release.version!==other.version||release.channel!==other.channel)throw Error('Both installers must have the same source, version and channel')
  if(windows.file?.name!==`${release.prefix}-windows-amd64-setup.exe`||linux.installer?.file!==`${release.prefix}-ubuntu24.04-amd64-setup.run`)throw Error('Installer name does not match its verified product identity')
  const candidate=typeof tag==='string'&&release.channel==='stable'&&tag.startsWith(`v${release.version}-rc.`)&&/^[1-9][0-9]*$/.test(tag.slice(`v${release.version}-rc.`.length))
  const validTag=typeof tag==='string'&&tag===tag.trim()&&(release.channel==='stable'
    ?tag===`v${release.version}`||candidate
    :tag.startsWith(`v${release.version.split('-')[0]}-preview.`)&&/^v[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]+(\.[0-9]+)*$/.test(tag))
  if(!validTag)throw Error('Release tag does not match the artifact channel/version')
  return {...release,publication_channel:candidate?'candidate':release.channel,prerelease:release.channel==='preview'||candidate,notes:release.channel==='preview'?'deploy/windows/CI-RELEASE.md':'deploy/RELEASE.md'}
}

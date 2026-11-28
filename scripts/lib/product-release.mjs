import assert from 'node:assert/strict'
import { isIPv4 } from 'node:net'

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
  return publicationProfile(release,tag)
}

export function publicationProfile(release,tag){
  const candidate=typeof tag==='string'&&release.channel==='stable'&&tag.startsWith(`v${release.version}-rc.`)&&/^[1-9][0-9]*$/.test(tag.slice(`v${release.version}-rc.`.length))
  const validTag=typeof tag==='string'&&tag===tag.trim()&&(release.channel==='stable'
    ?tag===`v${release.version}`||candidate
    :tag.startsWith(`v${release.version.split('-')[0]}-preview.`)&&/^v[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]+(\.[0-9]+)*$/.test(tag))
  if(!validTag)throw Error('Release tag does not match the artifact channel/version')
  return {...release,publication_channel:candidate?'candidate':release.channel,prerelease:release.channel==='preview'||candidate,notes:release.channel==='preview'?'deploy/windows/CI-RELEASE.md':'deploy/RELEASE.md'}
}

// Publication accepts evidence for the exact installer bytes, not a green build
// or a service configuration check performed on another deployment.
export function verifyInstallerAcceptance(manifest,result){
  if(!result || result.passed!==true || result.error)throw Error('Windows installer acceptance did not pass')
  if(!/^[a-f0-9]{64}$/.test(manifest.file?.sha256) ||
    result.commit!==manifest.commit || result.installer_source_commit!==manifest.commit ||
    result.installer_sha256!==manifest.file.sha256)throw Error('Installer acceptance does not match the published source and bytes')
  if(result.install_exit!==0 || result.uninstall_exit!==0)throw Error('Installer lifecycle did not finish successfully')
  for(const key of ['admin_login','gateway_restarted','scm_restarted','defaults_preserved','service_removed','data_preserved']){
    if(result[key]!==true)throw Error(`Missing installer acceptance: ${key}`)
  }
  if(result.pair?.passed!==true)throw Error('Installed native audio pair did not pass')
  for(const key of ['service','service_after_restart']){
    if(result[key]?.StartMode!=='Auto' || result[key]?.StartName!=='LocalSystem' || result[key]?.State!=='Running'){
      throw Error(`Installed automatic service is not verified: ${key}`)
    }
  }
}

function verifyWindows11InstallerIdentity(manifest, result) {
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.file?.sha256) && result?.commit === manifest.commit &&
    result.installer_source_commit === manifest.commit && result.installer_sha256 === manifest.file.sha256,
  'Windows 11 evidence does not match the installer source and bytes')
}

export function verifyWindows11RebootAcceptance(manifest, guest, result) {
  assert.ok(guest?.phase === 'guest_ready' && guest.secure_boot === true && guest.tpm_present === true,
    'Clean Windows 11 guest did not verify Secure Boot and TPM')
  assert.ok(result?.phase === 'completed' && result.passed === true && result.exit_code === 0 && !result.error,
    'Clean Windows 11 install and reboot acceptance did not pass')
  verifyWindows11InstallerIdentity(manifest, result)
  assert.ok([0, 3010].includes(result.install_exit) && result.uninstall_exit === 0,
    'Windows 11 installer lifecycle did not finish successfully')

  const before = result.pre_reboot
  const after = result.post_reboot
  for (const boot of [before, after]) {
    assert.ok(boot?.product_type === 1 && boot.architecture === 'X64' &&
      Number.isSafeInteger(boot.build) && boot.build >= 22000 && Number.isFinite(Date.parse(boot.boot_utc)),
      'Missing Windows 11 x64 boot observation')
    assert.ok(boot.service?.StartMode === 'Auto' && boot.service.StartName === 'LocalSystem',
      'Windows 11 automatic service registration was not verified')
  }
  assert.equal(guest.build, before.build, 'The install evidence does not match the observed Windows 11 guest')
  assert.ok(Date.parse(after.boot_utc) > Date.parse(before.boot_utc), 'Windows 11 did not reboot after installation')

  const processes = after.processes
  assert.ok(Array.isArray(processes) && processes.length === 3 &&
    processes.every(process => Number.isSafeInteger(process?.pid) && process.pid > 0 &&
      Number.isSafeInteger(process.session) && Date.parse(process.created_utc) >= Date.parse(after.boot_utc)) &&
    new Set(processes.map(process => process.pid)).size === processes.length,
    'Missing distinct native processes from the new Windows boot')
  const [controller, renderer, gateway] = processes
  assert.ok(controller.role === 'orchestrator' && controller.session === 0 &&
    controller.pid === after.service.ProcessId && after.service.State === 'Running' &&
    renderer.role === 'sunshine' && renderer.session > 0 &&
    gateway.role === 'web_server' && gateway.session === renderer.session,
    'Windows 11 components did not start in the expected service and desktop sessions')

  assert.ok(Number.isSafeInteger(result.pcm_frames) && result.pcm_frames > 0 && result.pcm_dropped === 0,
    'Windows 11 native recording verification did not pass')
  for (const key of ['admin_login', 'gateway_restarted', 'scm_restarted', 'defaults_preserved', 'service_removed', 'data_preserved']) {
    assert.equal(result[key], true, `Missing Windows 11 reboot acceptance: ${key}`)
  }
}

export function verifyWindows11LanAcceptance(result, client) {
  const guest = result?.lan_address_change
  assert.ok(guest?.passed === true && guest.stage === 'complete' && guest.runtime_commit === result.commit &&
    guest.config_trust_and_watch_preserved === true && guest.target_stopped === true,
  'Windows 11 did not preserve the installed runtime and viewing link across LAN migration')
  assert.ok(client?.passed === true && client.same_page_recovered === true,
    'The independent LAN browser did not recover its original viewing page')
  assert.deepEqual(client.network, guest.network, 'Guest and client LAN evidence must describe the same network')
  const {old_address: oldAddress, new_address: newAddress, client_address: clientAddress} = guest.network
  const addresses = [oldAddress, newAddress, clientAddress]
  assert.ok(addresses.every(isIPv4) && new Set(addresses).size === addresses.length,
    'LAN migration requires distinct old, new and independent client addresses')
  assert.deepEqual(guest.addresses_after, [newAddress], 'The Windows guest did not apply the new address')
  assert.deepEqual(guest.component_pids_after, guest.component_pids_before, 'Windows components restarted during LAN migration')
  assert.ok(['orchestrator', 'sunshine', 'gateway'].every(role =>
    Number.isSafeInteger(guest.component_pids_after?.[role]) && guest.component_pids_after[role] > 0),
  'Windows component identities are missing from LAN migration evidence')

  const leafFingerprints = []
  for (const [address, phase] of [[oldAddress, client.before], [newAddress, client.after]]) {
    const [hostname, resolvedAddress] = phase?.resolved?.split('\t') ?? []
    assert.ok(hostname?.replace(/\.$/, '').toLowerCase() === guest.hostname && resolvedAddress === address,
      'The independent client resolved a different Windows address')
    const listeners = phase.listeners
    assert.deepEqual(listeners?.map(listener => listener?.port), [19000, 18080], 'Both fixture HTTPS listeners are required')
    const fingerprint = listeners[0].leaf_fingerprint
    assert.ok(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i.test(fingerprint) && listeners.every(listener =>
      listener.address === address && listener.obsolete_ip_absent === true && listener.leaf_fingerprint === fingerprint),
    'Management and media must use the same valid certificate for the current address')
    leafFingerprints.push(fingerprint)
    assert.ok(phase.media?.remote_address === address && phase.media.frames >= 30 && phase.media.audio_packets > 0,
      'The independent client did not decode actual media at the current address')
    assert.deepEqual(phase.media.remote_host_addresses, [address], 'Media candidates do not match the current address')
  }
  assert.notEqual(leafFingerprints[0], leafFingerprints[1], 'The Windows LAN certificate did not rotate after changing addresses')
}

export function verifyWindows11LanForPublication(manifest, result, client) {
  verifyWindows11InstallerIdentity(manifest, result)
  const completed = result.phase === 'completed' && result.passed === true && result.exit_code === 0 && !result.error
  const observerFailedBeforeUninstall = result.phase === 'failed' && result.passed === false && result.exit_code === 1 &&
    result.cleanup_stage === 'verify_uninstaller_ownership' && result.uninstall_exit == null &&
    result.cleanup_error === 'spawnSync powershell.exe ETIMEDOUT' && result.error === result.cleanup_error
  assert.ok(completed || observerFailedBeforeUninstall, 'Windows 11 LAN run has an unrelated or unclassified failure')
  verifyWindows11LanAcceptance(result, client)
}

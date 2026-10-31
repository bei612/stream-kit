// Read-only evidence for native browser audio failures. Never starts services,
// opens audio streams, installs drivers or changes the default endpoint.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {startAudioProbe} = require('./lib/audio-probe.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (process.platform !== 'win32' || !args[0] || args.length > 2 || (args[1] && args[1] !== '--require-output')) {
    throw new Error('Expected Windows, an explicit native audio-probe path and optional --require-output');
  }
  const output = path.resolve('artifacts/audio-playback/windows-environment.json');
  const result = {recorded_at:new Date().toISOString(), scope:'Read-only services and native endpoint inventory; no audio playback or capture acceptance'};
  fs.mkdirSync(path.dirname(output), {recursive:true});
  let probe;
  try {
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @([pscustomobject]@{services=@(Get-Service -Name Audiosrv,AudioEndpointBuilder | Select-Object Name,@{n='status';e={$_.Status.ToString()}});sound_devices=@(Get-CimInstance Win32_SoundDevice | Select-Object Name,Status,ConfigManagerErrorCode)}) | ConvertTo-Json -Depth 4 -Compress";
    result.windows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8', windowsHide:true, timeout:15000, maxBuffer:1024*1024}));
    probe = startAudioProbe(path.resolve(process.argv[2]));
    const response = await probe.command('devices');
    if (response.error || !Array.isArray(response.data?.devices)) throw new Error(response.error || 'Invalid endpoint inventory');
    result.endpoints = response.data.devices;
    result.input_count = result.endpoints.filter(device => device.input).length;
    result.output_count = result.endpoints.filter(device => device.output).length;
    result.playback_prerequisite_met = result.output_count > 0;
    await probe.close();
    result.clean_exit = true;
    console.log(`Native audio inventory: ${result.input_count} inputs, ${result.output_count} outputs`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      const summary = JSON.stringify({services:result.windows.services, inputs:result.input_count, outputs:result.output_count});
      console.log('::notice title=Windows audio environment::' + summary.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));
    }
    if (args[1] === '--require-output' && !result.playback_prerequisite_met) {
      throw new Error('Windows browser playback requires an enabled native output endpoint. This runner has none; audio acceptance did not run. Provision an audio-capable runner before retrying.');
    }
  } catch (error) {
    result.error = error.message;
    throw error;
  } finally {
    try { if (probe) await probe.close(); }
    finally { fs.writeFileSync(output, JSON.stringify(result,null,2)); }
  }
}
main().catch(error => {console.error(error);process.exitCode=1});

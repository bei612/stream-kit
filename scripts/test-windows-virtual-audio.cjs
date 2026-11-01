// Development/CI only. Owns a temporary software device, verifies actual PCM,
// then supplies the native endpoint prerequisite for browser audio checks.
// Driver installation belongs to the elevated CI setup, never to this helper.
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const {startAudioProbe} = require('./lib/audio-probe.cjs');
const execute = promisify(execFile);

async function main() {
  if (process.platform !== 'win32' || process.argv.length !== 3) {
    throw Error('Expected Windows: node test-windows-virtual-audio.cjs AUDIO_TARGET_DEBUG_DIRECTORY');
  }
  const native = path.resolve(process.argv[2]);
  const output = path.resolve('artifacts/audio-playback/virtual-device');
  fs.mkdirSync(output, {recursive:true});
  const report = {schema_version:1, recorded_at:new Date().toISOString(), scope:'Temporary CI audio device and generated PCM; not physical human speech', passed:false};
  let provider, ended, probe, closed = false;
  const abort = new AbortController();
  const cancel = () => { abort.abort(); provider?.stdin?.end(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const logs = [];
  try {
    const stdout = fs.openSync(path.join(output,'provider.stdout.log'), 'w');
    const stderr = fs.openSync(path.join(output,'provider.stderr.log'), 'w');
    logs.push(stdout,stderr);
    // Explicit fixture identity is never copied into a customer configuration.
    provider = spawn(path.join(native,'examples/virtual_device.exe'), ['65534','1','CIOnly48k','stdin'], {
      windowsHide:true, stdio:['pipe',stdout,stderr],
    });
    ended = new Promise(resolve => {
      provider.once('error', error => { closed=true; resolve({error:error.message}); });
      provider.once('exit', (code,signal) => { closed=true; resolve({code,signal}); });
    });
    provider.stdin?.on('error', () => {}); // Exit promise reports a closed/crashed owner.
    probe = startAudioProbe(path.join(native,'audio-probe.exe'));
    const deadline = Date.now()+20000;
    while (Date.now()<deadline) {
      if (closed || abort.signal.aborted) throw Error('Virtual audio provider exited before endpoint enumeration');
      const reply = await probe.command('devices');
      if (reply.error || !Array.isArray(reply.data?.devices)) throw Error(reply.error || 'Invalid endpoint inventory');
      const candidates = reply.data.devices.filter(item => item.name.includes('Stream Kit Virtual Audio'));
      const inputs = candidates.filter(item=>item.input), outputs = candidates.filter(item=>item.output);
      if (inputs.length>1 || outputs.length>1) throw Error('Ambiguous test device inventory; existing devices are not substituted');
      if (inputs.length===1 && outputs.length===1) {
        report.endpoints={render:outputs[0],capture:inputs[0]};
        break;
      }
      await delay(100, undefined, {signal:abort.signal});
    }
    if (!report.endpoints) throw Error('Windows did not enumerate both native endpoints within 20 seconds');
    await probe.close(); probe=undefined;
    async function run(name,file,args,env=process.env) {
      let result;
      try { result=await execute(file,args,{env,windowsHide:true,timeout:180000,maxBuffer:8*1024*1024,signal:abort.signal}); }
      catch(error) { result=error; throw error; }
      finally {
        fs.writeFileSync(path.join(output,`${name}.stdout.log`),result?.stdout || '');
        fs.writeFileSync(path.join(output,`${name}.stderr.log`),result?.stderr || '');
      }
      return result.stdout;
    }
    await run('environment',process.execPath,['scripts/record-windows-audio-environment.cjs',path.join(native,'audio-probe.exe'),'--require-output']);
    report.pair=JSON.parse(await run('pair',path.join(native,'examples/verify_pair.exe'),[report.endpoints.render.id,report.endpoints.capture.id]));
    if (report.pair.passed!==true) throw Error('Actual native PCM pair did not pass');
    report.browsers=[];
    for (const engine of ['chromium','firefox']) {
      await run(`browser-${engine}`,process.execPath,['scripts/test-audio-playback-browser.cjs'],{...process.env,BROWSER_CHANNEL:'chromium',BROWSER_ENGINE:engine});
      report.browsers.push(engine);
    }
    if (closed) throw Error('Device exited during browser acceptance');
    report.passed=true;
  } catch(error) {
    report.error=error.message; throw error;
  } finally {
    try { if (probe) await probe.close(); }
    finally {
      provider?.stdin?.end();
      if (ended) {
        const timeout = new AbortController();
        const exit = await Promise.race([ended,delay(10000,{timeout:true},{signal:timeout.signal})]);
        timeout.abort();
        if (exit.timeout) {
          report.passed=false;
          report.cleanup_error='Owned provider did not close within 10 seconds';
          provider.kill(); // Exact owned test process only; timeout is a failure.
          await ended;
        } else {
          report.provider_exit=exit;
          report.clean_exit=exit.code===0 && !exit.signal && !exit.error;
          if (!report.clean_exit) report.passed=false;
        }
      }
      for (const fd of logs) fs.closeSync(fd);
      fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
      process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel);
      if (!report.passed) process.exitCode=1;
    }
  }
  if (!report.passed) throw Error(report.cleanup_error || 'Provider cleanup failed');
  console.log('Windows owned virtual audio: PCM, Chromium/Firefox audio and clean device shutdown passed');
}
main().catch(error => { console.error(error); process.exitCode=1; });

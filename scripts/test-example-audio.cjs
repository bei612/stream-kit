// Native IPC/lifecycle acceptance, without opening a microphone or speaker.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
async function run() {
  const executable = path.resolve(process.argv[2] || 'artifacts/example/audio-probe.exe');
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0, stderr = '';
  child.stderr.on('data', b => stderr += b);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code,signal})); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { const message=JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  const command = (op, device_id, schema_version=1) => new Promise((resolve,reject) => {
    const commandID=++id;
    const timeout=setTimeout(()=>reject(new Error(`audio command timeout: ${op}`)),5000);
    pending.set(commandID, message=>{ clearTimeout(timeout); resolve(message); });
    child.stdin.write(JSON.stringify({schema_version,id:commandID,op,device_id})+'\n');
  });
  try {
    const catalog=await command('devices');
    assert.equal(catalog.schema_version,1); assert.ok(Array.isArray(catalog.data.devices));
    assert.ok(catalog.data.devices.every(d=>d.id && d.name && (d.input||d.output)));
    for (const op of ['capture','tone','playback']) {
      assert.match((await command(op,'')).error,/explicit audio device/);
      assert.match((await command(op,'invalid-endpoint')).error,/.+/);
    }
    assert.match((await command('status',undefined,2)).error,/protocol version/);
    assert.match((await command('unknown')).error,/Unknown probe command/);
    const state=(await command('status')).data;
    assert.equal(state.state,'idle'); assert.equal(state.captured_frames,0); assert.equal(state.played_frames,0);
    assert.equal((await command('stop')).data.state,'idle');
    child.stdin.end();
    const deadline=setTimeout(()=>child.kill(),5000);
    const ended=await exit; clearTimeout(deadline);
    assert.deepEqual(ended,{code:0,signal:null},stderr);
    const result={passed:true,scope:'Real native device enumeration, command validation and EOF lifecycle; no audio streams opened',devices:catalog.data.devices.length,finished_at:new Date().toISOString()};
    fs.mkdirSync('artifacts/example',{recursive:true});
    fs.writeFileSync('artifacts/example/audio-protocol-result.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally { if (child.exitCode===null) child.kill(); lines.close(); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});

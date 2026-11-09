const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { targetInputObserver } = require('./target-input-observer.cjs');

async function until(read, accept, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (accept(value)) return value; await delay(200); } while (Date.now() < deadline);
  throw Error('Native exit timeout: ' + description);
}

async function verifyNativeExit({pages, api, sunshine, control, gateway, sessionId, app, example, report, save}) {
  assert.equal(process.platform, 'linux');
  const result = report.native_exit = { passed:false, trigger:'WM_DELETE_WINDOW on verified owned X11 target', observations:[], scope:'Passive native exit with two real Web viewers; not administrative stop, Android, input or audio acceptance' }; save();
  const route = '/stream-sessions/' + sessionId;
  const initialRuntime = await sunshine('/api/stream-kit/runtime');
  assert.equal(initialRuntime.app_id, app.id); assert.equal(initialRuntime.gamestream_id, app.sunshine_app_id);
  assert.match(initialRuntime.instance_id, /^[a-f0-9]{32}$/);
  const running = await until(() => api(route), s => s.state === 'running' && s.native_instance_id === initialRuntime.instance_id, 'running generation must match actual native instance');
  const target = await targetInputObserver(app, example), processId = target.processId;
  assert.equal(fs.realpathSync('/proc/' + processId + '/exe'), fs.realpathSync(example), 'Target executable ownership changed');
  const exec = (file, args) => execFileSync(file, args, { encoding:'utf8', timeout:10000, stdio:['ignore','pipe','pipe'] }).trim();
  const windows = exec('xdotool', ['search','--all','--onlyvisible','--pid', String(processId), '--class','StreamKitInputAcceptance']).split(/\r?\n/);
  assert.equal(windows.length, 1); assert.match(windows[0], /^\d+$/);
  assert.equal(exec('xdotool', ['getwindowpid', windows[0]]), String(processId));
  const access = await pages[0].evaluate(() => { const a=window.app.getStream().mediaAccess; return {bearer:a.bearer, connectionId:a.connectionId}; });
  assert.ok(running.connections[access.connectionId]);
  await api(route + '/controller/' + access.connectionId, 'POST');
  const invitation = await api('/stream-invitations', 'POST', {host_id:running.host_id, app_id:running.app_id});
  assert.equal(invitation.session_id, sessionId);
  const connectionPath = `/api/v1/client-sessions/${sessionId}/connections/${access.connectionId}`;
  const request = (url, token, method='GET') => fetch(url, {method, headers:{Authorization:'Bearer '+token}, signal:AbortSignal.timeout(10000)});
  assert.equal((await request(control+connectionPath, access.bearer)).status, 200);
  const response = await request(control+connectionPath+'/ticket', access.bearer, 'POST'); assert.equal(response.status, 200);
  const media = (await response.json()).data;
  const profile = () => fetch(gateway+'/api/host/stream/profile', {headers:{'X-Stream-Media-Ticket':media.ticket}, signal:AbortSignal.timeout(10000)});
  assert.equal((await profile()).status, 200, 'Actual media ticket must be valid before native exit');
  const connectionExpiry = JSON.parse(Buffer.from(access.bearer.split('.')[1], 'base64url')).exp * 1000;
  const expiry = Math.min(Date.parse(invitation.expires_at), Date.parse(media.expires_at), connectionExpiry);
  assert.ok(Number.isFinite(expiry) && expiry > Date.now()+30000, 'Old credentials must remain valid through the passive-exit observation');
  result.before = {session_id:sessionId, native_instance_id:initialRuntime.instance_id, process_id:processId, window_id:windows[0], controller_connection_id:access.connectionId, credential_earliest_expiry:new Date(expiry).toISOString()}; save();
  const closingAt = Date.now();
  exec(example, ['--close-owned-window', windows[0], String(processId)]);
  await until(async()=>{
    const events=fs.readFileSync(path.join(app.app_dir,'output.log'),'utf8').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    return events.some(e=>e.event==='closed' && e.process_id===processId) && !fs.existsSync('/proc/'+processId);
  }, Boolean, 'owned target must confirm a graceful close and leave the process table');
  const replacements = new Set();
  const stopped = await until(async()=>{
    const native=await sunshine('/api/stream-kit/runtime'), session=await api(route), application=await api('/apps/'+app.id);
    if(native.app_id===app.id && native.instance_id!==initialRuntime.instance_id && native.gamestream_id>0) replacements.add(native.instance_id);
    result.observations.push({elapsed_ms:Date.now()-closingAt, native_instance_id:native.instance_id, native_app_id:native.app_id, gamestream_id:native.gamestream_id, session_state:session.state, observed_stop:session.observed_stop, app_status:application.status}); save();
    return {native,session,application};
  }, v=>v.session.state==='stopped', 'old generation must become terminal without a stop command');
  assert.equal(stopped.session.observed_stop, true); assert.equal(stopped.session.controller_connection_id??'', ''); assert.deepEqual(stopped.session.connections, {});
  assert.ok(Date.now()<expiry, 'Credentials naturally expired before revocation was checked');
  const oldJoin = await request(control+'/api/v1/client-sessions/join', invitation.invitation, 'POST'); assert.equal(oldJoin.status, 400); assert.equal((await oldJoin.json()).code, 'SESSION_COMMAND_INVALID');
  const oldConnection = await request(control+connectionPath, access.bearer);
  const oldConnectionCode = (await oldConnection.json()).code;
  result.revocation = {old_invitation_status:oldJoin.status, old_connection_status:oldConnection.status, old_connection_code:oldConnectionCode}; save();
  assert.equal(oldConnection.status, 410);
  assert.equal(oldConnectionCode, 'CONNECTION_TERMINATED', 'Native exit must definitively terminate the old connection, not advertise a resumable lease expiry');
  const oldMedia = await profile(); result.revocation.old_media_status = oldMedia.status; save(); assert.equal(oldMedia.status, 401);
  await until(()=>api('/media-control'), s=>s.observations_valid && !s.observations?.[sessionId], 'signed media authority must withdraw old generation');
  let replacement = stopped.native.app_id===app.id ? stopped.native.instance_id : '';
  if(replacements.size) assert.ok(replacement && replacements.has(replacement), 'A replacement native execution disappeared during old-generation revocation');
  let stableUntil=Date.now()+6000;
  while(Date.now()<stableUntil){
    await delay(1000); const native=await sunshine('/api/stream-kit/runtime');
    if(!replacement && native.gamestream_id>0){
      assert.equal(native.app_id,app.id,'An unrelated native execution appeared');
      assert.notEqual(native.instance_id,initialRuntime.instance_id,'Closed native instance unexpectedly returned');
      replacement=native.instance_id; replacements.add(replacement); stableUntil=Date.now()+6000;
    }
    if(replacement){ assert.equal(native.app_id,app.id); assert.equal(native.instance_id,replacement,'Old generation revocation killed a replacement native instance'); }
    else assert.equal(native.gamestream_id,0);
  }
  const finalApp = await api('/apps/'+app.id); assert.equal(finalApp.status,replacement?'running':'stopped');
  result.after = {state:stopped.session.state, observed_stop:true, connections:0, controller_connection_id:'', old_invitation_status:oldJoin.status, old_connection_status:oldConnection.status, old_connection_code:oldConnectionCode, old_media_status:oldMedia.status, verified_before_expiry:Date.now()<expiry, app_status:finalApp.status, replacement_instance_id:replacement||null, replacement_observed:replacements.size>0, replacement_survived_if_present:replacement?true:null, stability_seconds:6};
  assert.equal(result.after.verified_before_expiry,true);
  result.passed=true; save();
}
module.exports = {verifyNativeExit};

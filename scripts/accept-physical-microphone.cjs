// Explicit native-device capture preflight. Never substitutes a generated track,
// records speech to disk, changes audio defaults, or claims target delivery.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {launchBrowser,engine}=require('./lib/test-browser.cjs');
const ts=require('../orchestrator/web/node_modules/typescript');
const root=path.resolve(__dirname,'..');
const labelIndex=process.argv.indexOf('--device-label');
assert.ok(labelIndex>0&&process.argv[labelIndex+1],'Explicit --device-label REGEX is required');
const pattern=process.argv[labelIndex+1];new RegExp(pattern,'i');
const output=path.join(root,'artifacts/physical-microphone',new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(output,{recursive:true});
const moduleCode=ts.transpileModule(fs.readFileSync(path.join(root,'third_party/moonlight-web-stream/web/stream/audio/microphone_capture.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const result={passed:false,engine,scope:'Physical-device getUserMedia through the production MicrophoneCapture owner, signal observation and revocation; no gateway/target/UE5 or permission-prompt acceptance',permission_mode:'automation grants browser permission under test authorization; OS permissions remain in effect'};
let browser;
const server=http.createServer((request,response)=>{
 response.setHeader('Cache-Control','no-store');
 if(request.url==='/capture.js'){response.setHeader('Content-Type','text/javascript');response.end(moduleCode)}
 else if(request.url==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Physical microphone acceptance</title>')}
 else {response.writeHead(404);response.end()}
});
(async()=>{
 try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await launchBrowser();result.browser=browser.version();
  const context=await browser.newContext();await context.grantPermissions(['microphone'],{origin});
  const page=await context.newPage();await page.goto(origin);
  result.capture=await page.evaluate(async pattern=>{
   const {MicrophoneCapture}=await import('/capture.js');
   if(!MicrophoneCapture.supported(window))throw Error('Secure-context microphone capture is unavailable');
   const devices=await navigator.mediaDevices.enumerateDevices();
   const matching=devices.filter(device=>device.kind==='audioinput'&&!['default','communications'].includes(device.deviceId)&&new RegExp(pattern,'i').test(device.label));
   if(matching.length!==1)throw Error(`Expected one explicit capture device, found ${matching.length}; inputs: ${devices.filter(d=>d.kind==='audioinput').map(d=>d.label).join(', ')}`);
   const device=matching[0];
   if(/cable|virtual|stereo mix|monitor|fake/i.test(device.label))throw Error('Selected device identifies a virtual/test/loopback source');
   const capture=new MicrophoneCapture();
   capture.configure({deviceId:device.deviceId,echoCancellation:true,noiseSuppression:true,autoGainControl:true});
   let audio;
   try {
    const track=await capture.acquire();if(!track||!capture.owns(track)||!capture.isLive())throw Error('Native capture did not return a live owned track');
    if(track.getSettings().deviceId!==device.deviceId)throw Error('Browser returned a different input device');
    audio=new AudioContext();await audio.resume();
    const analyser=audio.createAnalyser();analyser.fftSize=2048;
    const source=audio.createMediaStreamSource(new MediaStream([track]));source.connect(analyser);
    const samples=new Float32Array(analyser.fftSize);let peak=0,squares=0,frames=0;
    for(let i=0;i<30;i++){
     await new Promise(resolve=>setTimeout(resolve,100));
     if(!capture.isLive())throw Error('Physical microphone stopped during observation');
     analyser.getFloatTimeDomainData(samples);
     for(const value of samples){if(!Number.isFinite(value))throw Error('Invalid native capture samples');peak=Math.max(peak,Math.abs(value));squares+=value*value;frames++}
    }
    const settings=track.getSettings();capture.setAllowed(false);
    const stopped=track.readyState==='ended'&&!capture.isLive();
    capture.setAllowed(true);
    const regrant_stays_idle=!capture.isLive();
    return {label:device.label,sample_rate:settings.sampleRate,channels:settings.channelCount,echo_cancellation:settings.echoCancellation,noise_suppression:settings.noiseSuppression,auto_gain_control:settings.autoGainControl,sampled_frames:frames,peak,rms:Math.sqrt(squares/frames),stopped_after_revocation:stopped,regrant_stays_idle};
   } finally {capture.dispose();if(audio)await audio.close()}
  },pattern);
  assert.ok(result.capture.stopped_after_revocation&&result.capture.regrant_stays_idle,'Capture ownership was not released');
  result.capture_api_passed=true;
  // A live track producing only silence cannot prove audible microphone input.
  assert.ok(result.capture.peak>0.0001&&result.capture.rms>0.00001,'Physical device opened but no usable signal was observed');
  result.passed=true;
 } catch(error){result.error=error.message}
 finally {
  if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  result.finished_at=new Date().toISOString();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
 }
 console.log(JSON.stringify({...result,output}));process.exitCode=result.passed?0:1;
})().catch(error=>{console.error(error.message);process.exitCode=1});

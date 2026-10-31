// Real browser audio APIs and production players; silent generated audio only.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {createRequire}=require('node:module');
const {engine,launchBrowser,evidenceDirectory}=require('./lib/test-browser.cjs');
const root=path.resolve(__dirname,'..'),gateway=path.join(root,'third_party/moonlight-web-stream');
const gatewayRequire=createRequire(path.join(gateway,'package.json'));
const output=evidenceDirectory(path.join(root,'artifacts/audio-playback'));
async function main(){
  fs.mkdirSync(output,{recursive:true});
  const entry=path.join(output,'probe.ts');
  const source=name=>JSON.stringify(path.join(gateway,'web/stream/audio',name).replaceAll('\\','/'));
  fs.writeFileSync(entry,`
import {AudioElementPlayer} from ${source('audio_element')};
import {ContextDestinationNodeAudioPlayer} from ${source('audio_context_destination')};
import {AudioBufferPipe} from ${source('audio_buffer_pipe')};
import {AudioMediaStreamTrackGeneratorPipe} from ${source('media_stream_track_generator_pipe')};
import {AudioDecoderPipe} from ${source('audio_decoder_pipe')};
import {MicrophoneCapture} from ${source('microphone_capture')};
import {MicrophonePipe} from ${source('microphone_pipe')};
import {RtpTrackSenderPipe} from ${source('rtp_track_sender_pipe')};
const contextPlayer=new ContextDestinationNodeAudioPlayer();
const pcm=new AudioBufferPipe(contextPlayer);
pcm.setup({sampleRate:48000,channels:2,streams:1,coupledStreams:1,samplesPerFrame:960,mapping:[]});
const context=contextPlayer.getAudioContext();
const oscillator=context.createOscillator(),gain=context.createGain();
gain.gain.value=0; oscillator.connect(gain);
const destination=context.createMediaStreamDestination();gain.connect(destination);oscillator.start();
const player=new AudioElementPlayer();player.setTrack(destination.stream.getAudioTracks()[0]);player.mount(document.body);
const button=document.createElement('button');button.textContent='Enable audio';document.body.appendChild(button);
button.onclick=()=>{pcm.onUserInteraction();player.onUserInteraction()};
context.suspend().then(()=>{document.body.dataset.ready='true'});
(window as any).probe={context,pcm,async microphone(){
  const left=new RTCPeerConnection({iceServers:[]}),right=new RTCPeerConnection({iceServers:[]});
  const errors:string[]=[],tracks:MediaStreamTrack[]=[];
  let requests=0;
  const wait=async(check:()=>boolean|Promise<boolean>)=>{
    const deadline=performance.now()+10000;
    while(!await check()){if(performance.now()>deadline)throw new Error('Microphone RTP acceptance timed out');await new Promise(resolve=>setTimeout(resolve,20))}
  };
  // Generated source replaces only getUserMedia, keeping real tracks, peers,
  // RTP sender operations and the production capture/sender pipes.
  const capture=new MicrophoneCapture(async()=>{requests++;const track=destination.stream.getAudioTracks()[0].clone();tracks.push(track);return new MediaStream([track])});
  const sink=new RtpTrackSenderPipe({debug(message:string){errors.push(message)}} as any);
  const pipe=new MicrophonePipe(sink);(pipe as any).capture=capture;
  const sender=left.addTransceiver('audio',{direction:'sendonly'}).sender;sink.setRtpSender(sender);
  // Exchange candidates after descriptions are ready; no external STUN/TURN.
  const leftCandidates:RTCIceCandidateInit[]=[],rightCandidates:RTCIceCandidateInit[]=[];
  left.onicecandidate=e=>{if(e.candidate)leftCandidates.push(e.candidate.toJSON())};
  right.onicecandidate=e=>{if(e.candidate)rightCandidates.push(e.candidate.toJSON())};
  try {
    await Promise.all([pipe.resumeCapture(),pipe.resumeCapture(),pipe.resumeCapture()]);
    await wait(()=>sender.track===tracks[0]);
    await left.setLocalDescription(await left.createOffer());
    await wait(()=>left.iceGatheringState==='complete');
    await right.setRemoteDescription(left.localDescription!);
    await right.setLocalDescription(await right.createAnswer());
    await wait(()=>right.iceGatheringState==='complete');
    await left.setRemoteDescription(right.localDescription!);
    for(const candidate of leftCandidates)await right.addIceCandidate(candidate);
    for(const candidate of rightCandidates)await left.addIceCandidate(candidate);
    let packets=0;
    await wait(async()=>{for(const stat of (await right.getStats()).values())if(stat.type==='inbound-rtp'&&stat.kind==='audio')packets=stat.packetsReceived;return packets>2});
    const firstStopped=()=>tracks[0].readyState==='ended';
    pipe.setAllowed(false);
    const revoked=firstStopped();
    await wait(()=>sender.track===null);
    const revokedDetached=sender.track===null;
    pipe.setAllowed(true);
    const grantDidNotCapture=requests===1&&sender.track===null;
    await pipe.resumeCapture();await wait(()=>sender.track===tracks[1]);
    let resumedPackets=packets;
    await wait(async()=>{for(const stat of (await right.getStats()).values())if(stat.type==='inbound-rtp'&&stat.kind==='audio')resumedPackets=stat.packetsReceived;return resumedPackets>packets+2});
    pipe.cleanup();pipe.cleanup();await wait(()=>sender.track===null);
    return {requests,packets,resumedPackets,revoked,revokedDetached,grantDidNotCapture,allStopped:tracks.every(track=>track.readyState==='ended'),detached:sender.track===null,sourceLive:destination.stream.getAudioTracks()[0].readyState==='live',errors};
  } finally {pipe.cleanup();left.close();right.close();tracks.forEach(track=>track.stop())}
},async codec(){
  if(typeof AudioEncoder!=='function'||typeof AudioDecoder!=='function')return {supported:false};
  let decodedFrames=0,cleanups=0;const errors:string[]=[];
  const decoder=new AudioDecoderPipe({implementationName:'acceptance',submitSample(sample:AudioData){decodedFrames+=sample.numberOfFrames;sample.close()},getBase(){return null},cleanup(){cleanups++}} as any,{debug(message:string){errors.push(message)}} as any);
  decoder.setup({sampleRate:48000,channels:2,streams:1,coupledStreams:1,samplesPerFrame:960,mapping:[]});
  const encoder=new AudioEncoder({error:error=>errors.push(String(error)),output:chunk=>{
    const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
    decoder.decodeAndPlay({data,timestampMicroseconds:chunk.timestamp,durationMicroseconds:chunk.duration??20000});
  }});
  try {
    encoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:2,bitrate:64000});
    const input=new AudioData({format:'f32-planar',sampleRate:48000,numberOfFrames:960,numberOfChannels:2,timestamp:0,data:new Float32Array(1920)});
    encoder.encode(input);input.close();await encoder.flush();await (decoder as any).decoder.flush();
  } finally {encoder.close();decoder.cleanup()}
  return {supported:true,decodedFrames,cleanups,errors};
},async generated(){
  if(typeof MediaStreamTrackGenerator!=='function'||typeof AudioData!=='function')return {supported:false};
  const element=new AudioElementPlayer(),generator=new AudioMediaStreamTrackGeneratorPipe(element);
  const sample=new AudioData({format:'f32-planar',sampleRate:48000,numberOfFrames:960,numberOfChannels:2,timestamp:0,data:new Float32Array(1920)});
  generator.submitSample(sample);
  await new Promise(resolve=>setTimeout(resolve,100));
  const track=(element as any).oldTrack;
  const written=!(generator as any).output.pending,wasLive=track.readyState==='live';
  generator.cleanup();
  return {supported:true,written,wasLive,stopped:track.readyState==='ended',sampleClosed:sample.numberOfFrames===0};
},feed(){for(let i=0;i<1000;i++)pcm.playPcm({timestampMicroseconds:i*20000,durationMicroseconds:20000,channelData:[new Float32Array(960),new Float32Array(960)]})},cleanup(){player.cleanup();pcm.cleanup();oscillator.stop();destination.stream.getTracks().forEach(track=>track.stop())}};
`);
  const compiler=gatewayRequire('webpack')({mode:'production',context:gateway,entry,output:{path:output,filename:'probe.js'},resolve:{extensions:['.ts','.js']},module:{rules:[{test:/\.(svg|png)$/i,type:'asset/inline'},{test:/\.ts$/,loader:gatewayRequire.resolve('ts-loader'),options:{configFile:path.join(gateway,'tsconfig.json'),onlyCompileBundledFiles:true}}]}});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(closeError=>error||closeError||stats?.hasErrors()?reject(error||closeError||new Error(stats.toString({all:false,errors:true}))):resolve())));
  const server=http.createServer((req,res)=>{
    if(req.url==='/probe.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(output,'probe.js')))}
    else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><script src="/probe.js"></script></body></html>')}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser,page;
  const errors=[];
  try{
    browser=await launchBrowser();page=await browser.newPage();
    assert.equal(await page.evaluate(()=>typeof AudioContext),'function',`${engine} runtime does not expose AudioContext; playback acceptance cannot run`);
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>document.body.dataset.ready==='true');
    assert.equal(await page.evaluate(()=>window.probe.context.state),'suspended');
    await page.getByRole('button',{name:'Enable audio',exact:true}).click();
    await page.waitForFunction(()=>window.probe.context.state==='running'&&!document.querySelector('audio').paused&&!document.querySelector('audio').muted);
    assert.ok(await page.evaluate(()=>{window.probe.feed();return window.probe.pcm.sources.size<=7}),'PCM queue bounded after a burst');
    await page.evaluate(()=>window.probe.context.suspend());
    assert.equal(await page.evaluate(()=>{window.probe.feed();return window.probe.pcm.sources.size}),0,'Suspended context discards queued audio');
    await page.getByRole('button',{name:'Enable audio',exact:true}).click();
    await page.waitForFunction(()=>window.probe.context.state==='running');
    const microphone=await page.evaluate(()=>window.probe.microphone());
    assert.equal(microphone.requests,2);assert.ok(microphone.packets>2);
    assert.ok(microphone.resumedPackets>microphone.packets+2);
    for(const key of ['revoked','revokedDetached','grantDidNotCapture','allStopped','detached','sourceLive'])assert.equal(microphone[key],true,key);
    assert.deepEqual(microphone.errors,[]);
    const generatedTrack=await page.evaluate(()=>window.probe.generated());
    if(engine==='chromium')assert.equal(generatedTrack.supported,true,'Chromium must exercise the generated audio path');
    if(generatedTrack.supported)assert.deepEqual(generatedTrack,{supported:true,written:true,wasLive:true,stopped:true,sampleClosed:true});
    const codec=await page.evaluate(()=>window.probe.codec());
    if(engine==='chromium')assert.equal(codec.supported,true,'Chromium must exercise real WebCodecs Opus');
    if(codec.supported){assert.ok(codec.decodedFrames>=960);assert.equal(codec.cleanups,1);assert.deepEqual(codec.errors,[])}
    await page.evaluate(()=>window.probe.cleanup());
    await page.waitForFunction(()=>window.probe.context.state==='closed'&&document.querySelector('audio').srcObject===null&&document.querySelector('audio').paused);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,engine,browser:browser.version(),generatedTrack,codec,microphone,scope:'Production players resume a suspended AudioContext and play a generated silent track on a real click; PCM bursts remain bounded, suspension clears queued audio, and cleanup releases playback. Generated AudioData and real WebCodecs Opus round-trip are checked where supported. Microphone capture/sender pipes send generated audio through local real WebRTC peers, revoke tracks, reacquire and detach on cleanup. No getUserMedia permission, upstream gateway, physical microphone or target recording acceptance.',errors},null,2));
    console.log(`${engine}: audio playback and microphone RTP lifecycle passed`);
  }catch(error){
    const state=await page?.evaluate(()=>({ready:document.body.dataset.ready,context:window.probe?.context.state,audioContext:typeof AudioContext,track:typeof MediaStreamTrack,media:document.querySelector('audio')?{paused:document.querySelector('audio').paused,muted:document.querySelector('audio').muted,error:document.querySelector('audio').error?.message}:null})).catch(()=>null);
    fs.writeFileSync(path.join(output,'diagnostics.json'),JSON.stringify({errors,state},null,2));
    throw error;
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,engine,error:error.message},null,2));console.error(error);process.exitCode=1});

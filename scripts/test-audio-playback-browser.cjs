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
(window as any).probe={context,pcm,async generated(){
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
  const compiler=gatewayRequire('webpack')({mode:'production',context:gateway,entry,output:{path:output,filename:'probe.js'},resolve:{extensions:['.ts','.js']},module:{rules:[{test:/\.ts$/,loader:gatewayRequire.resolve('ts-loader'),options:{configFile:path.join(gateway,'tsconfig.json'),onlyCompileBundledFiles:true}}]}});
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
    const generatedTrack=await page.evaluate(()=>window.probe.generated());
    if(engine==='chromium')assert.equal(generatedTrack.supported,true,'Chromium must exercise the generated audio path');
    if(generatedTrack.supported)assert.deepEqual(generatedTrack,{supported:true,written:true,wasLive:true,stopped:true,sampleClosed:true});
    await page.evaluate(()=>window.probe.cleanup());
    await page.waitForFunction(()=>window.probe.context.state==='closed'&&document.querySelector('audio').srcObject===null&&document.querySelector('audio').paused);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,engine,browser:browser.version(),generatedTrack,scope:'Production players resume a suspended AudioContext and play a generated silent track on a real click; PCM bursts remain bounded, suspension clears queued audio, and cleanup releases playback. Generated AudioData writes and track release are checked where supported. No upstream media or physical audio quality acceptance.',errors},null,2));
    console.log(`${engine}: audio playback gesture and cleanup passed`);
  }catch(error){
    const state=await page?.evaluate(()=>({ready:document.body.dataset.ready,context:window.probe?.context.state,audioContext:typeof AudioContext,track:typeof MediaStreamTrack,media:document.querySelector('audio')?{paused:document.querySelector('audio').paused,muted:document.querySelector('audio').muted,error:document.querySelector('audio').error?.message}:null})).catch(()=>null);
    fs.writeFileSync(path.join(output,'diagnostics.json'),JSON.stringify({errors,state},null,2));
    throw error;
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,engine,error:error.message},null,2));console.error(error);process.exitCode=1});

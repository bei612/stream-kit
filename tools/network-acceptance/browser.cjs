// Runs as the ordinary CI user inside the separate LAN client namespace.
// Only observer counters are injected; transport, DNS, TLS and reconnect are
// the installed product's real implementations. No certificate/DNS overrides.
const assert=require('node:assert/strict');
const readline=require('node:readline');
const {launchBrowser}=require('../../scripts/lib/test-browser.cjs');
const {waitForPageCondition}=require('../../scripts/lib/browser-condition.cjs');
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);
let browser,page,initialPeerCount;
function viewer(){
  return page?.frames().find(frame=>{
    try{const url=new URL(frame.url());return url.origin==='https://stream-kit-server.local:18080'&&url.pathname==='/stream.html';}catch{return false;}
  });
}
async function snapshot(){
  const frame=viewer();if(!frame)return {peer_count:0,viewer_frame:false};
  return frame.evaluate(async()=>{
    const peers=window.__networkPeers||[],peer=peers.at(-1),video=document.querySelector('video');
    if(!peer)return {peer_count:0};
    const stats=await peer.getStats(),items=[...stats.values()];
    const transport=items.find(s=>s.type==='transport'&&s.selectedCandidatePairId);
    const pair=transport?stats.get(transport.selectedCandidatePairId):items.find(s=>s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded');
    const remote=pair?stats.get(pair.remoteCandidateId):null;
    return {peer_count:peers.length,state:peer.connectionState,
      frames:items.find(s=>s.type==='inbound-rtp'&&s.kind==='video')?.framesDecoded||0,
      audio_packets:items.find(s=>s.type==='inbound-rtp'&&s.kind==='audio')?.packetsReceived||0,
      presented_frames:window.__networkFrames||0,
      width:video?.videoWidth||0,remote_address:remote?.address,remote_port:remote?.port};
  });
}
async function waitMedia(address,minPeers){
  const end=Date.now()+120000;
  while(Date.now()<end){
    // The permanent entry owns a cross-origin viewer iframe. Observe that
    // renderer's real peers, not the top-level management document.
    const state=await snapshot().catch(()=>({}));
    if(state.state==='connected'&&state.peer_count>=minPeers&&state.frames>=30&&state.remote_address===address&&state.width>0){
      await waitForPageCondition(viewer(),frames=>window.__networkFrames>frames+10,state.presented_frames,{timeout:15000});
      return snapshot();
    }
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw Error('Media did not reach the expected LAN address');
}
async function command(message){
  if(message.action==='start'){
    const url=new URL(message.url);
    assert.equal(url.origin,'https://stream-kit-server.local:19000');assert.equal(url.pathname,'/watch');
    browser=await launchBrowser({args:['--autoplay-policy=no-user-gesture-required']});
    const context=await browser.newContext();
    await context.addInitScript(()=>{
      localStorage.setItem('mlSettings',JSON.stringify({videoSize:'720p',fps:30,bitrate:8000,videoCodec:'h264',dataTransport:'webrtc',forceVideoElementRenderer:true,canvasRenderer:false,playAudioLocal:false,microphone:false,enterFullscreenOnStreamStart:false,language:'en'}));
      window.__networkPeers=[];window.__networkFrames=0;
      const Original=window.RTCPeerConnection;
      window.RTCPeerConnection=class extends Original{constructor(...args){super(...args);window.__networkPeers.push(this);}};
      const videos=new WeakSet();
      const observe=()=>{for(const video of document.querySelectorAll('video')){
        if(videos.has(video))continue;videos.add(video);
        const next=()=>{window.__networkFrames++;video.requestVideoFrameCallback(next);};
        video.requestVideoFrameCallback(next);
      }};
      new MutationObserver(observe).observe(document,{childList:true,subtree:true});observe();
    });
    page=await context.newPage();await page.goto(url.href,{timeout:30000});
    const result=await waitMedia('198.18.31.1',1);initialPeerCount=result.peer_count;return result;
  }
  if(message.action==='recover')return waitMedia('198.18.31.2',initialPeerCount+1);
  if(message.action==='close'){await browser?.close();browser=null;return {closed:true};}
  throw Error('Unknown client operation');
}
(async()=>{
  for await(const line of readline.createInterface({input:process.stdin})){
    const message=JSON.parse(line);
    try{process.stdout.write(JSON.stringify({id:message.id,result:await command(message)})+'\n');}
    catch(error){
      // Playwright exceptions may contain the capability URL. Retain only
      // public media counters, never raw errors, URL, cookies or page text.
      const state=page?await snapshot().catch(()=>null):null;
      const reason=String(error.message).match(/net::ERR_[A-Z_]+/)?.[0]||(error.name==='TimeoutError'?'TimeoutError':'Media readiness failed');
      process.stdout.write(JSON.stringify({id:message.id,error:'Browser '+message.action+' failed: '+reason,state})+'\n');
    }
  }
})().finally(async()=>{await browser?.close();});

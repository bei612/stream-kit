// Native browser track lifecycle acceptance. Synthetic canvas source; no mock
// media APIs, production probes, Sunshine, or physical-device claims.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),web=path.join(root,'third_party/moonlight-web-stream/web');
const ts=require('../orchestrator/web/node_modules/typescript');
const {chromium}=createRequire(path.join(web,'../package.json'))('playwright');
const modules={},hashes={};
function load(file){
  const id=path.relative(web,file).replaceAll('\\','/');if(modules[id])return id;
  const source=fs.readFileSync(file,'utf8');hashes[id]=crypto.createHash('sha256').update(source).digest('hex');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const dependencies={};modules[id]={code,dependencies};
  for(const m of code.matchAll(/require\("([^"]+)"\)/g)){
    if(!m[1].startsWith('.'))throw Error('Unexpected external dependency');
    const base=path.resolve(path.dirname(file),m[1]);
    const target=[base,base+'.ts',base.replace(/\.js$/,'.ts'),path.join(base,'index.ts')].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
    if(!target||!target.startsWith(web+path.sep))throw Error('Unresolved dependency');dependencies[m[1]]=load(target);
  }return id;
}
const entry=load(path.join(web,'stream/video/media_stream_track_processor_pipe.ts'));
const draw=load(path.join(web,'stream/video/canvas_frame.ts')),canvas=load(path.join(web,'stream/video/canvas.ts'));
const output=path.join(root,'artifacts/browser-track-processor',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const result={passed:false,scope:'Native canvas capture and track replacement/cleanup using repository renderer; not installed media acceptance',source_sha256:hashes};
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Track ownership acceptance</title>');});let browser;
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,channel:'chrome'});result.browser=browser.version();
  const page=await browser.newPage();const errors=[],consoleErrors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});await page.goto(`http://127.0.0.1:${server.address().port}`);
  result.native=await page.evaluate(async({modules,entry,draw,canvas})=>{
    const cache={};function requireModule(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};new Function('exports','require',modules[id].code)(m.exports,n=>requireModule(modules[id].dependencies[n]));return m.exports;}
    const {VideoMediaStreamTrackProcessorPipe}=requireModule(entry),{CanvasFrameDrawPipe}=requireModule(draw),{BaseCanvasVideoRenderer}=requireModule(canvas);
    const wait=async predicate=>{const until=performance.now()+5000;while(!predicate()){if(performance.now()>until)throw Error('Native reader/frame did not settle');await new Promise(r=>setTimeout(r,10));}};
    const makeSource=color=>{const c=document.createElement('canvas');c.width=64;c.height=64;const ctx=c.getContext('2d');const stream=c.captureStream(30);return {stream,track:stream.getVideoTracks()[0],paint(){ctx.fillStyle=color;ctx.fillRect(0,0,64,64);stream.getVideoTracks()[0].requestFrame();}};};
    let replaced=0,released=0;
    for(let i=0;i<100;i++){
      const target=new OffscreenCanvas(64,64),context=target.getContext('2d'),renderer=new BaseCanvasVideoRenderer('native-track-acceptance');renderer.setCanvas(target);
      const pipe=new VideoMediaStreamTrackProcessorPipe(new CanvasFrameDrawPipe(renderer));const red=makeSource('#ff0000'),blue=makeSource('#0000ff');
      try{
        await pipe.setup({codec:'h264',width:64,height:64,fps:30});pipe.setTrack(red.track);
        await wait(()=>{red.paint();return context.getImageData(32,32,1,1).data[0]>200;});const old=pipe.trackProcessor;
        pipe.setTrack(blue.track);await wait(()=>{blue.paint();return context.getImageData(32,32,1,1).data[2]>200;});
        await wait(()=>!old.readable.locked);replaced++;
        const active=pipe.trackProcessor;pipe.cleanup();pipe.cleanup();await wait(()=>!active.readable.locked);released++;
        if(red.track.readyState!=='live'||blue.track.readyState!=='live')throw Error('Renderer stopped transport-owned source');
      }finally{pipe.cleanup();for(const source of [red,blue])source.stream.getTracks().forEach(t=>t.stop());}
    }
    const edgeCases=[];
    for(const scenario of ['no-frame','setup-close','concurrent-setup','source-ended','render-error']){
      const target=new OffscreenCanvas(64,64),renderer=new BaseCanvasVideoRenderer('native-track-edge');
      if(scenario==='render-error')structuredClone(target,{transfer:[target]}); // Native detached canvas throws on getContext.
      renderer.setCanvas(target);
      const base=new CanvasFrameDrawPipe(renderer),pipe=new VideoMediaStreamTrackProcessorPipe(base),source=makeSource('#00ff00');
      try{
        pipe.setTrack(source.track);
        const setup=pipe.setup({codec:'h264',width:64,height:64,fps:30});
        if(scenario==='setup-close'){
          pipe.cleanup();await setup;
          if(pipe.reader||pipe.trackProcessor||pipe.running)throw Error('Setup resurrected a closed pipe');
        }else{
          if(scenario==='concurrent-setup'&&pipe.setup({codec:'h264',width:64,height:64,fps:30})!==setup)throw Error('Setup was not shared');
          // The detached canvas must fail during actual rendering, not setup.
          if(scenario==='render-error')renderer.setCanvas(new OffscreenCanvas(64,64));
          await setup;
          if(scenario==='render-error')renderer.setCanvas(target);
          const processor=pipe.trackProcessor;
          if(scenario==='source-ended')source.track.stop();
          else if(scenario==='render-error')source.paint();
          else pipe.cleanup();
          await wait(()=>!processor.readable.locked);
          if(pipe.reader||pipe.trackProcessor)throw Error('Reader still retained after '+scenario);
          if(scenario==='render-error'&&base.currentFrame?.codedWidth!==0)throw Error('Failed render retained an open native frame');
        }
        pipe.cleanup();pipe.cleanup();
        if(scenario!=='source-ended'&&source.track.readyState!=='live')throw Error('Renderer stopped source in '+scenario);
        edgeCases.push(scenario);
      }finally{pipe.cleanup();source.stream.getTracks().forEach(t=>t.stop());}
    }
    return {cycles:100,replacedReadersReleased:replaced,cleanupReadersReleased:released,edgeCases};
  },{modules,entry,draw,canvas});
  result.pageerrors=errors;result.consoleerrors=consoleErrors;
  if(errors.length)throw Error('Unhandled browser lifecycle errors');
  if(consoleErrors.length!==1||!consoleErrors[0].startsWith('Video track processing failed'))throw Error('Unexpected native renderer errors');
  result.passed=true;
})().catch(e=>{result.error=e.message;process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,error:result.error,output,native:result.native}));});

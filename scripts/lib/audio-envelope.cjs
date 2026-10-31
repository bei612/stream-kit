const assert=require('node:assert/strict');

function compareEnvelopes(reference,received){
 for(const value of [reference,received]){
  assert.equal(value.sample_rate,48000);assert.equal(value.window_frames,480);assert.equal(value.notch_hz,997);
  assert.ok(Array.isArray(value.rms)&&value.rms.length>=200&&value.rms.length<=1000,'Expected 2-10 seconds of bounded envelope data');
  assert.ok(value.rms.every(v=>Number.isFinite(v)&&v>=0),'Invalid envelope value');
 }
 const mean=reference.rms.reduce((a,b)=>a+b,0)/reference.rms.length;
 const variance=reference.rms.reduce((a,b)=>a+(b-mean)**2,0)/reference.rms.length;
 let best=0,lag=0,overlap=0;
 // Ignore filter startup transients. Search at most one second of transport
 // delay; compare normalized log-energy to tolerate codec/gain differences.
 for(let offset=-100;offset<=100;offset++){
  const start=Math.max(20,-offset),end=Math.min(reference.rms.length,received.rms.length-offset),count=end-start;
  if(count<200)continue;
  let x=0,y=0,xx=0,yy=0,xy=0,n=0;
  for(let i=start;i<end;i++){
   const a=Math.log(Math.max(1e-9,reference.rms[i])),b=Math.log(Math.max(1e-9,received.rms[i+offset]));
   n++;const dx=a-x,dy=b-y;x+=dx/n;y+=dy/n;
   xx+=dx*(a-x);yy+=dy*(b-y);xy+=dx*(b-y);
  }
  const denominator=Math.sqrt(Math.max(0,xx)*Math.max(0,yy));
  const score=denominator>1e-12?Math.max(-1,Math.min(1,xy/denominator)):0;
  if(score>best){best=score;lag=offset;overlap=count}
 }
 return {correlation:best,lag_ms:lag*10,overlap_windows:overlap,reference_rms:Math.sqrt(reference.rms.reduce((a,b)=>a+b*b,0)/reference.rms.length),reference_variation:mean>0?Math.sqrt(variance)/mean:0};
}

async function captureEnvelope(page,direction='received',milliseconds=4000){
 assert.ok(['received','sent'].includes(direction));assert.ok(milliseconds>=2500&&milliseconds<=8000);
 return page.evaluate(async({direction,blocks})=>{
  const peer=window.__acceptancePeers.at(-1);
  const track=direction==='sent'?peer?.getSenders().find(s=>s.track?.kind==='audio')?.track:peer?.getReceivers().find(r=>r.track.kind==='audio')?.track;
  if(!track||track.readyState!=='live')throw Error('No live audio track for envelope capture');
  const context=new AudioContext({sampleRate:48000});let url;
  try{
   await context.resume();if(context.state!=='running')throw Error('Envelope AudioContext is not running');
   const worklet=`class Envelope extends AudioWorkletProcessor {
    constructor(options){super();this.max=options.processorOptions.blocks;this.values=[];this.frames=0;this.sum=0;this.x1=0;this.x2=0;this.y1=0;this.y2=0;const w=2*Math.PI*997/48000,a=Math.sin(w)/50;this.b0=1/(1+a);this.b1=-2*Math.cos(w)/(1+a);this.a2=(1-a)/(1+a)}
    process(inputs){const channels=inputs[0];if(!channels?.length)return true;for(let i=0;i<channels[0].length;i++){let x=0;for(const channel of channels)x+=channel[i];x/=channels.length;const y=this.b0*x+this.b1*this.x1+this.b0*this.x2-this.b1*this.y1-this.a2*this.y2;this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;this.sum+=y*y;if(++this.frames===480){this.values.push(Math.sqrt(this.sum/480));this.sum=0;this.frames=0;if(this.values.length===this.max){this.port.postMessage(this.values);return false}}}return true}
   };registerProcessor('stream-kit-envelope',Envelope);`;
   url=URL.createObjectURL(new Blob([worklet],{type:'text/javascript'}));await context.audioWorklet.addModule(url);
   const source=context.createMediaStreamSource(new MediaStream([track]));
   const meter=new AudioWorkletNode(context,'stream-kit-envelope',{processorOptions:{blocks}}),mute=context.createGain();mute.gain.value=0;
   const rms=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Audio envelope capture timed out')),blocks*10+4000);
    meter.port.onmessage=e=>{clearTimeout(timeout);resolve(e.data)};
    meter.onprocessorerror=()=>{clearTimeout(timeout);reject(Error('Audio envelope processor failed'))};
    source.connect(meter);meter.connect(mute);mute.connect(context.destination);
   });
   return {sample_rate:48000,window_frames:480,notch_hz:997,rms,label:track.label};
  }finally{await context.close();if(url)URL.revokeObjectURL(url)}
 },{direction,blocks:Math.floor(milliseconds/10)});
}
module.exports={compareEnvelopes,captureEnvelope};

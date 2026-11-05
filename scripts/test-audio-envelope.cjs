const {test}=require('node:test'),assert=require('node:assert/strict');
const {compareEnvelopes,assessMicrophoneSignal}=require('./lib/audio-envelope.cjs');
const packet=rms=>({sample_rate:48000,window_frames:480,notch_hz:997,rms});
const reference=Array.from({length:400},(_,i)=>0.001+0.009*(Math.sin(i*0.21)**2)*(0.2+0.8*Math.sin(i*0.053)**2));
test('physical envelope matching tolerates transport delay and gain without speech samples',()=>{
 const target=[...Array(23).fill(0),...reference.map(v=>v*0.4)];
 const result=compareEnvelopes(packet(reference),packet(target));
 assert.ok(result.correlation>0.999);assert.equal(result.lag_ms,230);assert.ok(result.reference_variation>0.15);
 const receivedRms=Math.sqrt(target.reduce((sum,value)=>sum+value*value,0)/target.length);
 assert.ok(Math.abs(result.received_rms-receivedRms)<1e-12);
});

test('microphone verdict requires measurable delivery and absolute plus relative rejection',()=>{
 const signal={reference_rms:0.1,received_rms:0.08,correlation:0.99};
 assert.equal(assessMicrophoneSignal(signal,true).passed,true);
 assert.equal(assessMicrophoneSignal(signal,false).passed,false);
 const correlatedNoise={...signal,received_rms:0.00001};
 assert.equal(assessMicrophoneSignal(correlatedNoise,true).passed,false);
 assert.equal(assessMicrophoneSignal(correlatedNoise,false).passed,true);
 // Weak correlation alone must not excuse an audible rejected track.
 assert.equal(assessMicrophoneSignal({...signal,correlation:0.01},false).passed,false);
 assert.equal(assessMicrophoneSignal({...signal,received_rms:0.0001},false).passed,false);
 // An absolute low level alone is insufficient if the reference is also weak.
 assert.equal(assessMicrophoneSignal({...correlatedNoise,reference_rms:0.001},false).passed,false);
 assert.equal(assessMicrophoneSignal({...signal,received_rms:0},false).passed,true);
 assert.throws(()=>assessMicrophoneSignal({...signal,received_rms:NaN},false),/finite/);
});
test('silence, unrelated signals, invalid data and wrong analysis formats cannot establish delivery',()=>{
 let seed=17;const noise=reference.map(()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return 0.001+seed/2**32*0.01});
 assert.ok(compareEnvelopes(packet(reference),packet(noise)).correlation<0.3);
 const silence=compareEnvelopes(packet(reference),packet(reference.map(()=>0)));
 assert.equal(silence.correlation,0);assert.equal(silence.received_rms,0);
 assert.throws(()=>compareEnvelopes(packet([NaN,...reference]),packet(reference)),/Invalid envelope/);
 assert.throws(()=>compareEnvelopes({...packet(reference),window_frames:960},packet(reference)));
 assert.throws(()=>compareEnvelopes(packet([]),packet(reference)),/bounded envelope/);
});

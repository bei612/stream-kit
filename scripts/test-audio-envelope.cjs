const {test}=require('node:test'),assert=require('node:assert/strict');
const {compareEnvelopes}=require('./lib/audio-envelope.cjs');
const packet=rms=>({sample_rate:48000,window_frames:480,notch_hz:997,rms});
const reference=Array.from({length:400},(_,i)=>0.001+0.009*(Math.sin(i*0.21)**2)*(0.2+0.8*Math.sin(i*0.053)**2));
test('physical envelope matching tolerates transport delay and gain without speech samples',()=>{
 const target=[...Array(23).fill(0),...reference.map(v=>v*0.4)];
 const result=compareEnvelopes(packet(reference),packet(target));
 assert.ok(result.correlation>0.999);assert.equal(result.lag_ms,230);assert.ok(result.reference_variation>0.15);
});
test('silence, unrelated signals, invalid data and wrong analysis formats cannot establish delivery',()=>{
 let seed=17;const noise=reference.map(()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return 0.001+seed/2**32*0.01});
 assert.ok(compareEnvelopes(packet(reference),packet(noise)).correlation<0.3);
 assert.equal(compareEnvelopes(packet(reference),packet(reference.map(()=>0))).correlation,0);
 assert.throws(()=>compareEnvelopes(packet([NaN,...reference]),packet(reference)),/Invalid envelope/);
 assert.throws(()=>compareEnvelopes({...packet(reference),window_frames:960},packet(reference)));
 assert.throws(()=>compareEnvelopes(packet([]),packet(reference)),/bounded envelope/);
});

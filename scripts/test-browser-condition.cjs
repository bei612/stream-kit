const {test}=require('node:test');
const assert=require('node:assert/strict');
const {waitForPageCondition}=require('./lib/browser-condition.cjs');

test('async false does not satisfy readiness',async()=>{
  let calls=0;
  await waitForPageCondition({evaluate:async fn=>fn()},async()=>++calls===3,undefined,{timeout:1000,interval:1});
  assert.equal(calls,3);
});
test('truthy objects and persistent false cannot satisfy readiness',async()=>{
  for(const value of [false,{},1])await assert.rejects(
    waitForPageCondition({evaluate:async()=>value},()=>true,undefined,{timeout:30,interval:1}),/Timed out/);
});
test('pending evaluation is bounded by deadline',async()=>{
  await assert.rejects(waitForPageCondition({evaluate:()=>new Promise(()=>{})},()=>true,undefined,{timeout:30}),/Timed out/);
});
test('browser failures remain failures',async()=>{
  await assert.rejects(waitForPageCondition({evaluate:async()=>{throw new Error('peer closed')}},()=>true),/peer closed/);
});

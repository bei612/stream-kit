const {test} = require('node:test');
const assert = require('node:assert/strict');
const {verify} = require('../tools/verify-native-tests.cjs');

function report() {
  return {tests:3,failures:0,disabled:0,errors:0,testsuites:[
    {name:'ConfigHttpTest',testsuite:[
      {name:'CaptureCapabilitiesRequireAuthentication',status:'RUN',result:'COMPLETED'},
      {name:'CaptureCapabilitiesExposeVersionedApplyPolicy',status:'RUN',result:'COMPLETED'},
    ]},
    {name:'ManagedAppsHttpTest',testsuite:[
      {name:'ApplicationModeSaveMatchesAdvertisedCapabilityAndLaunchRules',status:'RUN',result:'COMPLETED'},
    ]},
  ]};
}
test('a successful process and zero failures do not prove required cases ran', () => {
  assert.equal(verify(report(),'management'),3);
  for (const change of [
    r=>{r.tests=0;r.testsuites=[]},
    r=>{r.testsuites[0].testsuite[0].result='SKIPPED'},
    r=>{r.testsuites[0].testsuite[0].status='NOTRUN'},
    r=>{r.testsuites[0].testsuite[0].failures=[{failure:'native assertion'}]},
    r=>{r.testsuites[0].testsuite[0].name='WrongFilter'},
    r=>{r.testsuites[0].testsuite[1]={...r.testsuites[0].testsuite[0]}},
    r=>{r.tests=4},
    r=>{delete r.failures},
  ]) {
    const value=report();change(value);
    assert.throws(()=>verify(value,'management'));
  }
  assert.throws(()=>verify(report(),'capture'));
});

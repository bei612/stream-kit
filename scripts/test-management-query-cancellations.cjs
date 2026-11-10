'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { managementQueryCancellations: classify } = require('./lib/management-query-cancellations.cjs');
const key = 'https://management.invalid/api/v1/logs?page=1&private=canary-not-to-export';
const failure = {request_id:1,owner:0,management_read:true,method:'GET',started_order:1,failed_order:5,request_key:key,reason:'net::ERR_ABORTED',response_status:null};
const replacement = {request_id:2,owner:0,management_read:true,method:'GET',started_order:2,finished_order:6,request_key:key,response_status:200};

test('client cancellation requires a newer identical completed management read, with privacy-safe evidence', () => {
  const result = classify([failure], [replacement], 0);
  assert.deepEqual(result,[{request_id:1,replacement_request_id:2,classification:'superseded_management_read'}]);
  assert.ok(!JSON.stringify(result).includes('canary-not-to-export'));
  assert.equal(classify([{...failure,response_status:200}], [replacement], 0).length,1);
});

test('cancellation proof never accepts mutation, viewer, transport error or failed/incomplete replacement', () => {
  for(const patch of [{method:'POST'},{owner:1},{management_read:false},{reason:'net::ERR_CONNECTION_RESET'},{reason:'net::ERR_TIMED_OUT'},{reason:'net::ERR_CERT_AUTHORITY_INVALID'},{request_id:undefined},{request_key:''},{response_status:500}]) {
    assert.deepEqual(classify([{...failure,...patch}], [replacement], 0),[]);
  }
  for(const patch of [{request_key:key.replace('page=1','page=2')},{owner:1},{management_read:false},{method:'POST'},{request_id:undefined},{response_status:500},{response_status:'200'},{finished_order:null},{finished_order:4},{started_order:0}]) {
    assert.deepEqual(classify([failure], [{...replacement,...patch}], 0),[]);
  }
});

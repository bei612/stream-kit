import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureAnnotations } from './report-go-test-failures.mjs'

test('reports distinct failing tests and package failures without exposing test output',()=>{
  const events=[{Action:'output',Package:'pkg',Output:'private fixture data'},
    {Action:'pass',Package:'pkg',Test:'passing'},
    {Action:'fail',Package:'pkg',Test:'failure'},
    {Action:'fail',Package:'pkg',Test:'failure'},
    {Action:'fail',Package:'pkg'}]
  assert.deepEqual(failureAnnotations('compiler preamble\n'+events.map(JSON.stringify).join('\n')),[
    '::error title=Go test failure::pkg / failure',
    '::error title=Go test failure::pkg (package failed; see structured test artifact)',
  ])
})

test('escapes annotation control characters and ignores invalid events',()=>{
  const rows=[{Action:'fail',Package:'pkg%\n::warning::injected',Test:'test\rname'}, {Action:'fail',Package:null}]
  assert.deepEqual(failureAnnotations(rows.map(JSON.stringify).join('\n')),[
    '::error title=Go test failure::pkg%25%0A::warning::injected / test%0Dname',
  ])
})

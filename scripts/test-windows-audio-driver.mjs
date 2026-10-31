import test from 'node:test'
import assert from 'node:assert/strict'
import {validateAudioDriverFiles} from './lib/windows-audio-driver.mjs'

test('vendor driver inventory rejects replaced files, omissions and injected files',()=>{
  const files=[{path:'driver.inf',bytes:32,sha256:'a'.repeat(64)},{path:'driver.sys',bytes:128,sha256:'b'.repeat(64)}]
  const profile={files:structuredClone(files)}
  assert.doesNotThrow(()=>validateAudioDriverFiles(files,profile))
  assert.throws(()=>validateAudioDriverFiles([{...files[0],sha256:'c'.repeat(64)},files[1]],profile),/integrity mismatch/)
  assert.throws(()=>validateAudioDriverFiles(files.slice(1),profile),/file count/)
  assert.throws(()=>validateAudioDriverFiles([...files,{path:'extra.exe',bytes:1,sha256:'d'.repeat(64)}],profile),/file count/)
  assert.throws(()=>validateAudioDriverFiles([{...files[0],path:'DRIVER.INF'},files[1]],profile),/integrity mismatch/)
})

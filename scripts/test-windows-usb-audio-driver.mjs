import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {validateUSBDriverInventory} from './lib/windows-usb-audio-driver.mjs'

const profile=JSON.parse(fs.readFileSync(new URL('../orchestrator/internal/audiodevice/usbip-driver.json',import.meta.url),'utf8'))

test('USB audio packaging requires the host controller, companion filter and license',()=>{
  assert.doesNotThrow(()=>validateUSBDriverInventory(profile.files))
  assert.throws(()=>validateUSBDriverInventory(profile.files.filter(file=>!file.path.startsWith('usbip2_filter'))),/both signed drivers/)
  assert.throws(()=>validateUSBDriverInventory(profile.files.filter(file=>file.path!=='LICENSE.txt')),/license/)
})
test('USB audio packaging rejects changed, duplicate and development-only files',()=>{
  const changed=structuredClone(profile.files);changed[0].sha256='0'.repeat(64)
  assert.throws(()=>validateUSBDriverInventory(changed),/integrity mismatch/)
  const duplicate=structuredClone(profile.files);duplicate[0]=duplicate[1]
  assert.throws(()=>validateUSBDriverInventory(duplicate),/integrity mismatch/)
  assert.throws(()=>validateUSBDriverInventory([...profile.files,{path:'audio-probe.exe',bytes:1,sha256:'0'.repeat(64)}]),/license only/)
})

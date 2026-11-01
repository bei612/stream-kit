import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {validateUSBDriverInventory,validateUSBAudioIdentity} from './lib/windows-usb-audio-driver.mjs'

const profile=JSON.parse(fs.readFileSync(new URL('../orchestrator/internal/audiodevice/usbip-driver.json',import.meta.url),'utf8'))

test('committed signed runtime payload matches the pinned source and native installer inventory',()=>{
  const directory=new URL('../deploy/windows/usb-audio-driver/',import.meta.url)
  const files=fs.readdirSync(directory).map(name=>{
    const bytes=fs.readFileSync(new URL(name,directory))
    return {path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
  })
  validateUSBDriverInventory(files)
})

test('USB audio release identity is explicit and never supplies a shared test serial',()=>{
  const fixture={vendor_id:65534,product_id:1}
  assert.deepEqual(validateUSBAudioIdentity(fixture),fixture)
  for(const value of [null,[],{},'123',{...fixture,serial:'TestOnly'},{...fixture,vendor_id:0},{...fixture,product_id:65535},{...fixture,vendor_id:'65534'},{...fixture,product_id:1.5}]){
    assert.throws(()=>validateUSBAudioIdentity(value))
  }
})

test('USB audio packaging requires the host controller, companion filter and license',()=>{
  assert.doesNotThrow(()=>validateUSBDriverInventory(profile.files))
  assert.throws(()=>validateUSBDriverInventory(profile.files.filter(file=>!file.path.startsWith('usbip2_filter'))),/both signed drivers/)
  assert.throws(()=>validateUSBDriverInventory(profile.files.filter(file=>file.path!=='LICENSE.txt')),/license/)
})
test('shared Audio class profile requires a bounded owner namespace and no fixed serial',()=>{
  const shared={vendor_id:5824,product_id:10208,serial_prefix:'owner@example.org:'}
  assert.deepEqual(validateUSBAudioIdentity(shared),shared)
  assert.doesNotThrow(()=>validateUSBAudioIdentity({...shared,serial_prefix:'example.org:'}))
  assert.doesNotThrow(()=>validateUSBAudioIdentity(JSON.parse(fs.readFileSync(new URL('../deploy/windows/usb-audio-identity.json',import.meta.url),'utf8'))))
  for(const serial_prefix of [undefined,'','TestOnly','owner@example.org','bad,owner@example.org:','x'.repeat(112)+'.org:','owner@example.org:\n']){
    const value={...shared,serial_prefix};if(serial_prefix===undefined)delete value.serial_prefix
    assert.throws(()=>validateUSBAudioIdentity(value))
  }
})
test('USB audio packaging rejects changed, duplicate and development-only files',()=>{
  const changed=structuredClone(profile.files);changed[0].sha256='0'.repeat(64)
  assert.throws(()=>validateUSBDriverInventory(changed),/integrity mismatch/)
  const duplicate=structuredClone(profile.files);duplicate[0]=duplicate[1]
  assert.throws(()=>validateUSBDriverInventory(duplicate),/integrity mismatch/)
  assert.throws(()=>validateUSBDriverInventory([...profile.files,{path:'audio-probe.exe',bytes:1,sha256:'0'.repeat(64)}]),/license only/)
})

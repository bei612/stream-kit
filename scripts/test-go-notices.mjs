import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {collectGoNotices} from './lib/go-notices.mjs'

function fixture(t) {
  const base=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'stream-kit-go-notices-'))
  t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),base);assert.ok(path.basename(root).startsWith('stream-kit-go-notices-'));fs.rmSync(root,{recursive:true})})
  const vendor=path.join(root,'vendor'),goRoot=path.join(root,'go')
  fs.mkdirSync(vendor);fs.mkdirSync(goRoot);fs.writeFileSync(path.join(goRoot,'LICENSE'),'Go fixture license')
  const add=(module,license='module fixture license')=>{
    const directory=path.join(vendor,module);fs.mkdirSync(directory,{recursive:true})
    if(license!==null)fs.writeFileSync(path.join(directory,'LICENSE'),license)
    return directory
  }
  return {vendor,goRoot,add}
}

test('compiled dependencies retain notices, nested attribution and local replacement',t=>{
  const {vendor,goRoot,add}=fixture(t)
  const source='Copyright fixture\r\nLicense fixture\r\n',directory=add('example.org/a',source)
  add('example.org/unused',null)
  fs.mkdirSync(path.join(directory,'internal'));fs.writeFileSync(path.join(directory,'internal/NOTICE'),'Attribution fixture')
  const report=collectGoNotices(vendor,goRoot,{GoVersion:'go1.25.0',Deps:[{Path:'example.org/a',Version:'v1.0.0',Replace:{Path:'../fork',Version:'(devel)'}}]})
  assert.equal(report.packages.length,1);assert.equal(report.packages[0].notices.length,2)
  assert.equal(report.packages[0].notices[0].text,source)
  assert.equal(report.packages[0].notices[0].sha256,createHash('sha256').update(source).digest('hex'))
  assert.deepEqual(report.packages[0].replacement,{path:'../fork',version:'(devel)'})
  assert.equal(report.runtime_notices[0].text,'Go fixture license')
})

test('missing and empty dependency licenses reject the bundle',t=>{
  const {vendor,goRoot,add}=fixture(t)
  add('example.org/missing',null);add('example.org/empty','')
  for(const name of ['missing','empty'])assert.throws(()=>collectGoNotices(vendor,goRoot,{GoVersion:'go1.25.0',Deps:[{Path:'example.org/'+name,Version:'v1'}]}),/license|Empty notice/)
})

test('module paths cannot escape the vendor root',t=>{
  const {vendor,goRoot}=fixture(t)
  for(const module of ['../outside','/absolute','C:/outside','example.org/../outside','example.org\\outside'])assert.throws(()=>collectGoNotices(vendor,goRoot,{GoVersion:'go1.25.0',Deps:[{Path:module}]}),/Invalid compiled/)
})

test('missing toolchain license and missing build metadata are explicit failures',t=>{
  const {vendor,goRoot}=fixture(t)
  assert.throws(()=>collectGoNotices(vendor,goRoot,{}),/Missing compiled/)
  fs.unlinkSync(path.join(goRoot,'LICENSE'))
  assert.throws(()=>collectGoNotices(vendor,goRoot,{GoVersion:'go1.25.0',Deps:[]}),/toolchain license/)
})

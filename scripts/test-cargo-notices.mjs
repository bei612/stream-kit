import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {cargoMetadataNotices} from './lib/cargo-notices.mjs'

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stream-kit-cargo-notices-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const names=['root','normal','build','dev','missing']
  const packages=names.map(name=>{
    const directory=path.join(root,name);fs.mkdirSync(directory)
    if(name!=='missing')fs.writeFileSync(path.join(directory,'LICENSE'),`license text ${name}`)
    return {id:name,name,version:'1.0.0',license:'MIT',source:null,repository:null,manifest_path:path.join(directory,'Cargo.toml')}
  })
  const edge=(pkg,kind=null)=>({pkg,dep_kinds:[{kind}]})
  const nodes=[{id:'root',deps:[edge('normal'),edge('build','build'),edge('dev','dev'),edge('missing')]},{id:'normal',deps:[edge('root')]},...['build','dev','missing'].map(id=>({id,deps:[]}))]
  return {root,metadata:{packages,resolve:{root:'root',nodes}}}
}

test('collects reachable normal/build licenses, rejects dev-only attribution and handles cycles',t=>{
  const {root,metadata}=fixture(t)
  const result=cargoMetadataNotices(metadata,'test-native-target')
  assert.deepEqual(result.packages.map(pkg=>pkg.name),['build','missing','normal','root'])
  assert.deepEqual(result.missing_notice_packages,[{name:'missing',version:'1.0.0',license:'MIT'}])
  const notice=result.packages.find(pkg=>pkg.name==='normal').notices[0]
  assert.equal(notice.text,'license text normal')
  assert.equal(notice.sha256,createHash('sha256').update(notice.text).digest('hex'))
  assert.ok(!JSON.stringify(result).includes(root),'distributed notices expose machine-specific paths')
})

test('missing graph identity is an error rather than an incomplete successful inventory',t=>{
  const {metadata}=fixture(t)
  metadata.resolve.nodes=metadata.resolve.nodes.filter(node=>node.id!=='normal')
  assert.throws(()=>cargoMetadataNotices(metadata,'target'),/Incomplete Cargo/)
  assert.throws(()=>cargoMetadataNotices({packages:[]},'target'),/resolved root/)
})

test('an explicit license-file is collected and content must not be empty',t=>{
  const {root,metadata}=fixture(t)
  const file=path.join(root,'missing','rights.txt')
  fs.writeFileSync(file,'explicit license text')
  metadata.packages.find(pkg=>pkg.id==='missing').license_file='rights.txt'
  let result=cargoMetadataNotices(metadata,'target')
  assert.equal(result.packages.find(pkg=>pkg.name==='missing').notices[0].text,'explicit license text')
  assert.deepEqual(result.missing_notice_packages,[])
  fs.writeFileSync(file,'')
  assert.throws(()=>cargoMetadataNotices(metadata,'target'),/Empty or oversized/)
  metadata.packages.find(pkg=>pkg.id==='missing').license_file='../root/LICENSE'
  assert.throws(()=>cargoMetadataNotices(metadata,'target'),/outside its package/)
})

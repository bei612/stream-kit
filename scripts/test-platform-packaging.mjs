import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
function fixture(t,platform,wrongAssets=false){
  const base=path.join(repo,'.local/validation/platform-package-tests')
  fs.mkdirSync(base,{recursive:true})
  const root=fs.mkdtempSync(path.join(base,'case-'))
  t.after(()=>{
    const relative=path.relative(fs.realpathSync(base),fs.realpathSync(root))
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))
    fs.rmSync(root,{recursive:true,force:true})
  })
  // Fixture bytes test packaging contracts only; no renderer is executed.
  const names=platform==='linux'?{
    orchestrator:['orchestrator','dist/index.html','dist/THIRD_PARTY_NOTICES.json','THIRD_PARTY_NOTICES.go.json'],
    'media-gateway':['web-server','dist/index.html','LICENSE'],
    sunshine:['bin/sunshine',wrongAssets?'assets/web/index.html':'share/sunshine/web/index.html','LICENSE'],
  }:{
    orchestrator:['orchestrator.exe','dist/index.html','dist/THIRD_PARTY_NOTICES.json','THIRD_PARTY_NOTICES.go.json'],
    'media-gateway':['web-server.exe','dist/index.html','LICENSE','WINDOWS-RUNTIME.json'],
    sunshine:['sunshine.exe','assets/web/index.html','LICENSE'],
  }
  const inputs=[]
  for(const [component,files] of Object.entries(names)){
    const directory=path.join(root,component);inputs.push(directory)
    const inventory=files.map(name=>{
      const file=path.join(directory,...name.split('/')),bytes=Buffer.from('packaging fixture '+name)
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode:0o755})
      return {path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
    })
    fs.writeFileSync(path.join(directory,'bundle-manifest.json'),JSON.stringify({schema_version:1,component,commit:'a'.repeat(40),source_dirty:false,platform,architecture:'amd64',files:inventory}))
  }
  const output=path.join(root,'platform')
  return {output,run:()=>spawnSync(process.execPath,[path.join(repo,'scripts/package-platform-release.mjs'),...inputs,output],{cwd:repo,encoding:'utf8',windowsHide:true})}
}

for(const platform of ['windows','linux'])test(`${platform} assembly preserves its native runtime layout`,t=>{
  const f=fixture(t,platform),result=f.run()
  assert.equal(result.status,0,result.stderr)
  const manifest=JSON.parse(fs.readFileSync(path.join(f.output,'platform-manifest.json'),'utf8'))
  assert.equal(manifest.platform,platform)
  const executable=platform==='linux'?'sunshine/bin/sunshine':'sunshine/sunshine.exe'
  assert.ok(manifest.files.some(file=>file.path===executable))
})

test('self-consistent Linux hashes cannot admit a Windows-style asset layout',t=>{
  const f=fixture(t,'linux',true),result=f.run()
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/Required runtime file missing: sunshine\/share\/sunshine\/web\/index.html/)
  assert.equal(fs.existsSync(f.output),false)
})

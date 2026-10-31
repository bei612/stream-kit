import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

// Cargo's filtered resolve graph establishes dependency identity. Include build
// dependencies conservatively; it does not establish final binary reachability.
export function collectCargoNotices(manifest,{target,env=process.env}={}) {
  const execute=(file,args)=>execFileSync(file,args,{env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024})
  target ??= execute('rustc',['-vV']).match(/^host: (.+)$/m)?.[1].trim()
  if(!target)throw Error('Cannot determine Cargo notice target')
  const metadata=JSON.parse(execute('cargo',['metadata','--locked','--format-version','1','--filter-platform',target,'--manifest-path',manifest]))
  const supplementDirectory=fileURLToPath(new URL('../licenses/cargo/',import.meta.url))
  const supplementFile=path.join(supplementDirectory,'provenance.json')
  const supplements=fs.existsSync(supplementFile)?JSON.parse(fs.readFileSync(supplementFile,'utf8')).packages:[]
  return cargoMetadataNotices(metadata,target,{supplements,supplementDirectory})
}

export function cargoMetadataNotices(metadata,target,{supplements=[],supplementDirectory}={}) {
  if(!metadata.resolve?.root||!Array.isArray(metadata.resolve.nodes)||!Array.isArray(metadata.packages))throw Error('Cargo notice collection requires a resolved root package')
  const nodes=new Map(metadata.resolve.nodes.map(node=>[node.id,node]))
  const packages=new Map(metadata.packages.map(pkg=>[pkg.id,pkg]))
  const reached=new Set(),pending=[metadata.resolve.root]
  while(pending.length){
    const id=pending.pop()
    if(reached.has(id))continue
    reached.add(id)
    const node=nodes.get(id)
    if(!node||!packages.has(id))throw Error('Incomplete Cargo dependency graph')
    for(const dependency of node.deps){
      if(dependency.dep_kinds.some(kind=>kind.kind!=='dev'))pending.push(dependency.pkg)
    }
  }
  const records=[...reached].sort().map(id=>{
    const pkg=packages.get(id),directory=path.dirname(pkg.manifest_path)
    const candidates=fs.readdirSync(directory).filter(name=>/^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name)).map(name=>path.join(directory,name))
    let explicitLicense
    if(pkg.license_file){
      explicitLicense=path.resolve(directory,pkg.license_file)
      const relative=path.relative(directory,explicitLicense)
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error(`Cargo license-file is outside its package: ${pkg.name}`)
      candidates.push(explicitLicense)
    }
    const notices=[...new Set(candidates)].sort().flatMap(file=>{
      const stat=fs.lstatSync(file)
      if(stat.isSymbolicLink())throw Error(`Linked Cargo license file: ${pkg.name}`)
      if(!stat.isFile())return []
      if(stat.size===0||stat.size>2*1024*1024)throw Error(`Empty or oversized Cargo license file: ${pkg.name}`)
      const bytes=fs.readFileSync(file)
      return [{file:path.basename(file),is_license:file===explicitLicense||/^(licen[cs]e|copying)([._-].*)?$/i.test(path.basename(file)),sha256:createHash('sha256').update(bytes).digest('hex'),text:bytes.toString('utf8')}]
    })
    const supplement=supplements.find(entry=>entry.name===pkg.name&&entry.version===pkg.version)
    if(supplement){
      if(supplement.license!==pkg.license||supplement.repository!==pkg.repository)throw Error(`Cargo license provenance mismatch: ${pkg.name}`)
      if(supplement.revision){
        const vcs=JSON.parse(fs.readFileSync(path.join(directory,'.cargo_vcs_info.json'),'utf8'))
        if(vcs.git?.sha1!==supplement.revision||(vcs.path_in_vcs||'')!==(supplement.path_in_vcs||''))throw Error(`Cargo license source revision mismatch: ${pkg.name}`)
      } else if(!supplement.manifest_sha256||createHash('sha256').update(fs.readFileSync(pkg.manifest_path)).digest('hex')!==supplement.manifest_sha256){
        throw Error(`Cargo local license manifest mismatch: ${pkg.name}`)
      }
      for(const notice of supplement.notices){
        if(!supplementDirectory||typeof notice.file!=='string'||notice.file.includes('\\')||notice.file.includes(':')||notice.file.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe Cargo license supplement path')
        const file=path.join(supplementDirectory,notice.file),stat=fs.lstatSync(file)
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>2*1024*1024)throw Error(`Invalid Cargo license supplement: ${pkg.name}`)
        const bytes=fs.readFileSync(file),sha256=createHash('sha256').update(bytes).digest('hex')
        if(sha256!==notice.sha256)throw Error(`Cargo license supplement hash mismatch: ${pkg.name}`)
        notices.push({file:path.basename(file),source:notice.source,sha256,is_license:/^(licen[cs]e|copying)([._-].*)?$/i.test(path.basename(file)),text:bytes.toString('utf8')})
      }
    }
    return {id:`${pkg.source??'local'}#${pkg.name}@${pkg.version}`,name:pkg.name,version:pkg.version,license:pkg.license,source:pkg.source,repository:pkg.repository,notices}
  })
  records.sort((a,b)=>a.id.localeCompare(b.id,'en'))
  return {schema_version:1,target,scope:'Resolved Cargo normal/build dependency graph and available license texts; not a final binary symbol inventory',packages:records,missing_notice_packages:records.filter(pkg=>!pkg.notices.some(notice=>notice.is_license)).map(pkg=>({name:pkg.name,version:pkg.version,license:pkg.license}))}
}

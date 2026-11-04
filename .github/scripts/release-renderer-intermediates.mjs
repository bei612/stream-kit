import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {platformLayout} from '../../scripts/lib/platform-layout.mjs'

// Called after native checks, bundle staging and cache upload. Later Go/Rust
// builders consume the staged renderer, never these compiler-owned directories.
export function releaseRendererIntermediates(directory,commit) {
  if(!/^[a-f0-9]{40}$/.test(commit||''))throw Error('Expected renderer source revision')
  const root=fs.realpathSync(directory)
  const stage=path.join(root,'artifacts/linux-sunshine/renderer')
  if(fs.realpathSync(stage)!==stage)throw Error('Linked renderer staging directory')
  const manifest=JSON.parse(fs.readFileSync(path.join(stage,'bundle-manifest.json'),'utf8'))
  if(manifest.component!=='sunshine'||manifest.platform!=='linux'||manifest.commit!==commit||manifest.source_dirty!==false)throw Error('Expected verified renderer from this revision')
  const layout=platformLayout('linux','sunshine')
  for(const relative of [layout.executable,...layout.required_files]) {
    const file=path.join(stage,relative)
    if(fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile()||fs.statSync(file).size===0)throw Error('Missing regular staged renderer file: '+relative)
  }
  // Validate every deletion target before removing any. In particular, reject
  // a relocated .local directory or a linked cache pointing outside its owner.
  const targets=['cmake-build-sunshine','cmake-build-sunshine-deps','ccache'].map(name=>path.join(root,'.local',name))
  for(const target of targets) {
    if(!fs.existsSync(target))continue
    if(fs.realpathSync(target)!==target||!fs.lstatSync(target).isDirectory())throw Error('Unsafe renderer intermediate directory: '+target)
  }
  const available=()=>{const disk=fs.statfsSync(root);return disk.bavail*disk.bsize}
  const before=available()
  for(const target of targets)fs.rmSync(target,{recursive:true,force:true})
  return {removed:targets.map(target=>path.relative(root,target)),available_bytes_before:before,available_bytes_after:available()}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.RUNNER_OS!=='Linux')throw Error('Renderer cleanup is limited to the hosted Linux build job')
  if(fs.realpathSync(process.cwd())!==fs.realpathSync(process.env.GITHUB_WORKSPACE))throw Error('Expected the CI workspace working directory')
  console.log(JSON.stringify(releaseRendererIntermediates(process.env.GITHUB_WORKSPACE,process.env.GITHUB_SHA)))
}

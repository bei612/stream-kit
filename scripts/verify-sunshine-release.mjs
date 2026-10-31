import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {platformLayout,linuxRendererProfile} from './lib/platform-layout.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [directory, commit, outputFlag, outputDirectory] = process.argv.slice(2)
if (!directory || !/^[a-f0-9]{40}$/.test(commit || '') || ![4, 6].includes(process.argv.length) || (outputFlag && (outputFlag !== '--output' || !outputDirectory))) {
  throw new Error('Expected build directory, full source revision and optional --output NEW_DIRECTORY')
}
const output = outputDirectory ? path.resolve(outputDirectory) : null
if (output && fs.existsSync(output)) throw new Error('Release output must be a new directory')
// Linux distribution packaging has different filesystem and service rules;
// never apply the relocatable Windows installation layout to that platform.
if (output && !['win32','linux'].includes(process.platform)) throw new Error('Native renderer staging supports Windows and Linux')
const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8', windowsHide:true}).trim()
function verifySource() {
  const status=git('status', '--porcelain', '--untracked-files=normal')
  if (git('rev-parse', 'HEAD') !== commit || status) {
    throw new Error(`Sunshine release source must remain clean and match the build revision: ${status}`)
  }
}
verifySource()
const binary = path.join(path.resolve(directory), process.platform === 'win32' ? 'sunshine.exe' : 'sunshine')
const stat = fs.lstatSync(binary)
if (!stat.isFile()) throw new Error('Sunshine release must be a regular executable file')
// Native --version is independent of configuration/resources/devices. Check it
// from an empty unrelated directory, both before and after native installation.
const scratch = fs.mkdtempSync(path.join(path.resolve(directory), 'version-check-'))
const version = execFileSync(binary, ['--version'], {cwd:scratch, encoding:'utf8', windowsHide:true, timeout:30000}).trim()
if(fs.readdirSync(scratch).length)throw Error('Version query created unexpected runtime files')
if (!version.includes(`commit: ${commit}`) || version.includes('-dirty')) {
  throw new Error('Sunshine executable does not report the requested release revision')
}
verifySource()
let packagedBinary = binary
if (output) {
  const build = path.resolve(directory)
  const cache = fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8')
  const cmake = cache.match(/^CMAKE_COMMAND:INTERNAL=(.+)$/m)?.[1].trim()
  const assets = cache.match(/^SUNSHINE_ASSETS_DIR:(?:PATH|STRING|UNINITIALIZED)=(.+)$/m)?.[1].trim()
  if (!cmake) throw new Error('Missing configured native CMake')
  const layout=platformLayout(process.platform,'sunshine')
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  // CMake's own top-level install rules stage the renderer, DLLs, shaders,
  // Web assets and tools. Local-only excludes dependency development installs.
  if(process.platform==='win32'){
    if(assets!=='assets')throw Error('Expected relocatable Windows assets directory')
    fs.mkdirSync(output,{recursive:true})
    execFileSync(cmake, ['-DCMAKE_INSTALL_LOCAL_ONLY=TRUE', `-DCMAKE_INSTALL_PREFIX=${output.replaceAll('\\','/')}`, '-DCMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION=TRUE', '-P', path.join(build, 'cmake_install.cmake')], {cwd:build, stdio:'inherit', windowsHide:true})
    packagedBinary=path.join(output,layout.executable)
    if(hash(binary)!==hash(packagedBinary))throw Error('Installed renderer differs from verified executable')
    if(!fs.lstatSync(path.join(output,'zlib1.dll')).isFile())throw Error('Missing Windows zlib runtime')
  }else{
    const profile=linuxRendererProfile()
    const prefix=cache.match(/^CMAKE_INSTALL_PREFIX:(?:PATH|STRING|UNINITIALIZED)=(.+)$/m)?.[1].trim()
    const definition=cache.match(/^SUNSHINE_ASSETS_DIR_DEF:(?:PATH|STRING|UNINITIALIZED)=(.+)$/m)?.[1].trim()
    const bindir=cache.match(/^CMAKE_INSTALL_BINDIR:(?:PATH|STRING|UNINITIALIZED)=(.+)$/m)?.[1].trim()
    if(prefix!==profile.prefix||assets!==profile.assets||definition!==profile.definition||bindir!==path.posix.dirname(layout.executable))throw Error('Linux renderer staging requires SUNSHINE_PACKAGE_LAYOUT=platform')
    fs.mkdirSync(path.dirname(output),{recursive:true})
    const stage=fs.mkdtempSync(path.join(path.dirname(output),'.renderer-stage-'))
    execFileSync(cmake,['-DCMAKE_INSTALL_LOCAL_ONLY=TRUE',`-DCMAKE_INSTALL_PREFIX=${prefix}`,'-P',path.join(build,'cmake_install.cmake')],{cwd:build,env:{...process.env,DESTDIR:stage},stdio:'inherit',windowsHide:true})
    // Preserve native bin/lib/share and installed ELF RPATH; never flatten the
    // Linux tree or install its standalone services onto the build host.
    fs.cpSync(path.join(stage,prefix.slice(1)),output,{recursive:true,errorOnExist:true,force:false})
    packagedBinary=path.join(output,layout.executable)
    const nativeEnvironment={...process.env};delete nativeEnvironment.LD_LIBRARY_PATH;delete nativeEnvironment.LD_PRELOAD
    const linkage=execFileSync('ldd',[packagedBinary],{env:nativeEnvironment,encoding:'utf8',timeout:30000})
    const dynamic=execFileSync('readelf',['-d',packagedBinary],{env:nativeEnvironment,encoding:'utf8',timeout:30000})
    if(linkage.includes('not found')||dynamic.includes('.local/cmake-build'))throw Error('Installed Linux renderer retains missing or build-tree dependencies')
    const loader=linkage.split('\n').find(line=>line.includes('libvulkan.so.1 =>'))?.split('=>')[1].trim().split(/\s+/)[0]
    if(loader&&fs.realpathSync(loader)!==fs.realpathSync(path.join(output,'lib/stream-kit/libvulkan.so.1')))throw Error('Installed Linux renderer does not resolve its private Vulkan loader')
    const installedVersion=execFileSync(packagedBinary,['--version'],{cwd:scratch,env:nativeEnvironment,encoding:'utf8',timeout:30000}).trim()
    if(fs.readdirSync(scratch).length)throw Error('Installed version query created unexpected runtime files')
    if(!installedVersion.includes(`commit: ${commit}`)||installedVersion.includes('-dirty'))throw Error('Installed Linux renderer source stamp mismatch')
  }
  fs.copyFileSync(path.join(root, 'third_party/sunshine/LICENSE'), path.join(output, 'LICENSE'))
  fs.copyFileSync(path.join(root, 'deploy/RENDERER-BUNDLE.md'), path.join(output, 'RENDERER-BUNDLE.md'))
  for(const required of [layout.executable,...layout.required_files]){
    const stat=fs.lstatSync(path.join(output,required))
    if(!stat.isFile()||stat.size===0)throw Error(`Missing renderer runtime file: ${required}`)
  }
  const files = []
  function inventory(folder) {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder,name), stat = fs.lstatSync(file)
      if (stat.isDirectory()) inventory(file)
      else if (stat.isFile()) files.push({path:path.relative(output,file).split(path.sep).join('/'), bytes:stat.size, sha256:hash(file)})
      else throw new Error('Renderer bundle contains a linked or special file')
    }
  }
  inventory(output)
  verifySource()
  fs.writeFileSync(path.join(output,'bundle-manifest.json'),JSON.stringify({schema_version:1, component:'sunshine', commit, source_dirty:false, platform:process.platform, architecture:process.arch, files},null,2)+'\n')
}
console.log(JSON.stringify({component:'sunshine', commit, source_dirty:false, binary:packagedBinary,
  sha256:createHash('sha256').update(fs.readFileSync(packagedBinary)).digest('hex'), version}))

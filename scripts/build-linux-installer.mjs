import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {platformLayout} from './lib/platform-layout.mjs'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const [input, destination, ...extra]=process.argv.slice(2)
if(!input||!destination||extra.length)throw Error('Expected LINUX_PLATFORM_BUNDLE NEW_OUTPUT_DIRECTORY')
if(process.platform!=='linux'||process.arch!=='x64')throw Error('Build the Ubuntu amd64 installer on native Linux amd64')
const osRelease=fs.readFileSync('/etc/os-release','utf8')
if(!/^ID=ubuntu$/m.test(osRelease)||!/^VERSION_ID="24\.04"$/m.test(osRelease))throw Error('Build the installer on its Ubuntu 24.04 target distribution')
const run=(command,args,options={})=>execFileSync(command,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','inherit'],...options}).trim()
const git=(...args)=>run('git',args)
const commit=git('rev-parse','HEAD')
const clean=()=>{if(git('rev-parse','HEAD')!==commit||git('status','--porcelain','--untracked-files=normal'))throw Error('Installer requires an unchanged, committed source tree')}
clean()
const source=fs.realpathSync(path.resolve(input)), output=path.resolve(destination)
if(fs.existsSync(output))throw Error('Installer output must be new')
if(output===source||output.startsWith(source+path.sep))throw Error('Installer output must be outside its platform input')
const manifest=JSON.parse(fs.readFileSync(path.join(source,'platform-manifest.json'),'utf8'))
if(manifest.commit!==commit||manifest.platform!=='linux'||manifest.architecture!=='amd64'||manifest.release_channel!=='preview'||!Array.isArray(manifest.files))throw Error('Expected a same-commit Linux amd64 preview platform')
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function inventory(directory,prefix=''){
  return fs.readdirSync(path.join(directory,prefix)).sort().flatMap(name=>{
    const relative=prefix?`${prefix}/${name}`:name, file=path.join(directory,relative),stat=fs.lstatSync(file)
    if(stat.isDirectory()&&!stat.isSymbolicLink())return inventory(directory,relative)
    if(!stat.isFile()||stat.isSymbolicLink())throw Error(`Unsupported installer entry: ${relative}`)
    return [{path:relative,bytes:stat.size,sha256:hash(file)}]
  })
}
const files=inventory(source).filter(file=>file.path!=='platform-manifest.json')
const expected=new Map(manifest.files.map(file=>[file.path,file]))
if(expected.size!==manifest.files.length||expected.size!==files.length)throw Error('Platform inventory mismatch')
for(const file of files){const item=expected.get(file.path);if(!item||item.bytes!==file.bytes||item.sha256!==file.sha256)throw Error(`Platform file mismatch: ${file.path}`)}
const names=['orchestrator','media-gateway','sunshine']
if(manifest.components?.length!==names.length||names.some(name=>!manifest.components.some(item=>item.component===name&&item.commit===commit&&item.manifest_path===`${name}/bundle-manifest.json`)))throw Error('Linux installer requires exactly the three integrated native components')
const control=path.join(source,'orchestrator/orchestrator')
run(control,['verify-platform',source])
fs.mkdirSync(output,{recursive:true})
const stage=path.join(output,'package'), installed=path.join(stage,'opt/stream-kit')
fs.mkdirSync(path.dirname(installed),{recursive:true})
fs.cpSync(source,installed,{recursive:true,errorOnExist:true,force:false})
// Immutable source recipes accompany the binary inventory; no build tooling is
// installed in the runtime package. All three components keep their notices.
const copy=(from,to,mode=0o644)=>{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);fs.chmodSync(to,mode)}
copy(path.join(root,'deploy/stream-kit-orchestrator.service'),path.join(stage,'usr/lib/systemd/user/stream-kit.service'))
copy(path.join(root,'deploy/linux/README.md'),path.join(stage,'usr/share/doc/stream-kit/README.md'))
copy(path.join(root,'third_party/sunshine/LICENSE'),path.join(stage,'usr/share/doc/stream-kit/copyright'))
copy(path.join(root,'third_party/sunshine/src_assets/linux/misc/60-sunshine.rules'),path.join(stage,'usr/lib/udev/rules.d/60-stream-kit.rules'))
fs.mkdirSync(path.join(stage,'usr/lib/modules-load.d'),{recursive:true})
fs.writeFileSync(path.join(stage,'usr/lib/modules-load.d/60-stream-kit.conf'),'uinput\nuhid\n')
copy(path.join(root,'deploy/linux/prerm'),path.join(stage,'DEBIAN/prerm'),0o755)
// Debian resolves SONAMEs against the target distribution. The bundled Vulkan
// loader is private; unlike a missing host library, it has no Debian owner.
const binaries=names.map(name=>path.join(installed,name,platformLayout('linux',name).executable))
const privateLib=path.join(installed,'sunshine/lib/stream-kit')
const debian=path.join(output,'debian');fs.mkdirSync(debian)
fs.writeFileSync(path.join(debian,'control'),'Source: stream-kit\nSection: video\nPriority: optional\nMaintainer: Stream-Kit maintainers\n\nPackage: stream-kit\nArchitecture: amd64\nDescription: Unified cloud rendering platform\n')
fs.writeFileSync(path.join(debian,'shlibs.local'),'libvulkan 1 stream-kit\n')
const deps=run('dpkg-shlibdeps',['-O','-xstream-kit',`-l${privateLib}`,...binaries.map(binary=>`-e${binary}`)],{cwd:output})
const nativeDeps=deps.split('\n').find(line=>line.startsWith('shlibs:Depends='))?.slice('shlibs:Depends='.length)
if(!nativeDeps)throw Error('Native distribution dependency inventory is empty')
const dependencies=[nativeDeps,'systemd','dbus-user-session','udev','kmod','util-linux','qt6-qpa-plugins'].join(', ')
if(/\b(nodejs|npm|build-essential|cmake)\b/.test(dependencies))throw Error('Development tooling must not be a runtime prerequisite')
const version=`0.1.0~preview.${Math.floor(Date.parse(git('show','-s','--format=%cI','HEAD'))/1000)}.${commit.slice(0,12)}`
fs.writeFileSync(path.join(stage,'DEBIAN/control'),`Package: stream-kit\nVersion: ${version}\nArchitecture: amd64\nSection: video\nPriority: optional\nMaintainer: Stream-Kit maintainers\nDepends: ${dependencies}\nHomepage: https://github.com/bei612/stream-kit\nDescription: Unified single-administrator cloud rendering platform\n Native control, browser media gateway and application renderer.\n`)
const deb=path.join(output,'stream-kit.deb')
run('dpkg-deb',['--root-owner-group','--build',stage,deb])
const payloadHash=hash(deb)
const header=fs.readFileSync(path.join(root,'deploy/linux/install-header.sh'),'utf8').replace('# Generated payload metadata is inserted by build-linux-installer.mjs.',`STREAM_KIT_PAYLOAD_SHA256='${payloadHash}'`)
const filename=`stream-kit-preview-${commit.slice(0,12)}-ubuntu24.04-amd64-setup.run`
const installer=path.join(output,filename)
fs.writeFileSync(installer,Buffer.concat([Buffer.from(`${header}\n__STREAM_KIT_PAYLOAD__\n`),fs.readFileSync(deb)]),{mode:0o755})
clean()
const release={schema_version:1,release_channel:'preview',commit,platform:'linux',distribution:'ubuntu-24.04',architecture:'amd64',installer:{file:filename,bytes:fs.statSync(installer).size,sha256:hash(installer)},payload:{sha256:payloadHash,version,dependencies},runtime_requires_node:false}
fs.writeFileSync(path.join(output,'installer-manifest.json'),JSON.stringify(release,null,2)+'\n')
fs.writeFileSync(path.join(output,'SHA256SUMS'),`${release.installer.sha256}  ${filename}\n`)
console.log(JSON.stringify(release,null,2))

import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [directory, commit, outputFlag, outputDirectory] = process.argv.slice(2)
if (!directory || !/^[a-f0-9]{40}$/.test(commit || '') || ![4, 6].includes(process.argv.length) || (outputFlag && (outputFlag !== '--output' || !outputDirectory))) {
  throw new Error('Expected build directory, full source revision and optional --output NEW_DIRECTORY')
}
const output = outputDirectory ? path.resolve(outputDirectory) : null
if (output && fs.existsSync(output)) throw new Error('Release output must be a new directory')
// Linux distribution packaging has different filesystem and service rules;
// never apply the relocatable Windows installation layout to that platform.
if (output && process.platform !== 'win32') throw new Error('Use the native CPack distribution for Linux; this staging layout requires Windows')
const git = (...args) => execFileSync('git', args, {cwd:root, encoding:'utf8', windowsHide:true}).trim()
function verifySource() {
  if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Sunshine release source must remain clean and match the build revision')
  }
}
verifySource()
const binary = path.join(path.resolve(directory), process.platform === 'win32' ? 'sunshine.exe' : 'sunshine')
const stat = fs.lstatSync(binary)
if (!stat.isFile()) throw new Error('Sunshine release must be a regular executable file')
// Sunshine parses configuration even for its version command. Keep that
// configuration and any resulting files separate from installed services.
const scratch = fs.mkdtempSync(path.join(path.resolve(directory), 'version-check-'))
const config = path.join(scratch, 'sunshine.conf')
const settings = {log_path:'sunshine.log',file_apps:'apps.json',file_state:'state.json',
  credentials_file:'credentials.json',pkey:'key.pem',cert:'cert.pem'}
fs.writeFileSync(config, Object.entries(settings).map(([key, name]) => `${key} = ${path.join(scratch,name).replaceAll('\\','/')}`).join('\n'))
const version = execFileSync(binary, [config, '--version'], {cwd:scratch, encoding:'utf8', windowsHide:true, timeout:30000}).trim()
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
  if (!cmake || assets !== 'assets') throw new Error('Expected configured CMake and relocatable assets directory')
  fs.mkdirSync(output, {recursive:true})
  // CMake's own top-level install rules stage the renderer, DLLs, shaders,
  // Web assets and tools. Local-only excludes dependency development installs.
  execFileSync(cmake, ['-DCMAKE_INSTALL_LOCAL_ONLY=TRUE', `-DCMAKE_INSTALL_PREFIX=${output.replaceAll('\\','/')}`, '-DCMAKE_ERROR_ON_ABSOLUTE_INSTALL_DESTINATION=TRUE', '-P', path.join(build, 'cmake_install.cmake')], {cwd:build, stdio:'inherit', windowsHide:true})
  packagedBinary = path.join(output, 'sunshine.exe')
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (hash(binary) !== hash(packagedBinary)) throw new Error('Installed renderer differs from verified executable')
  for (const required of ['zlib1.dll', 'assets/web/index.html']) {
    if (!fs.lstatSync(path.join(output, required)).isFile()) throw new Error(`Missing renderer runtime file: ${required}`)
  }
  fs.copyFileSync(path.join(root, 'third_party/sunshine/LICENSE'), path.join(output, 'LICENSE'))
  fs.copyFileSync(path.join(root, 'deploy/RENDERER-BUNDLE.md'), path.join(output, 'RENDERER-BUNDLE.md'))
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

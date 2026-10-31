import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [directory, commit] = process.argv.slice(2)
if (!directory || !/^[a-f0-9]{40}$/.test(commit || '') || process.argv.length !== 4) {
  throw new Error('Expected build directory and full source revision')
}
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
console.log(JSON.stringify({component:'sunshine', commit, source_dirty:false, binary,
  sha256:createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), version}))

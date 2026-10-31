import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gateway = path.join(root, 'third_party/moonlight-web-stream')
// Cross compilation requires target-side runtime verification.
if (process.env.CARGO_BUILD_TARGET) throw new Error('Native gateway release cannot use CARGO_BUILD_TARGET')
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', windowsHide: true}).trim()
const commit = git('rev-parse', 'HEAD')
if (!/^[a-f0-9]{40}$/.test(commit) || git('status', '--porcelain', '--untracked-files=normal')) {
  throw new Error('Gateway release requires a clean, committed source tree')
}
const env = {...process.env, STREAM_KIT_SOURCE_COMMIT: commit, STREAM_KIT_SOURCE_DIRTY: 'false'}
execFileSync('cargo', ['build', '--locked', '--release'], {cwd: gateway, env, stdio: 'inherit', windowsHide: true})
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], {cwd: gateway, env, encoding: 'utf8', windowsHide: true}))
// This entry point builds for the native deployment host; cross compilation
// needs target-side runtime verification and is intentionally not accepted here.
const binary = path.join(metadata.target_directory, 'release', process.platform === 'win32' ? 'web-server.exe' : 'web-server')
const version = execFileSync(binary, ['--version'], {encoding: 'utf8', windowsHide: true}).trim()
if (!version.endsWith(`(commit: ${commit}, dirty: false)`)) throw new Error('Gateway binary source stamp does not match the release source')
if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain', '--untracked-files=normal')) {
  throw new Error('Source changed during gateway release build')
}
console.log(JSON.stringify({binary, commit, source_dirty: false, version}))

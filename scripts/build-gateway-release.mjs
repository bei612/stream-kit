import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import {bundleWindowsRuntime} from './lib/windows-runtime.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectCargoNotices } from './lib/cargo-notices.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const gateway = path.join(root, 'third_party/moonlight-web-stream')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
  throw new Error('Expected --output NEW_DIRECTORY, or no arguments for executable-only build')
}
const output = args.length ? path.resolve(args[1]) : null
if (output && fs.existsSync(output)) throw new Error('Release output must be a new directory')
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
if (output) {
  // Rebuild the bindings and viewer into a new directory, never copy a mutable
  // dist left by a development build or overwrite an installed deployment.
  execFileSync('cargo', ['test', '--locked', 'export_bindings'], {cwd: gateway, env, stdio: 'inherit', windowsHide: true})
  execFileSync(process.execPath, [path.join(root, 'scripts/build-gateway-bindings.mjs')], {cwd: gateway, env, stdio: 'inherit', windowsHide: true})
  fs.mkdirSync(output, {recursive: true})
  execFileSync(process.execPath, [path.join(gateway, 'node_modules/webpack/bin/webpack.js'), '--mode=production', '--output-path', path.join(output, 'dist')], {cwd: gateway, env, stdio: 'inherit', windowsHide: true})
  for (const required of ['index.html', 'stream.html', 'admin.html', 'manifest.json', 'service-worker.js', 'THIRD_PARTY_NOTICES.json']) {
    if (!fs.lstatSync(path.join(output, 'dist', required)).isFile()) throw new Error(`Missing viewer asset: ${required}`)
  }
  fs.copyFileSync(binary, path.join(output, path.basename(binary)))
  bundleWindowsRuntime(output,[path.basename(binary)],env)
  if(execFileSync(path.join(output,path.basename(binary)),['--version'],{env,encoding:'utf8',windowsHide:true}).trim()!==version)throw Error('Packaged gateway runtime/version verification failed')
  fs.copyFileSync(path.join(gateway, 'LICENSE'), path.join(output, 'LICENSE'))
  fs.copyFileSync(path.join(gateway, 'Cargo.lock'), path.join(output, 'Cargo.lock'))
  fs.copyFileSync(path.join(gateway, 'package-lock.json'), path.join(output, 'package-lock.json'))
  fs.copyFileSync(path.join(root, 'deploy/GATEWAY-BUNDLE.md'), path.join(output, 'GATEWAY-BUNDLE.md'))
  const notices={schema_version:1,native:collectCargoNotices(path.join(gateway,'Cargo.toml'),{env}),wasm:collectCargoNotices(path.join(gateway,'rust_modules/wasm/Cargo.toml'),{target:'wasm32-unknown-unknown',env})}
  fs.writeFileSync(path.join(output,'THIRD_PARTY_NOTICES.rust.json'),JSON.stringify(notices,null,2)+'\n')
}
if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain', '--untracked-files=normal')) {
  throw new Error('Source changed during gateway release build')
}
if (output) {
  const files = []
  function inventory(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file)
      if (stat.isDirectory()) inventory(file)
      else if (stat.isFile()) files.push({path: path.relative(output, file).split(path.sep).join('/'), bytes: stat.size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex')})
      else throw new Error('Release cannot contain linked or special files')
    }
  }
  inventory(output)
  fs.writeFileSync(path.join(output, 'bundle-manifest.json'), JSON.stringify({schema_version: 1, component: 'media-gateway', commit, source_dirty: false, platform: process.platform, architecture: process.arch, version, files}, null, 2) + '\n')
}
console.log(JSON.stringify({binary: output ? path.join(output, path.basename(binary)) : binary, output, commit, source_dirty: false, version}))

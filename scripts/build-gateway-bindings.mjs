// The official UniFFI builder, with repository-owned dependency locks. No remote
// source checkout and no edits to installed generator code are needed.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gateway = join(root, 'third_party/moonlight-web-stream')
const common = join(root, 'third_party/moonlight-common-rust')
const generator = join(gateway, 'node_modules/uniffi-bindgen-react-native')
const wasm = join(gateway, 'rust_modules/wasm')
const locks = join(root, 'third_party-manifests/gateway-web')
const generatorManifest = join(generator, 'crates/ubrn_cli/Cargo.toml')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: gateway, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`)
  return result.stdout?.trim()
}

function installLock(name, directory) {
  mkdirSync(directory, { recursive: true })
  copyFileSync(join(locks, name), join(directory, 'Cargo.lock'))
}

// Fail before generating anything when the rewriter does not match the crate.
const wasmVersion = readFileSync(join(gateway, 'Cargo.wasm.toml'), 'utf8')
  .match(/wasm-bindgen\s*=\s*"=([\d.]+)"/)?.[1]
if (!wasmVersion) throw new Error('Cargo.wasm.toml must pin wasm-bindgen exactly')
const rewriter = process.env.UBRN_WASM_BINDGEN || 'wasm-bindgen'
if (run(rewriter, ['--version'], { stdio: 'pipe', encoding: 'utf8' }) !== `wasm-bindgen ${wasmVersion}`) {
  throw new Error(`Install official wasm-bindgen-cli ${wasmVersion} with --locked`)
}

installLock('uniffi-generator.Cargo.lock', generator)
installLock('wasm.Cargo.lock', wasm)
const manifests = [generatorManifest, join(common, 'bindings/Cargo.toml')]
for (const manifest of manifests) run('cargo', ['fetch', '--locked', '--manifest-path', manifest])

// Generate the shim first, using the official builder's supported two-step mode.
// The builder's native command has no --locked option, so preflight the native
// lock and verify it after generation; offline mode prevents implicit downloads.
const nativeLock = readFileSync(join(common, 'Cargo.lock'))
const offline = { ...process.env, CARGO_NET_OFFLINE: 'true' }
const cli = ['run', '--locked', '--quiet', '--manifest-path', generatorManifest, '--', 'build', 'web', '--release']
run('cargo', [...cli, '--no-wasm-pack'], { env: offline })
if (!readFileSync(join(common, 'Cargo.lock')).equals(nativeLock)) {
  throw new Error('Native binding dependency lock changed; review and commit it before building')
}
run('cargo', ['fetch', '--locked', '--manifest-path', join(wasm, 'Cargo.toml')])
run('cargo', cli, { env: offline })
if (!readFileSync(join(common, 'Cargo.lock')).equals(nativeLock)) {
  throw new Error('Native binding dependency lock changed during WASM build')
}

import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'artifacts/ci')
fs.mkdirSync(output, {recursive:true})
const binary = path.join(output, process.platform === 'win32' ? 'gateway-stamp-tests.exe' : 'gateway-stamp-tests')
let log = ''
for (const [command, args] of [
  [process.env.RUSTC || 'rustc', ['--edition', '2024', '--test', path.join(root,'third_party/moonlight-web-stream/build.rs'), '-o', binary]],
  [binary, []],
]) {
  const result = spawnSync(command, args, {cwd:root, encoding:'utf8', windowsHide:true, timeout:120000, maxBuffer:8*1024*1024})
  const text = `${result.stdout || ''}${result.stderr || ''}${result.error ? String(result.error) : ''}`
  log += text
  process.stdout.write(text)
  fs.writeFileSync(path.join(output,'gateway-stamp-tests.log'), log)
  if (result.status !== 0) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      const detail = text.slice(-6000).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')
      console.log(`::error title=Gateway source stamp tests::${detail}`)
    }
    process.exit(result.status || 1)
  }
}

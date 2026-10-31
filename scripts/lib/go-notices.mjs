import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const noticeName = /^(licen[cs]e|copying|copyright|notice|patents|authors|contributors)([._-].*)?$/i
const licenseName = /^(licen[cs]e|copying)([._-].*)?$/i

function readNotice(file, relative) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Notice is not a regular file: ${relative}`)
  const bytes = fs.readFileSync(file)
  if (!bytes.length) throw new Error(`Empty notice: ${relative}`)
  return {file:relative, sha256:createHash('sha256').update(bytes).digest('hex'), text:bytes.toString('utf8')}
}

export function collectGoNotices(vendorRoot, goRoot, buildInfo) {
  if (!buildInfo.GoVersion || !Array.isArray(buildInfo.Deps)) throw new Error('Missing compiled Go dependency information')
  const packages = buildInfo.Deps.map(module => {
    if (typeof module.Path !== 'string' || module.Path.includes('\\') || module.Path.includes(':') || module.Path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid compiled Go module path')
    const directory = path.resolve(vendorRoot, module.Path)
    if (fs.realpathSync(directory) !== directory) throw new Error(`Linked Go dependency: ${module.Path}`)
    const notices = []
    function visit(current) {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name), stat = fs.lstatSync(file)
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsupported Go vendor entry: ${module.Path}`)
        if (stat.isDirectory()) visit(file)
        else if (noticeName.test(name)) notices.push(readNotice(file, path.relative(directory, file).split(path.sep).join('/')))
      }
    }
    visit(directory)
    if (!notices.some(notice => licenseName.test(path.basename(notice.file)))) throw new Error(`No vendored license text for compiled Go module: ${module.Path}`)
    return {path:module.Path, version:module.Version, replacement:module.Replace ? {path:module.Replace.Path,version:module.Replace.Version} : null, notices}
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const runtime = ['LICENSE', 'PATENTS'].filter(name => fs.existsSync(path.join(goRoot, name))).map(name => readNotice(path.join(goRoot, name), name))
  if (!runtime.some(notice => notice.file === 'LICENSE')) throw new Error('Go toolchain license is missing')
  return {schema_version:1, scope:'compiled Go module dependency notices and Go toolchain root notices', go_version:buildInfo.GoVersion, runtime_notices:runtime, packages}
}

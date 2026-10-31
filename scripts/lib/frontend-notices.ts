import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// Collect from emitted chunks instead of every installed development package.
type Supplement = {name: string; version: string; integrity: string; notices: {file: string; sha256: string; source: string}[]}

export function collectNotices(root: string, moduleIds: Iterable<string>, supplements: Supplement[] = []) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const directories = new Set<string>()
  for (const id of moduleIds) {
    if (id.startsWith('\0')) continue
    const normalized = id.replaceAll('\\', '/').split('?')[0]
    const marker = normalized.lastIndexOf('/node_modules/')
    if (marker < 0) continue
    const parts = normalized.slice(marker + '/node_modules/'.length).split('/')
    const count = parts[0].startsWith('@') ? 2 : 1
    directories.add(path.resolve(normalized.slice(0, marker + '/node_modules/'.length), ...parts.slice(0, count)))
  }
  return [...directories].sort().map(directory => {
    const relative = path.relative(root, directory).split(path.sep).join('/')
    if (!relative.startsWith('node_modules/') || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Bundled dependency is outside the locked frontend tree')
    if (fs.realpathSync(directory) !== directory) throw new Error(`Linked dependency cannot supply release notices: ${relative}`)
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (!manifest.name || !manifest.version || lock.packages?.[relative]?.version !== manifest.version) throw new Error(`Bundled dependency does not match lockfile: ${relative}`)
    const names = fs.readdirSync(directory).filter(name => /^(licen[cs]e|copying|copyright|notice)([._-].*)?$/i.test(name)).sort()
    const notices: {file: string; sha256: string; text: string; source?: string}[] = names.map(name => {
      const file = path.join(directory, name)
      if (!fs.lstatSync(file).isFile()) throw new Error(`License is not a regular file: ${relative}/${name}`)
      const bytes = fs.readFileSync(file)
      if (bytes.length === 0) throw new Error(`Empty license: ${relative}/${name}`)
      return { file: name, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') }
    })
    if (!names.some(name => /^(licen[cs]e|copying)([._-].*)?$/i.test(name))) {
      const supplement = supplements.find(item => item.name === manifest.name && item.version === manifest.version)
      if (!supplement || !supplement.integrity || supplement.integrity !== lock.packages[relative].integrity || !supplement.notices.length) throw new Error(`Bundled dependency has no license text: ${manifest.name}@${manifest.version}`)
      for (const notice of supplement.notices) {
        if (!fs.lstatSync(notice.file).isFile()) throw new Error('Supplemental license is not a regular file')
        const bytes = fs.readFileSync(notice.file)
        if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== notice.sha256) throw new Error('Supplemental license hash mismatch')
        notices.push({file: path.basename(notice.file), sha256: notice.sha256, text: bytes.toString('utf8'), source: notice.source})
      }
    }
    return { name: manifest.name, version: manifest.version, path: relative, declared_license: manifest.license ?? null, notices }
  })
}


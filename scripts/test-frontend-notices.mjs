import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { collectNotices } from '../orchestrator/web/build-tools/notices.ts'

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(base, 'stream-kit-notices-'))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), base)
    assert.ok(path.basename(root).startsWith('stream-kit-notices-'))
    fs.rmSync(root, { recursive: true })
  })
  const packages = {}
  const add = (name, license = 'Copyright fixture\nPermission fixture\n') => {
    const relative = `node_modules/${name}`, directory = path.join(root, relative)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.2.3', license: 'MIT' }))
    if (license !== null) fs.writeFileSync(path.join(directory, 'LICENSE'), license)
    packages[relative] = { version: '1.2.3' }
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages }))
    return path.join(directory, 'index.js')
  }
  return { root, add }
}

test('notices retain exact source text and deduplicate only selected packages', t => {
  const { root, add } = fixture(t)
  const source = 'Copyright fixture\r\nPermission fixture\r\n'
  const selected = add('@scope/runtime', source)
  add('unused-development-package', null)
  const notices = collectNotices(root, [selected, selected+'?commonjs', path.join(root, 'src/app.ts'), '\0virtual-module'])
  assert.equal(notices.length, 1)
  assert.equal(notices[0].name, '@scope/runtime')
  assert.equal(notices[0].notices[0].text, source)
  assert.equal(notices[0].notices[0].sha256, createHash('sha256').update(source).digest('hex'))
})

test('missing or empty license fails instead of inventing a license', t => {
  const { root, add } = fixture(t)
  assert.throws(() => collectNotices(root, [add('missing', null)]), /no license text/)
  assert.throws(() => collectNotices(root, [add('empty', '')]), /Empty license/)
})

test('installed version must match the locked dependency', t => {
  const { root, add } = fixture(t)
  const selected = add('runtime')
  fs.writeFileSync(path.join(path.dirname(selected), 'package.json'), JSON.stringify({name:'runtime',version:'9.0.0'}))
  assert.throws(() => collectNotices(root, [selected]), /does not match lockfile/)
})

test('non-file notices and dependencies outside the frontend tree fail', t => {
  const { root, add } = fixture(t)
  const selected = add('runtime')
  fs.mkdirSync(path.join(path.dirname(selected), 'NOTICE'))
  assert.throws(() => collectNotices(root, [selected]), /not a regular file/)
  assert.throws(() => collectNotices(root, [path.join(root, '..', 'node_modules', 'external', 'index.js')]), /outside the locked/)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { manifestRelease, verifyInstallerAcceptance } from './lib/product-release.mjs'

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function verifyUploaded(metadata, files) {
  const expected = new Map(files.map(file => [path.basename(file), file]))
  assert.equal(expected.size, files.length, 'Duplicate publication asset name')
  for (const asset of read(metadata)) {
    const file = expected.get(asset.name)
    assert.ok(file, `Unexpected published asset ${asset.name}`)
    assert.equal(asset.state, 'uploaded')
    assert.equal(asset.size, fs.statSync(file).size)
    assert.equal(asset.digest, `sha256:${sha256(file)}`)
    expected.delete(asset.name)
  }
  assert.equal(expected.size, 0, 'Release draft is missing an asset')
}

function prepareAssets(windowsDirectory, androidDirectory, sourceSbom, acceptance, tag, output) {
  const win = read(path.join(windowsDirectory, 'installer-manifest.json'))
  const version = manifestRelease(win)
  assert.equal(version.channel, 'stable', 'Windows + Android promotion requires a stable build')
  assert.equal(tag, `v${version.version}`)
  assert.equal(win.file.name, `${version.prefix}-windows-amd64-setup.exe`)
  verifyInstallerAcceptance(win, read(acceptance))
  assert.equal(sha256(path.join(windowsDirectory, win.file.name)), win.file.sha256)
  assert.match(read(sourceSbom).spdxVersion, /^SPDX-[0-9]+\.[0-9]+$/, 'Invalid source SBOM')

  const android = read(path.join(androidDirectory, 'provenance.json'))
  const signing = read('third_party-manifests/android-signing.json')
  assert.equal(android.kind, 'signed-release-candidate')
  assert.equal(android.source_commit, win.commit)
  assert.equal(android.version, version.version)
  assert.equal(android.application_id, 'io.github.bei612.streamkit')
  assert.equal(android.signing_certificate_sha256, signing.certificate_sha256.replace(/[\s:]/g, '').toLowerCase())
  assert.ok(Number.isSafeInteger(android.version_code) && android.version_code > 0)
  const apkName = `stream-kit-android-${android.version}.apk`
  assert.equal(sha256(path.join(androidDirectory, apkName)), android.apk_sha256)

  const gate = read(`docs/evidence/windows11-android-release-${version.version}.json`)
  assert.equal(gate.source_commit, win.commit)
  assert.equal(gate.installer_sha256, win.file.sha256)
  assert.equal(gate.apk_sha256, android.apk_sha256)
  assert.equal(gate.android_version_code, android.version_code)
  for (const name of ['windows11_install', 'service_recovery', 'maintenance_rollback', 'lan_migration',
    'android_upgrade', 'android_media_input_audio', 'dependency_review', 'cleanup_verified']) {
    assert.equal(gate.checks?.[name]?.passed, true, `Release evidence missing: ${name}`)
    const evidence = gate.checks[name].evidence
    assert.match(evidence, /^docs\/evidence\/[A-Za-z0-9._-]+\.json$/)
    const detail = read(evidence)
    assert.equal(detail.source_commit, win.commit, `Evidence source mismatch: ${name}`)
    assert.equal(detail.passed, true, `Evidence did not pass: ${name}`)
  }

  const downloads = new Map()
  for (const line of fs.readFileSync(path.join(androidDirectory, 'DOWNLOAD-SHA256SUMS.txt'), 'utf8').trimEnd().split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/)
    assert.ok(match && !downloads.has(match[2]), 'Invalid Android download checksum list')
    downloads.set(match[2], match[1])
  }
  const androidFiles = new Map([
    [apkName, apkName],
    ['distribution.zip', `stream-kit-android-${android.version}-distribution.zip`],
    ['provenance.json', 'android-provenance.json'],
    ['sbom.cdx.json', 'android-sbom.cdx.json'],
    ['dependency-notices.json', 'android-dependency-notices.json'],
    ['runtime-dependencies.json', 'android-runtime-dependencies.json'],
  ])
  assert.deepEqual([...downloads.keys()].sort(), [apkName, 'distribution.zip', 'provenance.json', 'sbom.cdx.json'].sort())
  for (const [file, expected] of downloads) assert.equal(sha256(path.join(androidDirectory, file)), expected)
  const inventory = fs.readFileSync(path.join(androidDirectory, 'SHA256SUMS.txt'), 'utf8').split(/\r?\n/)
  for (const file of ['dependency-notices.json', 'runtime-dependencies.json']) {
    assert.ok(inventory.includes(`${sha256(path.join(androidDirectory, file))}  ${file}`), `Android inventory mismatch: ${file}`)
  }

  fs.mkdirSync(output, {recursive:true})
  assert.equal(fs.readdirSync(output).length, 0, 'Publication directory must be empty')
  const copy = (directory, from, to = from) => {
    const source = path.join(directory, from), target = path.join(output, to)
    assert.ok(fs.lstatSync(source).isFile(), `Artifact must be an ordinary file: ${from}`)
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    return `${sha256(target)}  ${to}\n`
  }
  const windowsChecksums = copy(windowsDirectory, win.file.name)
    + copy(windowsDirectory, 'installer-manifest.json')
    + copy(path.dirname(sourceSbom), path.basename(sourceSbom), 'stream-kit-sbom.spdx.json')
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), windowsChecksums)
  const androidChecksums = [...androidFiles].map(([from, to]) => copy(androidDirectory, from, to)).join('')
  fs.writeFileSync(path.join(output, 'Android-SHA256SUMS.txt'), androidChecksums)
}

const args = process.argv.slice(2)
if (args[0] === '--uploaded') {
  assert.ok(args.length >= 3)
  verifyUploaded(args[1], args.slice(2))
} else {
  assert.equal(args.length, 6, 'Expected WINDOWS_DIR ANDROID_DIR SOURCE_SBOM INSTALLER_ACCEPTANCE TAG OUTPUT_DIR')
  prepareAssets(...args)
}

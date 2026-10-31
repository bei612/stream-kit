import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 4) throw new Error('Expected CONTROL_BUNDLE GATEWAY_BUNDLE RENDERER_BUNDLE NEW_OUTPUT')
const output = path.resolve(args[3])
if (fs.existsSync(output)) throw new Error('Output already exists; releases are never overwritten')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function inventory(directory) {
  const files = []
  function visit(folder) {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder,name), stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error('Linked bundle entry is not allowed')
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) files.push({path:path.relative(directory,file).split(path.sep).join('/'), bytes:stat.size, sha256:hash(file)})
      else throw new Error('Special bundle entry is not allowed')
    }
  }
  visit(directory)
  return files
}
const components = ['orchestrator','media-gateway','sunshine'].map((component,index) => {
  const directory = fs.realpathSync(path.resolve(args[index]))
  if (output === directory || output.startsWith(directory + path.sep)) throw new Error('Output must be outside input bundles')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory,'bundle-manifest.json'),'utf8'))
  if (manifest.component !== component || manifest.source_dirty !== false || !/^[a-f0-9]{40}$/.test(manifest.commit) || !Array.isArray(manifest.files)) throw new Error(`Invalid ${component} manifest`)
  const actual = inventory(directory).filter(file => file.path !== 'bundle-manifest.json')
  const expected = new Map()
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':') || file.path.split('/').some(part => !part || part === '.' || part === '..') || expected.has(file.path.toLowerCase())) throw new Error('Invalid or duplicate bundle path')
    expected.set(file.path.toLowerCase(),file)
  }
  if (actual.length !== expected.size) throw new Error(`Unexpected or missing files in ${component}`)
  for (const file of actual) {
    const declared = expected.get(file.path.toLowerCase())
    if (!declared || declared.path !== file.path || declared.bytes !== file.bytes || declared.sha256 !== file.sha256) throw new Error(`Integrity mismatch: ${component}/${file.path}`)
  }
  return {component,directory,manifest}
})
const commit = components[0].manifest.commit
const platform = value => value === 'win32' ? 'windows' : value
const arch = value => value === 'x64' ? 'amd64' : value === 'arm64' ? 'arm64' : value
for (const {manifest} of components) {
  if (manifest.commit !== commit || platform(manifest.platform) !== platform(components[0].manifest.platform) || arch(manifest.architecture) !== arch(components[0].manifest.architecture)) throw new Error('Components must share source revision, OS and architecture')
}
fs.mkdirSync(output,{recursive:true})
for (const {component,directory} of components) {
  fs.cpSync(directory,path.join(output,component),{recursive:true,errorOnExist:true,force:false})
}
fs.copyFileSync(path.join(root,'deploy/PLATFORM-PREVIEW.md'),path.join(output,'README.md'))
const files = inventory(output)
fs.writeFileSync(path.join(output,'platform-manifest.json'),JSON.stringify({schema_version:1,commit,platform:platform(components[0].manifest.platform),architecture:arch(components[0].manifest.architecture),release_channel:'preview',components:components.map(({component,manifest})=>({component,commit:manifest.commit,manifest_path:`${component}/bundle-manifest.json`})),files},null,2)+'\n')
console.log(JSON.stringify({output,commit,files:files.length,release_channel:'preview'}))

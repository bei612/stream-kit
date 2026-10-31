import { collectNotices } from './frontend-notices.ts'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const provenance = new URL('../licenses/ubjs-core-0.31.0-6/provenance.json', import.meta.url)
const supplement = JSON.parse(fs.readFileSync(provenance, 'utf8'))
supplement.notices = supplement.notices.map(notice => ({...notice, file: fileURLToPath(new URL(notice.file, provenance))}))

// Include modules in emitted chunks, including concatenated modules. Generated
// Webpack runtime code has no module resource, so retain its generator's license.
export class DependencyNoticesPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('StreamKitDependencyNotices', compilation => {
      compilation.hooks.processAssets.tap({
        name: 'StreamKitDependencyNotices',
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
      }, () => {
        const resources = new Set()
        const visit = module => {
          if (module.resource) resources.add(module.resource)
          if (module.modules) for (const child of module.modules) visit(child)
        }
        for (const chunk of compilation.chunks) {
          for (const module of compilation.chunkGraph.getChunkModulesIterable(chunk)) visit(module)
        }
        resources.add(compiler.context + '/node_modules/webpack/package.json')
        const packages = collectNotices(compiler.context, resources, [supplement])
        compilation.emitAsset('THIRD_PARTY_NOTICES.json', new compiler.webpack.sources.RawSource(
          JSON.stringify({schema_version: 1, scope: 'npm dependencies in viewer Webpack chunks and Webpack runtime generator; excludes Rust/WASM and copied project assets', packages}, null, 2) + '\n',
        ))
      })
    })
  }
}

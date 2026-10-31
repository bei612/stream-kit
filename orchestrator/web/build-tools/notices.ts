import path from 'node:path'
import type { Plugin } from 'vite'
import { collectNotices } from '../../../scripts/lib/frontend-notices.ts'
export { collectNotices } from '../../../scripts/lib/frontend-notices.ts'

export function dependencyNotices(): Plugin {
  let root = ''
  return {
    name: 'stream-kit-dependency-notices',
    apply: 'build',
    configResolved(config) { root = config.root },
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap(output => output.type === 'chunk'
        ? Object.entries(output.modules).filter(([, info]) => info.renderedLength > 0).map(([id]) => id) : [])
      // Vite injects browser helpers under virtual module IDs. Tailwind emits
      // CSS rather than a JavaScript module; retain both generators' notices.
      modules.push(path.join(root, 'node_modules/vite/package.json'))
      if (Object.keys(bundle).some(name => name.endsWith('.css'))) modules.push(path.join(root, 'node_modules/tailwindcss/package.json'))
      const packages = collectNotices(root, modules)
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.json', source: JSON.stringify({ schema_version: 1, scope: 'dependencies with rendered code in management JavaScript chunks, plus Vite browser-helper and Tailwind CSS generators', packages }, null, 2) + '\n' })
    },
  }
}

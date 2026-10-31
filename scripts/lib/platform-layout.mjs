import fs from 'node:fs'

// Owned by the native bundle verifier and embedded in the Go executable.
// Packagers must use these same entry points instead of flattening native trees.
const catalog=JSON.parse(fs.readFileSync(new URL('../../orchestrator/internal/bundle/layouts.json',import.meta.url),'utf8'))
export function platformLayout(platform,component) {
  platform=platform==='win32'?'windows':platform
  const layout=catalog[platform]?.[component]
  if(!layout)throw Error(`Unsupported runtime layout: ${platform}/${component}`)
  return {executable:layout.executable,required_files:[...layout.required_files]}
}

import fs from 'node:fs'
import path from 'node:path'

// Owned by the native bundle verifier and embedded in the Go executable.
// Packagers must use these same entry points instead of flattening native trees.
const catalog=JSON.parse(fs.readFileSync(new URL('../../orchestrator/internal/bundle/layouts.json',import.meta.url),'utf8'))
export function platformLayout(platform,component) {
  platform=platform==='win32'?'windows':platform
  const layout=catalog[platform]?.[component]
  if(!layout)throw Error(`Unsupported runtime layout: ${platform}/${component}`)
  return {...layout,required_files:[...layout.required_files]}
}

export function linuxRendererProfile(){
  const layout=platformLayout('linux','sunshine')
  const prefix='/opt/stream-kit/sunshine'
  const definition=path.posix.relative(path.posix.dirname(layout.executable),layout.resources)
  return {prefix,assets:layout.resources,definition,definitions:[
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    `-DCMAKE_INSTALL_BINDIR=${path.posix.dirname(layout.executable)}`,
    '-DCMAKE_INSTALL_LIBDIR=lib',
    `-DSUNSHINE_ASSETS_DIR=${layout.resources}`,
    `-DSUNSHINE_ASSETS_DIR_DEF=${definition}`,
  ]}
}

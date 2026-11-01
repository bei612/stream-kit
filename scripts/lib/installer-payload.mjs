// Both native installers deliver the same three runtime components. Development
// examples and acceptance tooling stay outside the customer's installation.
export function requireRuntimeInstallerPayload(manifest){
  const required=['orchestrator','media-gateway','sunshine']
  const components=manifest.components??[]
  if(components.length!==required.length||required.some(name=>components.filter(item=>item.component===name).length!==1))throw Error('Installer requires exactly the three runtime components; examples are development-only')
  for(const file of manifest.files??[]){
    const parts=file.path.split('/')
    if(file.path!=='README.md'&&!required.includes(parts[0]))throw Error(`Non-runtime installer entry: ${file.path}`)
    if(parts.some(part=>/^(?:example|tests?|__tests__|testdata|node_modules|playwright|\.local|artifacts)$/i.test(part))||/^(?:node|npm|cargo|rustc|go|dotnet|checkerboard|audio-probe|UnrealEditor(?:-Cmd)?)(?:\.exe|\.cmd)?$/i.test(parts.at(-1)))throw Error(`Development-only installer entry: ${file.path}`)
  }
}

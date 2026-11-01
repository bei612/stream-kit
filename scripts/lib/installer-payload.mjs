// Both native installers deliver the same three runtime components. Development
// examples and acceptance tooling stay outside the customer's installation.
export function requireRuntimeInstallerPayload(manifest){
  const required=['orchestrator','media-gateway','sunshine']
  const components=manifest.components??[]
  if(components.length!==required.length||required.some(name=>components.filter(item=>item.component===name).length!==1))throw Error('Installer requires exactly the three runtime components; examples are development-only')
  for(const file of manifest.files??[]){
    const parts=file.path.split('/')
    if(file.path!=='README.md'&&!required.includes(parts[0]))throw Error(`Non-runtime installer entry: ${file.path}`)
    const developmentDirectory=/^(?:examples?|tests?|__tests__|testdata|fixtures|__fixtures__|e2e|coverage|playwright(?:-report)?|test-results|node_modules|\.local|artifacts)$/i
    const developmentProgram=/^(?:node|npm|cargo|rustc|go|dotnet|checkerboard|audio-probe|virtual_device|verify_pair|UnrealEditor(?:-Cmd)?)(?:\.exe|\.cmd)?$/i
    const developmentScript=/^(?:(?:accept|test)-.*\.(?:[cm]?js|ps1|sh)|.*\.(?:test|spec)\.[cm]?[jt]sx?)$/i
    if(parts.some(part=>developmentDirectory.test(part))||developmentProgram.test(parts.at(-1))||developmentScript.test(parts.at(-1)))throw Error(`Development-only installer entry: ${file.path}`)
  }
}

import {linuxRendererProfile} from './lib/platform-layout.mjs'
if(process.argv.length!==3||process.argv[2]!=='linux')throw Error('Expected renderer-build-profile.mjs linux')
process.stdout.write(linuxRendererProfile().definitions.join('\n')+'\n')

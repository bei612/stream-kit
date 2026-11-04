import fs from 'node:fs'
import {promotionProfile,verifyInstallerAcceptance} from './lib/product-release.mjs'
const args=process.argv.slice(2)
if(args.length!==4)throw Error('Expected WINDOWS_MANIFEST LINUX_MANIFEST RELEASE_TAG INSTALLER_ACCEPTANCE')
const windows=JSON.parse(fs.readFileSync(args[0],'utf8'))
verifyInstallerAcceptance(windows,JSON.parse(fs.readFileSync(args[3],'utf8')))
console.log(JSON.stringify(promotionProfile(windows,JSON.parse(fs.readFileSync(args[1],'utf8')),args[2])))

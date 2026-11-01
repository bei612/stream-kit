import fs from 'node:fs'
import {promotionProfile} from './lib/product-release.mjs'
const args=process.argv.slice(2)
if(args.length!==3)throw Error('Expected WINDOWS_MANIFEST LINUX_MANIFEST RELEASE_TAG')
console.log(JSON.stringify(promotionProfile(JSON.parse(fs.readFileSync(args[0],'utf8')),JSON.parse(fs.readFileSync(args[1],'utf8')),args[2])))

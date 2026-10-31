const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '../..');
const engine = process.env.BROWSER_ENGINE || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error(`Unsupported BROWSER_ENGINE: ${engine}`);
const localCache = path.join(root, '.local/playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(localCache)) process.env.PLAYWRIGHT_BROWSERS_PATH = localCache;
const playwright = createRequire(path.join(root, 'third_party/moonlight-web-stream/package.json'))('playwright');

module.exports = {
  engine,
  launchBrowser: () => playwright[engine].launch({headless:true, ...(engine === 'chromium' ? {channel:process.env.BROWSER_CHANNEL || 'chrome'} : {})}),
  evidenceDirectory: base => engine === 'chromium' ? base : path.join(base, engine),
};

// Real browser codec acceptance with the repository decoder and its actual dependencies.
// Synthetic video input; this does not exercise Sunshine, transport, or physical devices.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require('../orchestrator/web/node_modules/typescript');
const {chromium} = createRequire(path.join(root, 'third_party/moonlight-web-stream/package.json'))('playwright');
const web = path.join(root, 'third_party/moonlight-web-stream/web');
const output = path.join(root, 'artifacts/browser-decoder', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, {recursive:true});
const modules = {}, hashes = {};
function load(file) {
  const id = path.relative(web, file).replaceAll('\\', '/');
  if (modules[id]) return id;
  const source = fs.readFileSync(file, 'utf8');
  hashes[id] = crypto.createHash('sha256').update(source).digest('hex');
  const code = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS}}).outputText;
  const dependencies = {}; modules[id] = {code, dependencies};
  for (const match of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (!match[1].startsWith('.')) throw Error(`Unexpected external dependency: ${match[1]}`);
    const base = path.resolve(path.dirname(file), match[1]);
    const target = [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!target || !target.startsWith(web + path.sep)) throw Error(`Unresolved source: ${match[1]}`);
    dependencies[match[1]] = load(target);
  }
  return id;
}
const entry = load(path.join(web, 'stream/video/video_decoder_pipe.ts'));
const canvasEntry = load(path.join(web, 'stream/video/canvas_frame.ts'));
const rendererEntry = load(path.join(web, 'stream/video/canvas.ts'));
const server = http.createServer((_req, res) => {res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Decoder acceptance</title>');});
let browser;
const result = {passed:false, scope:'Native browser H264 encode/decode using repository WebCodecs pipeline; synthetic frames', source_sha256:hashes};
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({headless:true, channel:process.env.BROWSER_CHANNEL || 'chrome'});
  result.browser = browser.version();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  result.verification = await page.evaluate(async ({modules, entry, canvasEntry, rendererEntry}) => {
    const cache = {};
    function requireModule(id) {
      if (cache[id]) return cache[id].exports;
      const module = cache[id] = {exports:{}};
      new Function('exports', 'require', modules[id].code)(module.exports, name => requireModule(modules[id].dependencies[name]));
      return module.exports;
    }
    const {VideoDecoderPipe} = requireModule(entry);
    const {CanvasFrameDrawPipe} = requireModule(canvasEntry);
    const {BaseCanvasVideoRenderer} = requireModule(rendererEntry);
    const check = (value, message) => {if (!value) throw Error(message);};
    const bounded = async promise => {
      let timer;
      try {return await Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(() => reject(Error('Codec operation timed out')), 20000);})]);}
      finally {clearTimeout(timer);}
    };
    const input = new OffscreenCanvas(160, 96), ctx = input.getContext('2d'), units = [], errors = [];
    const encoder = new VideoEncoder({error:error => errors.push(String(error)), output:chunk => {
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      units.push({type:chunk.type, data, timestampMicroseconds:chunk.timestamp, durationMicroseconds:chunk.duration || 33333});
    }});
    try {
      encoder.configure({codec:'avc1.42E01E', width:160, height:96, framerate:30, bitrate:500000, latencyMode:'realtime', avc:{format:'annexb'}});
      for (let i=0;i<6;i++) {
        ctx.fillStyle = i%2 ? '#00ff00' : '#ff0000'; ctx.fillRect(0,0,160,96);
        const frame = new VideoFrame(input, {timestamp:i*33333, duration:33333});
        try {encoder.encode(frame, {keyFrame:i===0});} finally {frame.close();}
      }
      await bounded(encoder.flush());
    } finally {if (encoder.state !== 'closed') encoder.close();}
    check(units.length === 6 && units[0].type === 'key', 'Expected six encoded frames beginning with a keyframe');
    const cases = [];
    for (const [overflow, drawOnSubmit] of [[false,true], [true,true], [false,false], [true,false]]) {
      const received = [], colors = [], canvas = new OffscreenCanvas(160,96), context = canvas.getContext('2d');
      let cleanups = 0, finalFrame;
      const renderer = new BaseCanvasVideoRenderer('native-canvas-acceptance');
      renderer.setCanvas(canvas);
      const originalCleanup = renderer.cleanup.bind(renderer), originalCommit = renderer.commitFrame.bind(renderer);
      renderer.cleanup = () => {cleanups++; originalCleanup();};
      renderer.commitFrame = () => {originalCommit(); colors.push(Array.from(context.getImageData(80,48,1,1).data));};
      const base = new CanvasFrameDrawPipe(renderer, undefined, {drawOnSubmit});
      const originalSubmit = base.submitFrame.bind(base);
      base.submitFrame = frame => {received.push(frame.timestamp); finalFrame=frame; originalSubmit(frame);};
      const pipe = new VideoDecoderPipe(base, {debug(message, info) {if (info?.type === 'fatal') errors.push(message);}});
      try {
        for (const unit of units.slice(0, overflow ? 4 : 3)) pipe.submitDecodeUnit(unit);
        check(pipe.bufferedUnits.length === (overflow ? 0 : 3), 'Startup bound mismatch');
        await bounded(pipe.setup({width:160,height:96,fps:30,codec:'h264'}));
        if (overflow) {
          check(pipe.pollRequestIdr() === true && pipe.pollRequestIdr() === false, 'Expected one recovery request');
          for (const unit of units) pipe.submitDecodeUnit(unit);
        }
        await bounded(pipe.decoder.flush());
        if (!drawOnSubmit) await bounded(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const expected = overflow ? 6 : 3;
        check(received.length === expected, `Expected ${expected} decoded frames, got ${received.length}`);
        check(received.every((time,i) => time === units[i].timestampMicroseconds), 'Frame order mismatch');
        const correctColor = (color,i) => i%2 ? color[1]>180 && color[0]<70 : color[0]>180 && color[1]<70;
        check(colors.length > 0, 'Canvas did not render');
        check(drawOnSubmit ? colors.length === expected && colors.every(correctColor) : correctColor(colors.at(-1), expected-1), 'Decoded pixel colors mismatch');
        cases.push({overflow, drawOnSubmit, frames:received.length, timestamps:received, colors, translator:!!pipe.translator});
      } finally {pipe.cleanup(); pipe.cleanup();}
      check(pipe.decoder.state === 'closed' && cleanups === 1, 'Decoder cleanup mismatch');
      check(finalFrame.format === null && base.currentFrame === null, 'Final canvas frame was not released');
      const draws = colors.length;
      await bounded(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(colors.length === draws, 'Canvas kept drawing after cleanup');
    }
    check(errors.length === 0, errors.join('; '));
    return {encoded_frames:units.length, cases, errors};
  }, {modules, entry, canvasEntry, rendererEntry});
  result.passed = true;
})().catch(error => {result.error = String(error.stack || error); process.exitCode = 1;}).finally(async () => {
  await browser?.close(); server.close();
  result.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result, source_sha256:undefined, output}));
});

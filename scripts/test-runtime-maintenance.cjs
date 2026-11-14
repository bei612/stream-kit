const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {inside,ordinary,inventory,copyTree,commandPath}=require('./maintain-windows-runtime.cjs');

test('maintenance confines paths and verifies real copied bytes without following junctions',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'stream-kit-maintenance-'));
  const temp=fs.realpathSync(os.tmpdir());
  t.after(()=>{assert.ok(path.resolve(base).startsWith(temp+path.sep));fs.rmSync(base,{recursive:true});});
  const source=path.join(base,'source'),outside=path.join(base,'other');
  fs.mkdirSync(source);fs.mkdirSync(outside);fs.mkdirSync(path.join(source,'nested'));
  fs.writeFileSync(path.join(source,'nested','state.bin'),Buffer.alloc(100000,31));
  assert.equal(commandPath(path.join(base,'file.json')),path.join(base,'file.json'));
  assert.equal(commandPath(path.join(base,'with space.json')),'"'+path.join(base,'with space.json')+'"');
  assert.throws(()=>commandPath(path.join(base,'bad"file.json')));
  assert.equal(inside(base,path.join(source,'nested')),path.join(source,'nested'));
  assert.throws(()=>inside(base,base));
  assert.throws(()=>inside(base,path.join(base,'..','escaped')));
  assert.throws(()=>inventory(source,99999));
  const target=path.join(base,'copy');copyTree(source,target,100000);
  assert.deepEqual(inventory(source,100000),inventory(target,100000));
  assert.throws(()=>copyTree(source,target,100000));
  fs.writeFileSync(path.join(target,'nested','state.bin'),Buffer.alloc(100000,32));
  assert.notDeepEqual(inventory(source,100000),inventory(target,100000));
  fs.symlinkSync(outside,path.join(source,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>ordinary(path.join(source,'linked')));
  assert.throws(()=>inventory(source,100000));
});

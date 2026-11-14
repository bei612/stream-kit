const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {inside,ordinary,inventory,copyTree,commandPath,execute,serviceStartTimeout,rendererBootstrap}=require('./maintain-windows-runtime.cjs');

test('maintenance watchdog preserves native startup deadlines and bounded failure metadata',()=>{
  assert.ok(serviceStartTimeout>60000+90000);
  assert.throws(()=>execute(process.execPath,['-e',"process.stderr.write('private-value');process.exit(7)"]),error=>{
    assert.equal(error.commandFailure.exit_code,7);
    assert.ok(!JSON.stringify(error).includes('private-value'));
    assert.ok(!error.message.includes('private-value'));
    return true;
  });
  assert.throws(()=>execute(process.execPath,['-e','setInterval(()=>{},1000)'],undefined,200),error=>{
    assert.equal(error.commandFailure.code,'ETIMEDOUT');
    assert.equal(error.commandFailure.timeout_ms,200);
    assert.ok(error.commandFailure.elapsed_ms<10000);
    return true;
  });
  const child=require('node:child_process').spawnSync(process.execPath,['-e',
    "const {execute}=require('./scripts/maintain-windows-runtime.cjs');try{execute(process.execPath,['-e',\"process.stderr.write('private-value');process.exit(7)\"])}catch{process.exitCode=3}"],
    {cwd:path.join(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,3);
  assert.equal(child.stdout,'');assert.equal(child.stderr,'');
});

test('maintenance confines paths and verifies real copied bytes without following junctions',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'stream-kit-maintenance-'));
  const temp=fs.realpathSync(os.tmpdir());
  t.after(()=>{assert.ok(path.resolve(base).startsWith(temp+path.sep));fs.rmSync(base,{recursive:true});});
  const source=path.join(base,'source'),outside=path.join(base,'other');
  fs.mkdirSync(source);fs.mkdirSync(outside);fs.mkdirSync(path.join(source,'nested'));
  fs.mkdirSync(path.join(source,'sunshine'));
  rendererBootstrap(source);assert.ok(!fs.existsSync(path.join(source,'sunshine','config')));
  rendererBootstrap(source,true);rendererBootstrap(source,true);
  assert.deepEqual(fs.readdirSync(path.join(source,'sunshine','config')),[]);
  fs.writeFileSync(path.join(source,'sunshine','config','state'),'private');
  assert.throws(()=>rendererBootstrap(source,true),/local state/);
  fs.unlinkSync(path.join(source,'sunshine','config','state'));
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

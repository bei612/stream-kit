// Historical mocked scenario harness, excluded from acceptance and CI.
// Actual management checks: accept-management-native.cjs; deployed media checks: accept-management-live.cjs.
const fs=require('fs'),p=require('path'),http=require('http'),assert=require('assert/strict');
const {launchBrowser,engine,evidenceDirectory}=require('./lib/test-browser.cjs');
const root=p.resolve(process.env.ADMIN_DIST || 'orchestrator/web/dist');
let state='stopping';let stops=0;const errors=[];
const app=()=>({id:'fixture',name:'Lifecycle fixture',status:'stopped',args:'--saved',capture_mode:'desktop',source:'local',lifecycle:{session_state:state,can_stop:state!=='stopped',can_launch:state==='stopped',can_edit:state==='stopped'}});
const server=http.createServer((req,res)=>{
 if(req.url.startsWith('/api/')){
  let data={};if(req.url==='/api/v1/apps/fixture')data=app();
  else if(req.url==='/api/v1/apps/fixture/stop'){stops++;if(stops===1){res.statusCode=503;res.setHeader('Content-Type','application/json');setTimeout(()=>res.end(JSON.stringify({status:'error',message:'Native stop not yet confirmed'})),200);return;}state='stopped'}
  else if(req.url==='/api/v1/apps/fixture/watch-link')data={enabled:false,path:''};
  else if(req.url==='/api/v1/apps')data=[app()];
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ok',data}));return;
 }
 const file=req.url.startsWith('/assets/')?p.join(root,req.url):p.join(root,'index.html');
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
(async()=>{let browser;try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await launchBrowser();
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('auth_token','e30.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600}))+'.fixture'));
 await page.goto(`http://127.0.0.1:${server.address().port}/apps/fixture`);
 await page.getByText('观看会话停止待完成').first().waitFor();
 assert.equal(await page.locator('textarea').first().isDisabled(),true);
 await page.getByRole('button',{name:'停止串流（含程序）',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'停止中...',exact:true}).isDisabled(),true);
 await page.getByRole('alert').filter({hasText:'Native stop not yet confirmed'}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('停止串流（含程序）')&&!b.disabled));
 assert.equal(await page.locator('textarea').first().isDisabled(),true);
 await page.getByRole('button',{name:'停止串流（含程序）',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('textarea').disabled);
 await page.locator('textarea').first().fill('--unsaved-draft');
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('ws-event',{detail:{type:'stream_session_state_changed'}})));
 await page.waitForTimeout(300);
 assert.equal(await page.locator('textarea').first().inputValue(),'--unsaved-draft');assert.equal(stops,2);assert.deepEqual(errors,[]);
 const report={passed:true,pending_stop_visible:true,stop_reenables_settings:true,failed_stop_retry:true,draft_preserved_on_refresh:true,page_errors:errors};const output=evidenceDirectory('artifacts/admin-app-lifecycle');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(p.join(output,'result.json'),JSON.stringify({...report,engine,scope:'Built UI with simulated lifecycle API; no production services changed'},null,2));console.log(report);
 }finally{await browser?.close();server.close()}})().catch(e=>{console.error(e);process.exitCode=1});

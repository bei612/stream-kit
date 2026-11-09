// Historical mocked scenario harness, excluded from acceptance and CI.
// Actual management checks: accept-management-native.cjs; deployed media checks: accept-management-live.cjs.
// Built management UI with delayed API responses. No real capability or app.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
const {launchBrowser,engine,evidenceDirectory}=require('./lib/test-browser.cjs');
const root=path.resolve(process.env.ADMIN_DIST||'orchestrator/web/dist');
const held=[],mutations=[],errors=[];
const link=letter=>'/watch#key='+letter.repeat(43);
const reply=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status===200?{status:'ok',data}:{status:'error',message:data}));};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  const match=url.pathname.match(/^\/api\/v1\/apps\/(first|second)(\/watch-link)?$/);
  if(match){
   const id=match[1];
   if(match[2]){
    if(req.method!=='GET')mutations.push({id,method:req.method});
    held.push({id,method:req.method,res});return;
   }
   return reply(res,{id,name:'Watch link '+id,status:'stopped',source:'local',args:'',capture_mode:'desktop',lifecycle:{can_edit:true,can_launch:true,can_stop:false,session_state:'stopped'}});
  }
  return reply(res,{});
 }
 const file=url.pathname.startsWith('/assets/')?path.resolve(root,'.'+url.pathname):path.join(root,'index.html');
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
async function pending(id,method){for(let n=0;n<100;n++){const i=held.findIndex(x=>x.id===id&&x.method===method);if(i>=0)return held.splice(i,1)[0].res;await new Promise(r=>setTimeout(r,20));}throw Error('No expected request '+id+' '+method);}
(async()=>{let browser;const output=evidenceDirectory('artifacts/admin-watch-link');fs.mkdirSync(output,{recursive:true});try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await launchBrowser();const page=await browser.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('auth_token','e30.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600}))+'.fixture'));
 const origin='http://127.0.0.1:'+server.address().port;
 await page.goto(origin+'/apps/first');const initial=await pending('first','GET');
 await page.getByRole('heading',{name:'固定观看链接',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'启用固定链接',exact:true}).isEnabled(),false,'An unresolved read must not allow mutation');
 reply(initial,'Read unavailable',503);await page.getByRole('alert').filter({hasText:'Read unavailable'}).waitFor();
 await page.getByRole('button',{name:'重新读取链接',exact:true}).click();const retry=await pending('first','GET');reply(retry,{enabled:false,path:''});
 await page.getByRole('button',{name:'启用固定链接',exact:true}).click();const oldMutation=await pending('first','POST');assert.equal(await page.getByRole('button',{name:'启用固定链接',exact:true}).isEnabled(),false);
 // SPA navigation retains the browser runtime, so the old mutation still resolves.
 await page.evaluate(()=>{history.pushState({},'', '/apps/second');window.dispatchEvent(new PopStateEvent('popstate'));});
 reply(await pending('second','GET'),{enabled:true,path:link('B')});await page.getByLabel('固定观看链接',{exact:true}).waitFor();reply(oldMutation,{enabled:true,path:link('A')});await page.waitForTimeout(100);
 assert.equal(await page.getByLabel('固定观看链接',{exact:true}).inputValue(),origin+link('B'));
 page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'重置链接',exact:true}).click();reply(await pending('second','PUT'),'Mutation result unknown',503);
 await page.getByRole('alert').filter({hasText:'Mutation result unknown'}).waitFor();assert.equal(await page.getByLabel('固定观看链接',{exact:true}).count(),0,'Unknown mutation must not expose an obsolete URL as current');
 await page.getByRole('button',{name:'重新读取链接',exact:true}).click();reply(await pending('second','GET'),{enabled:true,path:link('C')});await page.getByLabel('固定观看链接',{exact:true}).waitFor();assert.equal(await page.getByLabel('固定观看链接',{exact:true}).inputValue(),origin+link('C'));
 await page.getByRole('button',{name:'关闭链接',exact:true}).click();reply(await pending('second','DELETE'),{enabled:false,path:''});await page.getByRole('button',{name:'启用固定链接',exact:true}).waitFor();assert.equal(await page.getByLabel('固定观看链接',{exact:true}).count(),0);
 assert.deepEqual(mutations,[{id:'first',method:'POST'},{id:'second',method:'PUT'},{id:'second',method:'DELETE'}]);assert.deepEqual(errors,[]);
 const result={passed:true,engine,read_before_mutation:true,late_other_app_ignored:true,unknown_mutation_requires_authoritative_read:true,disable_clears_url:true,scope:'Built UI with delayed isolated API responses, not actual application launch'};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:false,engine,error:e.message},null,2));throw e;}finally{for(const x of held)x.res.destroy();await browser?.close();server.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});

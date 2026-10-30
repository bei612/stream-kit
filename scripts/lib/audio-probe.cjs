const {spawn}=require('node:child_process');
const readline=require('node:readline');

// Owns one native diagnostic child; transport failures reject every pending
// request. No shell, listener, default device or detached process is involved.
function startAudioProbe(executable) {
  const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map(); let nextID=0, ended=false, closing=false, stderr='';
  const lines=readline.createInterface({input:child.stdout});
  const fail=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error)}pending.clear()};
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8192)});
  child.stdin.on('error',fail);
  lines.on('line',line=>{
    let response;
    try {
      response=JSON.parse(line);
      if(!response || typeof response!=='object' || !Number.isSafeInteger(response.id))throw new Error('Invalid response');
    } catch {fail(new Error('Invalid audio probe response'));child.kill();return}
    const item=pending.get(response.id); if(!item)return;
    clearTimeout(item.timer);pending.delete(response.id);
    if(response.schema_version!==1)item.reject(new Error('Unsupported audio probe response version'));
    else item.resolve(response);
  });
  const exited=new Promise(resolve=>{
    child.once('error',error=>{ended=true;fail(error);resolve({error:error.message})});
    child.once('exit',(code,signal)=>{ended=true;fail(new Error(`Audio probe exited (${code ?? signal})`));resolve({code,signal})});
  });
  return {
    command(op, parameters={}) {
      if(ended || closing)return Promise.reject(new Error('Audio probe is closed'));
      return new Promise((resolve,reject)=>{
        const id=++nextID;
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Audio probe timed out: ${op}`))},5000);
        pending.set(id,{resolve,reject,timer});
        try {child.stdin.write(JSON.stringify({schema_version:1,...parameters,id,op})+'\n')}
        catch(error){clearTimeout(timer);pending.delete(id);reject(error)}
      });
    },
    async close() {
      if(!ended && !closing)child.stdin.end();
      closing=true;
      const timer=setTimeout(()=>{if(!ended)child.kill()},5000);
      try {const result=await exited;if(result.code!==0||result.signal)throw new Error(`Audio probe shutdown failed: ${JSON.stringify(result)} ${stderr}`)}
      finally {clearTimeout(timer);lines.close()}
    }
  };
}
module.exports={startAudioProbe};

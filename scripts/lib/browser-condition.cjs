const {setTimeout:delay}=require('node:timers/promises');

// Resolve the browser's async result before deciding whether to poll again.
// A Promise object itself must never satisfy a media-readiness condition.
async function waitForPageCondition(page,predicate,arg,{timeout=30000,interval=100}={}) {
  const deadline=Date.now()+timeout;
  const expired=()=>new Error('Timed out waiting for asynchronous browser condition');
  for(;;) {
    const remaining=deadline-Date.now();
    if(remaining<=0)throw expired();
    let timer;
    try {
      const value=await Promise.race([
        page.evaluate(predicate,arg),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(expired()),remaining)}),
      ]);
      if(value===true)return;
    } finally {clearTimeout(timer)}
    await delay(Math.min(interval,Math.max(0,deadline-Date.now())));
  }
}
module.exports={waitForPageCondition};

// Keep observations distinct from actual frontend disconnect evidence.
const assert=require('node:assert/strict');
async function verifyTcpRetention({expected,read,frontendClosed,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 assert(expected,'Original player TCP tuple is required');
 if(await frontendClosed())throw Error('Gateway recorded an actual player frontend disconnect');
 let observed=await read();
 if(observed!==expected){await wait(150);observed=await read();if(observed!==expected){await wait(150);observed=await read();}}
 if(await frontendClosed())throw Error('Gateway recorded an actual player frontend disconnect');
 assert.equal(observed,expected,'Original player TCP tuple is absent in confirmed OS snapshots');return expected;
}
module.exports={verifyTcpRetention};

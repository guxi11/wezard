import assert from 'node:assert/strict';
import {setup} from './workflow-http-fixture.mjs';

const opts = () => ({topOnly:true, openingMs:123, answerContext:{turn:'human-turn',channel:'chat:group',prefix:'existing progress'},origin:{asker:{who:'user:human',chat:'chat:group'},k:{kind:'chat',channel:'chat:group',turn:'123'}}});
const send = (x, extra={}) => x.post('/peers/tell',{name:'worker',text:'simple answer',answer:'transfer',...extra});
for (const extra of [{receipt:false},{kind:'fyi'},{job:'J'},{node:'node'},{re:'old'},{after:['old']},{chain:false},{answer:'invalid'}]) {
 const x=await setup(opts());
 const r=await send(x,extra);
 assert.ok(r.status===409||r.status===400,JSON.stringify(r));
 assert.equal(x.answers.all().length,0);
 assert.equal(x.injected.length,0);
 x.close();
}
for (const override of [{topOnly:false},{answerContext:undefined},{origin:{k:{kind:'peer',from:'upstream',turn:'old'},asker:{who:'user:human',chat:'chat:group'}}},{origin:{k:{kind:'chat',channel:'chat:group',turn:'123'}}}]) {
 const x=await setup({...opts(),...override});
 assert.equal((await send(x)).status,409);
 assert.equal(x.injected.length,0);
 x.close();
}
{
 const x=await setup(opts());let waits=0;
 x.m.idleNow=async()=>false;x.m.untilIdle=async()=>{waits++;return {idle:true};};
 assert.equal((await send(x,{priority:'urgent'})).status,409);
 assert.equal(waits,0,'busy transfer never waits or interrupts');
 assert.equal(x.answers.all().length,0);
 x.close();
}
{
 const x=await setup(opts());x.m.injectText=async()=>({ok:false,reason:'definite failure'});
 assert.equal((await send(x)).status,502);
 assert.equal(x.answers.all().length,0,'definite failed injection rolls back ownership');
 x.close();
}
{
 const x=await setup(opts());let taken=0;x.m.takeAnswer=()=>taken++;
 const r=await send(x);
 assert.equal(r.status,200,JSON.stringify(r));
 assert.equal(r.body.answer,'transfer');assert.equal(r.body.control,'transfer');
 assert.equal(taken,1);assert.equal(x.injected[0][3].channel,'');
 assert.match(x.injected[0][3].envelope,/回答权与控制权/);
 const row=x.answers.all()[0];
 assert.equal(row.prefix,'existing progress');assert.equal(row.channel,'chat:group');
 assert.equal(row.tell.answerTransfer,r.body.turn);
 assert.equal((await send(x,{name:'second'})).status,409,'same human turn transfers only once');
 assert.equal(x.answers.all().length,1);
 x.close();
}
{
 const x=await setup(opts());x.m.injectText=async()=>({ok:false,uncertain:true,reason:'unknown submit'});
 const r=await send(x);assert.equal(r.status,200);assert.equal(r.body.control,'transfer');
 await Promise.resolve();assert.equal(x.answerDeliveries.length,1);
 assert.equal(x.answerDeliveries[0].out.status,'canceled');
 assert.equal(x.answers.all()[0].state,'delivered');
 x.close();
}
{
 const x=await setup(opts());let enter,release;
 const started=new Promise(r=>enter=r), barrier=new Promise(r=>release=r);
 x.m.idleNow=async()=>{enter();await barrier;return true;};
 const first=send(x);await started;
 assert.equal((await send(x,{name:'second'})).status,409,'concurrent source transfer rejected');
 assert.equal((await x.post('/peers/tell',{name:'second',text:'ordinary child'})).status,409,'ordinary child cannot race transfer');
 release();assert.equal((await first).status,200);
 assert.equal(x.answers.all().length,1);x.close();
}
{
 const x=await setup();
 const r=await x.post('/peers/tell',{name:'worker',text:'old client'});
 assert.equal(r.status,200);assert.equal(r.body.answer,undefined);assert.equal(x.answers.all().length,0);
 x.close();
}
console.log('answer transfer HTTP: eligibility, busy, failure, success, uncertain, concurrency, old client passed');

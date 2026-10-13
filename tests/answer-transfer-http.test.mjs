import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
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
 const x=await setup({...opts(),transportHook:()=>{opts.current={turn:'next-human-turn',channel:'chat:group',prefix:'new progress'};}});
 const original=x.m.answerContext;x.m.answerContext=()=>opts.current??original();
 const r=await send(x);
 assert.equal(r.status,200,'physical exposure preserves the transfer even when submit guard rejects a turn switch');
 assert.equal(x.answers.all()[0].state,'delivered','uncertain exposed paste is terminally reconciled');
 assert.equal(x.answers.all()[0].sourceTurn,'human-turn');
 assert.equal(x.injected.length,0,'submit guard rejects the stale request');
 assert.equal(x.answerDeliveries.length,1,'user receives one explicit uncertainty terminal');
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
{
 const x=await setup({...opts(),lostAnswer:true});let kills=0;x.m.killPane=async()=>{kills++;return {ok:true};};
 const r=await x.post('/wizard/stop',{name:'worker',mode:'end'});
 const interrupted=await x.post('/wizard/stop',{name:'worker',mode:'interrupt'});
 assert.equal(r.status,409,'a source that transferred control cannot end the answer owner');
 assert.equal(interrupted.status,409,'a source that transferred control cannot interrupt the answer owner');
 assert.equal(kills,0);x.close();
}
{
 const x=await setup({openingEnv:{kind:'peer',private:true,turn:'tPinned'}});
 x.answers.reserve({id:'tPinned',source:'owner',target:'worker',sourceTurn:'human',sourceOpening:123,origin:'origin',channel:'chat:group',prefix:'',tell:{from:'owner',to:'worker',channel:'',turn:'tPinned'},state:'reserved'});
 x.answers.activate('tPinned');
 const src=readFileSync('daemon/index.ts','utf8'),start=src.indexOf('    const topOnlyMuted ='),end=src.indexOf('    http.register("POST /notify"',start);
 const code=ts.transpileModule(src.slice(start,end)+'\nreturn topOnlyMuted;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const env={...x.env,tagOfKey:()=> 'worker',kOfAttr:()=>undefined};
 const mute=new Function(...Object.keys(env),code)(...Object.values(env));
 assert.equal(mute('worker',['chat:group']),undefined,'active target owns notification control');
 x.answers.outcome('tPinned',{status:'timeout',body:'timeout'});x.answers.delivering('tPinned');
 assert.equal(mute('worker',['chat:group']).ok,false,'pinned terminal blocks late notify before ACK');
 assert.equal((await x.post('/peers/tell',{name:'other',text:'late child'},'worker')).status,409,'pinned terminal blocks late dispatch before ACK');
 assert.equal(x.injected.length,0);x.close();
}
console.log('answer transfer HTTP: eligibility, busy, failure, success, uncertain, concurrency, old client passed');

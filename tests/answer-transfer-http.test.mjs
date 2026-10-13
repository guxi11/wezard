import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {ConfigSchema} from '../shared/config.ts';
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
 const x=await setup(opts());let taken=0;x.m.takeAnswer=()=>{taken++;return {taken:true};};
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
 const x=await setup({...opts(),openingEnv:{kind:'peer',private:true,turn:'tPinned'}});
 x.answers.reserve({id:'tPinned',source:'owner',target:'worker',sourceTurn:'human-A',sourceOpening:123,origin:'owner\0human-A',channel:'chat:group',prefix:'',tell:{from:'owner',to:'worker',channel:'',turn:'tPinned'},state:'active'});
 let enter,release;const started=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
 x.m.idleNow=async()=>false;x.m.untilIdle=async()=>{enter();await barrier;return {idle:true};};
 const pending=x.post('/peers/tell',{name:'other',text:'ordinary child'},'worker');await started;
 x.answers.outcome('tPinned',{status:'timeout',body:'timeout'});release();
 const result=await pending;assert.equal(result.status,409,'terminal target cannot resume a child tell after its idle wait');
 assert.equal(x.injected.length,0);x.close();
}
{
 let enter,release;const started=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
 const settings={...opts(),idleNow:async()=>{enter();await barrier;return true;}};
 const x=await setup(settings);
 const pending=send(x);await started;
 settings.answerContext={turn:'human-B',channel:'chat:B',prefix:'B'};
 settings.openingMs=456;settings.origin={asker:{who:'user:B',chat:'chat:B'},k:{kind:'chat',channel:'chat:B',turn:'456'}};
 release();assert.equal((await pending).status,409,'transfer cannot adopt a new human turn during target waiting');
 assert.equal(x.answers.all().length,0);assert.equal(x.injected.length,0);x.close();
}
{
 const settings={...opts(),answerContext:()=>settings.current,origin:opts().origin};settings.current={turn:'human-A',channel:'chat:A',prefix:'A'};
 const x=await setup(settings);const first=await x.post('/peers/tell',{name:'worker-A',text:'A',answer:'transfer'});assert.equal(first.status,200);
 settings.current={turn:'human-B',channel:'chat:B',prefix:'B'};settings.origin={asker:{who:'user:B',chat:'chat:B'},k:{kind:'chat',channel:'chat:B',turn:'456'}};
 const second=await x.post('/peers/tell',{name:'worker-B',text:'B',answer:'transfer'});assert.equal(second.status,200,'old receipt from another source turn does not block a new turn');
 assert.deepEqual(x.answers.all().map(r=>r.sourceTurn).sort(),['human-A','human-B']);x.close();
}
{
 const x=await setup({...opts(),answerContext:()=>({turn:'same-ms-turn',channel:'chat:group',prefix:''})});
 assert.equal((await x.post('/peers/tell',{name:'worker-A',text:'A',answer:'transfer'},'router-A')).status,200);
 assert.equal((await x.post('/peers/tell',{name:'worker-B',text:'B',answer:'transfer'},'router-B')).status,200,'different source identities at the same chat millisecond have distinct transfer origins');
 assert.equal(new Set(x.answers.all().map(r=>r.origin)).size,2);x.close();
}
{
 let waiting=0,release;const barrier=new Promise(r=>release=r);let both;
 const ready=new Promise(r=>both=r);
 const settings={...opts(),answerContext:self=>({turn:`human-${self}`,channel:`chat:${self}`,prefix:`prefix-${self}`}),askerOf:self=>({who:`user:${self}`,chat:`chat:${self}`}),parentKOf:self=>({kind:'chat',channel:`chat:${self}`,turn:'same-ms'}),idleNow:async()=>{if(++waiting===2)both();await barrier;return true;}};
 const x=await setup(settings);
 const a=x.post('/peers/tell',{name:'worker-A',text:'A',answer:'transfer'},'router-A');
 const b=x.post('/peers/tell',{name:'worker-B',text:'B',answer:'transfer'},'router-B');await ready;release();
 const [ra,rb]=await Promise.all([a,b]);assert.equal(ra.status,200);assert.equal(rb.status,200);
 const [rowA,rowB]=x.answers.all().sort((l,r)=>l.source.localeCompare(r.source));
 await x.deliverAnswer(rowB.id,{status:'done',body:'answer B'});await x.deliverAnswer(rowA.id,{status:'done',body:'answer A'});
 assert.deepEqual(x.answerDeliveries.map(d=>d.id),[rowB.id,rowA.id],'two sources retain independent ownership when answers complete in reverse order');
 assert.equal(rowA.channel,'chat:router-A');assert.equal(rowB.channel,'chat:router-B');x.close();
}
{
 let waiting=0,release;const barrier=new Promise(r=>release=r);let both;
 const ready=new Promise(r=>both=r);
 const settings={...opts(),answerContext:self=>({turn:`human-${self}`,channel:'chat:group',prefix:''}),askerOf:self=>({who:`user:${self}`,chat:'chat:group'}),parentKOf:()=>({kind:'chat',channel:'chat:group',turn:'same-ms'}),idleNow:async()=>{if(++waiting===2)both();await barrier;return true;}};
 const x=await setup(settings);
 const a=x.post('/peers/tell',{name:'same-worker',text:'A',answer:'transfer'},'router-A');
 const b=x.post('/peers/tell',{name:'same-worker',text:'B',answer:'transfer'},'router-B');await ready;release();
 const results=await Promise.all([a,b]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal(x.answers.all().length,1);assert.equal(x.injected.length,1,'target lock allows one physical injection under barrier contention');x.close();
}
{
 const x=await setup(opts());
 assert.equal((await x.post('/peers/tell',{name:'child',text:'same-turn child'})).status,200);
 assert.equal((await x.post('/peers/tell',{name:'worker',text:'same-turn transfer',answer:'transfer'})).status,409,'same human turn with pending child work cannot transfer answer ownership');
 assert.equal(x.answers.all().length,0);x.close();
}
{
 const settings={...opts(),answerContext:()=>settings.current,origin:opts().origin};settings.current={turn:'human-A',channel:'chat:A',prefix:'A'};
 const x=await setup(settings);
 assert.equal((await x.post('/peers/tell',{name:'child',text:'old-turn child'})).status,200);
 settings.current={turn:'human-B',channel:'chat:B',prefix:'B'};settings.origin={asker:{who:'user:B',chat:'chat:B'},k:{kind:'chat',channel:'chat:B',turn:'456'}};
 assert.equal((await x.post('/peers/tell',{name:'worker',text:'new-turn transfer',answer:'transfer'})).status,200,'prior-turn child does not block a new human turn');
 x.close();
}
{
 const x=await setup({openingEnv:{kind:'peer',private:true,turn:'tPinned'},topOnly:true});
 x.answers.reserve({id:'tPinned',source:'owner',target:'worker',sourceTurn:'human-A',sourceOpening:123,origin:'owner\0human-A',channel:'chat:A',prefix:'',tell:{from:'owner',to:'worker',channel:'',turn:'tPinned'},state:'active'});
 x.answers.activate('tPinned');
 const src=readFileSync('daemon/index.ts','utf8'),start=src.indexOf('    const topOnlyMuted ='),end=src.indexOf('    // ── 给人看的文件',start);
 const code=ts.transpileModule(src.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const sent=[];const env={...x.env,http:{register:(path,fn)=>x.routes.set(path,fn)},channelOf:()=> 'chat:B',chatBaseOf:(_cfg,r)=>r,chatPolicyOf:()=>({topOnly:true}),ensureChatNames:()=>{},chatNameOf:(_cfg,d)=>d,postAs:(_self,dest)=>sent.push(dest),recordPost:()=>{},wx:{owns:()=>false,fresh:()=>true},sameBot:()=>true,tagOfKey:()=> 'worker',baseOfKey:x=>x};
 new Function(...Object.keys(env),code)(...Object.values(env));
 const r=await x.post('/notify',{markdown:'progress for A'},'worker');
 assert.equal(r.status,200);assert.deepEqual(sent,['chat:A'],'implicit notify follows the transferred answer source chat, not the target home chat');x.close();
}
for (const answer of [undefined, 'transfer']) {
 const settings={...opts(),answerContext:()=>settings.current,origin:opts().origin};settings.current={turn:'human-A',channel:'chat:A',prefix:'A'};
 const x=await setup(settings);let enter,release;const started=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
 const src=readFileSync('daemon/index.ts','utf8'),start=src.indexOf('    http.register("POST /dispatch"'),end=src.indexOf('    // 记忆三种作用域',start);
 const code=ts.transpileModule(src.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const env={...x.env,http:{register:(path,fn)=>x.routes.set(path,fn)},routeRowsOf:async()=>{enter();await barrier;return [];},cfg:{wrc:{mirror:{keepalive:{ttlSec:3600}}}},tagOfKey:()=>true,controlSnapshot:self=>({opening:settings.openingMs,turn:x.m.answerContext(self)?.turn}),controlValid:(self,s)=>settings.openingMs===s.opening&&x.m.answerContext(self)?.turn===s.turn&&!x.env.lostAnswer(self)&&!x.env.terminalAnswerTurn(self),hasAnswerChildren:()=>false,peerDispatching:new Map(),parentKOf:()=>settings.origin.k,askerOf:()=>settings.origin.asker,rankCandidates:()=>[],decide:()=>({kind:'existing',why:'test'}),m:{...x.m,getCwd:()=>({runningCwd:''})}};
 new Function(...Object.keys(env),code)(...Object.values(env));
 const pending=x.post('/dispatch',{task:answer?'TASK-FROM-A-TRANSFER':'ORDINARY-TASK-FROM-A',...(answer?{answer}:{})});await started;
 settings.current={turn:'human-B',channel:'chat:B',prefix:'B'};settings.openingMs=456;settings.origin={asker:{who:'user:B',chat:'chat:B'},k:{kind:'chat',channel:'chat:B',turn:'456'}};
 release();assert.equal((await pending).status,409,`dispatch ${answer??'without answer transfer'} keeps A's actor snapshot after routing crosses to B`);
 assert.equal(x.answers.all().length,0);assert.equal(x.injected.length,0);x.close();
}
{
 let enter,release;const started=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
 const settings={...opts(),answerContext:()=>settings.current,peers:async()=>{enter();await barrier;return [];}};settings.current={turn:'human-A',channel:'chat:A',prefix:'A'};
 settings.cfg=ConfigSchema.parse({bot:{botId:'test',secret:'test'},chats:{wezard:'user:admin'}});
 const x=await setup(settings);const birth=x.internal.bearAs('owner',{inherit:false,name:'new',description:'test wizard',tier:'standard'});await started;
 settings.current={turn:'human-B',channel:'chat:B',prefix:'B'};settings.openingMs=456;release();
 assert.equal((await birth).status,409,'spawn preparation cannot cross from caller turn A into B');assert.equal(x.counts().cloneCalls,0);x.close();
}
{
 let enter,release;const started=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
 const settings={...opts(),untilIdle:async()=>{enter();await barrier;return {idle:false};}};
 const x=await setup(settings);
 x.answers.reserve({id:'tPinned',source:'owner',target:'worker',sourceTurn:'human-A',sourceOpening:123,origin:'owner\0human-A',channel:'chat:group',prefix:'',tell:{from:'owner',to:'worker',channel:'',turn:'tPinned'},state:'active'});
 const tell={from:'owner',to:'worker',channel:'',turn:'tPinned',at:Date.now(),answerTransfer:'tPinned'};
 x.receipts.register(tell);
 await started;
 x.receipts.cancel('worker','owner',s=>s.turn==='tPinned');
 assert.equal(x.answers.terminalTarget('worker','tPinned')?.outcome?.status,'canceled','receipt cancel pins terminal answer synchronously');
 release();await new Promise(resolve=>setTimeout(resolve,5));x.close();
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
{
 let enter,release;const started=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
 const settings={openingEnv:{kind:'peer',private:true,turn:'tPinned'},others:async()=>{enter();await barrier;return undefined;}};
 const x=await setup(settings);
 x.answers.reserve({id:'tPinned',source:'owner',target:'worker',sourceTurn:'human-A',sourceOpening:123,origin:'owner\0human-A',channel:'chat:group',prefix:'',tell:{from:'owner',to:'worker',channel:'',turn:'tPinned'},state:'active'});
 const pending=x.post('/wizard/stop',{name:'unrelated',mode:'interrupt'},'worker');await started;
 x.answers.outcome('tPinned',{status:'timeout',body:'timeout'});release();
 assert.equal((await pending).status,409,'stop rechecks terminal target after the othersTurn await');
 assert.equal(x.counts().interruptCalls,0);assert.equal(x.counts().killCalls,0);x.close();
}
{
 let enter,release;const started=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);
 const x=await setup({...opts(),others:async()=>{enter();await barrier;return undefined;}});
 const stop=x.post('/wizard/stop',{name:'unrelated',mode:'interrupt'});await started;
 assert.equal((await send(x)).status,200,'source can transfer while stop is waiting');
 release();assert.equal((await stop).status,409,'source stop rechecks ownership after transfer');
 assert.equal(x.counts().killCalls,0);x.close();
}
console.log('answer transfer HTTP: eligibility, busy, failure, success, uncertain, concurrency, old client passed');

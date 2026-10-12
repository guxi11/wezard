// Real source routes over localhost with controlled transport barriers; no live daemon.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import ts from 'typescript';
import pino from 'pino';
import {createWorkflowNodes,resultDigest} from '../daemon/workflow-nodes.ts';
import {createReceipts,deadlineOf,canonicalTurn} from '../daemon/receipts.ts';
import {parseClosing} from '../daemon/peers.ts';
import {loadJobStore} from '../daemon/jobs.ts';
import {createLedger,pendingGc} from '../daemon/pending-items.ts';
import {loadJsonMap} from '../shared/json-map-store.ts';
const src=readFileSync('daemon/index.ts','utf8');
const start=src.indexOf('    // One durable key per tracked physical dispatch leg');
const end=src.indexOf(' // 老 MCP 进程还在调这个名字',start);
const closeStart=src.indexOf('    http.register("POST /jobs/close"');
const closeEnd=src.indexOf('    // 挂起事项全表',closeStart);
const stopStart=src.indexOf('    http.register("POST /wizard/stop"');
const stopEnd=src.indexOf('    // 换模型',stopStart);
const bootstrapStart=src.indexOf('      handoffs.resume();');
const bootstrapEnd=src.indexOf('      receipts.resume();',bootstrapStart)+'      receipts.resume();'.length;
const bootstrapCode=ts.transpileModule(src.slice(bootstrapStart,bootstrapEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const routeCode=ts.transpileModule(src.slice(start,end)+src.slice(closeStart,closeEnd)+src.slice(stopStart,stopEnd)+'\nreturn {tellPeerAs,recoverWorkflow};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const checkStart=src.indexOf('    const checkJob = ');
const checkEnd=src.indexOf('\n    };',checkStart)+7;
const checkCode=ts.transpileModule(src.slice(checkStart,checkEnd)+'\nreturn checkJob;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const afterStart=src.indexOf('    const afterNote =');
const afterEnd=src.indexOf('    // One durable key per tracked physical dispatch leg',afterStart);
const afterCode=ts.transpileModule(src.slice(afterStart,afterEnd)+'\nreturn afterNote;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const currentAskStart=src.indexOf('    const currentAsk =');
const currentAskEnd=src.indexOf('\n    };',currentAskStart)+7;
const currentAskCode=ts.transpileModule(src.slice(currentAskStart,currentAskEnd)+'\nreturn currentAsk;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const noop=()=>{};
const never=()=>new Promise(()=>{});
const root=mkdtempSync(join(tmpdir(),'workflow-review-'));
const cases=[];
let n=0;
async function setup(options={}){
 const dir=options.dir??join(root,String(++n));
 const workflow=createWorkflowNodes(join(dir,'nodes.json'));
 const afterNote=new Function('workflow','parseClosing','renderReminder','displayName','clipLine',afterCode)(workflow,parseClosing,(_tag,lines)=>lines.join('\n'),x=>x,(s,n)=>s.slice(0,n));
 let jobs=loadJobStore(join(dir,'jobs.json'));
 let job=options.dir?jobs.get('J'):jobs.open('chat','owner','test job',{maxTurns:options.maxTurns});
 // Stable id lets the source fixtures focus on HTTP behavior.
 const jobFile=join(dir,'jobs.json');if(!options.dir)writeFileSync(jobFile,JSON.stringify({J:{...job,id:'J'}}));jobs=loadJobStore(jobFile);
 const removeJob=()=>{writeFileSync(jobFile,'{}');jobs=loadJobStore(jobFile);};
 const jobView=new Proxy({}, {get:(_target,key)=>(...args)=>jobs[key](...args)});
 const ledgerStore=loadJsonMap(join(dir,'pending.json'),pendingGc,{strict:true});
 const ledger=createLedger(ledgerStore);
 let internal;
 const holdStore=loadJsonMap(join(dir,'holds.json'),undefined,{strict:true});
 if(options.hold)holdStore.set('owner\u0000consumer\u0000tHeld',options.hold);
 const outcomeEvents=[];
 const receipts=createReceipts({
   holdStore,
   release:async(h,seen,alive)=>{const r=await internal.tellPeerAs(h.from,h.body,afterNote(h.after,seen,h.from),{turn:h.turn,channel:h.channel,after:h.after,seen:h.seen,alive});options.onRelease?.(r);return {ok:r.status===200,reason:r.body.reason};},
   workflowPrereq:workflow.prereq,log:pino({level:'silent'}),
   idleNow:async()=>false,untilIdle:never,paneLive:async()=>true,
   replyFor:()=>undefined,deliver:async()=>({ok:true}),nameOf:x=>x,
   store:loadJsonMap(join(dir,'receipts.json')),
   onOutcome:(s,status,body)=>{outcomeEvents.push({from:s.from,turn:s.turn,status});workflow.outcome(s.from,s.turn,status,body);}
 });
 const injected=[];const routes=new Map();
 const m={idleNow:async()=>true,untilIdle:async()=>({idle:true}),sessionInfo:()=>undefined,
 injectText:async(...a)=>{if(a[3]?.guard&&!a[3].guard('paste'))return {ok:false,reason:'guard'};if(a[3]?.guard&&!a[3].guard('submit'))return {ok:false,reason:'guard'};injected.push(a);return {ok:true};},interruptPane:async()=>({ok:true}),killPane:async()=>({ok:true})};
 const openingAsk=()=>options.opening;
 const currentAsk=new Function('openingAsk','displayName',currentAskCode)(openingAsk,x=>x);
 const env={canonicalTurn,baseOfKey:x=>x,jobAncestors:()=>[],jobChildren:()=>[],jobEpisode:()=>({name:'owner'}),appendEpisode:()=>true,episodePath:()=>'',episodeName:()=>'',chatNameOf:()=>'',openingAsk,currentAsk,notices:{post:noop},briefOf:()=>({name:'worker'}),forgetWizard:noop,subjectOf:noop,postRoster:noop,sameBot:()=>true,workflow,receipts,jobs:jobView,m,http:{register:(path,fn)=>routes.set(path,fn)},
 readPeerBody:async req=>{let raw='';for await(const c of req)raw+=c;return {self:'owner',body:JSON.parse(raw)};},
 json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));},
 resolvePeer:(_s,t)=>({ok:true,target:t,foreign:false}),addrOf:b=>b.name,askerOf:()=>undefined,parentKOf:()=>undefined,
 checkJob:new Function('jobs','JOB_MEMBER_MAX',checkCode)(jobView,5),checkDirection:()=>undefined,displayName:x=>x,
 afterTurnsOf:b=>[...new Set((b.after??[]).map(x=>String(x).replace(/[`\s]/g,'')))],
 afterNote,channelOf:()=>'',wizards:{get:()=>true},cfg:{daemon:{stateDir:dir}},chatPolicyOf:()=>({topOnly:false}),
 handedOff:async()=>{},othersTurn:async()=>options.others,coldRefused:new Map(),coldGateOf:()=>'',touchOf:()=>0,ttlOf:()=>0,
 peerAddress:(_cfg,_s,t)=>t,roleParam:x=>x,wakeNoteOf:()=>'',deadlineOf,envelopeFor:()=>'',ledger,log:pino({level:'silent'}),relayPeer:noop};
 internal=new Function(...Object.keys(env),routeCode)(...Object.values(env));
 const server=createServer((req,res)=>{const fn=routes.get(req.method+' '+req.url);if(!fn){res.writeHead(404);res.end();return;}Promise.resolve(fn(req,res)).catch(e=>{res.writeHead(500);res.end(e.message)});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const raw=await r.text();let response;try{response=JSON.parse(raw);}catch{response={reason:raw};}return {status:r.status,body:response};};
 return {bootstrap:()=>new Function('workflow','receipts','handoffs','recoverWorkflow','log',bootstrapCode)(workflow,receipts,{resume:noop},internal.recoverWorkflow,pino({level:'silent'})),dir,workflow,receipts,outcomeEvents,jobs,ledgerStore,removeJob,m,injected,post,internal,close:()=>{server.closeAllConnections();server.close();}};
}const tick=()=>new Promise(r=>setTimeout(r,3200));
const prepare=(x,turn='tA',node='build',to='worker')=>{const a=x.workflow.begin('owner','J',node,turn,to,false);x.workflow.recordLeg(a.id,{text:'fixture '+node,at:Date.now(),kind:'task'});x.workflow.intent(a.id,{from:'owner',to,job:'J',channel:'',turn});x.workflow.dispatched(a.id,true);return a;};
const accept=async(x,a,body='RESULT: okay',files)=>{x.workflow.outcome('owner',a.turn,'done',body);const r=await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:resultDigest(body),reason:'reviewed',files});assert.equal(r.status,200,JSON.stringify(r));};
{
 const x=await setup(),a=prepare(x);
 x.receipts.register({from:'owner',to:'worker',job:'J',channel:'',turn:'tA'});
 x.workflow.intent(a.id,{from:'owner',to:'worker',job:'J',channel:'',turn:'tA'});x.workflow.dispatched(a.id,false);
 for(const re of ['tA','`tA`',' \n ` tA ` '])assert.equal((await x.post('/peers/tell',{name:'worker',text:'continue',re,priority:'now'})).status,409);
 assert.equal((await x.post('/peers/tell',{name:'worker',text:'continue',re:'`tA`',node:' ',priority:'now'})).status,400);
 assert.equal(x.injected.length,0);x.close();
}
for(const execution of ['running','needs-input','errored']){
 const out=[];const h={from:'owner',to:'worker',turn:'tA',at:Date.now(),after:['tPre'],body:{name:'worker',text:'ORIGINAL TASK',node:'build',job:'J',force:true,priority:'now'},channel:'',job:'J',seen:{}};
 const x=await setup({hold:h,onRelease:r=>out.push(r)}),pre=prepare(x,'tPre','pre','preworker');await accept(x,pre);
 prepare(x);if(execution!=='running')x.workflow.outcome('owner','tA',execution==='needs-input'?'need':'error','interim body');
 x.bootstrap();await tick();assert.equal(out[0]?.status,200);assert.equal(x.injected.length,0);assert.equal(x.workflow.byTurn('owner','tA').execution,execution);
 assert.ok(x.receipts.pending('owner','worker'),'queued residual hold must not masquerade as watcher');if(execution==='needs-input')assert.equal(x.receipts.pending('owner','worker').need,true,'interim NEED preserved in recovered watcher');x.close();
}
{
 const out=[];const x=await setup({hold:{from:'owner',to:'consumer',turn:'tHeld',at:Date.now(),after:['tLegacy'],body:{name:'consumer',text:'legacy',force:true,priority:'now'},channel:'',job:'',seen:{tLegacy:{to:'worker',status:'done',body:'RESULT: legacy'}}},onRelease:r=>out.push(r)});
 x.receipts.resume();await tick();assert.equal(out[0]?.status,200);assert.equal(x.injected.length,1);x.close();
}
// Interrupt without turn must use the same real opening-round predicate in both ledgers.
for(const round of ['tracked','human','task','receipt','forced-other','legacy-no-turn','end','explicit-turn']){
 const currentOwner=round==='forced-other'?'other':'owner';
 const opening=['human','task','receipt'].includes(round)?undefined:round==='legacy-no-turn'?{from:currentOwner}:{from:currentOwner,turn:'tCurrent'};
 const x=await setup({opening,others:round==='forced-other'?{from:currentOwner,turn:'tCurrent'}:undefined});
 const hasCurrent=!['human','task','receipt'].includes(round);
 const current=hasCurrent?x.workflow.begin(currentOwner,'J','current','tCurrent','worker',true):undefined;
 if(hasCurrent){
 x.workflow.intent(current.id,{from:currentOwner,to:'worker',job:'J',channel:'',turn:'tCurrent'});x.workflow.dispatched(current.id,true);
 x.receipts.register({from:currentOwner,to:'worker',job:'J',channel:'',turn:'tCurrent'});
 }
 const queued=x.workflow.begin('owner','J','queued','tQueued','worker',true);
 const otherQueued=x.workflow.begin('other','J','other-queued','tOtherQueued','worker',true);
 for(const [from,turn] of [['owner','tQueued'],['other','tOtherQueued']]){
  x.receipts.register({from,to:'prerequisite',channel:'',turn:'wait-'+from});
  x.receipts.hold({from,to:'worker',turn,at:Date.now(),after:['wait-'+from],body:{},channel:'',job:'J'});
 }
 let interrupts=0,kills=0;x.m.interruptPane=async()=>{interrupts++;return {ok:true};};x.m.killPane=async()=>{kills++;return {ok:true};};
 x.m.idleNow=async()=>false;
 // Force must cancel the actual other owner's round, not the caller's queued work.
 if(round==='forced-other'){
  assert.equal((await x.post('/wizard/stop',{name:'worker',mode:'interrupt'})).status,409);
  assert.equal(x.workflow.all().some(a=>a.canceled),false);assert.equal(interrupts,0);
 }
 const r=await x.post('/wizard/stop',{name:'worker',mode:round==='end'?'end':'interrupt',force:round==='forced-other',...(round==='explicit-turn'?{turn:'tQueued'}:{})});
 assert.equal(r.status,200,JSON.stringify(r));
 const canceledCurrent=['tracked','forced-other','legacy-no-turn','end'].includes(round);
 const canceledQueued=['legacy-no-turn','end','explicit-turn'].includes(round);
 if(hasCurrent)assert.equal(!!x.workflow.byTurn(currentOwner,current.turn).canceled,canceledCurrent,round+' current tracked');
 assert.equal(!!x.workflow.byTurn('owner',queued.turn).canceled,canceledQueued,round+' queued tracked');
 assert.equal(!!x.workflow.byTurn('other',otherQueued.turn).canceled,round==='end',round+' other queued');
 const receiptStates=x.receipts.states();
 if(hasCurrent)assert.equal(x.outcomeEvents.some(a=>a.from===currentOwner&&a.turn==='tCurrent'&&a.status==='canceled'),canceledCurrent,round+' current legacy receipt');
 for(const [from,turn,canceled] of [['owner','tQueued',canceledQueued],['other','tOtherQueued',round==='end']])assert.equal(receiptStates.some(a=>a.from===from&&a.turn===turn),!canceled,round+' held receipt '+from);
 assert.equal(r.body.canceled??0,Number(canceledCurrent)+Number(canceledQueued)+Number(round==='end'),round+' unique cancellation count');
 assert.equal(kills,round==='end'?1:0);assert.equal(interrupts,['end','explicit-turn'].includes(round)?0:1);x.close();
}
// N1: all held successors share cancellation, even when the successor has no node.
for(const prereqKind of ['tracked','legacy'])for(const barrier of ['idle','paste','submit'])for(const mode of ['end','turn']){
 const releases=[];let released;const completed=new Promise(r=>released=r);
 const x=await setup({onRelease:r=>{releases.push(r);released(r);}});
 let pre;
 if(prereqKind==='tracked')pre=prepare(x,'tPre','pre','preworker');
 else x.receipts.register({from:'owner',to:'preworker',channel:'',turn:'tPre'});
 const parked=await x.post('/peers/tell',{name:'consumer',text:'untracked held effect',job:'J',after:['tPre'],priority:barrier==='idle'?'normal':'now'});
 assert.equal(parked.body.parked,true,JSON.stringify(parked));
 let entered,release;const reached=new Promise(r=>entered=r),paused=new Promise(r=>release=r);
 if(barrier==='idle'){x.m.idleNow=async()=>false;x.m.untilIdle=async(_t,_ms,opts)=>{entered();await paused;return {idle:!opts.aborted()};};}
 else x.m.injectText=async(...a)=>{if(barrier==='submit'){assert.ok(a[3].guard('paste'));x.injected.push(a);}entered();await paused;if(!a[3].guard(barrier))return {ok:false,reason:'hold withdrawn'};x.injected.push(a);return {ok:true};};
 if(pre)await accept(x,pre);
 else x.receipts.register({from:'owner',to:'preworker',channel:'',turn:'tPre'},false); // legacy claimed-done semantics
 await reached;
 const stop=await x.post('/wizard/stop',{name:'consumer',mode:mode==='end'?'end':'interrupt',...(mode==='turn'?{turn:parked.body.turn}:{})});
 assert.equal(stop.status,200,JSON.stringify(stop));assert.equal(stop.body.canceled,1);
 release();const r=await completed;assert.notEqual(r.status,200);
 assert.equal(x.injected.length,barrier==='submit'?1:0,prereqKind+' '+barrier+' '+mode);
 assert.equal(x.receipts.pending('owner','consumer'),undefined,'withdrawn release must not resurrect watcher');
 assert.equal(x.outcomeEvents.filter(a=>a.turn===parked.body.turn&&a.status==='canceled').length,1,'one cancellation outcome per hold');x.close();
}
// N3: real JobStore budget, persistent leg keys, sent/restart and ledger projection.
{
 const x=await setup({maxTurns:1});
 x.m.injectText=async(...a)=>{assert.ok(a[3].guard('paste'));x.injected.push(a);return {ok:true,uncertain:true};};
 const first=await x.post('/peers/tell',{name:'worker',text:'perform one effect',role:'reviewer',job:'J',node:'one',priority:'now'});assert.equal(first.status,409);
 const a=x.workflow.list('owner')[0],key=a.dispatches[0].key;
 assert.equal(x.jobs.get('J').turns,1,'unknown conservatively reserves before delivery');
 assert.equal(x.jobs.get('J').members[0].task,'perform one effect');assert.equal(x.jobs.get('J').members[0].role,'reviewer');
 for(let n=0;n<2;n++)assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'sent',reason:'turn observed'})).status,200);
 assert.equal(x.jobs.get('J').turns,1);assert.deepEqual(x.jobs.get('J').dispatches,[key]);
 x.jobs.settle('J','worker','done');const item=x.ledgerStore.get(a.turn);x.ledgerStore.set(a.turn,{...item,closed:{at:Date.now(),why:'settled'}});
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'sent',reason:'repeat confirmation'})).status,200);
 assert.equal(x.jobs.get('J').members[0].outcome,'done');assert.ok(x.ledgerStore.get(a.turn).closed);
 const y=await setup({dir:x.dir});y.bootstrap();assert.equal(y.jobs.get('J').turns,1);assert.equal(y.jobs.get('J').members[0].outcome,'done');assert.ok(y.ledgerStore.get(a.turn).closed);
 assert.ok(y.receipts.pending('owner','worker'));
 assert.equal((await y.post('/workflow/verdict',{attemptId:a.id,as:'sent',reason:'after restart'})).status,200);
 assert.equal((await y.post('/peers/tell',{name:'second-worker',text:'effect two',job:'J',node:'two',priority:'now'})).status,409);assert.equal(y.injected.length,0);assert.equal(y.jobs.get('J').turns,1);x.close();y.close();
}
{
 const x=await setup({maxTurns:2});
 const r=await x.post('/peers/tell',{name:'worker',text:'original task',job:'J',node:'need',priority:'now'});assert.equal(r.status,200);
 const a=x.workflow.byTurn('owner',r.body.turn);x.workflow.outcome('owner',a.turn,'need','NEED: clarify');x.receipts.register(a.tell,true,{status:'need',body:'NEED: clarify'});
 assert.equal((await x.post('/peers/tell',{name:'worker',text:'clarification',re:a.turn,priority:'now'})).status,200);
 const next=x.workflow.byTurn('owner',a.turn);assert.equal(next.dispatches.length,2);assert.notEqual(next.dispatches[0].key,next.dispatches[1].key);assert.equal(next.dispatches[1].text,'clarification');assert.equal(next.dispatches[1].continuation,true);
 assert.equal(x.jobs.get('J').turns,2);assert.equal(x.jobs.get('J').members[0].task,'original task');
 const y=await setup({dir:x.dir});y.bootstrap();y.bootstrap();assert.equal(y.jobs.get('J').turns,2);assert.equal(y.ledgerStore.get(a.turn).dispatches.length,2);x.close();y.close();
}
{
 const x=await setup({maxTurns:1}),a=x.workflow.begin('owner','J','recover','tRecover','worker',false);
 x.workflow.recordLeg(a.id,{text:'recover complete task',role:'expert',at:Date.now(),kind:'task'});
 x.workflow.intent(a.id,{from:'owner',to:'worker',job:'J',channel:'',turn:a.turn});x.workflow.dispatched(a.id,true);
 // Simulate a confirmed historic injection with missing job/ledger projection.
 const y=await setup({dir:x.dir});y.bootstrap();y.bootstrap();assert.equal(y.jobs.get('J').turns,1);assert.equal(y.jobs.get('J').members[0].task,'recover complete task');assert.equal(y.jobs.get('J').members[0].role,'expert');assert.ok(y.ledgerStore.get(a.turn));assert.ok(y.receipts.pending('owner','worker'));x.close();y.close();
}
{
 const x=await setup({maxTurns:1});let release,entered;let count=0;const reached=new Promise(r=>entered=r),paused=new Promise(r=>release=r);
 x.m.idleNow=async()=>false;x.m.untilIdle=async()=>{if(++count===2)entered();await paused;return {idle:true};};
 const requests=['one','two'].map(node=>x.post('/peers/tell',{name:'worker-'+node,text:node,job:'J',node,priority:'normal'}));await reached;release();
 const results=await Promise.all(requests);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(x.injected.length,1);assert.equal(x.jobs.get('J').turns,1);x.close();
}
{
 const releases=[];const x=await setup({maxTurns:1,onRelease:r=>releases.push(r)}),pre=prepare(x,'tPre','pre','preworker');
 const parked=await x.post('/peers/tell',{name:'consumer',text:'held tracked',job:'J',node:'held',after:['tPre'],priority:'now'});assert.equal(parked.body.parked,true);assert.equal(x.jobs.get('J').turns,1);
 await accept(x,pre);await tick();assert.equal(releases[0]?.status,200);assert.equal(x.jobs.get('J').turns,1);assert.equal(x.workflow.byTurn('owner',parked.body.turn).dispatches.length,1);
 const y=await setup({dir:x.dir});y.bootstrap();assert.equal(y.jobs.get('J').turns,1);x.close();y.close();
}
{
 const x=await setup({maxTurns:1});const a=x.workflow.begin('owner','J','historical','tHistorical','worker',false);
 x.workflow.intent(a.id,{from:'owner',to:'worker',job:'J',channel:'',turn:a.turn});x.workflow.dispatched(a.id,true);
 // First-draft metadata cannot prove whether budget was already charged; never guess.
 const history=x.workflow.all().map(({accountingVersion,...row})=>row);writeFileSync(join(x.dir,'nodes.json'),JSON.stringify(history));
 x.jobs.attach('J',{target:'worker',task:'historical task',spawned:false});x.jobs.spend('J');
 const y=await setup({dir:x.dir});y.bootstrap();assert.equal(y.jobs.get('J').turns,1);assert.equal(y.receipts.pending('owner','worker'),undefined);
 assert.equal((await y.post('/workflow/verdict',{attemptId:a.id,as:'sent',reason:'observed'})).status,409);
 assert.equal((await y.post('/peers/tell',{name:'worker',text:'continue',re:a.turn,priority:'now'})).status,409);
 assert.equal((await y.post('/workflow/verdict',{attemptId:a.id,as:'stopped',reason:'verified old process stopped'})).status,200);assert.equal(y.jobs.get('J').turns,1);assert.equal((await y.post('/peers/tell',{name:'other-worker',text:'new work',node:'new',job:'J',priority:'now'})).status,409);x.close();y.close();
}
for(const fault of ['jobs','pending']){
 const x=await setup({maxTurns:2});const path=join(x.dir,fault+'.json');
 if(fault==='pending')writeFileSync(path,'{}');renameSync(path,path+'.backup');mkdirSync(path);
 const r=await x.post('/peers/tell',{name:'worker',text:'effect',job:'J',node:'failed-'+fault,priority:'now'});
 assert.equal(r.status,409);assert.equal(x.injected.length,0,'strict '+fault+' write failure blocks transport');
 assert.equal(x.receipts.pending('owner','worker'),undefined);
 assert.equal(x.jobs.get('J').turns,fault==='jobs'?0:1,'job reservation is not rolled back after ledger ambiguity');x.close();
}
for(const barrier of ['idle','before-paste','after-paste']){
 const x=await setup();let reached,release;const entered=new Promise(r=>reached=r),paused=new Promise(r=>release=r);
 if(barrier==='idle'){x.m.idleNow=async()=>false;x.m.untilIdle=async(_t,_ms,opts)=>{reached();await paused;return {idle:!opts.aborted()};};}
 else x.m.injectText=async(...a)=>{if(barrier==='after-paste'){assert.ok(a[3].guard('paste'));x.injected.push(a);}reached();await paused;if(!a[3].guard(barrier==='after-paste'?'submit':'paste'))return {ok:false,reason:'canceled guard'};x.injected.push(a);return {ok:true};};
 const request=x.post('/peers/tell',{name:'worker',text:'effect',job:'J',node:'build',priority:barrier==='idle'?'normal':'now'});await entered;
 const query=await x.post('/workflow/nodes',{});assert.equal(query.body.nodes.length,1);
 assert.equal((await x.post('/jobs/close',{job:'J',as:'cancel'})).status,200);
 release();const result=await request;assert.notEqual(result.status,200);assert.equal(x.injected.length,barrier==='after-paste'?1:0);
 const a=x.workflow.list('owner')[0];assert.equal(a.execution,barrier==='after-paste'?'dispatch-unknown':'terminal');
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'stopped',reason:'verified stopped'})).status,200);
 x.removeJob();assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'stopped',reason:'still stopped, job deleted'})).status,200);x.close();
}
{
 const x=await setup();let reached,release;const entered=new Promise(r=>reached=r),paused=new Promise(r=>release=r);
 x.m.injectText=async(...a)=>{reached();await paused;if(!a[3].guard('paste'))return {ok:false,reason:'guard'};x.injected.push(a);return {ok:true};};
 const pending=x.post('/peers/tell',{name:'worker',text:'effect',job:'J',node:'build',priority:'now'});await entered;
 assert.equal((await x.post('/wizard/stop',{name:'worker',mode:'interrupt',turn:x.workflow.list('owner')[0].turn})).status,200);
 release();assert.notEqual((await pending).status,200);assert.equal(x.injected.length,0);x.close();
}
{
 const x=await setup(),a=prepare(x),artifact=join(x.dir,'artifact.txt');writeFileSync(artifact,'v1');
 const body='RESULT: built\nARTIFACT: '+artifact+' — output';x.workflow.outcome('owner','tA','done',body);
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:resultDigest(body),reason:'reviewed'})).status,409);
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:resultDigest(body),reason:'reviewed',files:[{path:artifact,sha256:resultDigest('v1')}]})).status,200);
 const snapshot=x.workflow.byTurn('owner','tA').files[0].snapshot;assert.equal(readFileSync(snapshot,'utf8'),'v1');
 const positive=await x.post('/peers/tell',{name:'consumer',text:'consume accepted version',after:['tA'],priority:'now'});assert.equal(positive.status,200);assert.ok(x.injected[0][3].envelope.includes('ARTIFACT: '+snapshot));x.injected.length=0;
 x.m.injectText=async(...a)=>{await Promise.resolve();writeFileSync(artifact,'v2');if(!a[3].guard('paste'))return {ok:false,reason:'version changed'};x.injected.push(a);return {ok:true};};
 const r=await x.post('/peers/tell',{name:'consumer',text:'consume',after:['tA'],priority:'now'});assert.notEqual(r.status,200);assert.equal(x.injected.length,0);assert.equal(readFileSync(snapshot,'utf8'),'v1');x.close();
}
{
 const x=await setup(),a=prepare(x);
 x.workflow.outcome('owner','tA','need','NEED: clarify');
 x.receipts.register({from:'owner',to:'worker',job:'J',channel:'',turn:'tA'},true,{status:'need',body:'NEED: clarify'});
 assert.equal((await x.post('/peers/tell',{name:'worker',text:'answer input',re:' ` tA ` ',priority:'now'})).status,200);
 assert.equal(x.workflow.byTurn('owner','tA').id,a.id);assert.equal(x.injected.length,1);x.close();
}
{
 const x=await setup(),a=prepare(x);await accept(x,a);
 let reached,release;const entered=new Promise(r=>reached=r),paused=new Promise(r=>release=r);
 x.m.idleNow=async()=>false;x.m.untilIdle=async()=>{reached();await paused;return {idle:true};};
 const req=x.post('/peers/tell',{name:'consumer',text:'consume text',after:['tA'],priority:'normal'});await entered;
 assert.equal((await x.post('/jobs/close',{job:'J',as:'cancel'})).status,200);
 // Completed text is still an accepted result; a successor outside that job is permitted.
 release();assert.equal((await req).status,200);x.close();
}
{
 const x=await setup();x.m.injectText=async(...a)=>{assert.ok(a[3].guard('paste'));x.injected.push(a);return {ok:true,uncertain:true};};
 const r=await x.post('/peers/tell',{name:'worker',text:'effect',job:'J',node:'build',priority:'now'});assert.equal(r.status,409);
 const a=x.workflow.list('owner')[0];assert.equal(a.execution,'dispatch-unknown');
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'sent',reason:'turn observed in transcript'})).status,200);assert.equal(x.injected.length,1,'sent reconciliation never repastes');x.close();
}
{
 const x=await setup(),a=prepare(x),first=join(x.dir,'first.txt'),second=join(x.dir,'second.txt');writeFileSync(first,'first');writeFileSync(second,'second');
 const body='RESULT: two outputs\nARTIFACT: '+first+' — first\nARTIFACT: '+second+' — second';x.workflow.outcome('owner','tA','done',body);
 const params={attemptId:a.id,as:'accepted',digest:resultDigest(body),reason:'checked both',files:[{path:first,sha256:resultDigest('first')}]};
 assert.equal((await x.post('/workflow/verdict',params)).status,409,'partial artifact evidence is insufficient');
 params.files.push({path:second,sha256:resultDigest('second')});assert.equal((await x.post('/workflow/verdict',params)).status,200);x.close();
}

// A turn survives NEED/re, but its receipt must advance to the exact dispatch leg.
for(const recovery of ['sent','restart']){
 const x=await setup({maxTurns:1});
 const first=await x.post('/peers/tell',{name:'worker',text:'original',job:'J',node:'one',priority:'now'});
 const original=x.workflow.byTurn('owner',first.body.turn);
 x.workflow.outcome('owner',original.turn,'need','NEED: clarify');
 x.receipts.register(original.tell,true,{status:'need',body:'NEED: clarify'});
 x.m.injectText=async(...args)=>{assert.ok(args[3].guard('paste'));x.injected.push(args);return {ok:true,uncertain:true};};
 const continued=await x.post('/peers/tell',{name:'worker',text:'answer the one NEED',re:original.turn,priority:'now'});
 assert.equal(continued.status,409);assert.equal(x.jobs.get('J').turns,2);
 const latest=x.workflow.byTurn('owner',original.turn);
 assert.notEqual(latest.tell.dispatchKey,original.tell.dispatchKey);
 let current=x;
 if(recovery==='sent') assert.equal((await x.post('/workflow/verdict',{attemptId:original.id,as:'sent',reason:'latest input observed'})).status,200);
 else {
  // Crash after the latest leg is confirmed, before its old receipt is replaced.
  x.workflow.verdict('owner',original.id,'sent',undefined,'latest input observed');
  current=await setup({dir:x.dir});current.bootstrap();
 }
 assert.equal(current.receipts.pending('owner','worker').need,false,'old NEED must not survive a new sent leg');
 const receiptFile=join(x.dir,'receipts.json');
 const slot=()=>Object.values(JSON.parse(readFileSync(receiptFile,'utf8'))).find(s=>s.turn===original.turn);
 assert.equal(slot().dispatchKey,latest.tell.dispatchKey);assert.equal(slot().at,latest.tell.at);assert.equal(slot().deadlineAt,latest.tell.deadlineAt);
 const gen=slot().gen;
 assert.equal((await current.post('/workflow/verdict',{attemptId:original.id,as:'sent',reason:'same latest input observed again'})).status,200);
 current.bootstrap();assert.equal(slot().gen,gen,'same-leg recovery does not reset watcher/deadline');
 const forbidden=await current.post('/peers/tell',{name:'worker',text:'no new NEED exists',re:original.turn,priority:'now'});
 assert.equal(forbidden.status,409);assert.equal(current.jobs.get('J').turns,2);assert.equal(x.injected.length,2);
 // A genuine interim result already attached to this leg must not be cleared.
 current.receipts.register(latest.tell,true,{status:'need',body:'NEED: genuinely new question'});
 assert.equal((await current.post('/workflow/verdict',{attemptId:original.id,as:'sent',reason:'same leg; retain observed outcome'})).status,200);
 assert.equal(current.receipts.pending('owner','worker').need,true);
 current.close();if(current!==x)x.close();
}
// Strict hold mutations publish only after persistence. A fault also revokes
// closures already inside transport, even when the successor has no node.
await Promise.all([true,false].flatMap(tracked=>['set','seen','drop'].map(async failure=>{
 const releases=[];const x=await setup({maxTurns:1,onRelease:r=>releases.push(r)});x.bootstrap();
 x.receipts.register({from:'owner',to:'preworker',channel:'',turn:'tPre'});
 const failStore=()=>{const file=join(x.dir,'holds.json');if(!existsSync(file))writeFileSync(file,'{}');renameSync(file,file+'.backup');mkdirSync(file);};
 const request={name:'consumer',text:'hold fault must not dispatch',job:'J',...(tracked?{node:'held'}:{}),after:['tPre'],priority:'now'};
 let entered,release;
 const reached=new Promise(r=>entered=r),paused=new Promise(r=>release=r);
 if(failure==='drop')x.m.injectText=async(...a)=>{entered();await paused;if(!a[3].guard('paste'))return {ok:false,reason:'hold write fault'};x.injected.push(a);return {ok:true};};
 if(failure==='set'){
  failStore();await assert.rejects(x.internal.tellPeerAs('owner',request));
  assert.ok(!x.receipts.states().some(s=>s.to==='consumer'),'unpersisted hold must not be published');
 }else{
  assert.equal((await x.post('/peers/tell',request)).body.parked,true);
  if(failure==='seen')failStore();
 }
 x.receipts.register({from:'owner',to:'preworker',channel:'',turn:'tPre'},false);
 if(failure==='drop'){
  await reached;failStore();
  assert.equal((await x.post('/wizard/stop',{name:'consumer',mode:'end'})).status,500,'failed durable cancel must not claim success');
  release();
 }
 await new Promise(r=>setTimeout(r,6500));
 assert.equal(x.injected.length,0,`${tracked?'tracked':'legacy'} ${failure} failure must not dispatch`);
 assert.equal(x.receipts.pending('owner','consumer'),undefined,'failed hold cannot recreate watcher');
 assert.equal(x.jobs.get('J').turns??0,failure==='set'&&!tracked?0:1,'failed reservation cannot become uncharged execution');
 assert.equal(x.outcomeEvents.filter(e=>e.turn!=='tPre').length,0,'failed drop cannot announce successful cancellation');
 assert.ok(releases.every(r=>r.status!==200));x.close();
})));
console.log('workflow HTTP: canonical re, residual recovery, all held cancellation barriers, scoped stop, real JobStore budget/restart/NEED/held/concurrency/strict failures, file version guard passed');
process.exit(0);

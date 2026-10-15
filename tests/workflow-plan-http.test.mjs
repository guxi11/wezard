// Actual daemon plan wiring, bearAs/tellPeerAs/verdict/close routes and stores;
// only pane, transcript and CLI creation effects are controlled.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {setup} from './workflow-http-fixture.mjs';
import {createWorkflowPlanRunner} from '../daemon/workflow-plans.ts';
import {registerWorkflowPlanRoutes} from '../daemon/workflow-plan-http.ts';
import {ConfigSchema} from '../shared/config.ts';
import {pickTier} from '../shared/model-tiers.ts';
import {parseEffort,EFFORTS} from '../shared/effort.ts';
import {newTurn} from '../daemon/receipts.ts';
import {checkDirection} from '../daemon/direction.ts';
import {resultDigest} from '../daemon/workflow-nodes.ts';
import {WorkflowPlanInputSchema} from '../shared/workflow-plan.ts';
import {z} from 'zod';
import {baseOfKey,tagOfKey,keyOf,uniqueTag,normalizeTag,tagFromCwd} from '../shared/session-label.ts';
import {loadJsonMap} from '../shared/json-map-store.ts';
import {startGraph,validateSpec} from '../daemon/graph.ts';
const source=readFileSync('daemon/index.ts','utf8');
const start=source.indexOf('    const bearAs =');
const end=source.indexOf('    http.register("POST /wizard/clone"',start);
const birthCode=ts.transpileModule(source.slice(start,end)+'\nreturn {bearAs,planRunner};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const wait=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.ok(predicate(),'expected event did not occur');};
const barrier=()=>{let enter,release;return {entered:new Promise(r=>enter=r),pause:new Promise(r=>release=r),enter:()=>enter(),release:()=>release()};};
async function fixture(options={}){
 const setupOptions={...options,direction:checkDirection};
 const x=await setup(setupOptions);
 const registry=new Map(),spawned=[],errors=[];
 const cfg=ConfigSchema.parse({bot:{botId:'fixture',secret:'fixture'},wrc:{defaultCli:'codex',mirror:{cloneMax:5}},models:{backends:{codex:{tiers:{light:{model:'fixture-light',effort:'medium'},hard:{model:'fixture-hard',effort:'high'}}}}}});
 const names=new Map();
 const env={...x.env,cfg,parseEffort,EFFORTS,pickTier,existsSync:()=>false,expandHome:s=>s,newTurn,baseOfKey,tagOfKey,keyOf,uniqueTag,normalizeTag,tagFromCwd,childrenOf:()=>[],listPending:()=>[],chatBaseOf:()=>'',chatNamesFor:()=>[],
   charterFor:()=>'',BOOT_ID:'fixture',
   wizards:Object.assign(x.env.wizards,{get:t=>registry.get(t),byName:n=>[...registry.values()].find(w=>w.name===n),all:()=>[...registry.values()],upsert:(t,v)=>registry.set(t,{...registry.get(t),...v,target:t}),drop:t=>registry.delete(t),rename:(t,n)=>{registry.set(t,{...registry.get(t),target:t,name:n});names.set(n,t);return n;}}),
   createWorkflowPlanRunner,registerWorkflowPlanRoutes,errText:e=>String(e),
   tellPeerAs:x.internal.tellPeerAs,advancePlans:()=>{},
 };
 // The route fixture already bound these references; real registry is unnecessary
 // for private delivery. Planned peers resolve by globally unique recorded name.
 setupOptions.resolvePeer=(_self,name)=>({ok:true,target:names.get(normalizeTag(name))??name,foreign:false});
 x.m.chatTargets=()=>[];
 x.m.peers=async()=>[];
 x.m.currentChannel=()=>'';
 x.m.isBusy=async()=>false;
 x.m.lastText=()=> 'RESULT: legacy graph';
 x.m.newSession=async(target,name,cli,opts)=>{if(opts?.guard&&!opts.guard())return {ok:false,reason:'guard'};spawned.push({target,windowName:name,...opts});return {ok:true,cwd:opts?.cwd};};
 const claimStart=source.indexOf('    const claimSlot ='),claimEnd=source.indexOf('    // ── 给人看的消息',claimStart);
 const claimCode=ts.transpileModule(source.slice(claimStart,claimEnd)+'\nreturn claimSlot;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const claimEnv={...env,displace:async()=>false};
 env.claimSlot=new Function(...Object.keys(claimEnv),claimCode)(...Object.values(claimEnv));
 x.m.restored=Promise.resolve();
 x.m.cloneSession=async(args)=>{
   if(args.guard&&!args.guard('paste'))return {ok:false,reason:'guard',inherited:false};
   spawned.push(args);
   if(options.spawnBarrier&&spawned.length===1){options.spawnBarrier.enter();await options.spawnBarrier.pause;}
   if(options.spawnFailure)return {ok:false,reason:'controlled spawn failure',inherited:false};
   return {ok:true,inherited:false,sessionId:'fixture-'+args.windowName,cwd:args.cwd,model:args.model,effort:args.effort};
 };
 env.log={...x.env.log,error:(...args)=>errors.push(args),info:()=>{},warn:()=>{}};
 env.log.child=()=>env.log;
 delete env.planRunner;
 const internal=new Function(...Object.keys(env),birthCode)(...Object.values(env));
 const lifecycleStart=source.indexOf('    const planContinuationAllowed ='),lifecycleEnd=source.indexOf('    const receipts = createReceipts',lifecycleStart);
 const lifecycleCode=ts.transpileModule(source.slice(lifecycleStart,lifecycleEnd)+'\nreturn planContinuationAllowed;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const continuationAllowed=new Function(...Object.keys(env),lifecycleCode)(...Object.values(env));
 const routeEnv={...env,...internal,readBody:async req=>{let raw='';for await(const c of req)raw+=c;return JSON.parse(raw);},resolveSelf:b=>b.target??'owner',startGraph,validateSpec,notifyChat:()=>{}};
 const graphStart=source.indexOf('    http.register("POST /graph/run"'),graphEnd=source.indexOf('    http.register("GET /graph/status"',graphStart);
 const legacyStart=source.indexOf('    http.register("POST /sessions/new"'),legacyEnd=source.indexOf('    // One-shot project switch',legacyStart);
 const cloneEnd=source.indexOf('    // 收掉一个 wizard',end);
 const scheduleStart=source.indexOf('    scheduledTaskInject = async'),scheduleEnd=source.indexOf('    // 记忆整理者的一轮',scheduleStart);
 const scheduleCode=ts.transpileModule('let scheduledTaskInject;\n'+source.slice(scheduleStart,scheduleEnd)+'\nreturn scheduledTaskInject;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const scheduleEnv={...routeEnv,tasks:{get:()=>({owner:'owner'})},ownerOf:()=> 'owner',renderTaskEnvelope:()=>'',TASK_POSTPONE_MS:100,TASK_QUIET_WAIT_MS:100,loadJsonMap,join,settleName:()=> 'owner',withTagHeader:(_t,text)=>text,waitForIdle:async()=>({idle:false})};
 const scheduledInject=new Function(...Object.keys(scheduleEnv),scheduleCode)(...Object.values(scheduleEnv));
 const extraCode=ts.transpileModule(source.slice(graphStart,graphEnd)+source.slice(legacyStart,legacyEnd)+source.slice(end,cloneEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 new Function(...Object.keys(routeEnv),extraCode)(...Object.values(routeEnv));
 x.setRunner(internal.planRunner);
 await Promise.resolve();
 const create=async(nodes=[{id:'collect',task:'Collect fixed text',tier:'light'},{id:'review',task:'Review evidence',tier:'hard',after:['collect']}])=>{
  const r=await x.post('/workflow/plans/create',{version:1,job:'J',cwd:x.dir,nodes});assert.equal(r.status,200,JSON.stringify(r));return r.body.run.id;
 };
 const run=id=>internal.planRunner.status('owner',id);
 const current=id=>x.workflow.byTurn('owner',run(id).nodes.find(n=>n.attempt?.execution==='running')?.turn);
 const finish=async(id,body='RESULT: reviewed')=>{
  const a=current(id);assert.ok(a);x.workflow.outcome('owner',a.turn,'done',body);
  const r=await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:resultDigest(body),reason:'independently checked'});assert.equal(r.status,200,JSON.stringify(r));return a;
 };
 return {...x,...internal,spawned,errors,registry,scheduledInject,continuationAllowed,create,run,current,finish};
}
// MCP publishes strict object schemas too (the SDK's default raw shape strips
// unknown root keys). Test the registrations from source rather than a mirror.
{
 const src=readFileSync('mcp/server.ts','utf8'),begin=src.indexOf('registerTool("workflow_plan_create"'),end=src.indexOf('server.registerTool("workflow_verdict"',begin);
 const entries=new Map();new Function('registerTool','WorkflowPlanInputSchema','z','unwrap','daemonPost',src.slice(begin,end))((name,cfg,fn)=>entries.set(name,{cfg,fn}),WorkflowPlanInputSchema,z,()=>{},()=>{});
 assert.equal(entries.get('workflow_plan_create').cfg.inputSchema.safeParse({version:1,job:'J',cwd:'/tmp',nodes:[{id:'a',task:'x',tier:'mini'}],unknown:true}).success,false);
 assert.equal(entries.get('workflow_plan_status').cfg.inputSchema.safeParse({run:'w',unknown:true}).success,false);
 assert.equal(entries.get('workflow_plan_cancel').cfg.inputSchema.safeParse({run:'w',reason:'x',unknown:true}).success,false);
}

// Complete collect -> review; tier selection uses the real resolver. done alone
// cannot birth the reviewer, and completed history survives normal job archive.
{
 const x=await fixture({maxTurns:2}),id=await x.create();await wait(()=>x.injected.length===1);
 assert.equal(x.spawned.length,1);assert.equal(x.spawned[0].model,'fixture-light');assert.equal(x.spawned[0].inherit,false);assert.equal(x.spawned[0].bootstrap,undefined);
 const a=x.current(id);x.workflow.outcome('owner',a.turn,'done','RESULT: tests failed');x.planRunner.kick();await new Promise(r=>setTimeout(r,10));assert.equal(x.spawned.length,1);assert.equal(x.run(id).nodes[0].state,'validating');
 for(const caller of ['intruder','owner']){
  const r=await x.post('/peers/tell',{name:x.run(id).nodes[0].name,text:'pollute',job:'J',node:'other'},caller);assert.equal(r.status,409);
 }
 assert.equal((await x.post('/workflow/plans/status',{run:id},'intruder')).status,409);
 assert.equal((await x.post('/workflow/plans/cancel',{run:id,reason:'foreign'},'intruder')).status,409);
 assert.equal((await x.bearAs('owner',{name:'outside',description:'outside',inherit:false,job:'J',task:'pollute'})).status,409);
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:a.digest,reason:'wrong'})).status,409);
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:resultDigest('RESULT: tests failed'),reason:'owner checked actual evidence'})).status,200);
 await wait(()=>x.injected.length===2);assert.equal(x.spawned[1].model,'fixture-hard');assert.ok(x.injected[1][3].envelope.includes('tests failed'));
 await x.finish(id);await wait(()=>x.run(id).state==='completed');
 assert.equal(x.jobs.get('J').turns,2);assert.equal(new Set(x.jobs.get('J').dispatches).size,2);assert.equal(x.jobs.get('J').members.length,2);
 assert.equal((await x.post('/jobs/close',{job:'J',summary:'complete'})).status,200);assert.equal(x.run(id).state,'completed');
 assert.equal((await x.post('/workflow/plans/create',{version:1,job:'J',cwd:x.dir,nodes:[{id:'recover',task:'x',tier:'light'}]})).body.existingRun,id,'lost response recovery survives job archive');
 assert.equal((await x.post('/workflow/plans/cancel',{run:id,reason:'too late'})).status,409);x.close();
}
// The real onOutcome hook triggers fail-fast without a status-driven scheduler.
{
 const x=await fixture(),id=await x.create();await wait(()=>x.injected.length===1);const a=x.current(id);
 x.receipts.cancel(a.to,'owner',s=>s.turn===a.turn);
 await wait(()=>x.run(id).state==='failed');assert.equal(x.spawned.length,1);assert.equal(x.run(id).nodes[1].state,'skipped');x.close();
}
// Creation/status are scoped and strict, status performs no dispatch when stopped.
{
 const x=await fixture({maxTurns:2});x.planRunner.stop();
 assert.equal((await x.post('/workflow/plans/create',{version:1,job:'J',cwd:x.dir,nodes:[{id:'a',task:'x',tier:'light'}]},'intruder')).status,409);
 assert.equal((await x.post('/workflow/plans/create',{version:1,job:'J',cwd:x.dir,nodes:[{id:'a',task:'x',tier:'light',unknown:true}]})).status,400);
 assert.equal((await x.post('/workflow/plans/create',{version:1,job:'J',cwd:x.dir,nodes:[{id:'a',task:'x',tier:'light'}],unknown:true})).status,400);
 const id=await x.create();assert.equal((await x.post('/workflow/plans/status',{run:id})).status,200);assert.equal(x.spawned.length,0);
 const duplicate=await x.post('/workflow/plans/create',{version:1,job:'J',cwd:x.dir,nodes:[{id:'other',task:'x',tier:'light'}]});
 assert.equal(duplicate.status,409);assert.equal(duplicate.body.existingRun,id,'lost create response can recover run by same owner job');
 assert.equal((await x.post('/workflow/plans/status',{run:duplicate.body.existingRun})).body.run.plan.nodes[0].id,'collect','duplicate does not replace immutable plan');
 x.planRunner.start();await wait(()=>x.injected.length===1);x.close();
}
// Plan ownership cannot race a legacy bootstrap that has not attached its member.
{
 const pause=barrier(),x=await fixture({spawnBarrier:pause});
 const old=x.bearAs('owner',{name:'legacy',description:'legacy',inherit:false,job:'J',task:'legacy task'});await pause.entered;
 const request={version:1,job:'J',cwd:x.dir,nodes:[{id:'a',task:'x',tier:'light'}]};
 assert.equal((await x.post('/workflow/plans/create',request)).status,409);assert.equal(x.planStore.all().length,0);
 pause.release();assert.equal((await old).status,200);assert.equal(x.env.pendingBirthJobs.size,0);x.close();
}
// Cancellation while birth awaits cannot send the task; keep born identity for cleanup.
{
 const pause=barrier(),x=await fixture({spawnBarrier:pause}),id=await x.create();await pause.entered;
 const reserved=x.run(id).nodes[0].name;
 assert.equal((await x.bearAs('intruder',{name:reserved,description:'hijack',inherit:false})).status,409);
 assert.equal((await x.post('/peers/tell',{name:reserved,text:'hijack early birth'})).status,409);
 assert.equal((await x.post('/workflow/plans/cancel',{run:id,reason:'stop before task'})).status,200);pause.release();
 await wait(()=>x.run(id).nodes[0].to);assert.equal(x.injected.length,0);assert.equal(x.run(id).state,'canceled');
 x.planRunner.kick();assert.equal(x.spawned.length,1);x.close();
}
// Accepted file versions are rechecked on actual delivery, and the consumer sees
// the readonly snapshot. Changed versions invalidate a completed run on read.
for(const change of [false,true]){
 const x=await fixture(),id=await x.create();await wait(()=>x.injected.length===1);const a=x.current(id),file=join(x.dir,'evidence.txt');writeFileSync(file,'evidence-v1');
 const body='RESULT: collected\nARTIFACT: '+file+' — fixed evidence';x.workflow.outcome('owner',a.turn,'done',body);
 if(change)x.m.injectText=async(...args)=>{writeFileSync(file,'evidence-v2');if(!args[3].guard('paste'))return {ok:false,reason:'version changed'};x.injected.push(args);return {ok:true};};
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:resultDigest(body),reason:'file checked',files:[{path:file,sha256:resultDigest('evidence-v1')}]})).status,200);
 if(change){await wait(()=>x.run(id).state==='failed');assert.equal(x.injected.length,1);assert.equal(x.spawned.length,2);}
 else{
  await wait(()=>x.injected.length===2);const snapshot=x.workflow.byTurn('owner',a.turn).files[0].snapshot;assert.ok(x.injected[1][3].envelope.includes(snapshot));
  await x.finish(id);await wait(()=>x.run(id).state==='completed');writeFileSync(file,'evidence-v2');
  const r=await x.post('/workflow/plans/status',{run:id});assert.equal(r.body.run.state,'invalidated');assert.equal(r.body.run.recordedState,'completed');assert.equal(r.body.run.versionsValid,false);
 }
 x.close();
}
// Both explicit plan cancellation and close_job cover pre-paste and post-paste windows.
for(const how of ['plan','job'])for(const exposure of [false,true]){
 const x=await fixture(),pause=barrier();
 x.m.injectText=async(...args)=>{if(exposure){assert.ok(args[3].guard('paste'));x.injected.push(args);}pause.enter();await pause.pause;if(!args[3].guard(exposure?'submit':'paste'))return {ok:false,reason:'cancel guard'};x.injected.push(args);return {ok:true};};
 const id=await x.create();await pause.entered;
 const canceled=await x.post(how==='plan'?'/workflow/plans/cancel':'/jobs/close',how==='plan'?{run:id,reason:'cancel barrier'}:{job:'J',as:'cancel'});assert.equal(canceled.status,200);
 pause.release();await wait(()=>x.run(id).nodes[0].phase==='observing');assert.equal(x.injected.length,exposure?1:0);
 const a=x.workflow.byTurn('owner',x.run(id).nodes[0].turn);assert.equal(a.execution,exposure?'dispatch-unknown':'terminal');assert.equal(x.run(id).nodes[0].physicalStopConfirmed,!exposure);
 assert.equal(x.receipts.pending('owner',a.to),undefined);x.planRunner.kick();assert.equal(x.spawned.length,1);x.close();
}
// Reload confirmed work without replay. Terminal accepted predecessor causes next
// lazy birth on startup; uncertain spawn/tell stays blocked across restart.
for(const phase of ['running','accepted','unknown','spawn-unknown','dispatch-without-attempt','canceled']){
 const x=await fixture({maxTurns:2}),id=await x.create();await wait(()=>x.injected.length===1);
 const a=x.current(id);
 if(phase==='accepted'){x.planRunner.stop();await x.finish(id);}
 if(phase==='unknown'){x.workflow.intent(a.id,a.tell);x.workflow.dispatched(a.id,false);}
 x.planRunner.stop();
 const file=join(x.dir,'plans.json'),rows=JSON.parse(readFileSync(file,'utf8'));
 if(phase==='spawn-unknown')rows[id].nodes[0].phase='spawning';
 if(phase==='dispatch-without-attempt'){rows[id].nodes[0].phase='dispatching';rows[id].nodes[0].turn='tUnexposedNew';}
 if(phase==='canceled')rows[id].state='canceled';
 writeFileSync(file,JSON.stringify(rows));x.close();
 const y=await fixture({dir:x.dir});y.bootstrap();await new Promise(r=>setTimeout(r,15));
 if(phase==='accepted'){await wait(()=>y.injected.length===1);assert.equal(y.run(id).nodes[1].phase,'observing');assert.equal(y.jobs.get('J').turns,2);}
 else {assert.equal(y.injected.length,0);assert.equal(y.spawned.length,0);assert.equal(y.jobs.get('J').turns,1);}
 if(phase==='unknown')assert.equal(y.run(id).nodes[0].state,'dispatch-unknown');
 if(phase==='spawn-unknown')assert.equal(y.run(id).nodes[0].phase,'spawn-unknown');
 if(phase==='dispatch-without-attempt')assert.equal(y.run(id).nodes[0].phase,'blocked');
 if(phase==='canceled'){assert.equal(y.run(id).state,'canceled');assert.equal(y.workflow.byTurn('owner',a.turn).canceled,true);assert.equal(y.receipts.pending('owner',a.to),undefined);}
 y.close();
}
// Rejection fails this fixed segment, no implicit retry or independent branch release.
{
 const x=await fixture(),id=await x.create();await wait(()=>x.injected.length===1);const a=x.current(id);x.workflow.outcome('owner',a.turn,'done','RESULT: failed');
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'rejected',digest:resultDigest('RESULT: failed'),reason:'failure'})).status,200);
 await wait(()=>x.run(id).state==='failed');assert.equal(x.spawned.length,1);assert.equal(x.run(id).nodes[1].state,'skipped');x.close();
}
// The initial direction chain is fixed across owner context changes. NEED/re keeps
// node/attempt/turn and counts one real leg; dispatch-unknown never triggers replay.
{
 const origin={k:{kind:'peer',from:'upstream',turn:'tOriginal'},asker:{who:'user:x',chat:'chat'}},x=await fixture({origin,maxTurns:3}),id=await x.create();
 await wait(()=>x.injected.length===1);const a=x.current(id);assert.equal(a.tell.k.turn,'tOriginal');
 origin.k={kind:'peer',from:'changed',turn:'tLater'};
 x.workflow.outcome('owner',a.turn,'need','NEED: provide fixed input');x.receipts.cancel(a.to,'owner',()=>false);
 // register the actual interim outcome so the ordinary precise re path can recover it.
 x.receipts.register(a.tell,true,{status:'need',body:'NEED: provide fixed input'});
 assert.equal((await x.post('/peers/tell',{name:a.to,text:'fixed input',re:a.turn,job:'J',priority:'now'})).status,200);
 const next=x.workflow.byTurn('owner',a.turn);assert.equal(next.id,a.id);assert.equal(next.tell.k.turn,'tOriginal');assert.equal(x.jobs.get('J').turns,2);
 await x.finish(id);await wait(()=>x.injected.length===3);assert.equal(x.workflow.byTurn('owner',x.run(id).nodes[1].turn).tell.k.turn,'tOriginal');assert.equal(x.jobs.get('J').turns,3);x.close();
}
// Budget exhausted by explicit clarification blocks birth of the next executor.
{
 const x=await fixture({maxTurns:2}),id=await x.create();await wait(()=>x.injected.length===1);const a=x.current(id);
 assert.equal((await x.post('/peers/tell',{name:a.to,text:'more work',re:a.turn,job:'J',priority:'now'})).status,200);
 await x.finish(id);await wait(()=>x.run(id).state==='failed');assert.equal(x.spawned.length,1);assert.equal(x.jobs.get('J').turns,2);x.close();
}
// Lost kicks during an awaited dispatch are replayed once after releasing the lock.
{
 const x=await fixture(),pause=barrier();let first=true;
 x.m.injectText=async(...args)=>{assert.ok(args[3].guard('paste'));assert.ok(args[3].guard('submit'));x.injected.push(args);if(first){first=false;pause.enter();await pause.pause;}return {ok:true};};
 const id=await x.create();await pause.entered;const n=x.run(id).nodes[0],a=x.workflow.byTurn('owner',n.turn);
 // Model completion can race the response write after physical submission.
 x.workflow.dispatched(a.id,true);x.workflow.outcome('owner',a.turn,'done','RESULT: fast done');
 assert.equal((await x.post('/workflow/verdict',{attemptId:a.id,as:'accepted',digest:resultDigest('RESULT: fast done'),reason:'fast checked'})).status,200);
 pause.release();await wait(()=>x.injected.length===2);assert.equal(x.spawned.length,2);x.close();
}
// Failed plan-store mutation withdraws every in-flight dispatch capability.
{
 const x=await fixture(),pause=barrier();x.m.injectText=async(...args)=>{pause.enter();await pause.pause;if(!args[3].guard('paste'))return {ok:false,reason:'store failed'};x.injected.push(args);return {ok:true};};
 const id=await x.create();await pause.entered;const file=join(x.dir,'plans.json');renameSync(file,file+'.backup');mkdirSync(file);
 assert.equal((await x.post('/workflow/plans/cancel',{run:id,reason:'fail write'})).status,409);pause.release();await new Promise(r=>setTimeout(r,20));assert.equal(x.injected.length,0);assert.equal(x.planStore.healthy(),false);x.close();
}
// Real normalizeTag + claimSlot and public clone/legacy routes: initial birth is
// registered but not bound. Canonical aliases and fallbacks must never reuse it.
{
 const pause=barrier(),x=await fixture({spawnBarrier:pause}),id=await x.create();await pause.entered;
 const n=x.run(id).nodes[0],target=x.spawned[0].target;
 for(const caller of ['owner','intruder']){
  for(const name of [n.name,n.name+'!', '.'+n.name]){
   const r=await x.post('/wizard/clone',{name,description:'outside',inherit:false,task:'UNPLANNED',tier:'light'},caller);
   assert.equal(r.status,409,JSON.stringify(r));
  }
  assert.equal((await x.post('/wizard/clone',{description:n.name+'!',inherit:false,task:'UNPLANNED',tier:'light'},caller)).status,409,'description fallback reserved');
 }
 assert.equal((await x.post('/sessions/new',{target:'intruder',cwd:x.dir,name:n.name+'!'})).status,409);
 assert.equal((await x.post('/mirror/inject',{target,text:'UNPLANNED'})).status,409);
 assert.equal((await x.post('/graph/run',{target:'owner#intruder',nodes:[{tag:tagOfKey(target)}],steps:[{to:tagOfKey(target),prompt:'UNPLANNED'}],rounds:1})).status,409);
 assert.equal(x.spawned.length,1);assert.equal(x.injected.length,0);assert.equal(x.jobs.get('J').turns??0,0);
 await x.post('/workflow/plans/cancel',{run:id,reason:'cancel pending birth'});
 assert.equal((await x.post('/mirror/inject',{target,text:'RESURRECT'})).status,409);
 assert.equal(x.spawned[0].guard('paste'),false,'birth guard withdrawn by cancel');
 pause.release();await new Promise(r=>setTimeout(r,15));assert.equal(x.injected.length,0);x.close();
}
// Old graph/new/inject remain usable outside reservations and carry physical guards.
{
 const x=await fixture();
 const born=await x.post('/sessions/new',{target:'owner',cwd:x.dir,name:'ordinary!'});assert.equal(born.status,200,JSON.stringify(born));
 assert.equal(x.spawned[0].target,'owner#ordinary');assert.ok(x.spawned[0].guard());
 assert.equal((await x.post('/mirror/inject',{target:'owner#ordinary',text:'legacy injection'})).status,200);
 const r=await x.post('/graph/run',{target:'owner',nodes:[{tag:'legacy'}],steps:[{to:'legacy',prompt:'legacy graph'}],rounds:1});assert.equal(r.status,200,JSON.stringify(r));
 await wait(()=>x.injected.some(a=>a[1]==='legacy graph'));assert.ok(x.injected.every(a=>typeof a[3]?.guard==='function'));x.close();
}
// A graph authorized before an await must recheck resolved registry identity
// afterwards. A late name binding cannot turn it into an unbudgeted plan send.
{
 const pause=barrier(),x=await fixture({handedOff:async t=>{if(t==='owner#legacy'){pause.enter();await pause.pause;}}});
 const r=await x.post('/graph/run',{target:'owner',nodes:[{tag:'legacy'}],steps:[{to:'legacy',prompt:'late graph'}],rounds:1});assert.equal(r.status,200);await pause.entered;
 x.planRunner.stop();const id=await x.create();const n=x.run(id).nodes[0];
 x.registry.set('owner#legacy',{target:'owner#legacy',name:n.name});pause.release();
 await new Promise(r=>setTimeout(r,20));assert.equal(x.injected.length,0);assert.equal(x.jobs.get('J').turns??0,0);x.close();
}
// Scheduled named tasks recheck after handoff, idle wait, and at paste/submit.
{
 const x=await fixture(),id=await x.create();await wait(()=>x.injected.length===1);const target=x.spawned[0].target;
 assert.equal((await x.scheduledInject(target,'scheduled pollution',{taskId:'outside',fresh:false,quiet:false})).ok,false);
 assert.equal(x.injected.length,1);await x.post('/workflow/plans/cancel',{run:id,reason:'cancel'});
 assert.equal((await x.scheduledInject(target,'resurrect',{taskId:'outside',fresh:false,quiet:false})).ok,false);x.close();
}
for(const idle of [true,false]){
 const x=await fixture(),pause=barrier();x.m.isBusy=async()=>true;x.m.untilIdle=async()=>{pause.enter();await pause.pause;return {idle};};
 const r=await x.scheduledInject('owner#late','late scheduled',{taskId:'outside',fresh:false,quiet:false});assert.equal(r.ok,true);await pause.entered;
 x.planRunner.stop();const id=await x.create();x.registry.set('owner#late',{target:'owner#late',name:x.run(id).nodes[0].name});pause.release();
 await new Promise(r=>setTimeout(r,15));assert.equal(x.injected.length,0);assert.equal(x.spawned.length,0,'timeout cannot escape reservation via fallback runner');x.close();
}
{
 const x=await fixture();assert.equal((await x.scheduledInject('owner#ordinary','named legacy task',{taskId:'outside',fresh:false,quiet:false})).ok,true);assert.ok(x.injected[0][3].guard('submit'));x.close();
}
// Receipts/handoff are attempt continuations, never permission to restart an
// unknown/canceled/accepted executor. Manual human chat remains outside this gate.
{
 const x=await fixture(),id=await x.create();await wait(()=>x.injected.length===1);const a=x.current(id);
 assert.equal(x.continuationAllowed(a.to),true);assert.equal(x.continuationAllowed('ordinary'),true);
 x.workflow.outcome('owner',a.turn,'need','NEED: evidence');assert.equal(x.continuationAllowed(a.to),true);
 await x.post('/workflow/plans/cancel',{run:id,reason:'stop lifecycle'});assert.equal(x.continuationAllowed(a.to),false);x.close();
}
{
 const x=await fixture(),id=await x.create();await wait(()=>x.injected.length===1);const a=x.current(id);
 x.workflow.outcome('owner',a.turn,'done','RESULT: done');assert.equal(x.continuationAllowed(a.to),false,'validating is no longer a live execution to resume');x.close();
}
// The complete actual MirrorBridge.injectText, not a mocked replacement of
// its respawn logic. Only pane probes, spawn/kill and physical I/O are controlled.
const mirrorSource=readFileSync('daemon/mirror-bridge.ts','utf8');
const injectStart=mirrorSource.indexOf('    injectText: async (target, text, origin, opts) => {');
const injectEnd=mirrorSource.indexOf('    interruptPane: async',injectStart);
const realInjectCode=ts.transpileModule('return ({'+mirrorSource.slice(injectStart,injectEnd)+'}).injectText;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
for(const mode of ['cancel-during-pane-probe','cancel-during-spawn','store-failure-during-pane-probe','cleanup-failure','legacy']){
 const x=await fixture(),pause=barrier();let binds=0,births=0,watchers=0,pastes=0,seals=0,notices=0,returned;const kills=[];
 const attachment={sessionId:'old-sid',jsonlPath:'/tmp/old.jsonl',tmuxPane:'%old',runningCwd:x.dir};
 const respawnEnv={byTarget:{get:()=>attachment},restoreFromStore:async()=>attachment,noticeSuffixFor:()=>{notices++;return '';},rememberInject:()=>{},pushSeal:()=>{seals++;},sealKeys:()=>[],idleVerdict:()=>true,
 paneUsable:async()=>{if(['cancel-during-pane-probe','store-failure-during-pane-probe'].includes(mode)){pause.enter();await pause.pause;}return false;},
 log:{warn:()=>{},child:()=>({})},listJsonls:()=>[],dirname:()=>'/tmp',cfg:{},displayName:t=>t,backendForPath:()=>({name:'codex'}),respawnSpec:()=>({}),charterFor:()=>'',
 spawnTmuxClaude:async()=>{births++;if(['cancel-during-spawn','cleanup-failure'].includes(mode)){pause.enter();await pause.pause;}return {ok:true,tmuxPane:'%reborn'};},
 runTmux:async args=>{kills.push(args);return {ok:mode!=='cleanup-failure'};},
 deps:{store:{set:()=>{binds++;}}},startMigrationWatcher:()=>{watchers++;},forkOf:()=>'',isClearCommand:()=>false,
 inject:async args=>{if(args.guard&&(!args.guard('paste')||!args.guard('submit')))return {ok:false,reason:'guard'};pastes++;return {ok:true};},armSilentForkRebind:()=>{}};
 const actualInject=new Function(...Object.keys(respawnEnv),realInjectCode)(...Object.values(respawnEnv));
 if(mode==='legacy'){
  assert.equal((await actualInject('ordinary','legacy prompt')).ok,true);
  assert.equal(births,1);assert.equal(binds,1);assert.equal(watchers,1);assert.equal(pastes,1);assert.equal(seals,1);assert.equal(attachment.tmuxPane,'%reborn');assert.deepEqual(kills,[]);x.close();continue;
 }
 x.m.injectText=async(...args)=>{returned=await actualInject(...args);return returned;};
 const id=await x.create();await pause.entered;
 if(mode==='store-failure-during-pane-probe'){const file=join(x.dir,'plans.json');renameSync(file,file+'.backup');mkdirSync(file);}
 const canceled=await x.post('/workflow/plans/cancel',{run:id,reason:'respawn boundary cancellation'});
 assert.equal(canceled.status,mode==='store-failure-during-pane-probe'?409:200);
 pause.release();await wait(()=>returned!==undefined);
 assert.equal(returned.ok,false);assert.equal(binds,0);assert.equal(watchers,0);assert.equal(pastes,0);assert.equal(seals,0);assert.equal(notices,0);assert.equal(attachment.tmuxPane,'%old');
 const inSpawn=['cancel-during-spawn','cleanup-failure'].includes(mode);
 assert.equal(births,inSpawn?1:0);assert.deepEqual(kills,inSpawn?[['kill-pane','-t','%reborn']]:[]);
 if(mode==='cleanup-failure'){assert.equal(returned.uncertain,true);assert.ok(returned.reason.includes('%reborn'));await wait(()=>x.run(id).nodes[0].reason?.includes('%reborn'));}
 else if(mode!=='store-failure-during-pane-probe'){
  const a=x.workflow.byTurn('owner',x.run(id).nodes[0].turn);assert.equal(!!a.exposed,false,'preflight checks are not physical exposure');assert.equal(a.stopped,true);
 }
 x.close();
}
console.log('workflow plan HTTP: actual lazy tier spawn, owner/schema, accepted gate, cancellation barriers, startup reconciliation, precise re/budget, dirty kicks, readonly status and strict failure passed');
process.exit(0);

// Real source routes over localhost with controlled transport barriers; no live daemon.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import ts from 'typescript';
import pino from 'pino';
import {createWorkflowNodes,resultDigest} from '../daemon/workflow-nodes.ts';
import {createReceipts,deadlineOf,canonicalTurn,kAttr} from '../daemon/receipts.ts';
import {parseClosing} from '../daemon/peers.ts';
import {loadJobStore} from '../daemon/jobs.ts';
import {createLedger,pendingGc} from '../daemon/pending-items.ts';
import {loadJsonMap} from '../shared/json-map-store.ts';
import {loadWorkflowPlans} from '../daemon/workflow-plans.ts';
import {answerSourceLost,answerTargetOccupied,answerTransferOrigin,createAnswerTransfers} from '../daemon/answer-transfer.ts';
import {pickTier} from '../shared/model-tiers.ts';
import {parseEffort} from '../shared/effort.ts';
const src=readFileSync('daemon/index.ts','utf8');
const start=src.indexOf('    // One durable key per tracked physical dispatch leg');
const end=src.indexOf(' // 老 MCP 进程还在调这个名字',start);
const closeStart=src.indexOf('    http.register("POST /jobs/close"');
const closeEnd=src.indexOf('    // 挂起事项全表',closeStart);
const stopStart=src.indexOf('    http.register("POST /wizard/stop"');
const stopEnd=src.indexOf('    // 换模型',stopStart);
const bearStart=src.indexOf('    const bearAs = async');
const bearEnd=src.indexOf('    const planRunner = createWorkflowPlanRunner',bearStart);
const cloneStart=src.indexOf('    http.register("POST /wizard/clone"');
const cloneEnd=src.indexOf('    // 收掉一个 wizard',cloneStart);
const bootstrapStart=src.indexOf('      handoffs.resume();');
const bootstrapEnd=src.indexOf('      receipts.resume();',bootstrapStart)+'      receipts.resume();'.length;
const bootstrapCode=ts.transpileModule(src.slice(bootstrapStart,bootstrapEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const routeCode=ts.transpileModule(src.slice(start,end)+src.slice(closeStart,closeEnd)+src.slice(bearStart,bearEnd)+src.slice(cloneStart,cloneEnd)+src.slice(stopStart,stopEnd)+'\nreturn {tellPeerAs,recoverWorkflow,bearAs};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const checkStart=src.indexOf('    const checkJob = ');
const checkEnd=src.indexOf('\n    };',checkStart)+7;
const checkCode=ts.transpileModule(src.slice(checkStart,checkEnd)+'\nreturn checkJob;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const afterStart=src.indexOf('    const afterNote =');
const afterEnd=src.indexOf('    // One durable key per tracked physical dispatch leg',afterStart);
const afterCode=ts.transpileModule(src.slice(afterStart,afterEnd)+'\nreturn afterNote;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const currentAskStart=src.indexOf('    const currentAsk =');
const currentAskEnd=src.indexOf('\n    };',currentAskStart)+7;
const currentAskCode=ts.transpileModule(src.slice(currentAskStart,currentAskEnd)+'\nreturn currentAsk;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const outcomeStart=src.indexOf('      onOutcome: (s, status, bodyText, bySender) => {');
const outcomeEnd=src.indexOf('      jobTally:',outcomeStart);
const outcomeSource=src.slice(outcomeStart,outcomeEnd).trim().replace(/^onOutcome: /,'').replace(/,$/,'');
const outcomeCode=ts.transpileModule('return '+outcomeSource+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const noop=()=>{};
const never=()=>new Promise(()=>{});
const root=mkdtempSync(join(tmpdir(),'workflow-review-'));
let n=0;
export async function setup(options={}){
 const dir=options.dir??join(root,String(++n));
 const workflow=createWorkflowNodes(join(dir,'nodes.json'));
 const planStore=loadWorkflowPlans(join(dir,'plans.json'),workflow.prereq);
 let planRunner={cancelJob:()=>{}};let advancePlans=()=>{};
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
 let answers;
 let actualOutcome;
 const receipts=createReceipts({
   holdStore,
   release:async(h,seen,alive)=>{const r=await internal.tellPeerAs(h.from,h.body,afterNote(h.after,seen,h.from),{turn:h.turn,channel:h.channel,after:h.after,seen:h.seen,alive});options.onRelease?.(r);return {ok:r.status===200,reason:r.body.reason};},
   workflowPrereq:workflow.prereq,log:pino({level:'silent'}),
   idleNow:async()=>false,untilIdle:options.untilIdle??never,paneLive:async()=>true,
   replyFor:()=>undefined,deliver:async()=>({ok:true}),nameOf:x=>x,
   store:loadJsonMap(join(dir,'receipts.json')),
   onOutcome:(s,status,body,bySender)=>{outcomeEvents.push({from:s.from,turn:s.turn,status});actualOutcome(s,status,body,bySender);}
 });
 const injected=[];const routes=new Map();
 let killCalls=0,interruptCalls=0,cloneCalls=0;
 const m={idleNow:options.idleNow??(async()=>true),untilIdle:async()=>({idle:true}),sessionInfo:()=>undefined,
 injectText:async(...a)=>{if(a[3]?.guard&&!a[3].guard('paste'))return {ok:false,reason:'guard'};options.transportHook?.();if(a[3]?.guard&&!a[3].guard('submit'))return {ok:false,reason:'guard'};injected.push(a);return {ok:true};},interruptPane:async()=>{interruptCalls++;return {ok:true};},killPane:async()=>{killCalls++;return {ok:true};},
 peers:async()=>options.peers?.(),cloneSession:async(args)=>{cloneCalls++;if(args.guard&&!args.guard())return {ok:false,reason:'guard'};return {ok:true,sessionId:'new-session',inherited:false};},
 chatTargets:()=>[],sleepPane:async()=>({ok:true})};
 const openingAsk=()=>options.opening;
 answers=createAnswerTransfers(loadJsonMap(join(dir,'answer-transfers.json'),undefined,{strict:true}));
 actualOutcome=new Function('workflow','ledger','advancePlans','parseClosing','answers','m',outcomeCode)(workflow,ledger,()=>advancePlans(),parseClosing,answers,m);
 const answerDeliveries=[];
 const deliverTransferredAnswer=async(id,out)=>{const r=answers.outcome(id,out);if(r){answerDeliveries.push({id,out});answers.delivered(id);}return true;};
 m.answerContext=(self)=>typeof options.answerContext==='function'?options.answerContext(self):options.answerContext;
 m.prepareAnswer=()=>true; m.takeAnswer=async()=>({taken:true,cleared:true}); m.cancelAnswerPreparation=noop; m.stopAnswerProgress=noop;
 const currentAsk=new Function('openingAsk','displayName',currentAskCode)(openingAsk,x=>x);
 const env={answers,lostAnswer:(self)=>typeof options.lostAnswer==='function'?options.lostAnswer(self):options.lostAnswer??answerSourceLost(answers.all(),self,m.answerContext(self)?.turn,options.openingMs??123),terminalAnswerTurn:(self)=>{const t=options.openingEnv?.turn;return t?answers.terminalTarget(self,t):undefined;},answerTargetOccupied,answerTransferOrigin,openingOfSelf:()=>({ms:options.openingMs??123,env:options.openingEnv}),controlSnapshot:self=>({opening:options.openingMs??123,turn:m.answerContext(self)?.turn}),controlValid:(self,s)=>(options.openingMs??123)===s.opening&&m.answerContext(self)?.turn===s.turn&&!(typeof options.lostAnswer==='function'?options.lostAnswer(self):options.lostAnswer??answerSourceLost(answers.all(),self,m.answerContext(self)?.turn,options.openingMs??123))&&!env.terminalAnswerTurn(self),hasAnswerChildren:(self,k)=>!!k&&receipts.states().some(s=>s.from===self&&s.k&&kAttr(s.k)===kAttr(k)),kAttr,renderReminder:(_tag,lines)=>lines.join('\n'),deliverTransferredAnswer,canonicalTurn,baseOfKey:x=>x,jobAncestors:()=>[],jobChildren:()=>[],jobEpisode:()=>({name:'owner'}),appendEpisode:()=>true,episodePath:()=>'',episodeName:()=>'',chatNameOf:()=>'',openingAsk,currentAsk,notices:{post:noop},briefOf:()=>({name:'worker'}),forgetWizard:noop,subjectOf:noop,postRoster:noop,sameBot:()=>true,workflow,planStore,pendingBirthJobs:new Map(),planRunner:{cancelJob:(...a)=>planRunner.cancelJob(...a)},advancePlans:()=>advancePlans(),receipts,jobs:jobView,jobView,m,http:{register:(path,fn)=>routes.set(path,fn)},
 readPeerBody:async req=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);return {self:req.headers['x-caller']??'owner',body};},
 json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));},
 resolvePeer:(self,t)=>options.resolvePeer?.(self,t)??({ok:true,target:t,foreign:false}),addrOf:b=>b.name,askerOf:(self)=>typeof options.askerOf==='function'?options.askerOf(self):options.origin?.asker,parentKOf:(self)=>typeof options.parentKOf==='function'?options.parentKOf(self):options.origin?.k,
 checkJob:new Function('jobs','JOB_MEMBER_MAX',checkCode)(jobView,5),checkDirection:(i)=>options.direction?.(i),displayName:x=>x,
 afterTurnsOf:b=>[...new Set((b.after??[]).map(x=>String(x).replace(/[`\s]/g,'')))],
 afterNote,channelOf:()=>'',wizards:{get:()=>true},cfg:options.cfg??{daemon:{stateDir:dir}},chatPolicyOf:()=>({topOnly:options.topOnly??false}),pickTier,parseEffort,normalizeTag:x=>String(x??''),tagFromCwd:x=>x,
 handingOff:()=>false,handedOff:async t=>{await options.handedOff?.(t);},othersTurn:async(...a)=>typeof options.others==='function'?options.others(...a):options.others,coldRefused:new Map(),coldGateOf:()=>'',touchOf:()=>0,ttlOf:()=>0,
 peerAddress:(_cfg,_s,t)=>t,roleParam:x=>x,wakeNoteOf:()=>'',deadlineOf,envelopeFor:()=>'',ledger,log:pino({level:'silent'}),relayPeer:noop};
 internal=new Function(...Object.keys(env),routeCode)(...Object.values(env));
 const server=createServer((req,res)=>{const fn=routes.get(req.method+' '+req.url);if(!fn){res.writeHead(404);res.end();return;}Promise.resolve(fn(req,res)).catch(e=>{res.writeHead(500);res.end(e.message)});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const post=async(route,body,caller='owner')=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-caller':caller},body:JSON.stringify(body)});const raw=await r.text();let response;try{response=JSON.parse(raw);}catch{response={reason:raw};}return {status:r.status,body:response};};
 return {answers,answerDeliveries,deliverAnswer:deliverTransferredAnswer,planStore,env,routes,jobView,setRunner:r=>{planRunner=r;advancePlans=r.kick;},bootstrap:()=>{const e={...env,handoffs:{resume:noop},recoverWorkflow:internal.recoverWorkflow};new Function(...Object.keys(e),bootstrapCode)(...Object.values(e));},dir,workflow,receipts,outcomeEvents,jobs,ledgerStore,removeJob,m,injected,post,internal,counts:()=>({killCalls,interruptCalls,cloneCalls}),close:()=>{server.closeAllConnections();server.close();}};
}

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {withLinkedTagHeader} from '../shared/session-label.ts';
import {buildChatUrl} from '../daemon/detail.ts';
const source=readFileSync('daemon/mirror-bridge.ts','utf8');
const start=source.indexOf('  const answerBubbles =');
const end=source.indexOf('  // 收口一条 loading 气泡',start);
assert.ok(start>0&&end>start);
assert.ok(source.includes('    updateAnswerProgress(a, item);'), 'real onItem routes receiver activity');
const extract=name=>{const at=source.indexOf(`  const ${name} =`);assert.ok(at>0);return source.slice(at,source.indexOf('\n  };',at)+5);};
const boundaries=['onItem','bindLine','consumeFrom','consumeChannel','takeSeal','activateDispatch','flushCot','flushStream','sendStandalone','sendRaw','handleSubagentItem','pushSeal'].map(extract).join('\n');
const code=ts.transpileModule(source.slice(start,end)+boundaries+'\nreturn {answerContext,prepareAnswer,takeAnswer,cancelAnswerPreparation,stopAnswerProgress,deliverAnswer,updateAnswerProgress,onItem,flushCot,flushStream,sendStandalone,sendRaw,handleSubagentItem,pushSeal};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const sourceState=(suffix='A',live=false)=>({target:`chat:group#router-${suffix}`,briefTurnId:live?undefined:`human-${suffix}`,briefBubble:live?undefined:{frame:{req_id:`req-${suffix}`},streamId:`stream-${suffix}`,done:false},liveStream:live?{turnId:`human-${suffix}`,frame:{req_id:`req-${suffix}`},streamId:`stream-${suffix}`,acc:'OLD SOURCE',closed:false,dead:false}:undefined,channel:'chat:group',turnFromChat:true,cotLastSent:'OLD SOURCE'});
const make=(states=[sourceState()],transport,standaloneTransport)=>{
 const calls=[],timers=new Map(),lost=new Set();let timer=0;
 const cfg={wrc:{mirror:{brief:true,chunkBytes:1000}}};const noop=()=>{};
 const env={cfg,SEAL_TTL_MS:60000,ORIGIN_TTL_MS:60000,SOFT_END_CANCELLERS:new Set(['text','thinking','tool_use','turn_end','goal_start']),BRIEF_TURN_OPENERS:new Set(['text','tool_use']),
  recordTurnItem:noop,resolveSubagentMeta:()=>({label:'child'}),newTurnId:()=>`child-${++timer}`,voidTurnAgents:noop,closeBriefTurn:a=>{a.briefTurnId=undefined;},publicPeer:()=>undefined,openingOf:()=>undefined,lastChannelOf:()=>undefined,updateBriefProgress:noop,injectInto:noop,mergedAway:noop,recordTurnQuery:noop,recordTurnStart:noop,cliOf:()=>'',channelFields:()=>({}),openBriefTurn:(a,q)=>{a.briefTurnId=q.turnId;a.briefBubble=q.bubble;},
  toolUseSig:(name,input)=>JSON.stringify([name,input]),RECENT_SIGS_MAX:100,handleBriefItem:noop,ensureBriefTurn:a=>{a.briefTurnId='active-detail';},scheduleFlush:noop,STREAM_SOFT_CAP:10000,enqueueStandalone:()=>{throw new Error('private receiver leaked standalone');},hasVisibleBody:s=>!!s,answerSilent:a=>lost.has(a.briefTurnId??a.liveStream?.turnId??''),silenceAnswer:(_target,turn)=>lost.has(turn),replyChatId:a=>a.channel||'group',splitMarkdown:s=>s.split('|'),TAG_HEADER_BUDGET:0,withLinkedTag:(_a,s)=>s,briefLine:(_a,_t,s)=>s,
  byTarget:new Map(states.map(a=>[a.target,a])),isPrivate:a=>a.channel==='',baseOfKey:t=>t.split('#')[0],clearCot:a=>{timers.delete(a.cotTimer);a.cotText=undefined;},
  setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),COT_FLUSH_MS:1500,cotLine:s=>s.trim()?s.replace(/\s+/g,' ').slice(0,100)+'…':'',cotToolLabel:calls=>calls.map(c=>c.name).join(' / '),
  client:{replyStream:async(...args)=>{calls.push({kind:'stream',args});await transport?.(...args);},sendMessage:async(...args)=>{calls.push({kind:'standalone',args});await standaloneTransport?.(...args);}},log:{warn:noop,debug:noop,info:noop},errText:String,withLinkedTagHeader,chatTurnUrl:(target,turn)=>buildChatUrl('http://test','localhost',17890,turn,target,target)};
 const api=new Function(...Object.keys(env),code)(...Object.values(env));
 return {...api,calls,timers,cfg,lost,a:states[0],flush:async()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());await tick();}};
};
const worker=(id='transfer-A',name='worker-A')=>({target:`chat:group#${name}`,activePeerTurn:id,convFrom:{kind:'peer',turn:id}});
const take=(x,id='transfer-A',a=x.a,name='worker-A')=>{const turn=x.answerContext(a.target).turn;x.prepareAnswer(id,a.target,turn,`chat:group#${name}`,'chat:group');return x.takeAnswer(id,a.target,turn,`chat:group#${name}`,'chat:group');};
const deliver=(x,id='transfer-A',name='worker-A',body='FINAL ANSWER',standalone=false)=>x.deliverAnswer(id,`chat:group#${name}`,'human-A','chat:group','LEGACY SAVED PREFIX',body,standalone);
for(const live of [false,true]){
 const x=make([sourceState('A',live)]),c=x.answerContext(x.a.target);
 assert.equal(c.prefix,'');assert.equal((await take(x)).taken,true);await tick();
 assert.equal(x.a.briefBubble,undefined);assert.equal(x.a.liveStream,undefined);assert.equal(x.a.channel,'');
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].args[3],false);
 assert.doesNotMatch(x.calls[0].args[2],/OLD SOURCE/,'successful takeover resets old visible content immediately');
 assert.match(x.calls[0].args[2],/role=chat%3Agroup%23worker-A/);
 x.updateAnswerProgress(worker(),{kind:'thinking',body:'WORKER PROGRESS'});await x.flush();
 assert.match(x.calls[1].args[2],/WORKER PROGRESS/);assert.equal(x.calls[1].args[3],false);
 x.updateAnswerProgress(worker(),{kind:'tool_use',calls:[{name:'read-file'}]});await x.flush();
 assert.match(x.calls[2].args[2],/read-file/);assert.doesNotMatch(x.calls[2].args[2],/WORKER PROGRESS/);
 x.updateAnswerProgress(worker(),{kind:'text',body:'FINAL SHOULD NOT BE PROGRESS',final:true});await x.flush();assert.equal(x.calls.length,3);
 x.updateAnswerProgress(worker(),{kind:'text',body:'STALE QUEUED PROGRESS',final:false});
 await deliver(x);await x.flush();
 assert.equal(x.calls.length,4);assert.equal(x.calls[3].args[3],true);
 assert.match(x.calls[3].args[2],/FINAL ANSWER/);assert.doesNotMatch(x.calls[3].args[2],/SOURCE|PROGRESS|PREFIX|read-file/);
 x.updateAnswerProgress(worker(),{kind:'thinking',body:'LATE'});await x.flush();assert.equal(x.calls.length,4);
}
{
 const x=make(),c=x.answerContext(x.a.target);x.a.briefTurnId='new-human-turn';
 assert.equal((await x.takeAnswer('stale',x.a.target,c.turn,'worker','chat:group')).taken,false);
 assert.ok(x.a.briefBubble);await tick();assert.equal(x.calls.length,0);
}
{
 const a=sourceState('A'),b=sourceState('B'),x=make([a,b]);
 await take(x,'transfer-A',a);await take(x,'transfer-B',b,'worker-B');await tick();
 // Receiver identity, envelope turn and new-human boundaries all gate progress.
 for(const actor of [x.a,worker('transfer-B'),worker('unrelated'),{...worker(),activePeerTurn:undefined,pendingFromCli:true},{...worker(),activePeerTurn:undefined,pendingChannel:{channel:'chat:group'}}])x.updateAnswerProgress(actor,{kind:'thinking',body:'FOREIGN'});
 await x.flush();assert.equal(x.calls.length,2);
 x.updateAnswerProgress(worker(),{kind:'thinking',body:'PROGRESS A'});
 x.updateAnswerProgress({...worker('transfer-B'),pendingFrom:{from:{kind:'peer',turn:'transfer-B'}},pendingChannel:{channel:''},target:'chat:group#worker-B'},{kind:'thinking',body:'PROGRESS B'});
 await x.flush();
 assert.equal(x.calls[2].args[1],'stream-A');assert.match(x.calls[2].args[2],/PROGRESS A/);
 assert.equal(x.calls[3].args[1],'stream-B');assert.match(x.calls[3].args[2],/PROGRESS B/);
 a.briefTurnId='human-NEW';a.briefBubble={frame:{req_id:'NEW'},streamId:'NEW',done:false};
 await deliver(x,'transfer-B','worker-B','FINAL B');await deliver(x,'transfer-A','worker-A','FINAL A');
 assert.equal(x.calls[4].args[1],'stream-B');assert.doesNotMatch(x.calls[4].args[2],/PROGRESS|FINAL A/);
 assert.equal(x.calls[5].args[1],'stream-A');assert.doesNotMatch(x.calls[5].args[2],/PROGRESS|FINAL B/);assert.equal(a.briefBubble.streamId,'NEW');
}
{
 // A slow source refresh must settle before reset, and a slow receiver refresh
 // must settle before final. Queued progress cannot follow the final frame.
 let releaseOld,releaseProgress;
 const a=sourceState();a.briefBubble.pending=new Promise(r=>releaseOld=r);
 const x=make([a],async(_f,_s,body,finish)=>{if(!finish&&body.includes('SLOW'))await new Promise(r=>releaseProgress=r);});
 const taking=take(x);await tick();assert.equal(x.calls.length,0);
 releaseOld();await taking;await tick();assert.equal(x.calls.length,1);
 x.updateAnswerProgress(worker(),{kind:'thinking',body:'SLOW'});await x.flush();assert.equal(x.calls.length,2);
 x.updateAnswerProgress(worker(),{kind:'thinking',body:'LATE'});await x.flush();
 const done=deliver(x);await tick();assert.equal(x.calls.length,2);
 releaseProgress();await done;assert.equal(x.calls.length,3);assert.equal(x.calls[2].args[3],true);assert.doesNotMatch(x.calls[2].args[2],/SLOW|LATE/);
}
for(const [failure,standalone] of [[false,true],[true,false]]){
 const x=make(undefined,async()=>{if(failure)throw {headers:{req_id:'req'},errcode:40001,errmsg:'rejected'};});
 await take(x);await tick();await deliver(x,'transfer-A','worker-A','TERMINAL',standalone);
 assert.deepEqual(x.calls.map(c=>c.kind),['stream','stream','standalone']);
 assert.match(x.calls[2].args[1].markdown.content,/TERMINAL/);assert.doesNotMatch(x.calls[2].args[1].markdown.content,/SOURCE|PREFIX/);
 assert.equal(x.calls[2].args[0],'group');
}
{
 const x=make();await deliver(x,'recovered');assert.deepEqual(x.calls.map(c=>c.kind),['standalone']);
 assert.match(x.calls[0].args[1].markdown.content,/FINAL ANSWER/);assert.doesNotMatch(x.calls[0].args[1].markdown.content,/PREFIX/,'reload never restores old source prefix');
}
for(const standalone of [false,true]){
 const x=make(undefined,async()=>{throw new Error('Reply ack timeout');});await take(x);await tick();
 if(standalone){await deliver(x,'transfer-A','worker-A','timeout explanation',true);assert.equal(x.calls.filter(c=>c.kind==='standalone').length,1);}
 else {await assert.rejects(deliver(x),/Reply ack timeout/);assert.equal(x.calls.filter(c=>c.kind==='standalone').length,0,'uncertain final ACK never duplicates terminal delivery');}
}
// Exercise the actual input-boundary and onItem functions in both modes.
for(const brief of [true,false]){
 const x=make();x.cfg.wrc.mirror.brief=brief;
 const receiver={target:'chat:group#worker-A',channel:'chat:previous-human',channelSeeded:true,convFrom:{kind:'peer',turn:'old-task'},pendingFrom:{from:{kind:'peer',turn:'transfer-A'},at:Date.now()}};
 x.prepareAnswer('transfer-A',x.a.target,'human-A',receiver.target,'chat:group');
 x.onItem(receiver,{kind:'thinking',body:'OLD RECEIVER TURN'});await x.flush();assert.equal(x.calls.length,0,'pending metadata cannot activate a transfer');
 receiver.seals=[{keys:['task A'],fresh:true,at:Date.now(),query:'task A',channel:'',from:{kind:'peer',turn:'transfer-A'}}];
 x.onItem(receiver,{kind:'user_query',said:'task A',body:'task A'});
 assert.equal(receiver.activePeerTurn,'transfer-A');
 x.onItem(receiver,{kind:'thinking',body:'EARLY RECEIVER PROGRESS'});await x.flush();assert.equal(x.calls.length,0,'progress before ownership activation stays buffered');
 assert.equal((await x.takeAnswer('transfer-A',x.a.target,'human-A',receiver.target,'chat:group')).cleared,true);await tick();
 assert.equal(x.calls.length,2);assert.match(x.calls[1].args[2],/EARLY RECEIVER PROGRESS/);assert.doesNotMatch(x.calls[1].args[2],/OLD RECEIVER/);
 if(!brief){
  assert.equal(receiver.channel,'');
  x.onItem(receiver,{kind:'text',body:'PRIVATE PROGRESS',final:false});await x.flush();
  const count=x.calls.length;x.onItem(receiver,{kind:'text',body:'PRIVATE FINAL',final:true});await x.flush();assert.equal(x.calls.length,count,'receiver final is only delivered by receipt');
 }
 x.stopAnswerProgress('transfer-A');const stopped=x.calls.length;
 x.onItem(receiver,{kind:'thinking',body:'AFTER TIMEOUT'});await x.flush();assert.equal(x.calls.length,stopped,'outcome pin stops progress before deferred delivery');
 x.onItem(receiver,{kind:'user_text',body:'new human B',quiet:true});
 assert.equal(receiver.activePeerTurn,undefined);
 x.onItem(receiver,{kind:'thinking',body:'FOREIGN HUMAN B'});await x.flush();assert.equal(x.calls.length,stopped);
 await deliver(x);
}
{
 const x=make(),receiver=worker();await take(x);
 receiver.seals=[{keys:['human B'],at:Date.now(),query:'human B',channel:'chat:B',turn:{turnId:'B',bubble:{done:false}}}];
 x.onItem(receiver,{kind:'user_query',said:'human B',body:'human B'});
 assert.equal(receiver.activePeerTurn,undefined,'actual human chat activation clears peer identity');
 x.onItem(receiver,{kind:'thinking',body:'B'});await x.flush();assert.equal(x.calls.length,1);
 await deliver(x);
}
for(const live of [false,true]){
 // Take reads the *latest* source pending chain, including writes begun after prepare.
 let release;const x=make([sourceState('A',live)],async(_f,_s,body)=>{if(body.includes('SOURCE IN FLIGHT'))await new Promise(r=>release=r);});
 const a=x.a;x.prepareAnswer('transfer-A',a.target,'human-A','chat:group#worker-A','chat:group');
 let first,second;
 if(live){a.liveStream.acc='SOURCE IN FLIGHT';first=x.flushStream(a.liveStream);await tick();a.liveStream.acc='SOURCE QUEUED';second=x.flushStream(a.liveStream);}
 else {a.cotText='SOURCE IN FLIGHT';first=x.flushCot(a);await tick();a.cotText='SOURCE QUEUED';second=x.flushCot(a);}
 const taking=x.takeAnswer('transfer-A',a.target,'human-A','chat:group#worker-A','chat:group');await tick();assert.equal(x.calls.length,1);
 release();await Promise.all([first,second,taking]);assert.equal(x.calls.length,2);assert.doesNotMatch(x.calls[1].args[2],/SOURCE/,'queued old source is invalidated before reset');await deliver(x);
}
{
 const x=make();x.prepareAnswer('canceled',x.a.target,'human-A','chat:group#worker-A','chat:group');x.cancelAnswerPreparation('canceled');
 assert.ok(x.a.briefBubble);assert.equal(x.a.channel,'chat:group');assert.equal(x.calls.length,0,'failed injection leaves source bubble intact');
 const a=x.a;x.prepareAnswer('transfer-A',a.target,'human-A','chat:group#worker-A','chat:group');
 a.briefTurnId='human-B';a.briefBubble={streamId:'new-B',frame:{},done:false};a.channel='chat:B';a.cotLastSent='B progress';
 await x.takeAnswer('transfer-A',a.target,'human-A','chat:group#worker-A','chat:group');
 assert.equal(a.briefBubble.streamId,'new-B');assert.equal(a.channel,'chat:B');assert.equal(a.cotLastSent,'B progress');await deliver(x);
}
for(const raw of [false,true])for(const live of [false,true]){
 const x=make([sourceState('A',live)]);let release;x.a.standalonePending=new Promise(r=>release=r);
 (raw?x.sendRaw:x.sendStandalone)(x.a,'OLD SOURCE');x.lost.add('human-A');release();await x.a.standalonePending;
 assert.equal(x.calls.length,0,'queued source standalone rechecks its captured brief or live turn');
}
{
 let release;const x=make(undefined,undefined,async()=>new Promise(r=>release=r));x.a.standalonePending=Promise.resolve();
 x.sendStandalone(x.a,'first|second');await tick();assert.equal(x.calls.length,1);
 x.lost.add('human-A');release();await x.a.standalonePending;assert.equal(x.calls.length,1,'ownership transfer between chunks suppresses the remaining old source');
}
{
 const x=make(),receiver={...worker(),channel:'',channelSeeded:true};x.cfg.wrc.mirror.brief=false;
 // Run the actual nonbrief dispatch stamp, then the actual onItem boundary.
 const stamp=source.match(/        if \(!brief\) pushSeal\(a, .*\);/)[0];
 new Function('brief','pushSeal','a','sealKeys','effText','channel','baseOfKey','principal','speaker',stamp)(false,x.pushSeal,receiver,t=>[t],'new human B','chat:B',t=>t.split('#')[0],receiver.target,'user:B');
 receiver.liveStream={turnId:'human-B',acc:'',closed:false,dead:false,dest:undefined};
 x.onItem(receiver,{kind:'user_query',said:'new human B',body:'new human B'});
 assert.equal(receiver.activePeerTurn,undefined);assert.equal(receiver.channel,'chat:B');assert.equal(receiver.liveStream.dest,'chat:B');
 x.onItem(receiver,{kind:'text',body:'ANSWER B',final:false});assert.equal(receiver.liveStream.acc,'ANSWER B','new public answer survives private predecessor');
}
{
 const x=make(),receiver={target:'chat:group#worker-A',channel:'chat:old-human',briefTurnId:'old-human',recentToolSigs:new Map()};
 const agent=prompt=>x.onItem(receiver,{kind:'tool_use',calls:[{name:'Agent',input:{prompt}}]});
 agent('reused prompt');
 receiver.seals=[{keys:['task A'],fresh:true,at:Date.now(),query:'task A',channel:'',from:{kind:'peer',turn:'transfer-A'}}];
 x.onItem(receiver,{kind:'user_query',said:'task A',body:'task A'});
 await take(x);
 for(let i=0;i<8;i++)agent(`new task ${i}`);
 agent('reused prompt');await x.flush();
 assert.equal(receiver.agentCalls.length,9);
 assert.equal(receiver.agentCalls.filter(c=>c.prompt==='reused prompt').length,1,'old identical prompt was evicted by actual onItem cache truncation');
 const before=x.calls.length;
 x.handleSubagentItem(receiver,'old-child-first-seen-late',{kind:'task',body:'reused prompt',meta:{}});
 x.handleSubagentItem(receiver,'old-child-first-seen-late',{kind:'thinking',body:'OLD HUMAN PRIVATE CONTENT'});await x.flush();
 assert.equal(x.calls.length,before,'prompt reuse after cache eviction cannot authorize child content in a transferred stream');
 assert.ok(x.calls.every(c=>!c.args[2]?.includes('OLD HUMAN PRIVATE CONTENT')));
 x.onItem(receiver,{kind:'thinking',body:'CURRENT RECEIVER PROGRESS'});await x.flush();assert.match(x.calls.at(-1).args[2],/CURRENT RECEIVER PROGRESS/);await deliver(x);
}
console.log('answer transfer mirror: reset, receiver-only progress, final overwrite, concurrent turns, in-flight ordering, rejected/uncertain ACK and reload passed');

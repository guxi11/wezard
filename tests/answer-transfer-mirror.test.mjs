import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {withLinkedTagHeader} from '../shared/session-label.ts';
import {buildChatUrl} from '../daemon/detail.ts';
const source=readFileSync('daemon/mirror-bridge.ts','utf8');
const start=source.indexOf('  const answerBubbles =');
const end=source.indexOf('  // 收口一条 loading 气泡',start);
assert.ok(start>0&&end>start);
const code=ts.transpileModule(source.slice(start,end)+'\nreturn {answerContext,takeAnswer,deliverAnswer};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const make=(fail=false)=>{
 const calls=[];
 const a={target:'chat:group#router',briefTurnId:'human-ticket',briefBubble:{frame:{req_id:'req'},streamId:'stream',done:false},channel:'chat:group',turnFromChat:true,cotLastSent:'existing progress'};
 const env={byTarget:new Map([[a.target,a]]),isPrivate:a=>a.channel==='',baseOfKey:t=>t.split('#')[0],clearCot:()=>{},client:{replyStream:async(...args)=>{calls.push({kind:'stream',args});if(fail)throw {headers:{req_id:'req'},errcode:40001,errmsg:'rejected'};},sendMessage:async(...args)=>calls.push({kind:'standalone',args})},log:{warn:()=>{}},errText:String,withLinkedTagHeader,chatTurnUrl:(target,turn)=>buildChatUrl('http://test','localhost',17890,turn,target,target)};
 return {...new Function(...Object.keys(env),code)(...Object.values(env)),calls,a};
};
{
 const x=make(),context=x.answerContext(x.a.target);
 assert.equal(context.prefix,'`existing progress`');
 assert.equal(x.takeAnswer('id',x.a.target,context.turn).taken,true);
 assert.equal(x.a.briefBubble,undefined,'source can no longer finalize transferred bubble');
 assert.equal(x.a.channel,'','source late messages remain private');
 await x.deliverAnswer('id','chat:group#worker',context.turn,context.channel,context.prefix,'direct answer',false);
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].kind,'stream');
 assert.equal(x.calls[0].args[1],'stream');assert.equal(x.calls[0].args[3],true);
 assert.match(x.calls[0].args[2],/existing progress[\s\S]*direct answer/);
 assert.match(x.calls[0].args[2],/role=chat%3Agroup%23worker/,'footer identifies target despite source ticket');
}
{
 const x=make(),c=x.answerContext(x.a.target);
 x.a.briefTurnId='new-human-turn';
 assert.equal(x.takeAnswer('stale-transfer',x.a.target,c.turn).taken,false,'a transfer whose injection crossed into a new turn cannot take the new human bubble');
 assert.equal(x.answerContext(x.a.target).turn,'new-human-turn');
 assert.ok(x.a.briefBubble,'the new turn bubble remains available to its owner');
}
for(const [failure,standalone] of [[false,true],[true,false]]){
 const x=make(failure),c=x.answerContext(x.a.target);x.takeAnswer('id',x.a.target,c.turn);
 await x.deliverAnswer('id','chat:group#worker',c.turn,c.channel,c.prefix,'terminal answer',standalone);
 assert.deepEqual(x.calls.map(c=>c.kind),['stream','standalone']);
 assert.match(x.calls[1].args[1].markdown.content,/existing progress[\s\S]*terminal answer/);
 assert.equal(x.calls[1].args[0],'group');
}
{
 const x=make(),a=x.a;a.briefTurnId=undefined;a.briefBubble=undefined;
 a.liveStream={turnId:'human-ticket',frame:{req_id:'req'},streamId:'stream',acc:'early A',closed:false,dead:false};
 const captured=x.answerContext(a.target);a.liveStream.acc+=' + latest visible A';
 const held=x.takeAnswer('race',a.target,captured.turn);
 assert.equal(held.taken,true);assert.equal(held.prefix,'early A + latest visible A');
 await x.deliverAnswer('race','chat:group#worker',captured.turn,captured.channel,captured.prefix,'answer A',false);
 assert.match(x.calls[0].args[2],/early A \+ latest visible A[\s\S]*answer A/,'latest stream accumulator survives answerContext race');
}
{
 const a={target:'chat:A#router-A',briefTurnId:undefined,channel:'chat:A',liveStream:{turnId:'turn-A',frame:{id:'frame-A'},streamId:'stream-A',acc:'bubble A',closed:false,dead:false}};
 const b={target:'chat:B#router-B',briefTurnId:undefined,channel:'chat:B',liveStream:{turnId:'turn-B',frame:{id:'frame-B'},streamId:'stream-B',acc:'bubble B',closed:false,dead:false}};
 const calls=[];const env={byTarget:new Map([[a.target,a],[b.target,b]]),isPrivate:x=>x.channel==='',baseOfKey:t=>t.split('#')[0],clearCot:()=>{},client:{replyStream:async(...args)=>calls.push({kind:'stream',args}),sendMessage:async(...args)=>calls.push({kind:'standalone',args})},log:{warn:()=>{}},errText:String,withLinkedTagHeader,chatTurnUrl:(target,turn)=>buildChatUrl('http://test','localhost',17890,turn,target,target)};
 const api=new Function(...Object.keys(env),code)(...Object.values(env));const ca=api.answerContext(a.target),cb=api.answerContext(b.target);
 assert.equal(api.takeAnswer('handoff-A',a.target,ca.turn).taken,true);assert.equal(api.takeAnswer('handoff-B',b.target,cb.turn).taken,true);
 a.briefTurnId='turn-A-new';a.briefBubble={frame:{id:'new-frame-A'},streamId:'new-stream-A',done:false};
 assert.equal(api.takeAnswer('late-old-A',a.target,ca.turn).taken,false,'old transfer cannot claim a newly opened bubble');assert.ok(a.briefBubble);
 await api.deliverAnswer('handoff-B',b.target,cb.turn,cb.channel,cb.prefix,'done B',false);
 await api.deliverAnswer('handoff-A',a.target,ca.turn,ca.channel,ca.prefix,'timeout A',true);
 assert.deepEqual(calls.map(x=>x.kind),['stream','stream','standalone']);
 assert.equal(calls[0].args[0].id,'frame-B');assert.match(calls[0].args[2],/bubble B[\s\S]*done B/);
 assert.equal(calls[1].args[0].id,'frame-A');assert.match(calls[1].args[2],/bubble A/);assert.doesNotMatch(calls[1].args[2],/done B/);
 assert.match(calls[2].args[1].markdown.content,/bubble A[\s\S]*timeout A/);assert.doesNotMatch(calls[2].args[1].markdown.content,/bubble B|done B/);
}
{
 const x=make();
 await x.deliverAnswer('recovered','chat:group#worker','human-ticket','chat:group','saved progress','recovered answer',false);
 assert.deepEqual(x.calls.map(c=>c.kind),['standalone'],'reload without frame delivers standalone');
 assert.match(x.calls[0].args[1].markdown.content,/saved progress[\s\S]*recovered answer/);
}
{
 const x=make(),c=x.answerContext(x.a.target);
 // Replace stream transport with a lost ACK after recording the frame as visible.
 x.a.briefBubble=undefined;
 const a=x.a;a.briefTurnId=undefined;a.liveStream={turnId:c.turn,frame:{req_id:'req'},streamId:'stream',acc:c.prefix,closed:false,dead:false};
 // The client recorded the outgoing final before its ACK timed out.
 const code=source.slice(start,end).replace("if(fail)throw {headers:{req_id:'req'},errcode:40001,errmsg:'rejected'};","throw new Error('Reply ack timeout');");
 const env={byTarget:new Map([[a.target,a]]),isPrivate:a=>a.channel==='',baseOfKey:t=>t.split('#')[0],clearCot:()=>{},client:{replyStream:async(...args)=>{x.calls.push({kind:'stream',args});throw new Error('Reply ack timeout');},sendMessage:async(...args)=>x.calls.push({kind:'standalone',args})},log:{warn:()=>{}},errText:String,withLinkedTagHeader,chatTurnUrl:(target,turn)=>buildChatUrl('http://test','localhost',17890,turn,target,target)};
 const isolated=new Function(...Object.keys(env),ts.transpileModule(code+'\nreturn {answerContext,takeAnswer,deliverAnswer};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText)(...Object.values(env));
 const ctx=isolated.answerContext(a.target);assert.ok(ctx);
 assert.equal(isolated.takeAnswer('lost-ack-2',a.target,ctx.turn).taken,true);
 await assert.rejects(isolated.deliverAnswer('lost-ack-2',a.target,ctx.turn,ctx.channel,ctx.prefix,'FINAL-ONCE',false),/Reply ack timeout/);
 assert.equal(x.calls.filter(v=>v.kind==='standalone').length,0,'ambiguous ACK never triggers duplicate standalone final');
}
{
 const a={target:'chat:group#worker',briefTurnId:'t-timeout',briefBubble:{frame:{req_id:'r'},streamId:'s',done:false},channel:'chat:group',turnFromChat:true};
 const calls=[];const env={byTarget:new Map([[a.target,a]]),isPrivate:()=>false,baseOfKey:t=>t.split('#')[0],clearCot:()=>{},client:{replyStream:async(...args)=>{calls.push(['stream',...args]);throw new Error('Reply ack timeout');},sendMessage:async(...args)=>calls.push(['standalone',...args])},log:{warn:()=>{}},errText:String,withLinkedTagHeader,chatTurnUrl:(target,turn)=>buildChatUrl('http://test','localhost',17890,turn,target,target)};
 const api=new Function(...Object.keys(env),code)(...Object.values(env));
 api.takeAnswer('timeout','chat:group#worker','t-timeout');
 await api.deliverAnswer('timeout','chat:group#worker','t-timeout','chat:group','progress','timeout explanation',true);
 assert.deepEqual(calls.map(x=>x[0]),['stream','standalone'],'ambiguous progress-close ACK still sends one required terminal explanation');
 assert.match(calls[1][2].markdown.content,/timeout explanation/);
}
console.log('answer transfer mirror: retained stream content, ownership, terminal standalone, expired stream and reload passed');

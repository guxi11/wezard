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
 const env={byTarget:new Map([[a.target,a]]),isPrivate:a=>a.channel==='',baseOfKey:t=>t.split('#')[0],clearCot:()=>{},client:{replyStream:async(...args)=>{calls.push({kind:'stream',args});if(fail)throw new Error('window expired');},sendMessage:async(...args)=>calls.push({kind:'standalone',args})},log:{warn:()=>{}},errText:String,withLinkedTagHeader,chatTurnUrl:(target,turn)=>buildChatUrl('http://test','localhost',17890,turn,target,target)};
 return {...new Function(...Object.keys(env),code)(...Object.values(env)),calls,a};
};
{
 const x=make(),context=x.answerContext(x.a.target);
 assert.equal(context.prefix,'`existing progress`');
 x.takeAnswer('id',x.a.target);
 assert.equal(x.a.briefBubble,undefined,'source can no longer finalize transferred bubble');
 assert.equal(x.a.channel,'','source late messages remain private');
 await x.deliverAnswer('id','chat:group#worker',context.turn,context.channel,context.prefix,'direct answer',false);
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].kind,'stream');
 assert.equal(x.calls[0].args[1],'stream');assert.equal(x.calls[0].args[3],true);
 assert.match(x.calls[0].args[2],/existing progress[\s\S]*direct answer/);
 assert.match(x.calls[0].args[2],/role=chat%3Agroup%23worker/,'footer identifies target despite source ticket');
}
for(const [failure,standalone] of [[false,true],[true,false]]){
 const x=make(failure),c=x.answerContext(x.a.target);x.takeAnswer('id',x.a.target);
 await x.deliverAnswer('id','chat:group#worker',c.turn,c.channel,c.prefix,'terminal answer',standalone);
 assert.deepEqual(x.calls.map(c=>c.kind),['stream','standalone']);
 assert.match(x.calls[1].args[1].markdown.content,/existing progress[\s\S]*terminal answer/);
 assert.equal(x.calls[1].args[0],'group');
}
{
 const x=make();
 await x.deliverAnswer('recovered','chat:group#worker','human-ticket','chat:group','saved progress','recovered answer',false);
 assert.deepEqual(x.calls.map(c=>c.kind),['standalone'],'reload without frame delivers standalone');
 assert.match(x.calls[0].args[1].markdown.content,/saved progress[\s\S]*recovered answer/);
}
console.log('answer transfer mirror: retained stream content, ownership, terminal standalone, expired stream and reload passed');

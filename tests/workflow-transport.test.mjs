// Exercise the real paste helper and mirror submission function with fake tmux I/O.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createTmuxBufferPaster} from '../daemon/tmux-buffer.ts';
const ok=(stdout='')=>({ok:true,stdout,stderr:'',code:0});
for(const version of ['tmux 1.8','tmux 3.4']){
 let valid=true;const commands=[];
 const paste=createTmuxBufferPaster(async(args)=>{commands.push(args[0]);if(args[0]==='-V')return ok(version);if(args[0]==='load-buffer'){await Promise.resolve();valid=false;}return ok();});
 const r=await paste('%1','effect',()=>valid);
 assert.equal(r.ok,false);assert.ok(!commands.includes('paste-buffer'),'check after async load and legacy lock');
}
const source=readFileSync('daemon/mirror-bridge.ts','utf8');
const a=source.indexOf('const injectViaTmuxText =');const b=source.indexOf('const injectViaSpawn =',a);
const code=ts.transpileModule(source.slice(a,b)+'\nreturn injectViaTmuxText;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
let valid=true,reads=0;const commands=[];
const env={NO_WITNESS:{status:'',submitted:()=>false},fingerprints:()=>({headFp:'effect',tailFp:''}),probeOf:s=>s,
 readInputBox:async()=>({known:true,body:reads++?'effect':''}),readPaneInput:async()=>({cap:'effect',box:{known:true,body:'effect'}}),
 pasteTmuxBuffer:async(target,text,guard)=>{assert.ok(guard());commands.push('paste');valid=false;return {ok:true};},
 captureUndimmed:async()=>'',sleep:async()=>{},runTmux:async(args)=>{commands.push(args[0]);return ok();}};
const inject=new Function(...Object.keys(env),code)(...Object.values(env));
const result=await inject('%1','effect',{warn(){},info(){}},false,undefined,()=>valid);
assert.equal(result.ok,false);assert.deepEqual(commands,['paste'],'no Enter after cancellation during paste verification');
console.log('workflow physical transport: guard after buffer load and before Enter passed');

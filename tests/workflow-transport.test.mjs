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

// Real birth functions: revoke while tmux creation is awaiting, before binding
// or fork bootstrap. Only the newly born empty pane is eligible for cleanup.
const nsStart=source.indexOf('  const newSession = async ('),nsEnd=source.indexOf('  // ── Clone',nsStart);
const nsCode=ts.transpileModule(source.slice(nsStart,nsEnd)+'\nreturn newSession;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
let birthValid=true,bound=0,spawnCalls=0;const killed=[];
const birthEnv={byTarget:new Map(),deps:{store:{get:()=>undefined}},chatCwdFallback:()=>({}),expandHome:s=>s,expandedDefaultCwd:'/tmp',baseOfKey:s=>s,
 resolveCliBackend:()=>({name:'claude'}),newStewardSpec:()=>({}),randomUUID:()=> 'fresh',inFlightSids:new Set(),cfg:{wrc:{}},
 log:{child:()=>({})},charterFor:()=>'',attach:()=>{bound++;return {ok:true};},
 spawnTmuxClaude:async()=>{spawnCalls++;await Promise.resolve();birthValid=false;return {ok:true,tmuxPane:'%new'};},runTmux:async a=>{killed.push(a);return ok();}};
const newSession=new Function(...Object.keys(birthEnv),nsCode)(...Object.values(birthEnv));
birthValid=false;assert.equal((await newSession('reserved','reserved',undefined,{guard:()=>birthValid})).ok,false);assert.equal(spawnCalls,0);
birthValid=true;assert.equal((await newSession('reserved','reserved',undefined,{guard:()=>birthValid})).ok,false);assert.equal(bound,0);assert.deepEqual(killed,[['kill-pane','-t','%new']]);assert.equal(birthEnv.inFlightSids.size,0);
const csStart=source.indexOf('  const cloneSession = async'),csEnd=source.indexOf('  /** 一个会话此刻的硬事实',csStart);
const csCode=ts.transpileModule(source.slice(csStart,csEnd)+'\nreturn cloneSession;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
let bootExecuted=0,guardSeen=false;
const cloneEnv={...birthEnv,byTarget:new Map([['parent',{sessionId:'parent',jsonlPath:'/tmp/parent.jsonl',runningCwd:'/tmp'}]]),existsSync:()=>true,dirname:()=>'/tmp',listJsonls:()=>new Set(),backendForPath:()=>({name:'claude'}),lastModel:()=>'',parseEffort:()=>undefined,rememberInject:()=>{},
 inject:async a=>{guardSeen=typeof a.guard==='function';if(a.guard&&!a.guard('paste'))return {ok:false,reason:'withdrawn'};bootExecuted++;return {ok:true};}};
const cloneSession=new Function(...Object.keys(cloneEnv),csCode)(...Object.values(cloneEnv));
birthValid=true;assert.equal((await cloneSession({parent:'parent',target:'reserved',bootstrap:'UNPLANNED',guard:()=>birthValid})).ok,false);assert.equal(guardSeen,true);assert.equal(bootExecuted,0);assert.equal(bound,0);
console.log('workflow birth transport: pre-spawn, async spawn/binding and fork bootstrap guards passed');

// Actual lazy restore: both tmux awaits must withdraw before any healing writes
// or attach effects. Boot/ordinary unguarded restore remains compatible.
const rsStart=source.indexOf('  const restoreFromStore = async'),rsEnd=source.indexOf('  // Write the live `/stop` pause state',rsStart);
const rsCode=ts.transpileModule(source.slice(rsStart,rsEnd)+'\nreturn restoreFromStore;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
for(const mode of ['pane-probe','cwd-probe','legacy']){
 let valid=true,writes=0,attaches=0;const registry=new Map();
 const rec={sessionId:'old',jsonlPath:'/tmp/old.jsonl',tmuxPane:'%old',cwd:'/tmp'};
 const restoreEnv={deps:{store:{get:()=>rec,set:()=>{writes++;},drop:()=>{writes++;}}},expandHome:s=>s,existsSync:()=>true,
 tmuxPaneAlive:async()=>{await Promise.resolve();if(mode==='pane-probe')valid=false;return true;},
 runTmux:async()=>{await Promise.resolve();if(mode==='cwd-probe')valid=false;return {stdout:'/tmp'};},
 backendForPath:()=>({name:'claude'}),projectDirFor:()=>'/tmp',dirname:()=>'/tmp',byTarget:registry,
 attach:()=>{attaches++;registry.set('target',{});return {ok:true};},log:{info(){},warn(){}}};
 const restore=new Function(...Object.keys(restoreEnv),rsCode)(...Object.values(restoreEnv));
 const r=await restore('target',undefined,mode==='legacy'?undefined:()=>valid);
 assert.equal(attaches,mode==='legacy'?1:0);assert.equal(writes,0);assert.equal(r!==undefined,mode==='legacy');
}
console.log('workflow lazy restore: pane/cwd await withdrawal and unguarded compatibility passed');

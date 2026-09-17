import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,legalActions} from './engine.js';
import {newProfile} from './progression.js';
import {runCoach,buildContext} from './coach/runtime.js';
import {freshMemory,rememberBattle,readMemory} from './coach/memory.js';
const request=(message,game=createGame(),profile=newProfile(),memory=freshMemory())=>runCoach({message,context:buildContext(game,profile,'fox'),memory});
test('strategist gives a legal action grounded in current state',async()=>{const g=createGame(),answer=await request('这回合怎么打',g);assert.equal(answer.route,'strategist');assert(legalActions(g).some(a=>JSON.stringify(a)===JSON.stringify(answer.actions[0])));assert(answer.evidence.some(x=>x.includes('能量')));});
test('teacher reads selected pet and resource limits',async()=>{const p=newProfile();p.tokens=0;const a=await request('怎么培养',null,p);assert.match(a.text,/烬尾狐/);assert.match(a.text,/没有训练点/);});
test('quiz closes the teaching loop and records success',async()=>{const a=await request('小测验');assert(a.memory.pendingQuiz);const b=await request('先出手',createGame(),newProfile(),a.memory);assert.match(b.text,/答对/);assert.equal(b.memory.lessons.length,1);assert.equal(b.memory.pendingQuiz,null);});
test('explicit preference persists and preview results are not remembered',async()=>{const a=await request('记住以后简短说');assert.equal(readMemory(JSON.stringify(a.memory)).preference,'brief');const g=createGame();g.result='loss';assert.equal(rememberBattle(freshMemory(),g).events.length,1);g.preview=true;assert.equal(rememberBattle(freshMemory(),g).events.length,0);});
test('PVP restriction happens before provider calls',async()=>{let called=false;const c=buildContext(createGame(),newProfile(),'fox');c.mode='pvp-live';const a=await runCoach({message:'怎么打',context:c,memory:freshMemory(),provider:{async generate(){called=true;}}});assert.equal(called,false);assert.match(a.text,/不提供/);});
test('context excludes real RNG and invalid provider output is rejected',async()=>{const g=createGame(445);const c=buildContext(g,newProfile(),'fox');assert.equal(c.battle.seed,0);assert(!('initialSeed' in c.battle));await assert.rejects(runCoach({message:'怎么打',context:c,memory:freshMemory(),provider:{async generate(){return null;}}}));});

import {step} from './engine.js';
import {observe,feedback,archiveRound,reverseRounds,markdown,lessonFor} from './coach/experience.js';
test('ordinary play closes observation choice feedback and relevant practice',()=>{const g=createGame();const hint=observe(g);assert(hint.action);const next=step(g,hint.action);const h=next.history.at(-1);const result=feedback(h,hint);assert.match(result.text,/选择了建议行动/);assert(result.quiz.question);assert.equal(observe({...g,mode:'pvp-live'}),null);assert.equal(feedback(h,{...hint,turn:99}),null);assert.equal(lessonFor({...h,action:{kind:'skill',id:'ember'}}).id,'灼烧追击');});
test('round survives camp and serialization without leaking into new match',async()=>{const g=step(createGame(),{kind:'skill',id:'ember'});const archive=JSON.parse(JSON.stringify(archiveRound(g)));const context=buildContext(null,newProfile(),'fox',archive);const answer=await runCoach({message:'回顾上一回合',context,memory:freshMemory()});assert.match(answer.text,/第 1 回合/);assert(!answer.text.includes('没有回合'));assert.equal(buildContext(createGame(),newProfile(),'fox',archive).lastTurn,null);assert.equal(archiveRound({...g,preview:true},archive),archive);});
test('newest rounds first preserves event order; Markdown never executes HTML',()=>{assert.deepEqual(reverseRounds(['开始','── 1','a','b','── 2','c','d']),['── 2','c','d','── 1','a','b','开始']);assert.match(markdown('**重点**\n- 内容'),/<strong>重点<\/strong>/);assert(!markdown('<img src=x onerror=alert(1)>').includes('<img'));});
test('runaway model output falls back to grounded packet',async()=>{const a=await runCoach({message:'怎么打',context:buildContext(createGame(),newProfile(),'fox'),memory:freshMemory(),provider:{name:'fake',async generate(){return '冗长'.repeat(500);}}});assert(a.text.length<600);assert.match(a.text,/这一回合/);});

import {attentionState,trackAttention,shouldNudge,attentionText} from './coach/experience.js';
import {gatherAgentEvidence} from './coach/runtime.js';
test('seed explanation and follow-up cannot be rewritten as pet resources',async()=>{
 let calls=0;const provider={name:'bad-model',async generate(){calls++;return '种子是一种宠物';}};
 const args={context:buildContext(null,newProfile(),'fox'),memory:freshMemory(),provider};
 const a=await runCoach({...args,message:'种子啥意思'});assert.match(a.text,/随机编号/);assert.equal(calls,0);
 const b=await runCoach({...args,memory:a.memory,message:'就是首页的种子'});assert.match(b.text,/不是宠物/);
 const c=await runCoach({...args,memory:b.memory,message:'？'});assert.equal(c.route,'guide');assert.equal(calls,0);
});
test('quiz waits for an answer, survives reload, handles question mark and cancels',async()=>{
 const args={context:buildContext(null,newProfile(),'fox'),memory:freshMemory(),provider:{async generate(){throw Error('must not leak quiz to model');}}};
 const a=await runCoach({...args,message:'出一道小测验'});assert.match(a.text,/假设练习/);assert(!a.text.includes('答对'));assert.equal(a.choices.length,4);
 const memory=readMemory(JSON.stringify(a.memory));assert(memory.pendingQuiz);
 const b=await runCoach({...args,memory,message:'？'});assert(b.memory.pendingQuiz);assert.match(b.text,/等你作答/);
 const c=await runCoach({...args,memory:b.memory,message:'后出手'});assert.equal(c.quizResult.correct,false);assert.equal(c.memory.lessons.length,0);assert.match(c.text,/38\+3=41/);
 const cancel=await runCoach({...args,memory,message:'先不做了'});assert.equal(cancel.memory.pendingQuiz,null);
});
test('provider receives earlier dialogue and topic instead of an isolated follow-up',async()=>{
 const a=await request('怎么培养',null);let seen;
 await runCoach({message:'为什么',context:buildContext(null,newProfile(),'fox'),memory:readMemory(JSON.stringify(a.memory)),provider:{name:'fake',async generate(p){seen=p;return '我接着刚才的培养说。';}}});
 assert(seen.conversation.some(x=>x.content==='怎么培养'));assert(seen.conversation.some(x=>x.role==='assistant'));
});
test('attention is bounded, respects silence and cannot fire in background',()=>{
 const s=attentionState(0);trackAttention(s,'1','a',0);trackAttention(s,'1','b',4000);trackAttention(s,'1','a',8000);
 assert(shouldNudge(s,{now:9000,turn:'1'}));assert(!shouldNudge(s,{now:9000,turn:'1',active:false}));
 assert(!shouldNudge(s,{now:25000,turn:'1',mode:'quiet'}));assert(!shouldNudge(s,{now:25000,turn:'1',mode:'critical',risk:false}));
 s.shownTurn='1';assert(!shouldNudge(s,{now:80000,turn:'1'}));trackAttention(s,'2',null,90000);s.dismissed=true;assert(!shouldNudge(s,{now:120000,turn:'2'}));
 assert.match(attentionText(createGame(),{kind:'switch',target:1}),/用掉这回合/);
});
test('agent planner can adapt to tool receipts and invalid tools never execute',async()=>{
 const context=buildContext(createGame(),newProfile(),'fox');
 const result=await gatherAgentEvidence({message:'换宠能再攻击吗',context,plan:async t=>t.receipts.length?{tool:'compare_actions',args:{}}:{tool:'search_rules',args:{query:'换宠 回合'}}});
 assert.deepEqual(result.trace.map(x=>x.tool),['search_rules','compare_actions']);assert.equal(result.stopped,'tool-budget');
 const invalid=await gatherAgentEvidence({message:'x',context,plan:async()=>({tool:'execute_code'})});assert.equal(invalid.stopped,'invalid-tool');assert.equal(invalid.trace.length,0);
 let count=0;await gatherAgentEvidence({message:'x',context:{...context,mode:'pvp-live'},plan:async()=>{count++;}});assert.equal(count,0);
});

import {summarizeMatch,reviewMatch} from './coach/teacher.js';
import {decisiveOpportunity} from './coach/experience.js';
test('whole-match archive persists all turns, separates matches and preserves previews',async()=>{
 let g=createGame(17);g.player.pets.forEach(p=>{p.hp=1000;p.maxHp=1000;});g.id='battle-a';let archive=null;
 for(let i=0;i<4&&!g.result;i++){g=step(g,legalActions(g).find(a=>a.kind==='skill'));archive=archiveRound(g,archive);}
 g.result='win';archive=archiveRound(g,archive);archive=JSON.parse(JSON.stringify(archive));
 assert.equal(archive.completed[0].history.filter(h=>h.type==='turn').length,4);
 const context=buildContext(null,newProfile(),'fox',archive,'meadow','回顾上一局');
 const a=await runCoach({message:'回顾上一局',context,memory:freshMemory()});assert.equal(a.scope,'match');assert.match(a.text,/共4回合/);assert(a.choices.length);
 const b=await runCoach({message:'一整局',context,memory:a.memory});assert.equal(b.scope,'match');assert.match(b.text,/共4回合/);
 const next=step({...createGame(22),id:'battle-b'},{kind:'skill',id:'ember'});archive=archiveRound(next,archive);
 assert.equal(archive.completed[0].id,'battle-a');assert.equal(archive.current.id,'battle-b');
 const prior=buildContext(next,newProfile(),'fox',archive,'meadow','回顾上一局');assert.equal(prior.lastMatch.id,'battle-a');
 assert.equal(archiveRound({...next,preview:true},archive),archive);
});
test('selected review turn returns its evidence rather than the final hit',()=>{
 let g={...createGame(17),id:'battle-x'};g.player.pets.forEach(p=>{p.hp=1000;p.maxHp=1000;});for(let i=0;i<3;i++)g=step(g,legalActions(g).find(a=>a.kind==='skill'));g.result='win';
 const context=buildContext(null,newProfile(),'fox',archiveRound(g),'meadow','详看第1回合');assert.equal(context.lastTurn.before.turn,1);
 const summary=summarizeMatch(g);assert.equal(Object.values(summary.counts).reduce((a,b)=>a+b,0),3);
 assert.equal(reviewMatch({}).scope,'match');assert.match(reviewMatch({}).text,/无法还原/);
});
test('screenshot endgame flags attack opportunity with guard caveat',()=>{
 const g=createGame(17,['turtle','fox','sparrow'],{enemyTeam:['turtle','otter','deer']});g.turn=25;
 Object.assign(g.player.pets[0],{hp:28,maxHp:142,atk:36,def:32,speed:16,energy:6});
 Object.assign(g.enemy.pets[0],{hp:31,maxHp:161,atk:23,def:31,speed:13,energy:1});g.enemy.items.potion=0;g.enemy.pets.slice(1).forEach(p=>p.hp=0);
 const cue=decisiveOpportunity(g);assert(cue);assert.equal(cue.action.id,'tide');assert.equal(cue.evidence.damage,38);assert.match(cue.text,/防御/);
 assert.equal(decisiveOpportunity({...g,mode:'pvp-live'}),null);g.player.pets[0].energy=0;assert.equal(decisiveOpportunity(g),null);
});

test('current-match selection and missing requested turn never substitute another match or turn',async()=>{
 const previous={...step(createGame(12),{kind:'skill',id:'ember'}),id:'previous',result:'win'};
 const current={...step(createGame(13),{kind:'skill',id:'ember'}),id:'current'};
 const archive=archiveRound(current,archiveRound(previous));
 assert.equal(buildContext(current,newProfile(),'fox',archive,'meadow','回顾本局').lastMatch.id,'current');
 const context=buildContext(current,newProfile(),'fox',archive,'meadow','详看第99回合');
 assert.equal(context.lastTurn,null);
 const reply=await runCoach({message:'详看第99回合',context,memory:freshMemory()});assert.match(reply.text,/没有第 99 回合/);
});

import {requestCoach} from './coach/client.js';
test('whole-match UI request can review archived evidence without network or model credentials',async()=>{
 const g={...step(createGame(12),{kind:'skill',id:'ember'}),id:'offline-match',result:'win'};
 const answer=await requestCoach({message:'回顾上一局',context:buildContext(null,newProfile(),'fox',archiveRound(g),'meadow','回顾上一局'),memory:freshMemory(),stateToken:'camp-1'});
 assert.equal(answer.scope,'match');assert.equal(answer.verified,true);assert.equal(answer.stateToken,'camp-1');assert.match(answer.text,/共1回合/);
});

test('withdrawal is recorded separately from attacks in match summaries',()=>{
 let g=step(createGame(17),{kind:'skill',id:'ember'});g=step(g,{kind:'escape'});
 const m=summarizeMatch(g);assert.equal(m.rounds,2);assert.equal(m.counts.attacks,1);assert.equal(m.counts.escapes,1);
 assert.match(reviewMatch({lastMatch:m}).text,/撤退1次/);assert.match(m.keyTurns.at(-1).analysis,/直接结束对局/);
});

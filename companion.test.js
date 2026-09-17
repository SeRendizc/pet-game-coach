// 陪练闭环的自动测试：状态派生、档位切换、真实事件引用、克制约束、偏好跨局保持。
// 对局数据全部由引擎真实跑出来（不是手写的事件对象），这样「引用真实事件」才是真的被验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,step,legalActions,rankEnemyActions,SPECIES} from './engine.js';
import {newProfile} from './progression.js';
import {freshMemory,rememberBattle,readMemory,recordCoachEvent} from './coach/memory.js';
import {companion,companionState,companionFacts,checkCompanionRestraint,decideRegister,proactiveRegister,proactiveText,intentOf,trailingStreak,REGISTERS,REGISTER_ORDER} from './coach/companion.js';
import {runCoach,buildContext} from './coach/runtime.js';
import {coachEvent,coachContext} from './coach.js';

const STAGE='05 · 冠军高地';
// 随机出招必输；按引擎枚举的推荐出招会赢。两个种子是真实跑完的对局，不是编的结果。
function play(seed,{smart=false}={}){
 let g=createGame(seed,undefined,{difficulty:'normal',stageName:STAGE,stageId:'summit'});g.id='match-'+seed+(smart?'-smart':'');
 for(let n=0;n<160&&!g.result;n++){
  const actions=legalActions(g);
  g=step(g,smart?(rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||actions[0]):(actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions.find(a=>a.kind==='switch')||actions[0]));
 }
 return g;
}
const lossGame=()=>play(1);
const winGame=()=>play(4,{smart:true});
const history=games=>games.reduce((memory,game)=>rememberBattle(memory,game),freshMemory());

test('companion state is derived from real matches, dismissals and dialogue',()=>{
 const win=winGame(),loss=lossGame(),loss2=play(7);
 const memory=history([win,loss,loss2]);
 assert.equal(memory.events.length,3);
 const state=companionState(memory,{mode:'camp'},{playerInitiated:false},Date.now());
 assert.equal(state.momentum,-1,'1胜2负应为 -1');
 assert.equal(state.lossStreak,2,'最近两局连续失利');
 assert.equal(state.winStreak,0);
 assert.equal(state.consideration,2);
 assert.equal(state.engagement,1);
 assert(state.reasons.some(r=>/momentum=-1/.test(r)&&/memory\.events/.test(r)),'原因必须写明来源字段');
 assert(state.reasons.some(r=>/consideration=2/.test(r)&&/dismiss/.test(r)));
 // 与 adaptiveGate 读同一份 dismiss 数据：7 天内 2 次关闭 → 体贴度 0
 let gated=memory;
 for(const turn of [1,2])gated=recordCoachEvent(gated,{id:`m${turn}:dismiss:${turn}`,kind:'dismiss',matchId:`m${turn}`,turn});
 assert.equal(companionState(gated,{mode:'camp'},{},Date.now()).consideration,0);
 // 7 天以前的关闭不再压档
 const stale=recordCoachEvent(memory,{id:'old:dismiss:1',kind:'dismiss',matchId:'old',turn:1,time:new Date(Date.now()-8*86400000).toISOString()});
 assert.equal(companionState(stale,{mode:'camp'},{},Date.now()).consideration,2);
 // 空记忆：没有任何可依据的经历
 const empty=companionState(freshMemory(),{mode:'camp'},{playerInitiated:true,intent:'ask'},Date.now());
 assert.deepEqual([empty.momentum,empty.consideration,empty.engagement,empty.hasExperience],[0,2,2,false]);
 assert.equal(empty.register,'R0');
 assert.equal(trailingStreak(memory.events,'loss'),2);
});

test('register table: silence stays first and engagement never raises the ceiling',()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const stateFor=(message,context={},source=memory)=>companionState(source,context,{playerInitiated:true,intent:intentOf(message),message},Date.now());
 assert.equal(stateFor('随便聊聊',{preference:'quiet'}).register,'R0');
 assert.equal(stateFor('随便聊聊',{mode:'pvp-live',battle:{mode:'pvp-live'}}).register,'R0');
 assert.equal(stateFor('随便聊聊',{mode:'pvp-live',battle:{mode:'pvp-live',result:'loss'}}).register,'R1','对局结束后不再受线上竞技门控');
 assert.equal(decideRegister({context:{},playerInitiated:false,consideration:0,momentum:-3,pendingObservation:true}).register,'R0');
 assert.equal(stateFor('烦').register,'R3','真实连败时的倾诉才进收尾陪坐');
 assert.equal(stateFor('烦',{},history([winGame()])).register,'R2','没有连败记录时只做具体关切');
 assert.equal(stateFor('？').register,'R2');
 assert.equal(stateFor('你好').register,'R0');
 assert.equal(stateFor('这局怎么打').register,'R2');
 assert.equal(stateFor('随便聊聊').register,'R1');
 assert.equal(stateFor('这局怎么打',{},freshMemory()).register,'R0','没有真实记录时不进具体关切');
 assert.equal(decideRegister({playerInitiated:false,consideration:2,momentum:-3,pendingObservation:true,alreadySaid:false}).register,'R3');
 assert.equal(decideRegister({playerInitiated:false,consideration:2,momentum:-3,pendingObservation:true,alreadySaid:true}).register,'R1','本局已经就这件事说过就不再收尾');
 assert.equal(decideRegister({playerInitiated:false,consideration:2,momentum:0,pendingObservation:false}).register,'R0');
 // 表驱动：任何组合都不能超出档位表，且 engagement 只允许往下压
 for(const momentum of [-3,-2,-1,0,1,2,3])for(const consideration of [0,1,2])for(const playerInitiated of [true,false])for(const intent of ['emotion','followup','chat','ask','other']){
  const register=decideRegister({context:{},intent,playerInitiated,consideration,momentum,hasExperience:true,pendingObservation:true}).register;
  assert(REGISTER_ORDER.includes(register),`${register} 不在档位表里`);
  if(consideration===0&&!playerInitiated)assert.equal(register,'R0');
  const state=companionState(memory,{mode:'camp'},{playerInitiated,intent},Date.now());
  assert(state.engagement<=2,'engagement 上限为 2');
 }
});

test('the register changes the wording, not only the field',()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const answers=['你好','随便聊聊','这局怎么打','烦'].map(message=>companion({mode:'camp'},memory,message));
 assert.deepEqual(answers.map(a=>a.register),['R0','R1','R2','R3']);
 assert.equal(new Set(answers.map(a=>a.text)).size,4,'四个档位必须给出四种不同的文本');
 for(const answer of answers){
  assert(answer.text.length<=REGISTERS[answer.register].limit,`${answer.register} 超长：${answer.text}`);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons}}).valid,answer.text);
 }
 const [r0,r1,r2,r3]=answers;
 assert.equal(r0.text,'我在。');
 assert(!/[？?]/.test(r1.text+r3.text),'R1/R3 不得使用问句');
 assert.match(r3.text,/到这儿也行/);
 assert.match(r3.text,/连着2局没赢/);
 assert(!/加油|别灰心|你已经很棒/.test(answers.map(a=>a.text).join('')));
 // 模型路径：档位随证据包一起送到服务端，字数上限/问句上限可见
 assert.deepEqual([r0.replyConstraints.maxChars,r1.replyConstraints.maxChars,r2.replyConstraints.maxChars,r3.replyConstraints.maxChars],[8,40,80,30]);
 assert.deepEqual([r0.replyConstraints.maxQuestions,r2.replyConstraints.maxQuestions],[0,1]);
 assert.match(r1.replyConstraints.instruction,/R1/);
 assert.equal(r0.replyConstraints.forbid.includes(''),false);
});

test('templates cite the real match, the fallen pet and the opponent',()=>{
 const loss=lossGame();
 const memory=history([winGame(),loss]);
 const last=memory.events.at(-1);
 const fallen=loss.player.pets.filter(p=>p.hp<=0).map(p=>p.name);
 assert.equal(last.stage,STAGE);
 assert.deepEqual(last.enemy,loss.enemy.pets.map(p=>p.name));
 assert.deepEqual(last.faints,fallen);
 assert.equal(last.firstFallen,fallen[0]);
 assert.equal(last.turns,loss.turn);
 // R1：真实关卡、真实回合数、真实结果
 const r1=companion({mode:'camp'},memory,'随便聊聊').text;
 assert.match(r1,/冠军高地/);
 assert.match(r1,new RegExp(`${last.turns}回合`));
 assert.match(r1,/失利/);
 // R2：真实的首次减员回合与那只宠物
 const r2=companion({mode:'camp'},memory,'这局怎么打').text;
 assert.match(r2,new RegExp(`${last.firstFallen}在第${last.firstLossTurn}回合倒下`));
 assert.match(r2,new RegExp(`想回看第${last.firstLossTurn}回合`));
 // 依据里必须能核对这些数字与名字
 const evidence=companion({mode:'camp'},memory,'这局怎么打').evidence.join(' ');
 assert.match(evidence,/冠军高地/);
 assert.match(evidence,new RegExp(`首个减员在第${last.firstLossTurn}回合`));
 assert.match(evidence,new RegExp(`对手${last.enemy.join('、')}`));
 // 当前局面里的事实同样来自 game 本身
 const live=companion({mode:'pve',battle:{player:loss.player,enemy:loss.enemy,active:0,turn:loss.turn,mode:'pve'}},freshMemory(),'这局怎么打').text;
 assert.match(live,new RegExp(loss.enemy.pets[loss.enemy.active].name));
});

test('every number the companion says is backed by its own evidence',()=>{
 // checkGroundedAnswer 会用 evidence 做数字核对；模板若引用了依据里没有的数字，
 // 模型照抄就会被打回本地，所以这条是模板与依据之间的硬约束。
 const fixtures=[history([lossGame()]),history([winGame(),lossGame(),play(7)])];
 for(const memory of fixtures)for(const message of ['你好','随便聊聊','这局怎么打','烦','？']){
  const answer=companion({mode:'camp'},memory,message);
  const supported=new Set((JSON.stringify(answer.evidence).match(/-?\d+(?:\.\d+)?/g)||[]).map(Number));
  for(const number of answer.text.match(/-?\d+(?:\.\d+)?/g)||[])assert(supported.has(Number(number))||['1','2','3'].includes(number),`${message}「${answer.text}」里的 ${number} 不在依据里`);
  assert(answer.evidence.some(x=>/语气档位 R\d/.test(x)),'必须能回答「为什么是这个语气」');
  assert(answer.companionState.reasons.length>=3);
 }
});

test('restraint scan rejects the five forbidden shapes and accepts our own templates',()=>{
 const facts={allowPast:true,lessons:['灼烧追击']};
 const cases=[['别灰心，你已经很棒了！','empty-encouragement'],['没关系的，下次一定赢。','empty-encouragement'],['我很开心能陪你打这一局。','first-person-emotion'],['这局要不要再来？还是先看看？','too-many-questions'],['你速度意识差，太弱了。','skill-insult'],['我们已经练过速度判断了。','lesson-not-recorded']];
 for(const [text,reason] of cases)assert(checkCompanionRestraint(text,{register:'R2',facts}).reasons.some(r=>r.startsWith(reason)),`${text} → ${reason}`);
 assert(checkCompanionRestraint('上次那局你也是这么输的。',{register:'R2',facts:{allowPast:false,lessons:[]}}).reasons.includes('unsupported-past-claim'));
 assert.equal(checkCompanionRestraint('上次那局你也是这么输的。',{register:'R2',facts:{allowPast:true,lessons:[]}}).valid,true,'有记录时同样的句子是允许的');
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R2',facts}).valid,true,'R2 允许一个问句');
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R1',facts}).valid,false);
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R3',facts}).valid,false);
 assert(checkCompanionRestraint('还看第3回合吗？',{register:'R2',facts,previousAssistant:'想继续吗？'}).reasons.includes('consecutive-questions'));
 assert.equal(checkCompanionRestraint('长'.repeat(41),{register:'R1',facts}).valid,false);
 assert.equal(checkCompanionRestraint('   ',{register:'R1',facts}).reasons.includes('empty-text'),true);
 // 我们自己生成的每一条都必须过扫描
 const memory=history([winGame(),lossGame(),play(7)]);
 for(const message of ['你好','随便聊聊','这局怎么打','烦','？']){
  const answer=companion({mode:'camp'},memory,message);
  assert.deepEqual(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons},previousAssistant:''}).reasons,[],answer.text);
 }
});

test('one loss never becomes comfort, and silence stays a real output',()=>{
 const memory=history([lossGame()]);
 const sad=companion({mode:'camp'},memory,'好烦');
 assert.equal(sad.register,'R2','只有一局失利时不进收尾陪坐');
 assert(!/加油|别灰心|你已经很棒|下次一定|没关系/.test(sad.text));
 assert(!/[？?]/.test(sad.text));
 // 允许沉默：没有真实经历时只说最短承接句；安静档与线上竞技恒为 R0
 const empty=companion({mode:'camp'},freshMemory(),'这局怎么打');
 assert.equal(empty.register,'R0');
 assert.equal(empty.text,'我在。');
 assert.equal(empty.silent,true);
 assert.equal(companion({mode:'camp',preference:'quiet'},memory,'这局怎么打').register,'R0');
 assert.equal(companion({mode:'pvp-live',battle:{mode:'pvp-live'}},memory,'这局怎么打').register,'R0');
 // 旧实现不管练过什么都说「速度判断」：这一条必须按真实课程名说
 const lessonMemory={...memory,lessons:['灼烧追击']};
 assert(!companion({mode:'camp'},lessonMemory,'随便聊聊').text.includes('速度判断'));
 assert(!companion({mode:'camp'},lessonMemory,'随便聊聊').evidence.join(' ').includes('速度判断'));
 const realLesson={...memory,lessons:['速度判断']};
 assert.match(companion({mode:'camp'},realLesson,'随便聊聊').text,/速度判断/);
});

test('player preferences survive matches and change the reply',()=>{
 const memory=history([winGame(),lossGame()]);
 const last=memory.events.at(-1);
 const detailed=companion({mode:'camp'},{...memory,preference:'detailed'},'这局怎么打').text;
 const brief=companion({mode:'camp'},{...memory,preference:'brief'},'这局怎么打').text;
 assert(brief.length<detailed.length,'简短偏好必须真的更短');
 assert(!/说一声/.test(brief));
 // 玩法目标改变观察角度：同一批真实数据，稳健看生存、速攻看减员时机
 const steady=companion({mode:'camp'},{...memory,goal:'稳健'},'这局怎么打').text;
 const swift=companion({mode:'camp'},{...memory,goal:'速攻'},'这局怎么打').text;
 assert.notEqual(steady,swift,'目标偏好必须改变输出，否则等于没生效');
 assert.match(steady,/回复药|站着/);
 assert.match(swift,new RegExp(`${last.firstFallen}在第${last.firstLossTurn}回合倒下`));
 // 本命只在真的出现在那一局时才点名
 const favorite=SPECIES.find(p=>p.name===last.firstFallen);
 assert(favorite,`真实对局里倒下的 ${last.firstFallen} 必须是真实宠物`);
 const withFavorite=companion({mode:'camp'},{...memory,favorite:favorite.id,goal:'速攻'},'这局怎么打');
 assert.match(withFavorite.text,/你的本命/);
 assert(withFavorite.evidence.some(x=>x.includes(favorite.name)));
 const other=SPECIES.find(p=>p.id!==favorite.id);
 assert(!companion({mode:'camp'},{...memory,favorite:other.id,goal:'速攻'},'这局怎么打').text.includes('你的本命'));
 // 存档往返后偏好与真实对局事实都还在，并且输出一致
 const stored=readMemory(JSON.stringify({...memory,preference:'brief',goal:'速攻',favorite:favorite.id}));
 assert.equal(stored.preference,'brief');
 assert.equal(stored.goal,'速攻');
 assert.equal(stored.favorite,favorite.id);
 assert.equal(stored.events.at(-1).firstFallen,last.firstFallen);
 assert.equal(companion({mode:'camp'},stored,'这局怎么打').text,companion({mode:'camp'},{...memory,preference:'brief',goal:'速攻',favorite:favorite.id},'这局怎么打').text);
});

test('runCoach routes to the companion and hands the register to the model',async()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const seen=[];
 const provider={name:'fake',async generate(packet){seen.push(packet);return packet.text+'（模型改写）';}};
 const answer=await runCoach({message:'随便聊聊',context:buildContext(null,newProfile(),'fox'),memory,provider});
 assert.equal(answer.route,'companion');
 assert.equal(answer.register,'R1');
 assert.equal(answer.companionState.momentum,-1,'1胜2负的最近三局合计为 -1');
 assert.equal(answer.companionState.lossStreak,2);
 assert.match(answer.text,/模型改写/);
 assert.equal(seen[0].replyConstraints.maxChars,40);
 assert.equal(seen[0].replyConstraints.maxQuestions,0);
 assert.equal(seen[0].silent,false);
 assert(seen[0].evidence.length>=3);
 // 不同档位送给模型的是不同的约束，不只是不同的模板
 const sad=await runCoach({message:'烦',context:buildContext(null,newProfile(),'fox'),memory,provider});
 assert.equal(sad.register,'R3');
 assert.equal(seen[1].replyConstraints.maxChars,30);
 assert.equal(seen[1].text,sad.text.replace('（模型改写）',''));
});

test('a model reply that breaks the register falls back to the recorded template',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 const memory=history([lossGame()]);
 const context=buildContext(null,newProfile(),'fox');
 const local=await runCoach({message:'烦',context,memory});
 assert.equal(local.register,'R2');
 globalThis.fetch=async(url,opts)=>{
  if(String(url).includes('bootstrap'))return {ok:true,json:async()=>({csrf:'test-only',configured:true})};
  const payload=JSON.parse(opts.body);
  return {ok:true,json:async()=>({...local,text:'别灰心，你已经很棒了。',provider:'deepseek',stateToken:payload.stateToken})};
 };
 const {connectionStatus,requestCoach}=await import('./coach/client.js');
 await connectionStatus();
 const answer=await requestCoach({message:'烦',role:'auto',context,memory,conversation:[],stateToken:7});
 assert.equal(answer.provider,'local-fallback');
 assert.match(answer.fallbackReason,/陪练档位约束/);
 assert.equal(answer.restraint.valid,false);
 assert.match(answer.restraint.reasons.join(','),/empty-encouragement/);
 assert(!/别灰心|你已经很棒/.test(answer.text));
 assert.equal(answer.text,local.text,'回退到本机记录模板，而不是另写一句');
 assert.equal(answer.stateToken,7);
});

test('proactive companion cites the live match and stays silent by design',()=>{
 const profile=newProfile();
 const win=winGame();
 const context=coachContext(win,profile);
 assert.equal(context.stage,'冠军高地');
 assert.equal(context.opponent,win.enemy.pets[win.enemy.active].name);
 assert.deepEqual(context.fallen,win.player.pets.filter(p=>p.hp<=0).map(p=>p.name));
 assert.equal(context.alive,win.player.pets.filter(p=>p.hp>0).length);
 // 首次倒下：引用真实的倒下伙伴、剩余只数，不给建议
 const faint=coachEvent('first-faint',{...context,result:null,lossStreak:0},{count:0,lastTurn:null,dismissed:false});
 assert.match(faint,new RegExp(context.fallen.at(-1)));
 assert.match(faint,new RegExp(`${context.alive}只`));
 assert(!/[？?]/.test(faint));
 // 胜负后的反应引用真实关卡与回合数
 const session={count:0,lastTurn:null,dismissed:false};
 const victory=coachEvent('result',{...context,result:'win',lossStreak:0},session);
 assert.match(victory,/冠军高地/);
 assert.match(victory,new RegExp(`${win.turn}回合`));
 // 连败第 2 局起改收尾陪坐，不超过 30 字，也不追问
 const streak=coachEvent('result',{...context,result:'loss',lossStreak:2},{count:0,lastTurn:null,dismissed:false});
 assert.match(streak,/连着2局没赢/);
 assert.match(streak,/到这儿也行/);
 assert(streak.length<=REGISTERS.R3.limit);
 assert(!/[？?]/.test(streak));
 assert.equal(proactiveRegister({lossStreak:2}),'R3');
 assert.equal(proactiveRegister({lossStreak:1}),'R1');
 // 一次失败不弹安慰：只有 1 连败时是事实陈述
 const once=coachEvent('result',{...context,result:'loss',lossStreak:1},{count:0,lastTurn:null,dismissed:false});
 assert(!/加油|别灰心|你已经很棒|下次一定/.test(once));
 assert(!/[？?]/.test(once));
 for(const [text,register] of [[faint,'R1'],[victory,'R1'],[once,'R1'],[streak,'R3']])assert.deepEqual(checkCompanionRestraint(text,{register,facts:{allowPast:true,lessons:[]}}).reasons,[],text);
 // 门控（说不说）保持不变：同局第二次同事件、安静档、已关闭、线上竞技一律沉默
 assert.equal(coachEvent('first-faint',{...context,turn:win.turn+1},{count:1,lastTurn:win.turn,dismissed:false}),null);
 assert.equal(coachEvent('result',{...context,preference:'quiet'},{count:0,lastTurn:null}),null);
 assert.equal(coachEvent('result',{...context},{count:0,lastTurn:null,dismissed:true}),null);
 assert.equal(coachEvent('result',{...context,mode:'pvp-live'},{count:0,lastTurn:null}),null);
 assert.equal(coachEvent('unknown-event',context,{count:0,lastTurn:null}),null);
 // 没有真实局内信息时也不编造：退化成不带细节的句子，但仍然有话说
 const bare=proactiveText('first-faint',{turn:4},'R1');
 assert(bare&&!/冠军高地/.test(bare));
 assert.equal(proactiveText('result',{turn:4,lossStreak:2},'R3'),'连着2局没赢。到这儿也行，想继续我就在。');
 assert.equal(proactiveText('unknown-event',{},'R1'),null);
});

test('companion facts degrade to null instead of default values',()=>{
 const facts=companionFacts(freshMemory(),{mode:'camp'},Date.now());
 assert.deepEqual([facts.last,facts.stage,facts.turns,facts.result,facts.firstLossTurn,facts.firstFallen,facts.survivors,facts.potion,facts.favorite],[null,null,null,null,null,null,null,null,null]);
 // 旧存档（没有新增字段）读回来只能少说，不会被补成一句听起来具体的话
 const legacy=readMemory(JSON.stringify({version:1,events:[{id:'old',result:'loss',stage:'01 · 青芽草地',turns:9,time:new Date().toISOString()}]}));
 const legacyFacts=companionFacts(legacy,{mode:'camp'},Date.now());
 assert.equal(legacyFacts.firstFallen,null);
 assert.equal(legacyFacts.potion,null);
 assert.deepEqual(legacyFacts.faints,[]);
 const text=companion({mode:'camp'},legacy,'随便聊聊').text;
 assert.match(text,/青芽草地9回合/);
 assert(!/倒下|回合倒下|回复药/.test(text));
});

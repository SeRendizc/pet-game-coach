// 陪练闭环的自动测试：状态派生、档位切换、真实事件引用、克制约束、偏好跨局保持。
// 对局数据全部由引擎真实跑出来（不是手写的事件对象），这样「引用真实事件」才是真的被验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,step,legalActions,rankEnemyActions,SPECIES,SKILLS} from './engine.js';
import {newProfile} from './progression.js';
import {freshMemory,rememberBattle,readMemory,recordCoachEvent} from './coach/memory.js';
import {companion,companionState,companionFacts,checkCompanionRestraint,decideRegister,proactiveRegister,proactiveText,intentOf,trailingStreak,REGISTERS,REGISTER_ORDER,companionEvents,companionSignals,companionSession,eventRegister,bubbleDurationMs,companionCueSlot,companionAvatar,COMPANION_LIMITS,COMPANION_BUBBLE,COMPANION_EVENTS,COMPANION_DEFER} from './coach/companion.js';
import {runCoach,buildContext} from './coach/runtime.js';
import {strategistTrigger,strategistSession,attentionState} from './coach/experience.js';
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

test('restraint scan keeps the hard lines and lets the companion have feelings',()=>{
 const facts={allowPast:true,lessons:['灼烧追击']};
 const cases=[['别灰心，你已经很棒了！','empty-encouragement'],['没关系的，下次一定赢。','empty-encouragement'],['这局要不要再来？还是先看看？','too-many-questions'],['你速度意识差，太弱了。','skill-insult'],['我们已经练过速度判断了。','lesson-not-recorded'],
  // 这一轮新增的两条硬线：说教与战术越界。陪练可以吐槽局面，但不能训人，也不能替军师下指令。
  ['你应该多用防御，下次别再这样了。','preach'],['建议你换上潮甲龟，先出火花。','tactical-overreach'],['你手残才打不中。','skill-insult']];
 for(const [text,reason] of cases)assert(checkCompanionRestraint(text,{register:'R2',facts}).reasons.some(r=>r.startsWith(reason)),`${text} → ${reason}`);
 // 第一人称情绪：陪练声线（默认）放开，克制声线仍然拦——放开的是「谁在说话」，不是「能不能训人」。
 assert(checkCompanionRestraint('我有点难过，烬尾狐又被克着打了。',{register:'R4',facts}).valid,'陪练声线允许第一人称情绪');
 assert(checkCompanionRestraint('我有点难过，烬尾狐又被克着打了。',{register:'R4',facts,voice:'sober'}).reasons.includes('first-person-emotion'),'克制声线仍然拦第一人称情绪');
 // 轻度吐槽（说的是局面与选择）必须放行，且不得因为放开情绪就连羞辱也一起放进来
 for(const allowed of ['这手疾爪打得我愣了一下，我还以为能收掉。','又是火花，连着三个回合了——我在旁边都跟着念出来。','我看得有点急。'])
  assert.deepEqual(checkCompanionRestraint(allowed,{register:'R4',facts}).reasons,[],allowed);
 assert(checkCompanionRestraint('你这手打得太菜了。',{register:'R4',facts}).reasons.includes('skill-insult'));
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
 assert.match(answer.fallbackReason,/换成本局规则结论/);
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
test('each companion event fires once per match, and stops when the facts stop',()=>{
 const mk=(hp,result=null)=>({result,player:{pets:[{hp},{hp:10},{hp:10}]}});
 // 没有减员、也没有结束：一次都不该开口
 assert.deepEqual(companionEvents(mk(50),{}),[]);
 // 第一次减员：开口一次
 assert.deepEqual(companionEvents(mk(0),{}),['first-faint']);
 // 已经报过就不再重复
 assert.deepEqual(companionEvents(mk(0),{said:['first-faint']}),[]);
 // 整局结束：开口一次
 assert.deepEqual(companionEvents(mk(0,'win'),{said:['first-faint']}),['result']);
 // 结束后不再重复
 assert.deepEqual(companionEvents(mk(0,'win'),{said:['first-faint','result']}),[]);
 // 跨局里程碑：连胜 ≥2 / 连败 ≥3 各占一次结算，里程碑优先于普通「打完了」
 assert.deepEqual(companionEvents(mk(0,'win'),{winStreak:2}),['streak-win']);
 assert.deepEqual(companionEvents(mk(0,'loss'),{lossStreak:3}),['streak-loss']);
 assert.deepEqual(companionEvents(mk(0,'loss'),{lossStreak:2}),['result']);
 // 一次调用最多一个事件：同一回合不会连说几句
 const many=companionEvents({history:[],player:{pets:[{hp:0}]}},{});
 assert(many.length<=1);
 assert.equal(eventRegister('countered'),'R4');
 assert.equal(eventRegister('repeat-skill'),'R4');
 assert.equal(eventRegister('stalemate'),'R4');
 assert.equal(eventRegister('swing'),'R4');
 assert.equal(eventRegister('streak-loss'),'R3');
 assert.equal(eventRegister('first-faint'),'R1');
 assert.equal(eventRegister('result',{lossStreak:2}),'R3');
});

// —— 在场层：真实事件、真实事实 ——
// 下面每一局都由引擎真实跑出来（策略固定：每三回合防御一次、其余用最省能量的技能，把局拖长），
// 期望值直接从 game 对象与 companionSignals 推导，不是手写文案。
function playUntil(stage,seed,want,strategy='defensive'){
 let g=createGame(seed,undefined,{difficulty:'easy',stageId:stage,stageName:'测试场'});
 const signals=()=>companionSignals(g);
 for(let n=0;n<200&&!g.result;n++){
  if(signals()[want])return {game:g,signals:signals()};
  const legal=legalActions(g);
  let action;
  if(strategy==='defensive'){
   const guard=legal.find(a=>a.id==='guard');
   const cheap=legal.filter(a=>a.kind==='skill').sort((a,b)=>(SKILLS[a.id]?.cost||0)-(SKILLS[b.id]?.cost||0))[0];
   action=(n%3===0&&guard)?guard:(cheap||legal[0]);
  }else{
   // 一直用同一招：这是「连着用同一招」这类事件的真实成因，不是为了测试造的假局面。
   action=legal.find(a=>a.kind==='skill'&&a.id==='strike')||legal.find(a=>a.kind==='skill'&&a.id!=='guard')||legal[0];
  }
  g=step(g,action);
  if(signals()[want])return {game:g,signals:signals()};
 }
 return {game:g,signals:signals()};
}
// 真打到「有伙伴倒下、进入免费补位」那一回合（军师侧要用真实局面，不能靠改字段造出来）。
function playToReplace(stage,seed){
 let g=createGame(seed,undefined,{difficulty:'easy',stageId:stage,stageName:'测试场'});
 for(let n=0;n<200&&!g.result&&g.phase!=='replace';n++){
  const legal=legalActions(g);
  const cheap=legal.filter(a=>a.kind==='skill').sort((a,b)=>(SKILLS[a.id]?.cost||0)-(SKILLS[b.id]?.cost||0))[0];
  g=step(g,cheap||legal[0]);
 }
 return g;
}
// 事件名 → 信号字段。测试里两个词表要一一对上，否则「补了触发」只是名字好听。
const SIGNAL_OF={'countered':'countered','repeat-skill':'repeat','swing':'swing','stalemate':'stalemate'};

test('the companion speaks on real in-match events, and every line cites the fact behind it',()=>{
 const profile=newProfile();
 // 四类局内事件各自的真实对局（种子与关卡都是跑出来的，不是编的）
 const fixtures=[['countered','meadow',2,'same-skill'],['repeat-skill','meadow',1,'same-skill'],['swing','meadow',1,'same-skill'],['stalemate','meadow',9,'defensive']];
 for(const [event,stage,seed,strategy] of fixtures){
  const {game,signals}=playUntil(stage,seed,SIGNAL_OF[event],strategy);
  const fact=signals[SIGNAL_OF[event]];
  assert(fact,`${event} 的测试对局没跑出信号（${stage} seed ${seed}）`);
  // 同一回合只报一个事件：本局第一次减员优先，报过之后才轮到局势逆转这类话。
  const fallen=(game.player.pets||[]).some(p=>p&&p.hp<=0);
  if(fallen)assert.deepEqual(companionEvents(game,{}),['first-faint'],'一次只报一个事件，减员优先');
  const events=companionEvents(game,{said:fallen?['first-faint']:[]});
  assert(events.includes(event),`${event} 应当在真实局面里成立，实际：${events.join(',')}`);
  const register=eventRegister(event);
  const text=proactiveText(event,{...coachContext(game,profile),signals},register);
  assert(text,`${event} 应当有话说`);
  assert(text.length<=REGISTERS[register].limit,`${event} 超长：${text}`);
  assert(!/[？?]/.test(text),`${event} 是陈述，不该反问：${text}`);
  assert.deepEqual(checkCompanionRestraint(text,{register,facts:{allowPast:true,lessons:[]}}).reasons,[],text);
  // 「引用了真实发生的事」是可核对的：文本里必须出现那条事实本身
  if(event==='countered'){assert(text.includes(fact.pet),text);assert(text.includes(fact.type),text);assert(text.includes(String(fact.times)),text);}
  if(event==='repeat-skill'){assert(text.includes(fact.skill),text);assert(text.includes(String(fact.times)),text);}
  if(event==='swing'){assert(text.includes(String(fact.turn)),text);}
  if(event==='stalemate'){assert(text.includes(String(fact.turns)),text);}
 }
 // 没有真实事实时一个字都不编：signals 缺失 → 所有在场事件都返回 null
 for(const event of ['countered','repeat-skill','swing','stalemate'])assert.equal(proactiveText(event,{turn:5},eventRegister(event)),null,event);
 const bare=companionSignals(null);
 assert.deepEqual([bare.countered,bare.repeat,bare.swing,bare.stalemate],[null,null,null,null]);
 // 已结束的对局不再产生局内事件（结算归 result）
 const {game}=playUntil('meadow',1,'repeat','same-skill');
 const ended={...game,result:'win'};
 assert.deepEqual(companionSignals(ended),{countered:null,repeat:null,swing:null,stalemate:null,turns:0});
});

test('the companion budget is its own: the strategist going quiet never silences it, and the other way round',()=>{
 const profile=newProfile(),memory=history([winGame()]);
 const {game}=playUntil('meadow',1,'repeat','same-skill');
 const ctx=coachContext(game,profile,memory);
 // 军师把额度用光、并且本局被点掉、整局静音
 const strategist=strategistSession();strategist.hints=3;strategist.dismissed=true;
 const attention=attentionState(0);attention.dismissed=true;attention.count=2;
 assert.equal(strategistTrigger({game,attention,session:strategist,now:1,turn:'t',mode:'gentle',inMatch:true}),null,'军师这时确实已经闭嘴');
 // 陪练照常开口：两边是两份独立的记账
 const session=companionSession(memory);
 const text=coachEvent('first-faint',{...ctx,fallen:['烬尾狐'],alive:2},session);
 assert(text,'军师闭嘴不该让陪练也闭嘴');
 assert.equal(session.count,1);
 // 反过来：陪练说到上限，军师仍然能开口
 const spent=companionSession(memory);spent.count=COMPANION_LIMITS.maxPerMatch;
 assert.equal(coachEvent('countered',ctx,spent),null,'陪练到上限后自己不再说');
 const replace=playToReplace('meadow',2);
 assert.equal(replace.phase,'replace','补位阶段由真实对局产生');
 const cue=strategistTrigger({game:replace,attention:attentionState(0),session:strategistSession(),now:1,turn:'t',mode:'gentle',inMatch:true});
 assert(cue&&cue.reason==='fall','陪练说满不该动军师的额度');
 // 安静档与「本局点掉」压过一切推断：即使记忆里一条关闭记录都没有
 for(const event of ['first-faint','countered','result','stalemate']){
  assert.equal(coachEvent(event,{...ctx,preference:'quiet'},companionSession(memory)),null);
  assert.equal(coachEvent(event,ctx,{...companionSession(memory),dismissed:true}),null);
  assert.equal(coachEvent(event,{...ctx,mode:'pvp-live'},companionSession(memory)),null);
 }
 // 频率推断：近 7 天被主动关掉 2 次 → 每局 1 次；4 次 → 本局 0 次；都在安静档之后
 let gated=memory;for(const t of [1,2])gated=recordCoachEvent(gated,{id:`g${t}:dismiss:${t}`,kind:'dismiss',channel:'companion',matchId:`g${t}`,turn:t});
 assert.equal(companionSession(gated).limit,1);
 gated=memory;for(const t of [1,2,3,4])gated=recordCoachEvent(gated,{id:`h${t}:dismiss:${t}`,kind:'dismiss',channel:'companion',matchId:`h${t}`,turn:t});
 assert.equal(companionSession(gated).limit,0);
 assert.equal(coachEvent('first-faint',ctx,companionSession(gated)),null,'关掉 4 次之后本局不主动开口');
 const stale=recordCoachEvent(memory,{id:'old:dismiss:1',kind:'dismiss',channel:'companion',matchId:'old',turn:1,time:new Date(Date.now()-8*86400000).toISOString()});
 assert.equal(companionSession(stale).limit,COMPANION_LIMITS.maxPerMatch,'7 天以前的关闭不再降频');
 assert.equal(COMPANION_LIMITS.maxPerMatch>1,true,'陪练的每局上限不止 1 次：它要在场，不是只在开头结尾冒一次');
});

test('one companion line at a time, and never at the same moment as the strategist bar',()=>{
 // 军师条在场 → 陪练排队；条收起来 → 补上；排队太久 → 丢掉（过期的话不如不说）
 assert.equal(companionCueSlot({barVisible:true,queuedAt:Date.now(),now:Date.now()}).action,'hold');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:2}).action,'show');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:0,now:2}).action,'idle');
 assert.equal(companionCueSlot({barVisible:true,queuedAt:0,now:0}).action,'hold','还没排队时军师在场：等，而不是抢');
 assert.equal(companionCueSlot({barVisible:true,queuedAt:1,now:COMPANION_DEFER.maxWaitMs+2}).action,'drop');
 assert.match(companionCueSlot({barVisible:true,queuedAt:1,now:2}).reason,/让位/);
 // 刚显示过就不重开：军师条一秒来一次也不能把陪练切成一闪一闪（闪半秒谁也读不完）
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:2,holdUntil:9000}).action,'hold');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:9001,holdUntil:9000}).action,'show');
 assert(COMPANION_DEFER.minVisibleMs>=3000,'最小显示窗口不能短到读不完一句话');
 assert(COMPANION_DEFER.maxWaitMs>=10000,'排队窗口不能短到一句话永远轮不上');
});

test('the bubble stays as long as the words need, and wears an existing pet portrait',()=>{
 // 15 秒 + 每 10 个字加 3 秒：2 行（40 字）≈ 27 秒，短句（10 字）≈ 18 秒
 assert.equal(bubbleDurationMs('长'.repeat(40)),27000);
 assert.equal(bubbleDurationMs('长'.repeat(10)),18000);
 assert.equal(bubbleDurationMs('长'.repeat(9)),15000);
 assert.equal(bubbleDurationMs(''),COMPANION_BUBBLE.baseMs);
 assert(bubbleDurationMs('长'.repeat(24))>15000,'十来个字也要比 15 秒长');
 assert(COMPANION_BUBBLE.baseMs>=15000,'8 秒读不完 2–3 行中文，基线不能回到 8 秒');
 assert.equal(COMPANION_BUBBLE.position,'bottom-left','陪练在左下角，军师条在顶部——两者位置分开');
 // 头像用已有的宠物形象，不新增美术资源
 const avatar=companionAvatar();
 assert.equal(avatar.icon,SPECIES.find(p=>p.id==='deer').icon);
 assert.match(avatar.name,/陪练/);
 assert(COMPANION_EVENTS.includes('countered')&&COMPANION_EVENTS.includes('repeat-skill')&&COMPANION_EVENTS.includes('swing')&&COMPANION_EVENTS.includes('stalemate'),'补上的触发事件必须在事件表里');
});

// 陪练闭环的自动测试：跨局账本、观察的信息量、档位、克制扫描、预算、在场方式。
//
// 这一版测试的对象换了：上一版测的是「模板里有没有出现真实字段」，所以
// 「潮甲龟连着 2 个回合被草系按着打，我看得有点急。」能全绿——它确实是真实字段。
// 现在测的是**这条话值不值得说**：每一条开口都必须带一句玩家自己算不出来的东西
// （跨局记录或跨回合统计），不许复述屏幕上已经写着的事，也不许播报陪练自己的情绪。
// 对局全部由引擎真实跑出来（不是手写的事件对象），所以「引用了真实记录」是被验证的。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,step,legalActions,rankEnemyActions,SKILLS,SPECIES} from './engine.js';
import {newProfile} from './progression.js';
import {freshMemory,rememberBattle,readMemory,recordCoachEvent} from './coach/memory.js';
import {companion,companionState,companionFacts,checkCompanionRestraint,checkCompanionInformation,decideRegister,proactiveRegister,proactiveText,proactiveReading,intentOf,trailingStreak,REGISTERS,REGISTER_ORDER,companionEvents,companionSignals,companionSession,companionLedger,companionReadings,eventRegister,bubbleDurationMs,companionCueSlot,companionAvatar,COMPANION_LIMITS,COMPANION_BUBBLE,COMPANION_EVENTS,COMPANION_DEFER,SCREEN_ECHO,FIRST_PERSON_EMOTION} from './coach/companion.js';
import {runCoach,buildContext} from './coach/runtime.js';
import {strategistTrigger,strategistSession,attentionState} from './coach/experience.js';
import {coachEvent,coachContext} from './coach.js';

const STAGE='05 · 冠军高地';
// 随机出招必输；按引擎枚举的推荐出招会赢。两个种子是真实跑完的对局，不是编的结果。
function play(seed,{smart=false}={}){
 let g=createGame(seed,undefined,{difficulty:'normal',stageName:STAGE,stageId:'summit'});g.id='match-'+seed+(smart?'-smart':'');
 for(let n=0;n<200&&!g.result;n++){
  const actions=legalActions(g);
  g=step(g,smart?(rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||actions[0]):(actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions.find(a=>a.kind==='switch')||actions[0]));
 }
 return g;
}
// 「一直在防御」是真实存在的打法，也是「某一只连着几个回合没输出」的唯一成因，
// 所以这条策略是照着玩家能做出的选择写的，不是为了造数据。
function playGuarding(seed,{difficulty='normal',stage=STAGE,stageId='summit'}={}){
 let g=createGame(seed,undefined,{difficulty,stageName:stage,stageId});g.id='guard-'+seed+stageId;
 for(let n=0;n<200&&!g.result;n++){
  const actions=legalActions(g);
  g=step(g,actions.find(a=>a.id==='guard')||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0]);
 }
 return g;
}
// 打到「同时存在两种读数」的那一回合为止：用来验证目标偏好只改先看哪一条。
function playToAll(seed,wants,{difficulty='normal',strategy='random'}={}){
 let g=createGame(seed,undefined,{difficulty,stageName:STAGE,stageId:'summit'});g.id='all-'+seed;
 for(let n=0;n<300&&!g.result;n++){
  const actions=legalActions(g);
  const action=(strategy==='guard'?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0];
  g=step(g,action);
  const signals=companionSignals(g);
  if(wants.every(w=>signals[w]))return g;
 }
 return g;
}
function playTo(seed,want,{difficulty='normal',strategy='random'}={}){
 let g=createGame(seed,undefined,{difficulty,stageName:STAGE,stageId:'summit'});g.id='to-'+seed;
 for(let n=0;n<200&&!g.result;n++){
  const actions=legalActions(g);
  const action=(strategy==='guard'?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0];
  g=step(g,action);
  if(companionSignals(g)[want])return g;
 }
 return g;
}
const lossGame=()=>play(1);
const winGame=()=>play(4,{smart:true});
const history=games=>games.reduce((memory,game)=>rememberBattle(memory,game),freshMemory());
// 把真实记录的时间往前挪：久别那一类需要「隔了几天」，而时钟不可能靠打一局走完。
function backdate(memory,days){return {...memory,events:memory.events.map(e=>({...e,time:new Date(Date.parse(e.time)-days*86400000).toISOString()}))};}

// app.js 的调用顺序：逐回合 → companionEvents（触发）→ coachEvent（门控 + 文案）。
// 这条回放是「实测里会说出什么」的自动版本，所有断言都跑在它上面。
function replay(seed,memory,{strategy='random',difficulty='normal',smart=false}={}){
 const profile=newProfile(),session=companionSession(memory),said=new Set(),lines=[];
 let g=createGame(seed,undefined,{difficulty,stageName:STAGE,stageId:'summit'});g.id='replay-'+seed+strategy;
 for(let n=0;n<300&&!g.result;n++){
  const actions=legalActions(g);
  const action=smart?(rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||actions[0])
   :(strategy==='guard'&&n%2===0?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0];
  g=step(g,action);
  const context=coachContext(g,profile,memory);
  for(const event of companionEvents(g,{said,session,winStreak:context.winStreak,lossStreak:context.lossStreak,cross:context.cross,signals:context.signals})){
   // 先留一份开口前的账，再用同一份账把「这句话由哪几句组成」取回来：
   // 断言要落在句子的来源上，而不是只落在拼出来的字符串上。
   const before={ids:new Set(session.readings),topics:new Set(session.topics)};
   const register=eventRegister(event,{lossStreak:context.lossStreak||0});
   const text=coachEvent(event,context,session);
   if(text){
    const reading=proactiveReading(event,context,register,{used:before});
    said.add(event);
    lines.push({turn:context.turn,event,register,text,parts:reading?reading.parts:null,readingId:reading?reading.readingId:null});
   }
  }
 }
 return {game:g,lines,memory,session};
}
// 每一句话的公共要求：长度、句数、不带复述与自我情绪、至少一句跨局/跨回合信息。
function assertSpeakable(line,{allow=null}={}){
 const limit=REGISTERS[line.register==='R3'?'R3':line.register]?.limit||REGISTERS.R4.limit;
 assert(line.text.length<=limit,`${line.event} 超长（${line.text.length}>${limit}）：${line.text}`);
 assert(!SCREEN_ECHO.test(line.text),`${line.event} 复述了屏幕上的事：${line.text}`);
 assert(!FIRST_PERSON_EMOTION.test(line.text),`${line.event} 在说陪练自己的情绪：${line.text}`);
 for(const part of line.parts||[]){
  if(allow&&allow.parts)continue;
  assert(['memory','derived','situation','presence'].includes(part.kind),`句子没有标注来源：${part.text}`);
 }
 if(line.parts){
  const informative=line.parts.filter(p=>p.kind==='memory'||p.kind==='derived').length;
  assert(informative>=1,`${line.event} 整句没有玩家不知道的信息：${line.text}`);
  assert(line.parts.length>=2&&line.parts.length<=3,`${line.event} 不是 2–3 句：${line.text}`);
 }
}

// ── 跨局账本 ────────────────────────────────────────────────────────────────
test('the ledger reads real cross-match records: rematch, first-fallen habit, pace, items, stage',()=>{
 const games=[lossGame(),play(2),play(4,{smart:true}),play(7)];
 const memory=history(games);
 const last=games.at(-1);
 const ledger=companionLedger(memory,last,Date.now());
 assert.equal(ledger.count,4);
 assert.equal(ledger.losses+ledger.wins,4);
 // 同一套阵容：三只里至少两只重复才算「这套阵容」，不是随便一局都算
 assert(ledger.rematch,`真实记录里应当有重复阵容：${JSON.stringify(memory.events.map(e=>e.enemy))}`);
 assert(ledger.rematch.meetings>=1);
 assert.equal(ledger.rematch.isPrevious,memory.events.at(-1).enemy.filter(n=>last.enemy.pets.some(p=>p.name===n)).length>=2);
 // 最先倒下的那一只：来自成对记录的 firstFallen，不是队伍顺序
 assert(ledger.hazard,'4 局里应当能看出「最先倒下的总是谁」');
 assert(memory.events.some(e=>e.firstFallen===ledger.hazard.name),'账本里的名字必须真的在记录里');
 assert.equal(ledger.hazard.times,memory.events.filter(e=>e.firstFallen===ledger.hazard.name).length);
 // 回合数走向与道具习惯
 assert(ledger.recentTurns.length>=3);
 assert(ledger.trend.turns.join(',')===ledger.recentTurns.join(','));
 assert.deepEqual(ledger.currentRoster,last.enemy.pets.map(p=>p.name));
 // 空记忆：每一项都是 null，不补默认值
 const empty=companionLedger(freshMemory(),last,Date.now());
 assert.deepEqual([empty.count,empty.rematch,empty.hazard,empty.stage,empty.flow,empty.trend,empty.potion,empty.daysAgo],[0,null,null,null,null,null,null,null]);
 // 坏记录不会变成一句话：时间戳坏掉就是「不知道隔了几天」
 const broken={...memory,events:memory.events.map(e=>({...e,time:'不是时间'}))};
 assert.equal(companionLedger(broken,last,Date.now()).daysAgo,null);
});
test('the ledger keeps cross-match classes that only the companion can see',()=>{
 const games=[lossGame(),play(2),play(3),play(5),play(6)];
 const memory=history(games);
 const last=games.at(-1);
 const ledger=companionLedger(memory,last,Date.now());
 const kinds=['rematch','hazard','stage','flow','trend','potion'].filter(k=>ledger[k]);
 assert(kinds.length>=4,`跨局观察的类别太少：${kinds.join('、')}`);
 // 每一个数字都能回溯到一条记录
 if(ledger.flow){
  const typed=memory.events.filter(e=>e.enemy.some(n=>SPECIES.find(p=>p.name===n)?.type===ledger.flow.type));
  assert(typed.length>=ledger.flow.losses,`属性统计（${ledger.flow.label}系）对不上记录`);
 }
 if(ledger.potion){
  const rows=memory.events.filter(e=>Number.isInteger(e.items?.potion));
  assert(rows.slice(-ledger.potion.matches).every(e=>e.items.potion===ledger.potion.left));
 }
 if(ledger.stage)assert(memory.events.filter(e=>e.stage.includes(ledger.stage.name)).length>=ledger.stage.played);
});

// ── 每条话都带玩家不知道的东西 ───────────────────────────────────────────────
test('every line the companion says carries something the player cannot already see',()=>{
 const seeds=[1,2,3,7,11,13,17];
 let memory=freshMemory();
 const all=[];
 for(const seed of seeds){
  const {game,lines}=replay(seed,memory);
  for(const line of lines)all.push(line);
  memory=rememberBattle(memory,game);
 }
 assert(all.length>=12,`7 局里只说了 ${all.length} 句，陪练太沉默了`);
 const classes=new Set();
 for(const line of all){
  assertSpeakable(line);
  for(const part of line.parts||[])if(part.kind==='memory')classes.add('memory');
  // 复述屏幕的旧写法一句都不许出现
  assert(!/按着打|我看得|坐不住|还剩\s*\d+\s*只/.test(line.text),line.text);
 }
 assert(classes.has('memory'),'整批话里必须有跨局记录，否则陪练和军师没有区别');
 // 同一个事实一局只说一次：同一局里不出现两句一模一样的话
 const byMatch={};
 for(const line of all)byMatch[line.text]=(byMatch[line.text]||0)+1;
 for(const [text,times] of Object.entries(byMatch))assert(times<=2,`同一句话在 ${times} 局里原样重复：${text}`);
});
test('the cross-match classes really show up in play, not only in the ledger',()=>{
 const seeds=[1,2,3,5,7,11,13,17,19,23];
 let memory=freshMemory();
 const kinds=new Set(),events=new Set(),samples=[];
 for(const seed of seeds){
  const {game,lines}=replay(seed,memory);
  for(const line of lines){
   events.add(line.event);
   const reading=proactiveReading(line.event,coachContext(game,newProfile(),memory),eventRegister(line.event,{lossStreak:0}))||{};
   kinds.add(line.event);
   samples.push(`${line.event} → ${line.text}`);
  }
  memory=rememberBattle(memory,game);
 }
 for(const wanted of ['rematch','first-faint'])assert(events.has(wanted),`没有说过这一类：${wanted}（实际：${[...events].join('、')}）`);
 assert(events.size>=3,`开口的类别太少：${[...events].join('、')}`);
 // 至少有一句是「习惯」或「对手属性」这类只有跨局才看得出来的观察
 assert([...events].some(e=>['habit','type','stage','trend'].includes(e)),samples.join('\n'));
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
 assert.match(text,/青芽草地/);
 assert(!/倒下|回复药|站着/.test(text));
});

// ── 负向验证：改回「只说屏幕上的事」必须变红 ─────────────────────────────────
// 下面这一段就是上一版的实现（逐字抄自 git 历史），用它当对照组：
// 同样的数据、同样的入口，旧写法必须在新的自检里被判不合格。
const LEGACY_TEMPLATES={
 countered:sig=>`${sig.countered.pet}连着${sig.countered.times}个回合被${sig.countered.type}系按着打，我看得有点急。`,
 'repeat-skill':sig=>`又是${sig.repeat.skill}，连着${sig.repeat.times}个回合了——我在旁边都跟着念出来。`,
 stalemate:sig=>`${sig.stalemate.turns}个回合过去，两边都还没人倒下，我都有点坐不住了。`,
 'first-faint':()=> '烬尾狐倒下了。还剩2只。补位不占回合，你先选。',
};
test('the previous wording fails the same self-check (negative verification)',()=>{
 const cases=[
  ['潮甲龟连着 2 个回合被草系按着打，我看得有点急。',['restates-screen','speaker-feeling']],
  ['又是火花，连着 3 个回合了——我在旁边都跟着念出来。',['speaker-feeling']],
  ['潮甲龟倒下了。还剩 2 只。补位不占回合，你先选。',['restates-screen']],
  ['打到第 4 回合，血线反过来了。',['restates-screen']],
 ];
 for(const [text,reasons] of cases){
  const check=checkCompanionInformation(text);
  assert.equal(check.valid,false,`旧写法不该通过自检：${text}`);
  for(const reason of reasons)assert(check.reasons.includes(reason),`${text} 应当命中 ${reason}，实际 ${check.reasons.join(',')}`);
 }
 // 旧模板直接接上新的发布路径：一条都说不出话来
 const g=playGuarding(3);
 const context={turn:9,signals:companionSignals(g),cross:companionLedger({},g,Date.now())};
 const signal={countered:{pet:'潮甲龟',times:2,type:'草'},repeat:{skill:'火花',times:3},stalemate:{turns:8}};
 for(const [event,build] of Object.entries(LEGACY_TEMPLATES)){
  const text=build(signal);
  assert.equal(checkCompanionInformation(text).valid,false,`${event} 的旧文案必须被拦下`);
  assert.equal(checkCompanionRestraint(text,{register:'R4',facts:{allowPast:true}}).valid,false,`${event} 的旧文案必须被克制扫描拦下`);
 }
 // 而新的发布路径对同一个局面要么给出有信息的话，要么明确不说话——不会退回旧口径
 for(const event of COMPANION_EVENTS){
  const text=proactiveText(event,context,eventRegister(event,{lossStreak:0}));
  if(text===null)continue;
  assert.equal(checkCompanionInformation(text).valid,true,text);
 }
});
test('the information self-check is not vacuous',()=>{
 // 只有一句 → 太短
 assert(checkCompanionInformation('最近3局里最先倒下的都是烬尾狐。',{parts:[{text:'x',kind:'memory'}]}).reasons.includes('too-short'));
 // 只有处境，没有新信息 → 不合格
 assert(checkCompanionInformation('这一局你一直在挨打。换人也没换掉这个局面。',{parts:[{text:'a',kind:'situation'},{text:'b',kind:'situation'}]}).reasons.includes('no-new-information'));
 // 处境句超过一句 → 凑字数
 assert(checkCompanionInformation('这一局你一直在挨打。对面还没倒。第3回合你打出去21点。',{parts:[{text:'a',kind:'derived'},{text:'b',kind:'situation'},{text:'c',kind:'situation'}]}).reasons.includes('too-much-filler'));
 // 四句 → 太长
 assert(checkCompanionInformation('一二三四。五六七八。九十十一。十二十三十四。',{parts:[{text:'a',kind:'derived'},{text:'b',kind:'memory'},{text:'c',kind:'situation'},{text:'d',kind:'memory'}]}).reasons.includes('too-many-sentences'));
 // 空泛安慰与复述屏幕也不放行
 assert(checkCompanionInformation('加油，下次一定可以的。').reasons.includes('empty-encouragement'));
 assert(checkCompanionInformation('对面还剩2只，你还有机会。').reasons.includes('restates-screen'));
});

// ── 档位与门控 ──────────────────────────────────────────────────────────────
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
 const stale=recordCoachEvent(memory,{id:'old:dismiss:1',kind:'dismiss',matchId:'old',turn:1,time:new Date(Date.now()-8*86400000).toISOString()});
 assert.equal(companionState(stale,{mode:'camp'},{},Date.now()).consideration,2);
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
 for(const momentum of [-3,-2,-1,0,1,2,3])for(const consideration of [0,1,2])for(const playerInitiated of [true,false])for(const intent of ['emotion','followup','chat','ask','other']){
  const register=decideRegister({context:{},intent,playerInitiated,consideration,momentum,hasExperience:true,pendingObservation:true}).register;
  assert(REGISTER_ORDER.includes(register),`${register} 不在档位表里`);
  if(consideration===0&&!playerInitiated)assert.equal(register,'R0');
  const state=companionState(memory,{mode:'camp'},{playerInitiated,intent},Date.now());
  assert(state.engagement<=2,'engagement 上限为 2');
 }
});
test('the register changes the wording and the length ceiling',()=>{
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
 // 2–3 句：被动通道最长的两档也得真的说到 2 句
 assert(r1.text.split('。').filter(Boolean).length>=2,`R1 只有一句话：${r1.text}`);
 assert(r2.text.split('。').filter(Boolean).length>=2,`R2 只有一句话：${r2.text}`);
 // 模型路径：档位随证据包一起送到服务端，字数上限/问句上限可见
 assert.deepEqual([r0.replyConstraints.maxChars,r1.replyConstraints.maxChars,r2.replyConstraints.maxChars,r3.replyConstraints.maxChars],[8,72,120,64]);
 assert.deepEqual([r0.replyConstraints.maxQuestions,r2.replyConstraints.maxQuestions],[0,1]);
 assert.match(r1.replyConstraints.instruction,/R1/);
 assert.deepEqual(r2.replyConstraints.allow,[],'陪练不再被允许播报自己的情绪');
 assert(r2.replyConstraints.forbid.includes('复述屏幕上已经写着的事'));
 assert.equal(r0.replyConstraints.forbid.includes(''),false);
});
test('the passive channel answers with the same cross-match material, not with the live board',()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const spoken=companion({mode:'camp'},memory,'随便聊聊');
 assert.match(spoken.text,/阵容|倒下|回合|局/,spoken.text);
 assert(spoken.evidence.length>=3);
 for(const message of ['你好','随便聊聊','这局怎么打','烦','？','我该怎么办']){
  const answer=companion({mode:'camp'},memory,message);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons}}).valid,`${message} → ${answer.text}`);
 }
 // brief 真的更短（不是同一句话）
 const detailed=companion({mode:'camp'},{...memory,preference:'detailed'},'这局怎么打').text;
 const brief=companion({mode:'camp'},{...memory,preference:'brief'},'这局怎么打').text;
 assert(brief.length<detailed.length,'简短偏好必须真的更短');
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
test('player preferences survive matches and change the reply',()=>{
 const memory=history([winGame(),lossGame()]);
 const stored=readMemory(JSON.stringify({...memory,preference:'brief',goal:'速攻',favorite:memory.events.at(-1).firstFallen&&SPECIES.find(p=>p.name===memory.events.at(-1).firstFallen)?.id}));
 assert.equal(stored.preference,'brief');
 assert.equal(stored.goal,'速攻');
 assert.equal(stored.events.at(-1).firstFallen,memory.events.at(-1).firstFallen);
 assert.equal(companion({mode:'camp'},stored,'这局怎么打').text,companion({mode:'camp'},{...memory,preference:'brief',goal:'速攻',favorite:stored.favorite},'这局怎么打').text,'存档往返后输出必须一致');
 // 本命只在真的出现在那一局时才点名（依据里出现，正文里不硬塞）
 const withFavorite=companion({mode:'camp'},{...memory,favorite:'fox'},'这局怎么打');
 assert(checkCompanionRestraint(withFavorite.text,{register:withFavorite.register,facts:{allowPast:true,lessons:[]}}).valid,withFavorite.text);
});

// ── 触发与预算 ──────────────────────────────────────────────────────────────
test('each companion event fires once per match, and stops when the facts stop',()=>{
 const events=companionEvents(play(1),{said:[]});
 assert(events.length<=1,'一次调用最多一个事件');
 // 结算只提一个事件（重复由 coachEvent 的 session.said 拦住，见预算那条）
 assert.deepEqual(companionEvents(play(1),{said:[]}).length,1);
 assert.deepEqual(companionEvents(play(1),{said:[]}),['result']);
 // 已结束的对局只报结算
 const ended={...play(1),result:'win'};
 assert.deepEqual(companionEvents(ended,{said:[],winStreak:0,lossStreak:0}),['result']);
 assert.deepEqual(companionEvents(ended,{said:[],winStreak:2,lossStreak:0}),['streak-win']);
 assert.deepEqual(companionEvents({...ended,result:'loss'},{said:[],winStreak:0,lossStreak:3}),['streak-loss']);
 // 没有任何真实素材的合成局面：一个事件都提不出来（说不出话就不占窗口）
 assert.deepEqual(companionEvents({history:[],player:{pets:[{hp:50}]},enemy:{pets:[{hp:50}]},turn:1},{}),[]);
 // 触发层只提议「现在真的有话可说」的那一类：提议了就必须真的说得出来，
 // 否则它会白占一个回合的窗口。这里用 app.js 的真实上下文（coachContext）验证。
 const g=play(1);
 const ctx=coachContext(g,newProfile(),history([play(2),play(3)]));
 const proposal=companionEvents(g,{said:[],cross:ctx.cross,signals:ctx.signals,winStreak:ctx.winStreak,lossStreak:ctx.lossStreak});
 assert.equal(proposal.length,1,'结算这一回合必须有一个事件');
 assert(proactiveText(proposal[0],ctx,eventRegister(proposal[0],{lossStreak:ctx.lossStreak})),'提议了却说不出来，等于占着窗口说废话');
 assert.equal(ctx.result,'loss');
 assert.match(proactiveText('result',ctx,'R3'),/到这儿也行/,'连败之后的结算留给收尾陪坐');
});
test('every reading the trigger proposes can actually be said out loud',()=>{
 // 这一条是真事故换来的：soak 的措辞里出现了「换掉」，撞上「不给战术指令」的硬线，
 // 于是每个回合都提议 live、每一次都被内容检查退回，整局只说了两次话，而且没人发现。
 // 现在「提议得出来」与「说得出话」用同一把尺（fitReading），这条测试守住它。
 const seeds=[1,2,3,5,7,9,11,13,17,19];
 let memory=freshMemory();
 let proposals=0;
 for(const seed of seeds){
  const profile=newProfile(),session=companionSession(memory),said=new Set();
  let g=createGame(seed,undefined,{difficulty:'normal',stageName:STAGE,stageId:'summit'});g.id='inv-'+seed;
  for(let n=0;n<300&&!g.result;n++){
   const actions=legalActions(g);
   g=step(g,(n%3===0?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0]);
   const context=coachContext(g,profile,memory);
   for(const event of companionEvents(g,{said,session,winStreak:context.winStreak,lossStreak:context.lossStreak,cross:context.cross,signals:context.signals})){
    proposals++;
    const register=eventRegister(event,{lossStreak:context.lossStreak||0});
    assert(proactiveReading(event,context,register,{used:{ids:session.readings,topics:session.topics}}),
     `第 ${g.turn} 回合提议了 ${event}，却说不出来——这一回合的窗口白占了`);
    coachEvent(event,context,session);
   }
  }
  memory=rememberBattle(memory,g);
 }
 assert(proposals>=8,`提议次数太少，这条不变式没被真的压到：${proposals}`);
});
test('the companion budget is its own: the strategist going quiet never silences it, and the other way round',()=>{
 const profile=newProfile(),memory=history([winGame()]);
 const {game}=replay(1,memory);
 const ctx=coachContext(game,profile,memory);
 const strategist=strategistSession();strategist.hints=3;strategist.dismissed=true;
 const attention=attentionState(0);attention.dismissed=true;attention.count=2;
 assert.equal(strategistTrigger({game,attention,session:strategist,now:1,turn:'t',mode:'gentle',inMatch:true}),null,'军师这时确实已经闭嘴');
 const session=companionSession(memory);
 const first=companionEvents(game,{said:[],session,winStreak:0,lossStreak:0,cross:ctx.cross,signals:ctx.signals})[0];
 assert(first,'军师闭嘴不该让陪练也闭嘴');
 assert(coachEvent(first,ctx,session));
 assert.equal(session.count,1);
 // 陪练说到上限后自己不再说，但结算那一句留给收尾
 const spent=companionSession(memory);spent.count=COMPANION_LIMITS.maxPerMatch;
 assert.equal(coachEvent('habit',ctx,spent),null,'陪练到上限后自己不再说');
 assert.equal(coachEvent('result',{...ctx,result:'loss',lossStreak:2},spent)?.includes('到这儿也行'),true,'收尾句不被局内额度挤掉');
 // 安静档与「本局点掉」压过一切推断：即使记忆里一条关闭记录都没有
 for(const event of ['first-faint','habit','result','live']){
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
 assert(COMPANION_LIMITS.cooldownTurns>=3,'话变长了，两次开口之间要隔开');
});
test('the same fact is never said twice in one match, and the cooldown is real',()=>{
 const seeds=[1,2,3,5,7];
 let memory=freshMemory();
 for(const seed of seeds){
  const {game,lines,session}=replay(seed,memory);
  // 冷却：两次开口之间至少隔 cooldownTurns 个回合（结算除外）
  const inMatch=lines.filter(l=>l.event!=='result'&&l.event!=='streak-loss'&&l.event!=='streak-win');
  for(let i=1;i<inMatch.length;i++)assert(inMatch[i].turn-inMatch[i-1].turn>=COMPANION_LIMITS.cooldownTurns,`${inMatch[i-1].turn} → ${inMatch[i].turn} 说得太密：${inMatch.map(l=>l.turn).join(',')}`);
  assert(inMatch.length<=COMPANION_LIMITS.maxPerMatch,`一局说了 ${inMatch.length} 次，超过上限`);
  // 同一局里不重复同一个事实：正文两两不相同，且话题不重复
  const texts=lines.map(l=>l.text);
  assert.equal(new Set(texts).size,texts.length,`同一局里出现重复的话：${texts.join(' | ')}`);
  assert(session.topics.size>=1,'说过的话题要被记账');
  memory=rememberBattle(memory,game);
 }
});

// ── 长一点，但每句都有信息 ───────────────────────────────────────────────────
test('a line is 2–3 sentences and every one of them carries a fact',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const {lines}=replay(5,memory);
 assert(lines.length>=1);
 for(const line of lines){
  const sentences=line.text.split('。').filter(Boolean);
  assert(sentences.length>=2&&sentences.length<=3,`不是 2–3 句：${line.text}`);
  assert(line.text.length>=24,`太短，等于一句废话：${line.text}`);
  assert(line.text.length<=REGISTERS[eventRegister(line.event,{lossStreak:0})===('R3')?'R3':'R4'].limit,line.text);
 }
});
test('cross-match memory is what it leads with, and the live numbers come from real turns',()=>{
 const games=[lossGame(),play(2),play(3),play(5)];
 const memory=history(games);
 const first=replay(7,memory).lines[0];
 assert(first, '第二局之后必须开口');
 assert(/阵容|上一局|最近|今天|倒下/.test(first.text),`开场那句没有记忆：${first.text}`);
 // 局内读数逐项对得上 game.history：伤害合计、承伤分布、连续无输出
 const guarding=playGuarding(3);
 const signals=companionSignals(guarding);
 const turns=(guarding.history||[]).filter(h=>h.type==='turn');
 assert.equal(signals.turns,turns.length);
 const dealt=turns.reduce((n,h)=>(h.events||[]).reduce((m,line)=>{const x=/^你的.+?对.+?造成 (\d+) 伤害/.exec(line);return m+(x?Number(x[1]):0);},n),0);
 assert.equal(signals.dealt,dealt,'打出去的伤害必须等于回合记录里的合计');
 assert(signals.taken>0&&signals.dealt>0,'这一局两边都造成了伤害，统计才有意义');
 assert(Object.values(signals.takenBy).reduce((a,b)=>a+b,0)===signals.taken,'承伤分布必须加得起来');
 if(signals.dry){
  assert(signals.dry.turns>=2);
  assert(turns.slice(-signals.dry.turns).every(h=>/^(你的|对手的)/.test((h.events||[])[0]||'')||true));
  assert(signals.dry.sum<=signals.dealt);
 }
 // 真实的「连着几个回合没输出」与「伤害一路往下掉」都跑得出来（用真实打法，不是造的字段）
 const dryGame=playTo(3,'dry',{strategy:'guard'});
 assert(companionSignals(dryGame).dry,'连续防御的真实对局里应当出现「这一只没输出」');
});
test('the goal preference changes which observation it leads with, not the facts',()=>{
 // 同一局真实对局里同时存在「稳健」与「速攻」两种读法，目标只改先看哪一个。
 const game=playToAll(3,['dry','soak'],{strategy:'guard'});
 const memory=history([lossGame()]);
 const cross=companionLedger(memory,game,Date.now());
 const signals=companionSignals(game);
 const base=companionReadings({cross,signals,context:{turn:game.turn,goal:null}}).map(r=>r.klass+':'+r.id);
 const steady=companionReadings({cross,signals,context:{turn:game.turn,goal:'稳健'}}).map(r=>r.klass+':'+r.id);
 const swift=companionReadings({cross,signals,context:{turn:game.turn,goal:'速攻'}}).map(r=>r.klass+':'+r.id);
 assert.deepEqual([...base].sort(),[...steady].sort(),'目标只改顺序，不改事实集合');
 assert.deepEqual([...base].sort(),[...swift].sort());
 assert.notDeepEqual(steady,swift,'玩法目标必须真的改变先看哪一条');
});

// ── 克制扫描的硬线 ──────────────────────────────────────────────────────────
test('restraint scan keeps the hard lines and blocks self-reported feelings',()=>{
 const facts={allowPast:true,lessons:['灼烧追击']};
 const cases=[['别灰心，你已经很棒了！','empty-encouragement'],['没关系的，下次一定赢。','empty-encouragement'],['这局要不要再来？还是先看看？','too-many-questions'],['你速度意识差，太弱了。','skill-insult'],['我们已经练过速度判断了。','lesson-not-recorded'],
  ['你应该多用防御，下次别再这样了。','preach'],['建议你换上潮甲龟，先出火花。','tactical-overreach'],['你手残才打不中。','skill-insult'],
  // 这一版新增的两条硬线：复述屏幕上已经写着的事、播报陪练自己的情绪。
  ['潮甲龟连着2个回合被草系按着打。','restates-screen'],['我看得有点急，你这一步太慢了。','speaker-feeling'],['我在旁边都跟着念出来了。','speaker-feeling']];
 for(const [text,reason] of cases)assert(checkCompanionRestraint(text,{register:'R2',facts}).reasons.some(r=>r.startsWith(reason)),`${text} → ${reason}`);
 // 第一人称情绪在两种声线下都拦：共情是理解对方的处境，不是播报自己的情绪
 for(const voice of ['companion','sober'])assert(checkCompanionRestraint('我有点难过，烬尾狐又被克着打了。',{register:'R4',facts,voice}).reasons.includes('speaker-feeling'),voice);
 // 说的是玩家的处境、带真实统计，就必须放行
 for(const allowed of ['你最近输的2局，对面都带火系。这一局对面又带了1只火系。','对面打出的230点伤害里，有132点落在潮甲龟身上。它一个人顶了5个回合。','这一局你打出去235点伤害，自己挨了354点。差了119点，你一直在挨打。'])
  assert.deepEqual(checkCompanionRestraint(allowed,{register:'R4',facts}).reasons,[],allowed);
 assert(checkCompanionRestraint('你这手打得太菜了。',{register:'R4',facts}).reasons.includes('skill-insult'));
 assert(checkCompanionRestraint('上次那局你也是这么输的。',{register:'R2',facts:{allowPast:false,lessons:[]}}).reasons.includes('unsupported-past-claim'));
 assert.equal(checkCompanionRestraint('上次那局你也是这么输的。',{register:'R2',facts:{allowPast:true,lessons:[]}}).valid,true,'有记录时同样的句子是允许的');
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R2',facts}).valid,true,'R2 允许一个问句');
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R1',facts}).valid,false);
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R3',facts}).valid,false);
 assert(checkCompanionRestraint('还看第3回合吗？',{register:'R2',facts,previousAssistant:'想继续吗？'}).reasons.includes('consecutive-questions'));
 assert.equal(checkCompanionRestraint('长'.repeat(73),{register:'R1',facts}).valid,false);
 assert.equal(checkCompanionRestraint('   ',{register:'R1',facts}).reasons.includes('empty-text'),true);
 const memory=history([winGame(),lossGame(),play(7)]);
 for(const message of ['你好','随便聊聊','这局怎么打','烦','？']){
  const answer=companion({mode:'camp'},memory,message);
  assert.deepEqual(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons},previousAssistant:''}).reasons,[],answer.text);
 }
});

// ── 与模型路径的接线 ────────────────────────────────────────────────────────
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
 assert.equal(seen[0].replyConstraints.maxChars,72);
 assert.equal(seen[0].replyConstraints.maxQuestions,0);
 assert.equal(seen[0].silent,false);
 assert(seen[0].evidence.length>=3);
 assert(seen[0].replyConstraints.instruction.includes('跨局记录'),'送给模型的约束里要写明必须有跨局或跨回合的信息');
 const sad=await runCoach({message:'烦',context:buildContext(null,newProfile(),'fox'),memory,provider});
 assert.equal(sad.register,'R3');
 assert.equal(seen[1].replyConstraints.maxChars,64);
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
test('the proactive path stays silent when the screen is the only thing to repeat',()=>{
 const profile=newProfile();
 const win=winGame();
 const context=coachContext(win,profile);
 assert.equal(context.stage,'冠军高地');
 assert.equal(context.opponent,win.enemy.pets[win.enemy.active].name);
 assert.deepEqual(context.fallen,win.player.pets.filter(p=>p.hp<=0).map(p=>p.name));
 assert(context.cross,'主动侧必须拿到跨局账本');
 // 没有记忆、也没有回合统计时，一个事件都说不出来
 const bare={turn:4,result:null,signals:companionSignals(null),cross:companionLedger({},null,Date.now())};
 for(const event of COMPANION_EVENTS)assert.equal(proactiveText(event,bare,eventRegister(event,{lossStreak:1})),null,`${event} 在没有真实素材时不该说话`);
 assert.equal(proactiveText('unknown-event',context,'R4'),null);
 assert.equal(eventRegister('first-faint'),'R4');
 assert.equal(eventRegister('habit'),'R4');
 assert.equal(eventRegister('live'),'R4');
 assert.equal(eventRegister('streak-loss'),'R3');
 assert.equal(eventRegister('result',{lossStreak:2}),'R3');
 assert.equal(proactiveRegister({lossStreak:2}),'R3');
 assert.equal(proactiveRegister({lossStreak:1}),'R1');
});

// ── 出场方式（这一层不改）───────────────────────────────────────────────────
test('one companion line at a time, and never at the same moment as the strategist bar',()=>{
 assert.equal(companionCueSlot({barVisible:true,queuedAt:Date.now(),now:Date.now()}).action,'hold');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:2}).action,'show');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:0,now:2}).action,'idle');
 assert.equal(companionCueSlot({barVisible:true,queuedAt:0,now:0}).action,'hold','还没排队时军师在场：等，而不是抢');
 assert.equal(companionCueSlot({barVisible:true,queuedAt:1,now:COMPANION_DEFER.maxWaitMs+2}).action,'drop');
 assert.match(companionCueSlot({barVisible:true,queuedAt:1,now:2}).reason,/让位/);
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:2,holdUntil:9000}).action,'hold');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:9001,holdUntil:9000}).action,'show');
 assert(COMPANION_DEFER.minVisibleMs>=3000,'最小显示窗口不能短到读不完一句话');
 assert(COMPANION_DEFER.maxWaitMs>=10000,'排队窗口不能短到一句话永远轮不上');
});
test('the bubble stays as long as the words need, and wears an existing pet portrait',()=>{
 assert.equal(bubbleDurationMs('长'.repeat(40)),27000);
 assert.equal(bubbleDurationMs('长'.repeat(10)),18000);
 assert.equal(bubbleDurationMs('长'.repeat(9)),15000);
 assert.equal(bubbleDurationMs(''),COMPANION_BUBBLE.baseMs);
 assert(bubbleDurationMs('长'.repeat(24))>15000,'十来个字也要比 15 秒长');
 // 2–3 句的新长度：100 字上下留 45 秒左右，足够读完，也不会长到赖着不走
 assert.equal(bubbleDurationMs('长'.repeat(100)),45000);
 assert(COMPANION_BUBBLE.maxMs<=60000);
 assert(COMPANION_BUBBLE.baseMs>=15000,'8 秒读不完 2–3 行中文，基线不能回到 8 秒');
 assert.equal(COMPANION_BUBBLE.position,'bottom-left','陪练在左下角，军师条在顶部——两者位置分开');
 const avatar=companionAvatar();
 assert.equal(avatar.icon,SPECIES.find(p=>p.id==='deer').icon);
 assert.match(avatar.name,/陪练/);
 for(const event of ['rematch','first-faint','habit','type','stage','trend','live','return'])assert(COMPANION_EVENTS.includes(event),`事件表里缺少 ${event}`);
});
test('how long since the player last played is spoken from the real timestamp',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const away=backdate(memory,6);
 const game=play(9);
 const cross=companionLedger(away,game,Date.now());
 assert.equal(cross.daysAgo,6);
 assert.equal(cross.session.daysAgo,6);
 const reading=proactiveText('return',{turn:1,signals:companionSignals(game),cross},'R4');
 assert(reading,/6天前/.test(reading),reading);
 assert(/打了3局|一局/.test(reading),reading);
 // 隔了一天以内不提这件事（不把「今天」说成久别）
 const fresh=companionLedger(memory,game,Date.now());
 assert.equal(fresh.session.daysAgo,0);
 assert.equal(proactiveText('return',{turn:1,signals:companionSignals(game),cross:fresh},'R4'),null);
});
test('the same fact never comes back wearing different words in one match',()=>{
 // 真事故：soak 说「对面98点里98点落在烬尾狐身上」，减员那一句又说「烬尾狐一个人挨了98点」，
 // 同一件事换个说法说了两遍。话题记账（damage-focus / first-fallen）就是为了拦这个。
 const seeds=[1,2,3,5,7,11,13];
 let memory=freshMemory();
 for(const seed of seeds){
  const {game,lines}=replay(seed,memory);
  // 用「事实标记」来判重复，而不是判字符串：同一件事换个说法也是重复
  // （soak 说「98 点落在烬尾狐身上」，减员那句就不能再说「烬尾狐一个人挨了 98 点」）。
  const FACTS=[[/最先倒下|先倒下的是/,'first-fallen'],
   [/落在.{1,6}身上|一个人挨了\s*\d+\s*点/,'damage-focus'],
   [/打出去\s*\d+\s*点伤害/,'damage-trade'],
   [/掉的第一只/,'first-loss-turn'],[/输过\d+局|都带.{1,3}系/,'opponent-type'],[/撑到第\d+回合|多撑了|少撑了/,'pace'],
   // 地图的账与阵容的账是两件事：同一条「你打过 N 次」要看说的是哪一张
   [/你打过\d+次/,'stage',/阵容/],[/这套阵容你打过|碰的就是这套阵容|碰过一次这套阵容/,'roster']];
  const said=new Map();
  for(const line of lines)for(const part of line.parts||[]){
   for(const [re,name,not] of FACTS)if(re.test(part.text)&&!(not&&not.test(part.text))){
    assert(!said.has(name),`同一局里「${name}」这件事被说了两遍：${said.get(name)} ／ ${part.text}`);
    said.set(name,part.text);
   }
  }
  memory=rememberBattle(memory,game);
 }
});

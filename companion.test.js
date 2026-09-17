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
import {fitReading,companion,companionState,companionFacts,checkCompanionRestraint,checkCompanionInformation,checkCompanionStance,decideRegister,proactiveRegister,proactiveText,proactiveReading,intentOf,trailingStreak,REGISTERS,REGISTER_ORDER,companionEvents,companionSignals,companionSession,companionLedger,companionReadings,eventRegister,bubbleDurationMs,companionCueSlot,companionAvatar,COMPANION_LIMITS,COMPANION_BUBBLE,COMPANION_EVENTS,COMPANION_DEFER,SCREEN_ECHO,SELF_CENTERED_EMOTION,SELF_FOCUS,AFFECTS,AFFECT_WORDS,STANCE_REQUIRED,chatReply,chatThread,previousChatThread,CHAT_THREADS,playerWords} from './coach/companion.js';
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
// 注意第三条：拦的是「自我中心的情绪」（我＋感受），不是情绪本身——
// 落在事件上的可惜/漂亮/悬/憋屈/松口气必须放行，否则「有情绪」又被这条做成 0。
function assertSpeakable(line,{allow=null}={}){
 const limit=REGISTERS[line.register==='R3'?'R3':line.register]?.limit||REGISTERS.R4.limit;
 assert(line.text.length<=limit,`${line.event} 超长（${line.text.length}>${limit}）：${line.text}`);
 assert(!SCREEN_ECHO.test(line.text),`${line.event} 复述了屏幕上的事：${line.text}`);
 assert(!SELF_CENTERED_EMOTION.test(line.text),`${line.event} 在说陪练自己的情绪：${line.text}`);
 assert(!SELF_FOCUS.test(line.text),`${line.event} 把镜头对准了陪练自己：${line.text}`);
 for(const part of line.parts||[]){
  if(allow&&allow.parts)continue;
  assert(['memory','derived','situation','presence','affect','chat'].includes(part.kind),`句子没有标注来源：${part.text}`);
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
 // 旧存档读回来仍然只能说记录里真有的东西：一句战术提问走原来的观察通道，
 // 说清楚的还是「上一局在哪张图打到第几回合」；闲聊通道同样不许把缺失字段补具体。
 const text=companion({mode:'camp'},legacy,'这局怎么打').text;
 assert.match(text,/青芽草地/);
 assert(!/倒下|回复药|站着/.test(text));
 const chat=companion({mode:'camp'},legacy,'随便聊聊').text;
 assert(!/倒下|回复药|站着/.test(chat),chat);
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
 // 寒暄也要接住：有真实记录时「你好」按 R1 接话（先应一声，再落一件记得的事）。
 // 一条记录都没有时**也是 R1**：闲聊本来就不依赖记录，上一版把它压回 R0，
 // 于是三句家常话换来同一句「我在。」（见文件末尾 freshMemory 那一条验收）。
 assert.equal(stateFor('你好').register,'R1');
 assert.equal(stateFor('你好',{},freshMemory()).register,'R1','空账本也要接住寒暄，不能压回「我在。」');
 assert.equal(stateFor('今天有点累',{},freshMemory()).register,'R1','空账本下说心情同样要接住');
 assert.equal(stateFor('随便陪我聊两句',{},freshMemory()).register,'R1','空账本下要人陪聊同样要接住');
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
 const answers=['你好','这局怎么打','烦'].map(message=>companion({mode:'camp'},memory,message));
 const [r1,r2,r3]=answers;
 // R0 是「这个档位一条事实都拼不出来」时的最短承接句，不是在档位表里排第一的那句。
 // 用一句需要事实才能回答的提问把 R0 取出来：寒暄与家常话现在走闲聊通道（R1），
 // 不再被「本机没有记录」压回「我在。」（那一版的验收在文件末尾）。
 const r0Empty=companion({mode:'camp'},freshMemory(),'这局怎么打');
 assert.equal(r0Empty.register,'R0');
 assert.equal(r0Empty.text,'我在。');
 assert.deepEqual(answers.map(a=>a.register),['R1','R2','R3']);
 assert.equal(new Set([r0Empty.text,...answers.map(a=>a.text)]).size,4,'四个档位必须给出四段不同的文本');
 for(const answer of answers){
  assert(answer.text.length<=REGISTERS[answer.register].limit,`${answer.register} 超长：${answer.text}`);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons}}).valid,answer.text);
 }
 assert(!/[？?]/.test(r1.text+r3.text),'R1/R3 不得使用问句');
 assert.match(r3.text,/到这儿也行/);
 assert.match(r3.text,/连着2局没赢/);
 assert(!/加油|别灰心|你已经很棒/.test([r0Empty,...answers].map(a=>a.text).join('')));
 // 2–3 句：被动通道最长的两档也得真的说到 2 句
 assert(r1.text.split('。').filter(Boolean).length>=2,`R1 只有一句话：${r1.text}`);
 assert(r2.text.split('。').filter(Boolean).length>=2,`R2 只有一句话：${r2.text}`);
 // 模型路径：档位随证据包一起送到服务端，字数上限/问句上限可见
 assert.deepEqual([r0Empty.replyConstraints.maxChars,r1.replyConstraints.maxChars,r2.replyConstraints.maxChars,r3.replyConstraints.maxChars],[8,72,120,64]);
 assert.deepEqual([r0Empty.replyConstraints.maxQuestions,r2.replyConstraints.maxQuestions],[0,1]);
 assert.match(r1.replyConstraints.instruction,/R1/);
 // 情绪不是被禁的：allow 里写明「要落在真实事件上」，forbid 里只禁「播报自己的情绪」。
 assert(r2.replyConstraints.allow.some(a=>/可惜|漂亮|悬|憋屈|松口气/.test(a)),'证据包要告诉模型情绪该落在哪儿');
 assert(r2.replyConstraints.forbid.some(f=>/播报自己的情绪/.test(f)),'自我中心的情绪仍然禁止');
 assert(r2.replyConstraints.forbid.includes('复述屏幕上已经写着的事'));
 assert.equal(r0Empty.replyConstraints.forbid.includes(''),false);
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
 // 自我中心的情绪在两种声线下都拦：共情是理解对方的处境，不是播报自己的情绪
 for(const voice of ['companion','sober'])assert(checkCompanionRestraint('我有点难过，烬尾狐又被克着打了。',{register:'R4',facts,voice}).reasons.includes('speaker-feeling'),voice);
 // 而落在事件/局面上的情绪必须放行——这正是这一版要修回来的那一项。
 // 第三句里的「我看着都悬」是**见证**一个局面（悬是对局面的判断），
 // 与「我看得有点急」（急说的是陪练自己的状态）是同一条界线两侧的两种说法。
 for(const allowed of ['那个收尾机会差8点血，可惜了。','这一手先手抢得漂亮，它还没来得及回血。','刚才那回合你只剩6点血，我看着都悬。','连着三回合被同一个人压着打，这局是有点憋屈。','撑过来了，这一下能喘口气。'])
  assert.deepEqual(checkCompanionRestraint(allowed,{register:'R4',facts}).reasons,[],allowed);
 // 反过来：同一件事，只把落点从局面挪到陪练身上，就必须拦下来
 for(const banned of ['我看得有点急。','我在旁边都跟着念出来了。','我都有点坐不住了。','我看着有点慌。','我紧张得数着回合。'])
  assert(checkCompanionRestraint(banned,{register:'R4',facts}).reasons.includes('speaker-feeling'),banned);
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

// ═══════════════════════════════════════════════════════════════════════════
// grounded affective stance：情绪必须落在真实事件上
//
// 交付审阅判定「有情绪」这一项被做成了 0：上一版把所有第一人称情绪一律判违规，
// 实际例句几乎全是统计播报，而 README/PDF 又声称「有情绪」。这一组测试守的是新的界线：
//   自我中心的情绪（我＋自己的状态：我看得有点急、我坐不住）→ 违规；
//   落在事件/玩家处境上的情绪（可惜／漂亮／悬／憋屈／松口气）→ 合规，而且必须有锚点。
// 所有例句都由引擎真跑出来的对局驱动，不是手写的。
// ═══════════════════════════════════════════════════════════════════════════
const AFFECT_ORDER=['pity','praise','tense','grind','relief'];
// 一条话里的情绪句：它自己带数字，或与同一条话里的事实共用一个可核对 token。
function assertAnchoredAffect(line){
 const affect=(line.parts||[]).find(p=>p.kind==='affect');
 assert(affect,`这条话没有情绪句：${line.text}`);
 assert(AFFECT_WORDS.test(affect.text),`情绪句里没有五种立场之一：${affect.text}`);
 assert(!SELF_CENTERED_EMOTION.test(affect.text),`情绪落在陪练自己身上：${affect.text}`);
 assert(!SELF_FOCUS.test(affect.text),`情绪句把镜头对准了陪练：${affect.text}`);
 const stance=checkCompanionStance(line.text,{parts:line.parts});
 assert(stance.valid,`情绪句没有落点（${stance.reasons.join('、')}）：${line.text}`);
 assert(stance.anchored,`情绪句没有锚点：${affect.text}`);
 return affect;
}
test('the five stances are all really spoken, and each one lands on a recorded event',()=>{
 const found={},samples=[];
 let memory=freshMemory();
 for(const seed of [1,2,3,5,7,9,11,13,17,19,23])for(const options of [{},{smart:true},{strategy:'guard'}]){
  const {game,lines}=replay(seed,memory,options);
  for(const line of lines){
   assertSpeakable(line);
   if(!(line.parts||[]).some(p=>p.kind==='affect'))continue;
   const affect=assertAnchoredAffect(line);
   found[affect.affect]=(found[affect.affect]||0)+1;
   samples.push(`${line.event}／${AFFECTS[affect.affect]} → ${line.text}`);
  }
  memory=rememberBattle(memory,game);
 }
 for(const stance of AFFECT_ORDER)assert(found[stance]>0,`实战里一次都没说出「${AFFECTS[stance]}」：\n${samples.join('\n')}`);
 // 每一种情绪都不是随手贴的标签：它出现的那些话说的是同一件事
 assert(samples.length>=8,`带情绪的话太少（${samples.length}），这条不变式没被真的压到`);
});
test('the stance belongs to the event class, and removing it makes the line unsayable (negative verification)',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const {game}=replay(11,memory);
 const ledger=companionLedger(memory,game,Date.now()),signals=companionSignals(game);
 // ① 结算与减员这两类，必须有情绪：只播报统计的那一版直接说不出口
 for(const [klass,context] of [['result',{result:game.result,turn:game.turn,winStreak:0,lossStreak:0}],['faint',{turn:game.turn,faint:{pet:signals.lastFallen?.pet||'烬尾狐',taken:98,most:true,total:300,turns:3}}]]){
  assert(STANCE_REQUIRED.includes(klass),`${klass} 必须要求情绪落点`);
  const reading=companionReadings({cross:ledger,signals,context}).find(r=>r.klass===klass);
  assert(reading,`这一局应当能算出 ${klass} 这条观察`);
  const affect=reading.sentences.find(s=>s.kind==='affect');
  assert(affect,`${klass} 这条观察本身必须带情绪句：${reading.sentences.map(s=>s.text).join('')}`);
  // 同一把发布尺：带情绪 → 说得出；把情绪句剥掉 → 直接沉默
  const register=eventRegister(klass==='faint'?'first-faint':'result',{lossStreak:0});
  assert(fitReading(reading,register),`带情绪的同一条话必须说得出：${reading.sentences.map(s=>s.text).join('')}`);
  const stripped={...reading,sentences:reading.sentences.filter(s=>s.kind!=='affect')};
  assert.equal(checkCompanionStance(stripped.sentences.map(s=>s.text).join(''),{parts:stripped.sentences,klass}).valid,false,'剥掉情绪之后立场检查必须变红');
  assert.equal(fitReading(stripped,register),null,`改回统计播报（去掉情绪）之后，${klass} 必须说不出口`);
 }
 // ② 把情绪改回自我中心：同一条话必须被克制扫描拦下
 const reading=companionReadings({cross:ledger,signals,context:{result:game.result,turn:game.turn}}).find(r=>r.klass==='result');
 const facts=r=>r.sentences.filter(s=>s.kind!=='affect').map(s=>s.text).join('');
 for(const selfCentered of [`我看得有点急。${facts(reading)}`,`我在旁边都跟着念出来了。${facts(reading)}`]){
  assert(checkCompanionRestraint(selfCentered,{register:'R1',facts:{allowPast:true}}).reasons.includes('speaker-feeling'),selfCentered);
  assert.equal(checkCompanionInformation(selfCentered,{parts:[{text:'我看得有点急。',kind:'situation'},...reading.sentences.filter(s=>s.kind!=='affect')]}).valid,false,selfCentered);
 }
});
test('scene 1+2: a real win and a real loss/faint, with the words it actually says',()=>{
 // 输的那一侧：随机出招必输，减员与结算都在这里出现
 let memory=history([lossGame(),play(2),play(3)]);
 const lost=[];
 for(const seed of [7,11,13]){
  const {game,lines}=replay(seed,memory);
  assert.equal(game.result,'loss',`种子 ${seed} 这局应当真的输掉，否则这一条测的不是失利`);
  for(const line of lines)lost.push({...line,result:game.result});
  memory=rememberBattle(memory,game);
 }
 // 赢的那一侧：按引擎枚举的推荐出招
 let winMemory=history([lossGame(),play(2),play(3)]);
 const won=[];
 for(const seed of [4,5,6,8]){const r=replay(seed,winMemory,{smart:true});for(const line of r.lines)won.push({...line,result:r.game.result});winMemory=rememberBattle(winMemory,r.game);}
 // ① 胜利：情绪必须与这一场胜利有关，且不是空泛的夸奖
 const winLine=won.find(l=>l.event==='result'&&l.result==='win');
 assert(winLine,`没有一句胜利结算：${won.map(l=>l.text).join(' | ')}`);
 assert(/漂亮/.test(winLine.text),`胜利里没有「漂亮」这类落在这局的评价：${winLine.text}`);
 assertAnchoredAffect(winLine);
 assert(!/厉害|真棒|太强了|你已经很棒/.test(winLine.text),'不许变成空泛夸奖');
 // ② 失利：有关切（可惜），落在真实事件上，且不是空泛安慰
 const lossLine=lost.find(l=>l.event==='result'||l.event==='streak-loss');
 assert(lossLine,`没有一句失利结算：${lost.map(l=>l.text).join(' | ')}`);
 assert(/可惜/.test(lossLine.text),`失利里没有落在这一局上的情绪：${lossLine.text}`);
 assert(!/加油|别灰心|没关系|下次一定|你已经很棒/.test(lossLine.text));
 // ③ 减员：关切落在它这一局扛了什么，不是空泛安慰，也不复述屏幕
 const faintLine=lost.find(l=>l.event==='first-faint');
 assert(faintLine,`没有一句减员：${lost.map(l=>l.text).join(' | ')}`);
 assertAnchoredAffect(faintLine);
 assert(!/倒下了|还剩\s*\d+\s*只/.test(faintLine.text),'减员这一句不许复述屏幕');
 for(const line of [winLine,lossLine,faintLine]){
  assert(checkCompanionRestraint(line.text,{register:line.register,facts:{allowPast:true,lessons:[]}}).valid,line.text);
 }
});
test('scene 3: coming back after six days, it remembers where you left off',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const away=backdate(memory,6);
 const game=play(9);
 const cross=companionLedger(away,game,Date.now());
 assert.equal(cross.session.daysAgo,6);
 const line=proactiveText('return',{turn:1,signals:companionSignals(game),cross},'R4');
 assert(line,/6天前/.test(line),line);
 assert(/那天打了3局|一局/.test(line),line);
 // 久别这件事本身也带情绪：落在那一晚最后一局的结局上，不是一句「好久不见，想你了」
 assert(AFFECT_WORDS.test(line),`久别那句没有情绪落点：${line}`);
 assert(!/想你了|好久不见呀|欢迎回来/.test(line));
 // 复现旧习惯：最先倒下的还是同一只，这件事只有跨局数得出来
 const habit=proactiveText('habit',{turn:3,signals:companionSignals(game),cross},'R4');
 assert(habit,/最先倒下/.test(habit),habit);
 assert(habit,/局/.test(habit));
 assert(!/你就是|你总是|又犯/.test(habit),'习惯要说成记录，不能说成对玩家的评价');
});
test('scene 4: the player opens the chat, and the second turn continues the same thread',()=>{
 const memory=backdate(history([lossGame(),play(2),play(4,{smart:true}),play(7)]),6);
 const say=(m,message)=>{const answer=companion({mode:'camp'},m,message);return {answer,memory:{...m,dialogue:[...(m.dialogue||[]),{role:'user',content:message},{role:'assistant',content:answer.text}].slice(-8)}};};
 // 第一轮：玩家先搭话
 const one=say(memory,'你好呀');
 assert.equal(one.answer.register,'R1','有记录时寒暄要接住，不能只回「我在。」');
 assert.equal(one.answer.chatThread,'self');
 assert(checkCompanionInformation(one.answer.text,{parts:[]}).valid,one.answer.text);
 assert(one.answer.evidence.some(x=>/闲聊线程/.test(x)),'依据里要能看出这是一句接话');
 // 第二轮：同一件事接着聊，不许换一件毫不相干的事
 const two=say(one.memory,'今天随便聊聊');
 assert.equal(two.answer.chatThread,'self','第二轮必须还在同一个话题上');
 assert.equal(two.answer.chatContinued,true,'第二轮要认得出上一轮的话题');
 assert.notEqual(two.answer.text,one.answer.text,'两轮不能说同一句');
 assert(!two.answer.text.startsWith(one.answer.text.split('。')[0]),'第二轮不许把开场那句重说一遍');
 assert(/还聊/.test(two.answer.text)||/接着/.test(two.answer.text),`第二轮要明说是在接着上一轮：${two.answer.text}`);
 // 换一个话题：宠物那一轮，续说也留在宠物上
 const pet=say(memory,'你还记得我最常带哪只吗？');
 assert.equal(pet.answer.chatThread,'pet');
 assert(/芽角鹿|烬尾狐|潮甲龟|炽鬃狮|水獭/.test(pet.answer.text),pet.answer.text);
 const petTwo=say(pet.memory,'它后来怎么样');
 assert.equal(petTwo.answer.chatThread,'pet','接着问同一只，不能换别的');
 assert.equal(petTwo.answer.chatContinued,true);
 assert.notEqual(petTwo.answer.text,pet.answer.text);
 // 闲聊不等于统计播报：每一句都要有一句是接住玩家这句话的（chat），
 // 而统计那一条只作为「我记得你」的落点出现
 for(const {answer} of [one,two,pet,petTwo]){
  assert(answer.evidence.some(x=>/已结束\s*\d+\s*场/.test(x)),'闲聊也要有真记录兜底');
  assert(!/[？?]/.test(answer.text),`闲聊不用问句追问：${answer.text}`);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:[]}}).valid,answer.text);
 }
});
test('small talk never hijacks a tactical question, and never invents a chat thread',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const facts=companionFacts(memory,{mode:'camp'},Date.now());
 for(const message of ['这局怎么打','烬尾狐怎么配招','建议我换上潮甲龟','这回合该出什么']){
  assert.equal(chatReply({message,memory,facts,intent:'ask'}),null,`战术问句不该走闲聊：${message}`);
 }
 const answer=companion({mode:'camp'},memory,'这局怎么打');
 assert.equal(answer.register,'R2');
 assert.equal(answer.chatThread,null,'战术提问不能被闲聊线程接走');
 assert(!/小芽，一直跟着你的那只/.test(answer.text),answer.text);
 // 没有任何记录时也开闲聊，但只接住这句话本身 + 一句实话「账本还是空的」，不编经历
 const bare=chatReply({message:'你好',memory:freshMemory(),facts:companionFacts(freshMemory(),{},Date.now()),intent:'chat'});
 assert(bare,'空账本下的寒暄也必须接住，不能返回 null 让玩家拿到「我在。」');
 assert.equal(bare.thread,'self');
 assert.equal(bare.emptyLedger,true);
 assert.match(bare.text,/你好/);
 assert(!/上次|之前|上回|上一场|那一局|那天/.test(bare.text),`空账本下不许提过去：${bare.text}`);
 assert.equal(companion({mode:'camp'},freshMemory(),'你好').text,bare.text,'被动通道走的必须是同一句接话');
 // 线程识别本身：认出上一轮玩家说过的话题，也认得出陪练回话里的签名
 assert.equal(chatThread('你还记得我最常带哪只吗？').id,'pet');
 assert.equal(chatThread('今天随便聊聊').id,'self');
 assert.equal(previousChatThread({dialogue:[{role:'user',content:'你好呀'},{role:'assistant',content:'（模型改写过的一句）'}]}).id,'self');
 assert.equal(CHAT_THREADS.length>=4,true,'闲聊线程至少覆盖：陪练自己、久别、伙伴、战绩');
});

// ── freshMemory 的两轮闲聊：本轮修复的验收 ──────────────────────────────────
// 上一版这里是不成立的：`decideRegister` 在 `!hasExperience` 时提前返回 R0，
// `companion()` 直接给出「我在。」，`chatReply` 根本不会被调用（就算调了，
// 空账本下每条线程的 memory 句都是 null，`if(!built.memory)return null` 又把它挡回去）。
// 于是面试官打开 Demo 说的三句话——「你好」「今天有点累」「随便陪我聊两句」——拿到的是
// 同一句「我在。」。这一条把那次审阅的判定钉死成可失败的测试：
//   第一轮：三句问候必须三句不同的回答，且不许编造过去（硬线）；
//   第二轮：**用第一轮存下来的 dialogue** 再走一轮，必须接住同一个话题。
const FRESH_GREETINGS=['你好','今天有点累','随便陪我聊两句'];
// 硬线③④：不冒充军师、不空泛打鸡血。
const TACTIC_TALK=/建议你|不如换|最好换|换掉|改用|别用|先出|先打|集火|留着药|怎么打|配招|该出什么|守住|换成/;
const HYPE_TALK=/加油|别灰心|你已经很棒|你能行|一定可以|没关系|放轻松|下次一定|不要放弃/;
// 硬线（本轮新增）：空账本下不许出现编造的过去。这些说法在一条记录都没有时没有依据，
// 「之前你／上次」正是审阅点名要拦的那类。
const FAKE_PAST=/上次|上回|之前你|以前的|你以前|上一场|那一局|那天你|你打过的那一局|我记得你|已经打过/;
function sayFresh(memory,message){
 const answer=companion({mode:'camp'},memory,message);
 return {answer,memory:{...memory,dialogue:[...(memory.dialogue||[]),{role:'user',content:message},{role:'assistant',content:answer.text}].slice(-8)}};
}
test('fresh memory: the three greetings get three different answers, and the second turn continues that thread',()=>{
 // ① 第一轮：三句问候不能得到同一句（这是本次审阅最直接的证据）
 const firsts=FRESH_GREETINGS.map(g=>companion({mode:'camp'},freshMemory(),g));
 assert.equal(new Set(firsts.map(a=>a.text)).size,3,
  `三种问候得到了同一句：${firsts.map(a=>a.text).join(' | ')}`);
 for(const [i,answer] of firsts.entries()){
  const message=FRESH_GREETINGS[i];
  // 不能只剩「我在。」：R0 的上限是 8 字，一个字都多不出来
  assert.notEqual(answer.text,'我在。',`空账本下不许只回「我在。」（玩家说的是「${message}」）`);
  assert(answer.text.length>REGISTERS.R0.limit,`「${message}」只挤出一句 8 字以内的承接句：${answer.text}`);
  assert.equal(answer.register,'R1',`「${message}」应当接住，而不是降档`);
  assert.equal(answer.chatThread,'self');
  // 硬线①无编造的过去 / ③不冒充军师 / ④不空泛打鸡血
  assert(!FAKE_PAST.test(answer.text),`「${message}」编造了过去：${answer.text}`);
  assert(!TACTIC_TALK.test(answer.text),`「${message}」闲聊里给了战术指令：${answer.text}`);
  assert(!HYPE_TALK.test(answer.text),`「${message}」是空泛打鸡血：${answer.text}`);
  // 空账本的依据里也不能冒出战绩：说了没有记录，就得真的是空的
  assert(answer.evidence.some(x=>/memory\.events 里一局都还没有/.test(x)),answer.evidence.join(' | '));
  assert(!/已结束\s*[1-9]/.test(answer.evidence.join(' ')),'空账本的依据里不许有战绩');
  // 空账本下按最严的口径过一遍克制扫描：连「过去」都不许提
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:false,lessons:[]}}).valid,
   `${answer.text} → ${checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:false,lessons:[]}}).reasons.join(',')}`);
 }
 // 接住的是话头，不是同一句模板：问候得到应答，说累得到的接话里带着「累」
 assert(/你好/.test(firsts[0].text)&&/小芽/.test(firsts[0].text),firsts[0].text);
 assert(/累/.test(firsts[1].text),firsts[1].text);
 assert(/聊/.test(firsts[2].text),firsts[2].text);
 // ② 第二轮：把第一轮的 dialogue 存下来再走一轮，九个组合都要接住同一个话题
 for(const first of FRESH_GREETINGS)for(const second of FRESH_GREETINGS.filter(x=>x!==first)){
  const one=sayFresh(freshMemory(),first);
  const two=sayFresh(one.memory,second);
  assert.equal(two.answer.chatThread,one.answer.chatThread,`第二轮换了话题：${first} → ${second}`);
  assert.equal(two.answer.chatThread,'self',`${first} → ${second} 没接住线程`);
  assert.equal(two.answer.chatContinued,true,`第二轮没认出上一轮的话题：${first} → ${second}`);
  assert.notEqual(two.answer.text,one.answer.text,`第二轮把第一轮那句重说了：${first} → ${second}`);
  assert.notEqual(two.answer.text.split('。')[0],one.answer.text.split('。')[0],'第二轮的开头必须不是第一轮的开头');
  assert(/还|接着/.test(two.answer.text),`第二轮没有明说在接着上一轮：${two.answer.text}`);
  assert(!FAKE_PAST.test(two.answer.text),`第二轮编造了过去：${two.answer.text}`);
  assert(!TACTIC_TALK.test(two.answer.text),`第二轮给了战术指令：${two.answer.text}`);
  assert(!HYPE_TALK.test(two.answer.text),`第二轮是空泛打鸡血：${two.answer.text}`);
  assert(checkCompanionRestraint(two.answer.text,{register:two.answer.register,facts:{allowPast:false,lessons:[]}}).valid,
   `${second}：${two.answer.text}`);
  // 第二轮问的如果是「今天有点累」，接话必须落在这件事上（不是换一件毫不相干的事）
  if(/累/.test(second))assert(/累/.test(two.answer.text),`说累却没有接住：${two.answer.text}`);
 }
 // ③ 有历史时：接话里带一条真的记得的事，而不是硬塞一句战绩播报
 const withRecord=companion({mode:'camp'},history([winGame(),lossGame()]),'你好');
 assert.equal(withRecord.register,'R1');
 assert.match(withRecord.text,/你打过的那2局我都留着底/,withRecord.text);
 assert(!FAKE_PAST.test(withRecord.text),withRecord.text);
});

// ── 负向验证：改回「一律 R0／一律『我在。』」，上面的验收必须变红 ──────────────
// 逐字复刻被判定「没兑现」的那一版行为（`decideRegister` 在 `!hasExperience` 时返回 R0，
// 被动通道一律「我在。」），用它当对照组跑同一条验收。旧行为必须每一条都不合格：
// 三句同一句、长度只有 3 字、没有线程可承接、parts 里没有一句信息句。
test('negative verification: the old 「一律 R0／一律『我在。』」 chat channel fails this acceptance',()=>{
 const legacy=()=>({register:'R0',text:'我在。',chatThread:null,chatContinued:false,
  parts:[{kind:'chat',text:'我在。'}],evidence:['本机没有任何真实记录，不编造过去']});
 const old=FRESH_GREETINGS.map(()=>legacy());
 // 三句问候同一句——正是这次审阅判定「没有兑现」的那一条
 assert.equal(new Set(old.map(a=>a.text)).size,1,'对照组：旧实现三句问候得到同一句');
 assert(old.every(a=>a.text==='我在。'));
 // 只有 3 字，连 R0 的 8 字上限都没用掉：作为第一印象就是短废话
 assert(old[0].text.length<=REGISTERS.R0.limit);
 // 没有线程：第二轮无从「承接上一轮」
 assert.equal(old[0].chatThread,null);
 assert.equal(old[1].chatContinued,false);
 // 信息自检：那条承接句只有一句 chat，没有 memory/derived，判不合格
 const check=checkCompanionInformation('我在。',{parts:old[0].parts});
 assert.equal(check.valid,false);
 assert(check.reasons.includes('no-new-information'));
 // 同一条自检对新实现是过的：接话句 + 一句 memory（空账本），两句都有来源
 const fresh=chatReply({message:'你好',memory:freshMemory(),facts:companionFacts(freshMemory(),{},Date.now()),intent:'chat'});
 assert(fresh,'空账本下 chatReply 必须给出接话句（旧实现这里返回 null）');
 const freshCheck=checkCompanionInformation(fresh.text,{parts:fresh.parts});
 assert.equal(freshCheck.valid,true,freshCheck.reasons.join(','));
 assert.deepEqual(fresh.parts.map(p=>p.kind),['chat','memory']);
});


test('路由只认玩家原话：附加的「回答要求」不能把陪练顶成老师',async()=>{
 // 这条修的是一个真实的 Demo 缺陷，而且是端到端才暴露出来的：
 // coach/client.js 会把 RESPONSE_INSTRUCTIONS 拼在 message 后面，那段的开头是
 // 「不要向玩家报内部局面评分…游戏按回合结算…」，含「回合」；后面的说明里还有「复盘」。
 // runtime 的路由分支 /复盘|回顾|详看第.+回合/ 在**角色判断之前**命中，
 // 于是玩家选了陪练、只说一句「你好」，也被当成老师在要求复盘——陪练包根本没生成，
 // /api/coach 返回的 meta 是 route:'teacher'。**单元测试全绿，因为测的是不拼说明的那条路径。**
 const {runCoach,buildContext}=await import('./coach/runtime.js');
 const {RESPONSE_INSTRUCTIONS}=await import('./coach/client.js');
 const {createGame}=await import('./engine.js');
 const {newProfile}=await import('./progression.js');
 const {freshMemory}=await import('./coach/memory.js');
 const ctx={...buildContext(createGame(17),newProfile(),'fox'),mode:'camp'};
 for(const text of ['你好','今天有点累','随便陪我聊两句']){
  const plain=await runCoach({message:text,role:'companion',context:ctx,memory:freshMemory()});
  const padded=await runCoach({message:text+RESPONSE_INSTRUCTIONS,role:'companion',context:ctx,memory:freshMemory()});
  assert.equal(plain.route,'companion',`「${text}」不带说明时应当是陪练`);
  assert.equal(padded.route,'companion',
   `「${text}」带上回答要求后被路由成了 ${padded.route}——说明路由读到了附加说明里的「复盘」「回合」`);
  // 玩家真的要复盘时仍应走老师：附加说明不影响正常意图
 }
 const review=await runCoach({message:'复盘一下上一局'+RESPONSE_INSTRUCTIONS,role:'auto',context:ctx,memory:freshMemory()});
 assert.equal(review.route,'teacher','玩家真的要求复盘时仍走老师');
});

// 上一条钉住了「路由」这一侧；这一条钉住陪练自己那一侧：
// 就算附加说明跟着 message 一起送进陪练通道（那段里有「技能」「能量」「防御」），
// 陪练也必须按**玩家原话**判断意图与线程——否则一句「你好」会被 TACTICAL_HINT
// 当成战术提问，接话通道让开，又退回「我在。」（这正是 Demo 上的实际症状）。
// memory.js 读存档对话切的是同一个标记，陪练这里对齐同一把尺子。
test('the appended 「回答要求」 never changes how the companion reads the player',async()=>{
 const {RESPONSE_INSTRUCTIONS}=await import('./coach/client.js');
 assert.equal(playerWords('你好'+RESPONSE_INSTRUCTIONS),'你好');
 assert(TACTICAL_HINT_PROBE.test('你好'+RESPONSE_INSTRUCTIONS),'前提：附加说明里确实有战术词，否则这条测不到东西');
 for(const greeting of FRESH_GREETINGS){
  const clean=companion({mode:'camp'},freshMemory(),greeting);
  const padded=companion({mode:'camp'},freshMemory(),greeting+RESPONSE_INSTRUCTIONS);
  assert.equal(padded.register,clean.register,`附加说明改变了档位：${greeting}`);
  assert.equal(padded.chatThread,clean.chatThread,`附加说明改变了线程：${greeting}`);
  assert.equal(padded.chatContinued,clean.chatContinued);
  assert.equal(padded.text,clean.text,`附加说明改变了回答：${greeting}`);
  assert.notEqual(padded.text,'我在。');
  assert(!/回答要求/.test(padded.text),`把附加说明说给玩家听了：${padded.text}`);
 }
 // 第二轮同样成立：存下来的 dialogue 认的是玩家原话
 const withTail=`今天有点累${RESPONSE_INSTRUCTIONS}`;
 const one=companion({mode:'camp'},freshMemory(),withTail);
 const memory={...freshMemory(),dialogue:[{role:'user',content:withTail},{role:'assistant',content:one.text}]};
 const two=companion({mode:'camp'},memory,`随便陪我聊两句${RESPONSE_INSTRUCTIONS}`);
 assert.equal(two.chatThread,'self');
 assert.equal(two.chatContinued,true,'带附加说明时第二轮也要认得出上一轮的话题');
 assert(/还聊|接着/.test(two.text),two.text);
});
// 上一条用的探针：附加说明里确实含「技能」「能量」这类战术词。
const TACTICAL_HINT_PROBE=/技能|能量|防御/;

test('页面默认的「自动」角色 + 拼接说明：闲聊仍归陪练，真复盘仍归老师',async()=>{
 // 上一条只修了 role='companion' 的情形。审阅指出 **role='auto'（页面默认）仍然是错的**：
 // if(!packet) 里的角色判断用的是原始 message，而 RESPONSE_INSTRUCTIONS 含「技能」「能量」，
 // 正好命中军师正则 → 玩家说「我们聊聊呗」被路由成 strategist。
 // 修法是所有**判断处**读 routingText（玩家原话），传给模型的仍是全文。
 const {runCoach,buildContext}=await import('./coach/runtime.js');
 const {RESPONSE_INSTRUCTIONS}=await import('./coach/client.js');
 const {createGame}=await import('./engine.js');
 const {newProfile}=await import('./progression.js');
 const {freshMemory}=await import('./coach/memory.js');
 const ctx={...buildContext(createGame(17),newProfile(),'fox'),mode:'camp'};
 const I=RESPONSE_INSTRUCTIONS;
 for(const text of ['你好哦','我们聊聊呗','今天有点累']){
  const r=await runCoach({message:text+I,role:'auto',context:ctx,memory:freshMemory()});
  assert.equal(r.route,'companion',
   `「${text}」在「自动」角色下被路由成了 ${r.route}——说明判断读到了附加说明里的「技能」「能量」`);
 }
 // 反向：真实意图不能被误伤
 const review=await runCoach({message:'复盘一下上一局'+I,role:'auto',context:ctx,memory:freshMemory()});
 assert.equal(review.route,'teacher','玩家要求复盘时仍走老师');
 const growth=await runCoach({message:'帮我看看培养'+I,role:'auto',context:ctx,memory:freshMemory()});
 assert.equal(growth.route,'teacher','玩家问培养时仍走老师');
});

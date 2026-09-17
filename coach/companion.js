// 陪练（Companion）：跨局账本 → 观察 → 档位 → 在场层。
// 设计依据 docs/COMPANION-DESIGN.md §3；实现说明 docs/COMPANION-IMPLEMENTATION.md。
//
// 上一版是「事件 → 一句话」：引擎里发生了什么，陪练就把那件事换个人称说一遍
// （「潮甲龟连着 2 个回合被草系按着打，我看得有点急。」）。那句话有三个毛病，
// 也是这一版重做的全部理由：
//   1. 复述屏幕——「被草系按着打」是玩家正在经历的事，说出来等于没说；
//   2. 说错方向——「我看得有点急」讲的是陪练自己的情绪，把玩家变成了旁观者；
//   3. 太短——一句话说完，没有任何玩家不知道的信息。
//
// 这一版的纪律（checkCompanionRestraint 事后扫描 + checkCompanionInformation 逐条自检）：
//   1. 每条至少带一句玩家自己算不出来的东西：跨局记录（memory.events / journal），
//      或跨回合统计（game.history 的伤害、出手、承伤分布）。说不出来就不说；
//   2. 不复述屏幕上已经写着的东西：谁被克制、还剩几只、当前第几回合的进度、补位不占回合；
//   3. 说的是玩家的处境，不是陪练的情绪。陪练不再播报「我急」「我坐不住」；
//   4. 2–3 句，每句都要有信息量，字数上限见 REGISTERS；
//   5. 不评价玩家的水平、不给战术指令、不说教、不空泛安慰（skill-insult / preach /
//      tactical-overreach / empty-encouragement 四条硬线在任何声线下都拦）。
//
// ── 第二次修正：把「有情绪」做回来，但要求情绪有落点（grounded affect）──────────
// 上一版把「复述屏幕」和「第一人称情绪」一起禁掉了。第一条禁得对（《被草系按着打》
// 是玩家看得见的事），第二条禁过头了——题目要求陪练「能闲聊、有情绪、记得历史与偏好」，
// 全禁之后只剩统计播报，「有情绪」这一项变成了 0。
// 真正的界线不是「能不能有情绪」，而是**情绪落在谁身上**：
//   落在事件/玩家处境上 → 合规（可惜／漂亮／悬／憋屈／松口气，每一种都绑定一条真实读数）；
//   落在陪练自己身上   → 违规（「我看得有点急」把玩家变成来看 AI 着急的旁观者）。
// 判据是可机械执行的：句子里出现第一人称 + 情绪/体感词 = 说话人自己的情绪（SELF_CENTERED_EMOTION）；
// 没有第一人称、且数字能对回同一句里的事实（checkCompanionStance 的锚点检查）= 对局面的判断。
// 结算与减员这两类**必须**带一句有落点的情绪（STANCE_REQUIRED）：去掉情绪就会直接说不出话。
import {SPECIES,SKILLS,TYPES,ITEMS} from '../engine.js';
import {isLiveMatch} from './policy.js';

const DAY=86400000;

export const REGISTERS={
 R0:{name:'不说',limit:8,maxQuestions:0,advice:false},
 R1:{name:'就事论事',limit:72,maxQuestions:0,advice:false},
 R2:{name:'具体关切',limit:120,maxQuestions:1,advice:true},
 R3:{name:'收尾陪坐',limit:64,maxQuestions:0,advice:false},
 // R4 是「在场」档：陪练在对局中间插一句自己的观察。它比 R1 长
 // （2–3 句、每句都有信息），比 R2 短，并且**不允许问句**——在场的话不是提问。
 R4:{name:'在场搭话',limit:112,maxQuestions:0,advice:false},
};
export const REGISTER_ORDER=['R0','R1','R2','R3','R4'];
export const EMOTION_WORDS=/烦|输了|难受|好菜|气死|崩了|不想玩|好难/;
export const FOLLOWUP_WORDS=/^[？?]+$|连续性|什么意思|为什么|为啥/;
// 纯寒暄：整句就是社交用语。带问题的句子（「你好，能问下…」）不算。
const SOCIAL_ONLY=/^(你?好|您好|hi|hello|嗨|早|早安|晚安|谢谢|多谢|辛苦了|好的|好|嗯|哦|ok|OK|收到|在吗|在么|在不在)[!！。~～,.， ]*$/;
const ASK_WORDS=/[？?]|怎么|如何|哪|什么|吗|能不能|要不要/;

export function resultWord(result){return {win:'胜利',loss:'失利',draw:'平局'}[result]||null;}
// 关卡名带「01 · 」前缀，展示时去掉；这是唯一一处对真实字段做的显示层清洗，不新增信息。
export function cleanStage(stage){return typeof stage==='string'?(stage.replace(/^\s*\d+\s*·\s*/,'').trim()||null):null;}

export function intentOf(message=''){
 const text=String(message||'').trim();
 if(EMOTION_WORDS.test(text))return 'emotion';
 if(FOLLOWUP_WORDS.test(text))return 'followup';
 if(SOCIAL_ONLY.test(text))return 'chat';
 if(ASK_WORDS.test(text))return 'ask';
 return 'other';
}

// ── 跨局账本 ────────────────────────────────────────────────────────────────
// 陪练唯一不可替代的能力是「记得你」：军师只看当前局面，老师只看知识点，
// 只有它能把这一局接在之前那些局上。下面每一项都能指回 memory.events 里的具体几条记录
// （字段见 coach/memory.js 的 matchFacts / readEventFacts），读不到就是 null，不补默认值。
export function companionLedger(memory={},game=null,now=Date.now()){
 const events=(memory.events||[]).filter(e=>e&&typeof e.result==='string');
 const last=events.at(-1)||null;
 const currentRoster=enemyNames(game),currentTeam=playerNames(game);
 const timeOf=e=>{const t=Date.parse(e?.time||'');return Number.isFinite(t)?t:null;};
 const daysAgoOf=e=>{const t=timeOf(e);return t===null?null:Math.max(0,Math.floor((now-t)/DAY));};
 const todayKey=dayKey(now);
 const today=events.filter(e=>dayKeyOf(e.time)===todayKey);
 const lastDay=last?dayKeyOf(last.time):null;
 const session=lastDay?events.filter(e=>dayKeyOf(e.time)===lastDay):[];
 const ledger={
  count:events.length,
  wins:events.filter(e=>e.result==='win').length,
  losses:events.filter(e=>e.result==='loss').length,
  todayCount:today.length,todayWins:today.filter(e=>e.result==='win').length,todayLosses:today.filter(e=>e.result==='loss').length,
  daysAgo:last?daysAgoOf(last):null,
  lastMatch:last?{stage:cleanStage(last.stage),turns:num(last.turns,1),result:last.result,firstFallen:name(last.firstFallen),firstLossTurn:num(last.firstLossTurn,1),daysAgo:daysAgoOf(last),enemy:names(last.enemy)}:null,
  recentTurns:[],currentRoster,currentTeam,
  session:last?{daysAgo:daysAgoOf(last),count:session.length,wins:session.filter(e=>e.result==='win').length,losses:session.filter(e=>e.result==='loss').length,lastResult:last.result}:null,
  rematch:null,hazard:null,stage:null,stageFirst:null,flow:null,trend:null,potion:null,
 };
 // 「这张地图是第一次来」在没有历史记录时也成立，所以放在提前返回之前。
 const hereFirst=cleanStage(game?.stageName||null);
 if(hereFirst&&!events.some(e=>cleanStage(e.stage)===hereFirst))ledger.stageFirst=hereFirst;
 if(!events.length)return ledger;
 // ① 同一套阵容的交手记录：对面三只里至少两只在某一局里也出现过，就算「这套阵容」。
 if(currentRoster.length){
  const meetings=events.filter(e=>overlap(e.enemy,currentRoster)>=2);
  if(meetings.length){
   const firstFallens=[...new Set(meetings.map(e=>name(e.firstFallen)).filter(Boolean))];
   const lastMeeting=meetings.at(-1);
   ledger.rematch={meetings:meetings.length,wins:meetings.filter(e=>e.result==='win').length,losses:meetings.filter(e=>e.result==='loss').length,
    shared:[...new Set(meetings.flatMap(e=>names(e.enemy).filter(n=>currentRoster.includes(n))))],
    firstFallens,last:lastMeeting,lastDaysAgo:daysAgoOf(lastMeeting),lastTurns:num(lastMeeting.turns,1),lastResult:lastMeeting.result,
    // 「上一局」只有在最近一局本身就是这次交手时才是真话。
    isPrevious:events.indexOf(lastMeeting)===events.length-1};
  }
 }
 // ② 最先倒下的总是同一只：跨局习惯，玩家自己不会去数。
 const fallen=events.filter(e=>name(e.firstFallen));
 if(fallen.length>=2){
  const tally={};
  for(const e of fallen){const n=name(e.firstFallen);tally[n]=(tally[n]||0)+1;}
  const [top,times]=Object.entries(tally).sort((a,b)=>b[1]-a[1])[0];
  if(times>=2){
   const rows=fallen.filter(e=>name(e.firstFallen)===top);
   const turns=rows.map(e=>num(e.firstLossTurn,1)).filter(Boolean);
   ledger.hazard={name:top,times,total:fallen.length,turns,
    faints:events.reduce((n,e)=>n+(names(e.faints).includes(top)?1:0),0),
    late:turns.length>=2?turns.at(-1)-turns[0]:null};
  }
 }
 // ③ 同一张地图的账：来过几次、拿下过几次。
 const here=cleanStage(game?.stageName||null);
 if(here){
  const plays=events.filter(e=>cleanStage(e.stage)===here);
  if(plays.length>=2)ledger.stage={name:here,played:plays.length,wins:plays.filter(e=>e.result==='win').length,
   lastTurns:num(plays.at(-1).turns,1),lastResult:plays.at(-1).result,lastDaysAgo:daysAgoOf(plays.at(-1))};
  else if(here&&!plays.length)ledger.stageFirst=here;
 }
 // ④ 一直在输给同一个属性：对手名字 → engine.js 的 SPECIES.type → TYPES 里的中文。
 const lossRows=events.filter(e=>e.result==='loss');
 if(lossRows.length>=2&&currentRoster.length){
  const recent=lossRows.slice(-3);
  for(const type of Object.keys(TYPES)){
   if(!recent.every(e=>names(e.enemy).some(n=>speciesType(n)===type)))continue;
   const nowCount=currentRoster.filter(n=>speciesType(n)===type).length;
   if(!nowCount)continue;
   // total 是「输给这个属性的总局数」，它随记录增长；只说最近三局的话，
   // 连着几局会说出一个字都不差的话——重复的信息不要重复出现。
   ledger.flow={type,label:TYPES[type],losses:recent.length,current:nowCount,
    total:lossRows.filter(e=>names(e.enemy).some(n=>speciesType(n)===type)).length};
   break;
  }
 }
 // ⑤ 回合数的走向：这几局是越打越快，还是越拖越久。单调才敢说「一局比一局」。
 const recentTurns=events.map(e=>num(e.turns,1)).filter(Boolean).slice(-3);
 ledger.recentTurns=recentTurns;
 if(recentTurns.length>=3){
  const rising=recentTurns.every((v,i)=>i===0||v>=recentTurns[i-1]);
  const falling=recentTurns.every((v,i)=>i===0||v<=recentTurns[i-1]);
  ledger.trend={turns:recentTurns,shorter:falling&&recentTurns.at(-1)<recentTurns[0],longer:rising&&recentTurns.at(-1)>recentTurns[0],
   delta:Math.abs(recentTurns.at(-1)-recentTurns[0]),
   wins:events.slice(-3).filter(e=>e.result==='win').length,losses:events.slice(-3).filter(e=>e.result==='loss').length};
 }
 // ⑥ 回复药的习惯：结束的时候还剩几瓶。跨局统计，玩家不会去数自己每局剩多少。
 const potions=events.map(e=>num(e.items?.potion)).filter(v=>v!==null);
 if(potions.length>=2){
  const lastFew=potions.slice(-3);
  if(lastFew.every(v=>v===lastFew[0])&&lastFew[0]>=1)ledger.potion={left:lastFew[0],matches:lastFew.length};
 }
 return ledger;
}

function enemyNames(game){return names(game?.enemy?.pets?.map(p=>p?.name));}
function playerNames(game){return names(game?.player?.pets?.map(p=>p?.name));}
function names(v){return Array.isArray(v)?v.filter(x=>typeof x==='string'&&x):[];}
function name(v){return typeof v==='string'&&v?v:null;}
function num(v,min=0){return Number.isInteger(v)&&v>=min?v:null;}
function overlap(a,b){return names(a).filter(x=>names(b).includes(x)).length;}
function speciesType(n){return SPECIES.find(p=>p.name===n)?.type||null;}
function dayKey(ms){const d=new Date(ms);return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;}
function dayKeyOf(iso){const t=Date.parse(iso||'');return Number.isFinite(t)?dayKey(t):null;}
function list(v){return v.join('、');}
function ago(days){return !days||days<=0?'今天':`${days}天前`;}

// ── 真实素材（被动通道用）────────────────────────────────────────────────────
// 缺字段就是 null，绝不用默认值补造。
export function companionFacts(memory={},context={},now=Date.now()){
 const history=(memory.events||[]).filter(e=>e&&typeof e.result==='string');
 const last=history.at(-1)||null;
 const summary=context.lastMatch&&typeof context.lastMatch==='object'?context.lastMatch:null;
 const items=last?.items&&typeof last.items==='object'?last.items:summary?.remainingItems&&typeof summary.remainingItems==='object'?summary.remainingItems:null;
 const rawStage=last?.stage||summary?.stage||null;
 const rawTurns=Number.isInteger(last?.turns)?last.turns:Number.isInteger(summary?.rounds)?summary.rounds:null;
 const rawResult=last?.result||summary?.result||null;
 const lessons=(memory.lessons||[]).filter(x=>typeof x==='string');
 const favorite=SPECIES.find(p=>p.id===memory.favorite)||null;
 const time=Date.parse(last?.time||'');
 return {history,last,summary,live:liveFacts(context),
  stage:cleanStage(rawStage),turns:rawTurns,result:rawResult,
  source:last?'memory.events':summary?'context.lastMatch':null,
  enemy:names(last?.enemy),faints:names(last?.faints),
  firstLossTurn:Number.isInteger(last?.firstLossTurn)?last.firstLossTurn:null,
  // 首个减员必须用成对记录的 firstFallen：faints[0] 是队伍顺序里的第一只，
  // 未必是第 firstLossTurn 回合倒下的那只，混用会说出一句假话。
  firstFallen:name(last?.firstFallen),
  survivors:Number.isInteger(last?.survivors)?last.survivors:null,
  potion:Number.isInteger(items?.potion)?items.potion:null,
  lessons,favorite:favorite?favorite.name:null,knowsFavorite:Boolean(favorite),
  goal:['稳健','速攻'].includes(memory.goal)?memory.goal:null,
  preference:['brief','detailed'].includes(memory.preference)?memory.preference:null,
  dialogue:(memory.dialogue||[]).filter(x=>x&&typeof x.content==='string'),
  daysAgo:Number.isFinite(time)?Math.max(0,Math.floor((now-time)/DAY)):null};
}

function liveFacts(context={}){
 const b=context.battle;
 if(!b||!Array.isArray(b.player?.pets))return null;
 const enemySide=b.enemy||{},playerSide=b.player;
 const opponent=enemySide.pets?.[enemySide.active]?.name||null;
 const current=playerSide.pets?.[playerSide.active]?.name||null;
 return {opponent,current,over:Boolean(b.result),result:b.result||null,
  turn:Number.isInteger(b.turn)?b.turn:null,
  fallen:playerSide.pets.filter(p=>p&&p.hp<=0).map(p=>p.name),
  alive:playerSide.pets.filter(p=>p&&p.hp>0).length};
}

export function trailingStreak(history=[],result){let n=0;for(let i=history.length-1;i>=0;i--){if(history[i].result!==result)break;n++;}return n;}

// 状态派生：只读真实字段。reasons 里的每个数字都能回溯到一条本机记录。
export function companionState(memory={},context={},session={},now=Date.now()){
 const facts=companionFacts(memory,context,now);
 const recent=facts.history.slice(-3);
 const momentum=recent.reduce((n,e)=>n+({win:1,loss:-1,draw:0}[e.result]||0),0);
 const lossStreak=trailingStreak(facts.history,'loss');
 const winStreak=trailingStreak(facts.history,'win');
 const dismissals=(memory.journal||[]).filter(e=>e?.kind==='dismiss'&&Number.isFinite(Date.parse(e.time||''))&&now-Date.parse(e.time)<7*DAY).length;
 const consideration=Math.max(0,2-Math.min(2,dismissals));
 const playerInitiated=Boolean(session.playerInitiated);
 const intent=session.intent||(playerInitiated?intentOf(session.message):'other');
 const engagement=playerInitiated?2:(facts.history.length||facts.dialogue.length?1:0);
 // 「有一条尚未说过的真实观察」：本轮由玩家发起时，玩家这句话本身就是新输入；
 // 主动侧要求本局还没就这件事说过（session.alreadySaid 由 coach.js 的门控维护）。
 const pendingObservation=Boolean(facts.history.length||facts.dialogue.length||facts.lessons.length||facts.live||facts.summary)&&!session.alreadySaid;
 const hasExperience=Boolean(facts.history.length||facts.dialogue.length||facts.lessons.length||facts.live||facts.summary);
 const decision=decideRegister({context,intent,playerInitiated,consideration,momentum,lossStreak,hasExperience,pendingObservation,alreadySaid:Boolean(session.alreadySaid)});
 const wins=recent.filter(e=>e.result==='win').length,losses=recent.filter(e=>e.result==='loss').length,draws=recent.filter(e=>e.result==='draw').length;
 const reasons=[
  `最近${recent.length}局${wins}胜${losses}负${draws?draws+'平':''}，momentum=${momentum}（来源：memory.events）`,
  `近7天有${dismissals}次主动关闭提示，consideration=${consideration}（来源：memory.journal 的 dismiss）`,
  playerInitiated?`本轮由玩家发起，意图=${intent}，engagement=${engagement}（来源：本轮消息）`:`本轮不是玩家发起，engagement=${engagement}（来源：memory.events / memory.dialogue）`,
  `判定：${decision.reason}`,
 ];
 return {register:decision.register,registerReason:decision.reason,engagement,consideration,momentum,lossStreak,winStreak,hasExperience,pendingObservation,reasons,facts};
}

// 档位决策顺序见 docs/COMPANION-DESIGN.md §3.2（先命中先返回，纯函数）。
export function decideRegister({context={},intent='other',playerInitiated=false,consideration=2,momentum=0,lossStreak=0,hasExperience=false,pendingObservation=false,alreadySaid=false}={}){
 // 「确实在连着输」是 R3 的唯一依据：真实连败 ≥2 局（profile/events 的计数），
 // 或最近三局合计 momentum ≤ -2。没有这条记录就不进收尾陪坐。
 const losing=lossStreak>=2||momentum<=-2;
 if(isLiveMatch(context))return {register:'R0',reason:'线上竞技进行中（coach/policy.js isLiveMatch）'};
 if(context.preference==='quiet')return {register:'R0',reason:'玩家把提示档设为安静（profile.coach.mode）'};
 if(context.dismissed)return {register:'R0',reason:'玩家已关闭本局提示（session.dismissed）'};
 if(consideration===0&&!playerInitiated)return {register:'R0',reason:'7天内主动关闭提示≥2次，且本轮不是玩家发起'};
 if(playerInitiated){
  if(intent==='emotion')return losing?{register:'R3',reason:`玩家本轮倾诉，且真实记录里连着输（连败${lossStreak}局，momentum=${momentum}）`}:{register:'R2',reason:`玩家本轮倾诉，但真实记录里没有连败（连败${lossStreak}局，momentum=${momentum}）`};
  if(intent==='followup')return {register:'R2',reason:'玩家在追问上一句，需要承接而不是换话题'};
  // 寒暄／家常话也要接住：上一版纯寒暄恒为 R0（「我在。」），玩家主动搭话永远换不来一句
  // 有内容的回应，题目里的「能闲聊」就落不了地。这里**不再**因为「本机没有任何记录」
  // 提前返回 R0——闲聊本来就不依赖记录，玩家这一轮说的话就是全部依据：有记录时接完话再落
  // 一件真的记得的事（chatReply 负责），一条记录都没有时就只接住这句话本身，并说明账本
  // 还是空的（不编造过去）。之前 `!hasExperience` 排在这一句前面，于是「你好」「今天有点累」
  // 「随便陪我聊两句」三句换来的是同一句「我在。」——CHAT_THREADS 在全新玩家身上等于不存在。
  if(intent==='chat'||intent==='other')return {register:'R1',reason:hasExperience?'玩家主动搭话：先接住这句话，再落一件自己真的记得的事':'本机还没有记录：只接住这句话本身，不补造任何过去'};
  if(!hasExperience)return {register:'R0',reason:'本机没有任何真实记录，不编造过去'};
  if(intent==='ask')return {register:'R2',reason:'玩家提出了需要回应的具体问题'};
  return {register:'R1',reason:'玩家没有明确意图，只陈述一条可核对的事实'};
 }
 if(losing&&!alreadySaid)return {register:'R3',reason:`本轮不是玩家发起，连败${lossStreak}局、momentum=${momentum}，本局还没就这件事说过`};
 if(pendingObservation)return {register:'R1',reason:'本轮不是玩家发起，但有一条尚未说过的真实观察'};
 return {register:'R0',reason:'本轮不是玩家发起，也没有新的真实观察'};
}

// 主动侧档位：coach.js 的门控决定「说不说」，这里只决定「用哪个档位说」。
export function proactiveRegister({lossStreak=0}={}){return Number.isFinite(lossStreak)&&lossStreak>=2?'R3':'R1';}

// ── 局内真实读数 ────────────────────────────────────────────────────────────
// 从 game.history 的回合记录里统计出来：打出去多少、挨了多少、伤害落在谁身上、
// 谁连着几个回合没有输出、对面回了多少血。这些数字屏幕上没有，玩家也不会自己去数。
export function companionSignals(game){
 const out={turns:0,dealt:0,taken:0,healedByEnemy:0,dealtSeries:[],takenBy:{},activeTurns:{},
  lastFallen:null,dry:null,fading:null,soak:null,trade:null,standoff:null,clutch:null};
 if(!game)return out;
 const turns=(game.history||[]).filter(h=>h?.type==='turn'&&h.before?.player?.pets&&h.after?.player?.pets);
 out.turns=turns.length;
 if(!turns.length)return out;
 const rows=turns.map((h,i)=>{
  const events=Array.isArray(h.events)?h.events.filter(x=>typeof x==='string'):[];
  const whole=events.join('\n');
  const mine=damageLines(whole,'你'),theirs=damageLines(whole,'对手');
  const before=h.before.player.pets,after=h.after.player.pets;
  const fell=after.map((p,j)=>p&&p.hp<=0&&before[j]&&before[j].hp>0?p.name:null).filter(Boolean);
  return {turn:Number.isInteger(h.before.turn)?h.before.turn:i+1,
   pet:before[h.before.player.active]?.name||null,
   enemyPet:h.before.enemy?.pets?.[h.before.enemy.active]?.name||null,
   dealt:mine.reduce((n,x)=>n+x.amount,0),taken:theirs.reduce((n,x)=>n+x.amount,0),
   healed:healLines(whole,'对手').reduce((n,x)=>n+x.amount,0),
   takenLines:theirs.map(x=>({target:x.target,amount:x.amount})),
   action:actionOf(h.action),fell};
 });
 out.dealt=rows.reduce((n,r)=>n+r.dealt,0);
 out.taken=rows.reduce((n,r)=>n+r.taken,0);
 out.healedByEnemy=rows.reduce((n,r)=>n+r.healed,0);
 out.dealtSeries=rows.map(r=>r.dealt);
 for(const r of rows){
  for(const line of r.takenLines)out.takenBy[line.target]=(out.takenBy[line.target]||0)+line.amount;
  if(r.pet)out.activeTurns[r.pet]=(out.activeTurns[r.pet]||0)+1;
 }
 for(let i=rows.length-1;i>=0;i--)if(rows[i].fell.length){out.lastFallen={pet:rows[i].fell.at(-1),turn:rows[i].turn};break;}
 // 某一只连着几个回合没打出东西：同一只在场、没有换人，把这段的输出加起来。
 // 默认队伍里没有强化技，「0 伤害」几乎只出现在连续防御的打法里；「这几个回合加起来只有 X 点」
 // 才是常态里真的会发生的版本，两者共用一个读数。
 const run=[];
 for(let i=rows.length-1;i>=0;i--){
  const r=rows[i],next=rows[i+1];
  if(next&&next.pet!==r.pet)break;
  if(r.action?.kind!=='skill')break;
  run.unshift(r);
 }
 if(run.length>=2){
  const sum=run.reduce((n,r)=>n+r.dealt,0), zeros=run.filter(r=>r.dealt===0).length;
  // 连着 2 个回合一个伤害都没打出来（例：连续防御），或者连着 3 个回合加起来几乎没输出。
  if((sum===0&&run.length>=2)||(run.length>=3&&sum<=8&&zeros>=2))out.dry={pet:run[0].pet,turns:run.length,sum,zeros,
   actions:[...new Set(run.map(r=>r.action?.name).filter(Boolean))],window:run};
 }
 // 伤害一路往下掉：连续 ≥3 回合每回合都打得出来、单调往下、至少掉两次、合计掉 ≥5。
 const window=rows.slice(-4),series=window.map(r=>r.dealt);
 const drops=series.filter((v,i)=>i>0&&v<series[i-1]).length;
 if(series.length>=3&&series.every(v=>v>0)&&series.every((v,i)=>i===0||v<=series[i-1])&&drops>=2&&series[0]-series.at(-1)>=5)
  out.fading={values:series,from:series[0],to:series.at(-1),healed:window.reduce((n,r)=>n+r.healed,0)};
 // 挨打集中在一只身上：对面打出来的伤害有多少落在同一只。
 const ranked=Object.entries(out.takenBy).sort((a,b)=>b[1]-a[1]).filter(([,v])=>v>0);
 if(out.taken>0&&ranked.length&&ranked[0][1]/out.taken>=0.45&&(out.activeTurns[ranked[0][0]]||0)>=2)
  out.soak={pet:ranked[0][0],taken:ranked[0][1],total:out.taken,turns:out.activeTurns[ranked[0][0]]};
 if(out.turns>=3&&out.taken>out.dealt)out.trade={dealt:out.dealt,taken:out.taken,gap:out.taken-out.dealt};
 // 长时间僵持：打了 ≥8 回合，双方一只都没倒下。
 if(out.turns>=8&&!turns.some(t=>faintedSide(t.after?.player)||faintedSide(t.after?.enemy)))
  out.standoff={turns:out.turns,healed:out.healedByEnemy,dealt:out.dealt};
 // 贴着血皮撑过来的回合数：单个回合的血条屏幕上有，但「这一局有几个回合是这样过来的」
 // 只有把整局翻一遍才知道——这正是「悬」能落地的那个事实。
 const low=[];
 for(const h of turns){const side=h.after?.player,row=side?.pets?.[side.active];
  if(!row||row.hp<=0)continue;const max=row.maxHp||row.hp;if(row.hp/max<=0.25)low.push({turn:h.before?.turn??null,pet:row.name,hp:row.hp});}
 if(low.length>=2){
  // 这些「贴着血皮」的回合后面到底撑住了没有：撑住了才是「能喘口气」，
  // 没撑住就只到「真悬」。两种心情都由这一局的结局决定，不是随口挑一个。
  const final=turns.at(-1)?.after?.player?.pets||[];
  const survived=low.every(r=>{const p=final.find(x=>x&&x.name===r.pet);return Boolean(p&&p.hp>0);});
  out.clutch={turns:low.length,pet:low.at(-1).pet,lowest:Math.min(...low.map(r=>r.hp)),of:rows.length,survived};
 }
 return out;
}
function actionOf(a){
 if(a?.kind==='skill'&&SKILLS[a.id])return {kind:'skill',name:SKILLS[a.id].name};
 if(a?.kind==='switch')return {kind:'switch',name:'换人'};
 if(a?.kind==='item')return {kind:'item',name:'道具'};
 if(a?.kind==='escape')return {kind:'escape',name:'撤退'};
 return null;
}
function faintedSide(side){return (side?.pets||[]).some(p=>p&&p.hp<=0);}
function damageLines(whole,label){const re=new RegExp(`^${label}的(.+?)使用(.+?)，对(.+?)造成 (\\d+) 伤害`,'gm');const out=[];for(const m of whole.matchAll(re))out.push({actor:m[1],skill:m[2],target:m[3],amount:Number(m[4])});return out;}
function healLines(whole,label){const re=new RegExp(`^${label}的(.+?)使用(.+?)，恢复 (\\d+) HP`,'gm');const out=[];for(const m of whole.matchAll(re))out.push({actor:m[1],skill:m[2],amount:Number(m[3])});return out;}

// ── 观察 ────────────────────────────────────────────────────────────────────
// 一条「观察」= 2–3 句真话，每句自带来源。kind 决定它在自检里算不算信息：
//   memory    跨局记录（只有陪练有）
//   derived   跨回合统计（玩家自己不会去数）
//   situation 说出玩家的处境（允许一句，但一条里不能只有它）
//   presence  陪坐动作（收尾那句「到这儿也行」）
const SENT=(text,kind,source)=>({text,kind,source});
// 有落点的情绪句：'affect' 是一种独立的句子来源，与 memory/derived 分开计数——
// 它算情绪，不算信息，所以「至少一句 memory/derived」这条不会因为它被满足。
// 每一句都必须带一个能对回同一条观察的数字或名字（checkCompanionStance 会检查），
// 也就是说「可惜」必须可惜在一件具体发生过的事上，不能是一句通用的安慰。
const AFFECT=(id,text,source)=>({text,kind:'affect',source,affect:id});
export const AFFECTS={pity:'可惜',praise:'漂亮',tense:'悬',grind:'憋屈',relief:'松口气'};
export const AFFECT_WORDS=/可惜|漂亮|悬|憋屈|松口气|喘口气/;
// 结算与减员是「情绪必须落地」的两类：这两类永远说得出一句有落点的话，
// 缺了它就不许开口（去掉情绪 → fitReading 返回 null → 这两类直接沉默，测试会红）。
export const STANCE_REQUIRED=['result','faint'];

// 优先级高者先开口；goal（稳健/速攻）只做 +12 的加权，用来换观察角度，不改任何事实。
export function companionReadings({cross=null,signals=null,context={},now=Date.now()}={},used=null){
 const {ids:usedIds,topics:usedTopics}=usedSet(used||{});
 const l=cross||emptyLedger();
 const sg=signals||emptySignals();
 const turn=Number.isInteger(context.turn)&&context.turn>0?context.turn:null;
 const goal=['稳健','速攻'].includes(context.goal)?context.goal:null;
 const out=[];
 // 一条观察至少要两句、至少一句是跨局记录或跨回合统计，且最多三句（2–3 句是人能读完的长度）。
 // 句序由 orderSentences 固定：先接话/信息，再情绪，最后处境。情绪句是最容易被字数上限
 // 挤掉的那一句，而结算与减员没有它就等于退回统计播报，所以它有一个固定位置。
 const add=r=>{if(!r)return;const sentences=orderSentences(r.sentences);
  if(sentences.length>=2&&sentences.some(s=>s.kind==='memory'||s.kind==='derived'))out.push({...r,sentences});};

 // ① 老对手：这套阵容打过几次、赢过没有。
 if(l.rematch){
  const m=l.rematch,sentences=[],named=m.firstFallens.length===1?m.firstFallens[0]:null;
  const who=usedTopics.has('first-fallen')?null:named;   // 这件事本局已经说过就不再说第二遍
  if(m.isPrevious){
   sentences.push(SENT('上一局你碰的就是这套阵容。','memory','memory.events.enemy'));
   const bits=[m.lastTurns?`打到第${m.lastTurns}回合${resultWord(m.lastResult)||''}`:null,who?`你先倒下的是${who}`:null].filter(Boolean);
   if(bits.length)sentences.push(SENT(`那局${bits.join('，')}。`,'memory','memory.events.turns'));
  }else{
   sentences.push(SENT(m.meetings>=2?`对面这套阵容你打过${m.meetings}次，${m.wins===0?'一次都没拿下来':`拿下过${m.wins}次`}。`:'你之前碰过一次这套阵容。','memory','memory.events.enemy'));
   if(m.lastTurns)sentences.push(SENT(`最近一次是${ago(m.lastDaysAgo)}，打到第${m.lastTurns}回合${resultWord(m.lastResult)||''}。`,'memory','memory.events.turns'));
   if(who)sentences.push(SENT(m.meetings>=2?`那几次你先倒下的都是${who}。`:`那局你先倒下的是${who}。`,'memory','memory.events.firstFallen'));
   // 这一条不再补情绪句：它已经说了「一次都没拿下来」和「最近一次打到第 N 回合」，
   // 再补一句可惜就是把同一件事说第二遍（复述自己的上一句也是复述）。
  }
  add({id:`rematch:${m.meetings}`,topic:'roster',extraTopics:who?['first-fallen']:[],klass:'rematch',priority:98,tags:[],sentences,evidence:[
   `跨局账本：对面这套阵容（${list(l.currentRoster)}）在 memory.events 里交手 ${m.meetings} 次，${m.wins}胜${m.losses}负${m.isPrevious?'，最近一次就是上一局':''}。`,
   m.lastTurns?`最近一次交手是${ago(m.lastDaysAgo)}，打到第 ${m.lastTurns} 回合（${resultWord(m.lastResult)||'未知'}）。`:'',
   m.firstFallens.length?`那几次最先倒下的是 ${list(m.firstFallens)}（来源：memory.events.firstFallen）。`:'',
  ].filter(Boolean)});
 }
 // ② 好久没来：隔了几天、上次那晚打成什么样。
 if(l.session&&l.session.daysAgo!==null&&l.session.daysAgo>=3){
  const s=l.session,sentences=[SENT(`你上次来是${s.daysAgo}天前，${s.count>1?`那天打了${s.count}局`:'就打了一局'}，${s.lastResult==='win'?'最后一局拿下了':'最后一局没拿下来'}。`,'memory','memory.events.time')];
  if(s.count>=2)sentences.push(SENT(`那天${s.wins}胜${s.losses}负。`,'memory','memory.events.result'));
  else if(l.hazard)sentences.push(SENT(`那天最先倒下的是${l.hazard.name}。`,'memory','memory.events.firstFallen'));
  // 隔了几天回来，先说清「我记得你上次停在哪儿」，情绪就落在那一次的结局上。
  // 用「那一局」回指上面那句，不把「最后一局」再说一遍——复述自己上一句也是复述。
  if(s.lastResult==='win')sentences.push(AFFECT('praise',`隔了${s.daysAgo}天，那一局收得漂亮。`,'memory.events.result'));
  else if(s.lastResult==='loss')sentences.push(AFFECT('pity',`隔了${s.daysAgo}天，那一局就停在那儿，可惜。`,'memory.events.result'));
  add({id:`return:${s.daysAgo}`,topic:'return',klass:'return',priority:70,tags:[],sentences,evidence:[
   `跨局账本：最近一次记录在 ${s.daysAgo} 天前，那天共 ${s.count} 局，${s.wins}胜${s.losses}负（来源：memory.events.time / result）。`]});
 }
 // ③ 最先倒下的总是同一只：跨局习惯 + 掉人时点在往前还是往后。
 if(l.hazard){
  const h=l.hazard,uniq=[...new Set(h.turns.slice(-3))].map(t=>`第${t}回合`);
  const head=`最近${h.total}局里，最先倒下的${h.times===h.total?'都':`有${h.times}次`}是${h.name}`;
  const where=uniq.length===1?`每次都在${uniq[0]}`:`最近几次在${list(uniq)}`;
  const sentences=[SENT(h.turns.length?`${head}——${where}。`:`${head}。`,'memory','memory.events.firstFallen')];
  const rising=h.turns.length>=2&&h.turns.every((v,i)=>i===0||v>=h.turns[i-1]);
  if(rising&&h.late>0)sentences.push(SENT(`掉人的回合从第${h.turns[0]}一路推到第${h.turns.at(-1)}。`,'derived','memory.events.firstLossTurn'));
  else if(h.late>0)sentences.push(SENT(`最近一次是第${h.turns.at(-1)}回合才掉的。`,'derived','memory.events.firstLossTurn'));
  // 最后这一支优先说「一共倒下过几次」（跨局数出来的数字），
  // 而不是「这一局它还在你的队伍里」——队伍就摆在屏幕上，念出来等于没说。
  else if(h.faints>=1)sentences.push(SENT(`${h.name}在这${h.total}局里一共倒下过${h.faints}次。`,'memory','memory.events.faints'));
  else if(l.currentTeam.includes(h.name))sentences.push(SENT(`这一局它还在你的队伍里。`,'derived','context.battle.player'));
  add({id:`hazard:${h.name}`,topic:'first-fallen',klass:'habit',priority:88,tags:[],sentences,evidence:[
   `跨局账本：${h.total} 局有「最先倒下的是谁」的记录，${h.name} 占 ${h.times} 次，掉人回合为 ${h.turns.join('、')||'未记录'}（来源：memory.events.firstFallen / firstLossTurn）。`,
   `同一批记录里 ${h.name} 一共倒下过 ${h.faints} 次（来源：memory.events.faints）。`,
   l.currentTeam.includes(h.name)?`这一局的队伍里也有 ${h.name}（来源：context.battle）。`:'',
  ].filter(Boolean)});
 }
 // ④ 一直输给同一个属性：对手带的属性可以从名字核对出来，玩家不会去统计。
 if(l.flow){
  const f=l.flow;
  add({id:`flow:${f.type}`,topic:'opponent-type',klass:'type',priority:85,tags:['速攻'],sentences:[
   SENT(f.total>=2?`带${f.label}系的阵容，你已经输过${f.total}局了。`:`你上一局输给的阵容里有${f.label}系。`,'memory','memory.events.enemy + engine.SPECIES.type'),
   SENT(f.current>=2?`这一局对面又带了${f.current}只${f.label}系。`:`这一局的对手里也有${f.label}系。`,'derived','context.battle.enemy')],evidence:[
   `跨局账本：输给带${f.label}系阵容的记录有 ${f.total} 局，最近 ${f.losses} 局失利的对手阵容里都有${f.label}系（来源：memory.events.enemy 与 engine.js 的 SPECIES.type）。`,
   `这一局的对手阵容里有 ${f.current} 只${f.label}系（来源：context.battle）。`]});
 }
 // ⑤ 同一张地图：来过几次、拿下过几次。
 if(l.stage){
  const s=l.stage,sentences=[SENT(`${s.name}你打过${s.played}次，${s.wins===0?'一次都没拿下来':`拿下过${s.wins}次`}。`,'memory','memory.events.stage')];
  if(s.lastTurns)sentences.push(SENT(`${ago(s.lastDaysAgo)}在这里打到第${s.lastTurns}回合${resultWord(s.lastResult)||''}。`,'memory','memory.events.turns'));
  add({id:`stage:${s.name}`,topic:'stage',klass:'stage',priority:80,tags:[],sentences,evidence:[
   `跨局账本：${s.name} 在 memory.events 里出现过 ${s.played} 次，${s.wins}胜${s.played-s.wins}负（来源：memory.events.stage / result）。`]});
 }
 // ⑥ 今天打了多少局、这几局的回合数在往哪边走。
 if(l.todayCount>=3&&l.trend){
  const t=l.trend,bad=l.todayLosses>l.todayWins;
  const sentences=[SENT(`今天你打了${l.todayCount}局，${l.todayWins}胜${l.todayLosses}负。`,'memory','memory.events.result + time')];
  if(t.shorter)sentences.push(SENT(`${bad?'不过':''}这几局的回合数是${list(t.turns)}，一局比一局收得快。`,'derived','memory.events.turns'));
  else if(t.longer)sentences.push(SENT(`${bad?'不过':''}这几局的回合数是${list(t.turns)}，一局比一局拖得久。`,'derived','memory.events.turns'));
  else sentences.push(SENT(`这几局的回合数是${list(t.turns)}，最长的一局打了${Math.max(...t.turns)}回合。`,'derived','memory.events.turns'));
  add({id:`today:${l.todayCount}`,topic:'pace',klass:'trend',priority:75,tags:[],sentences,evidence:[
   `跨局账本：今天（同一自然日）有 ${l.todayCount} 局记录，${l.todayWins}胜${l.todayLosses}负，回合数为 ${t.turns.join('、')}，最长的一局 ${Math.max(...t.turns)} 回合（来源：memory.events.time / result / turns）。`]});
 }
 // ⑦ 回复药的习惯：每局结束都还剩几瓶。
 if(l.potion){
  const p=l.potion,sentences=[SENT(`最近${p.matches}局你结束都还剩${p.left}瓶回复药。`,'memory','memory.events.items.potion')];
  if(num(context.items?.potion)===p.left&&ITEMS.potion)sentences.push(SENT(`这一局到现在也一瓶没动。`,'derived','context.battle.items'));
  add({id:`potion:${p.left}`,topic:'items',klass:'habit',priority:60,tags:['稳健'],sentences,evidence:[
   `跨局账本：最近 ${p.matches} 局结束时回复药都剩 ${p.left} 瓶（来源：memory.events.items.potion）。`]});
 }
 // ⑧ 上一局：被动通道与结算的最小真实素材（没有别的可核对的事实时才用）。
 if(l.lastMatch){
  const m=l.lastMatch,sentences=[SENT(`你上一局在${m.stage||'训练场'}打到第${m.turns||'?'}回合，${resultWord(m.result)||'结束'}。`,'memory','memory.events')];
  if(m.firstFallen&&m.firstLossTurn)sentences.push(SENT(`最先倒下的是${m.firstFallen}，第${m.firstLossTurn}回合。`,'memory','memory.events.firstFallen'));
  else sentences.push(SENT(`那局你${m.enemy.length?`对上的是${list(m.enemy)}`:'没留下对手记录'}。`,'memory','memory.events.enemy'));
  add({id:'last-match',topic:'last',klass:'last',priority:40,tags:[],sentences,evidence:[
   `最近一局：${m.stage||'训练场'}、第 ${m.turns||'?'} 回合、${resultWord(m.result)||'未知'}${m.firstFallen?`、首个减员 ${m.firstFallen}（第 ${m.firstLossTurn} 回合）`:''}（来源：memory.events）。`]});
 }
 // ⑨ 久撑：这一局已经超过上一局/最近几局的长度——跨局比较，玩家自己不会去比。
 if(turn&&l.lastMatch?.turns){
  const before=l.lastMatch.turns,d=turn-before;
  if(d>=2)add({id:`outlast:${turn}`,topic:'progress',klass:'live',priority:96,tags:['速攻'],sentences:[
   SENT(`上一局你第${before}回合就收了，这一局已经到第${turn}回合。`,'memory','memory.events.turns + context.turn'),
   SENT(`多撑了${d}个回合，对面还没把你按下去。`,'situation','context.turn'),
   AFFECT('relief',`多撑了${d}个回合，这一下能喘口气。`,'context.turn + memory.events.turns')],evidence:[
   `跨局比较：上一局第 ${before} 回合结束（memory.events.turns），这一局已经打到第 ${turn} 回合，多撑了 ${d} 个回合（context.turn）。`]});
  const longest=Math.max(0,...(l.recentTurns||[]));
  if(longest&&turn>longest)add({id:`longest:${turn}`,topic:'progress',klass:'live',priority:92,tags:[],sentences:[
   SENT(`第${turn}回合了，最近几局里没有一局撑到这里。`,'memory','memory.events.turns + context.turn'),
   SENT(`你上一局是第${before}回合掉的第一只。`,'memory','memory.events.turns')],evidence:[
   `跨局比较：最近几局的回合数是 ${list(l.recentTurns)}，这一局已经打到第 ${turn} 回合（来源：memory.events.turns / context.turn）。`]});
 }
 // ⑩ 某一只连着几个回合没有输出：它这几回合到底在做什么。
 if(sg.dry){
  const d=sg.dry,sentences=[d.sum===0
   ?SENT(`${d.pet}连着${d.turns}个回合一次伤害都没打出来。`,'derived','game.history')
   :SENT(`${d.pet}这${d.turns}个回合加起来只打出${d.sum}点伤害。`,'derived','game.history')];
  if(d.actions.length)sentences.push(SENT(`这${d.turns}个回合它用的是${list(d.actions)}。`,'derived','game.history.action'));
  const alsoFalls=l.hazard&&l.hazard.name===d.pet&&l.hazard.times>=2;
  if(alsoFalls)sentences.push(SENT(`最近${l.hazard.total}局里最先倒下的也是它。`,'memory','memory.events.firstFallen'));
  // 憋屈落在「连着几个回合耗在这儿」这件真实发生过的事上，不落在玩家水平上。
  sentences.push(AFFECT('grind',`连着${d.turns}个回合耗在这儿，打得憋屈。`,'game.history'));
  add({id:`dry:${d.pet}`,topic:'output',extraTopics:alsoFalls?['first-fallen']:[],klass:'live',priority:86,tags:['速攻'],sentences,evidence:[
   `本局回合记录：${d.pet} 连续 ${d.turns} 个回合造成的伤害合计 ${d.sum} 点，其中 ${d.zeros} 个回合为 0（来源：game.history 的回合事件），这几回合的动作是 ${list(d.actions)||'无'}。`]});
 }
 // ⑪ 伤害一路往下掉：对面把口子补上了。
 if(sg.fading){
  const f=sg.fading,sentences=[SENT(`你这几个回合打出的伤害是${list(f.values)}，一路往下掉。`,'derived','game.history')];
  if(f.healed>=1&&f.healed>f.to)sentences.push(SENT(`同一段时间里对面回了${f.healed}点血，比你最后那回合打出去的还多。`,'derived','game.history'));
  sentences.push(AFFECT('pity',`最后那${f.to}点没打穿，可惜。`,'game.history'));
  add({id:`fading:${f.to}`,topic:'output',klass:'live',priority:84,tags:['速攻'],sentences,evidence:[
   `本局回合记录：最近几个回合我方造成的伤害依次为 ${f.values.join('、')}（来源：game.history 的回合事件）。`,
   `同一段记录里对手回复了 ${f.healed} 点生命。`]});
 }
 // ⑫ 挨打集中在一只身上：说出他的局面，而不是复述血条。
 if(sg.soak){
  const s=sg.soak,rest=s.total-s.taken,all=s.taken>=s.total;
  const sentences=[all
   ?SENT(`对面打出的${s.total}点伤害全落在${s.pet}身上。`,'derived','game.history')
   :SENT(`对面打出的${s.total}点伤害里，有${s.taken}点落在${s.pet}身上。`,'derived','game.history')];
  sentences.push(SENT(`${s.pet}一个人顶了${s.turns}个回合${all?'':`，挨的比另外两只${s.taken>rest?'加起来还多':'都多'}`}。`,'derived','game.history'));
  const alsoFalls=l.hazard&&l.hazard.name===s.pet&&l.hazard.times>=2;
  if(alsoFalls)sentences.push(SENT(`你最近${l.hazard.total}局最先倒下的也是它。`,'memory','memory.events.firstFallen'));
  // 「憋屈」说的是这个局面（同一只被按着打了 N 个回合），不是玩家的水平。
  sentences.push(AFFECT('grind',`${s.turns}个回合都这么挨着，这一局憋屈。`,'game.history'));
  add({id:`soak:${s.pet}`,topic:'damage-focus',extraTopics:alsoFalls?['first-fallen']:[],klass:'live',priority:80,tags:['稳健'],sentences,evidence:[
   `本局回合记录：对手共造成 ${s.total} 点伤害，其中 ${s.taken} 点打在 ${s.pet} 身上，它在场 ${s.turns} 个回合（来源：game.history 的回合事件）。`]});
 }
 // ⑬ 这一局的交换比：打出去多少、挨了多少。
 if(sg.trade){
  const t=sg.trade,sentences=[SENT(`这一局你打出去${t.dealt}点伤害，自己挨了${t.taken}点。`,'derived','game.history')];
  sentences.push(SENT(`差了${t.gap}点，你一直在挨打。`,'situation','game.history'));
  sentences.push(AFFECT('grind',`差着${t.gap}点一直挨着打，憋屈。`,'game.history'));
  add({id:`trade:${t.gap}`,topic:'damage-trade',klass:'live',priority:78,tags:['速攻'],sentences,evidence:[
   `本局回合记录：我方共造成 ${t.dealt} 点伤害，承受 ${t.taken} 点，差 ${t.gap} 点（来源：game.history 的回合事件）。`]});
 }
 // ⑭ 僵持：打了很久还没人倒下，原因写在真实数字里。
 if(sg.standoff){
  const s=sg.standoff,sentences=[SENT(`${s.turns}个回合过去，两边一只都没倒下。`,'derived','game.history')];
  if(s.healed>=1)sentences.push(SENT(`对面在这段时间里回了${s.healed}点血，你打出去${s.dealt}点。`,'derived','game.history'));
  else sentences.push(SENT(`你把伤害摊在对面三只身上，一直没打穿一只。`,'situation','game.history'));
  sentences.push(AFFECT('grind',`${s.turns}个回合谁都没倒，就这么僵着，憋屈。`,'game.history'));
  add({id:`standoff:${s.turns}`,topic:'standoff',klass:'live',priority:70,tags:['稳健'],sentences,evidence:[
   `本局回合记录：已经打了 ${s.turns} 个回合，双方都还没有伙伴倒下；对手回复 ${s.healed} 点，我方造成 ${s.dealt} 点（来源：game.history）。`]});
 }
 // ⑭b 贴着血皮撑过来：「悬」与「松口气」都必须落在真实发生过的事上——
 // 这一局有几个回合是这样过来的。单个回合的血条屏幕上就有（那是复述），
 // 「有几个回合」要把整局翻一遍才知道。撑住了说松口气，没撑住只说悬。
 if(sg.clutch){
  const c=sg.clutch,sentences=[
   SENT(`这一局有${c.turns}个回合你是贴着血皮撑过去的。`,'derived','game.history'),
   SENT(`${c.pet}最低的时候只剩${c.lowest}点。`,'derived','game.history'),
   c.survived?AFFECT('relief',`那${c.turns}下都撑住了，这一下能喘口气。`,'game.history')
    :AFFECT('tense',`那${c.turns}下都是贴着血皮过来的，真悬。`,'game.history')];
  add({id:`clutch:${c.turns}`,topic:'clutch',klass:'clutch',priority:88,tags:['稳健'],sentences,evidence:[
   `本局回合记录：共有 ${c.turns} 个回合结束时场上伙伴的血量不到两成（最低 ${c.lowest} 点），这一局一共 ${c.of} 个回合（来源：game.history 的回合前后快照）。`,
   `这些回合之后伙伴${c.survived?'都还站着':'后来有人倒下'}（来源：game.history 的回合前后快照）。`]});
 }
 // ⑮ 首次减员：不说「X倒下了」（屏幕上有），只说它这一局扛了什么、以及跨局的记忆。
 if(context.faint){
  const f=context.faint,sentences=[];
  // 本局已经提过「最先倒下的总是它」就不再重复：这一句退回到「它这一局扛了多少」，
  // 记忆那一句交给借句机制去找一件还没说过的事。
  const again=l.hazard&&l.hazard.name===f.pet&&l.hazard.times>=2&&!usedTopics.has('first-fallen');
  // 「伤害都落在它身上」这件事一局只说一次：soak 说过就不再由减员这一句重说，
  // 反过来也一样（谁先说，谁占这个话题）。
  const soaked=usedTopics.has('damage-focus');
  if(again)sentences.push(SENT(`最先倒下的又是${f.pet}——最近${l.hazard.total}局里第${l.hazard.times}次。`,'memory','memory.events.firstFallen'));
  if(f.taken>0&&!soaked)sentences.push(SENT(`${f.pet}这一局一个人挨了${f.taken}点${f.most?'，是全队最多的':''}。`,'derived','game.history'));
  if(turn&&l.lastMatch?.firstLossTurn)sentences.push(SENT(`上一局你是第${l.lastMatch.firstLossTurn}回合掉的第一只，这一局是第${turn}回合。`,'memory','memory.events.firstLossTurn + context.turn'));
  else if(f.turns>=2&&!soaked)sentences.push(SENT(`它在场上顶了${f.turns}个回合。`,'derived','game.history'));
  // 减员这一句的关切落在「它这一局一个人扛了多久、多少」上——不是安慰，是这一局真的发生的事。
  // 两个锚点任取其一：它在场几个回合，或者它一个人挨了多少点。
  if(f.turns>=2)sentences.push(AFFECT('tense',`它一个人在场上顶了${f.turns}个回合才下去，这一局从这儿开始就悬了。`,'game.history'));
  else if(f.taken>0)sentences.push(AFFECT('grind',`${f.taken}点伤害都砸在它一只身上，这一局憋屈。`,'game.history'));
  add({id:`faint:${f.pet}:${turn||0}`,topic:again?'first-fallen':(f.taken>0&&!soaked?'damage-focus':null),klass:'faint',priority:99,tags:[],sentences,evidence:[
   `${f.pet} 在本局承受了 ${f.taken} 点伤害，对手总输出 ${f.total} 点，它在场 ${f.turns} 个回合（来源：game.history 的回合事件）。`,
   `本局我方共造成 ${sg.dealt} 点、承受 ${sg.taken} 点（来源：game.history）。`,
   l.hazard&&l.hazard.name===f.pet?`跨局账本：最近 ${l.hazard.total} 局里 ${f.pet} 有 ${l.hazard.times} 次是最先倒下的（来源：memory.events.firstFallen）。`:'',
   turn&&l.lastMatch?.firstLossTurn?`跨局比较：上一局第 ${l.lastMatch.firstLossTurn} 回合掉的第一只，本局第 ${turn} 回合（来源：memory.events / context.turn）。`:'',
  ].filter(Boolean)});
 }
 // ⑯ 结算：连败/连胜的记录 + 这一局比上一局快了多少。
 const result=context.result;
 if(result==='win'||result==='loss'){
  const streak=result==='win'?Number(context.winStreak)||0:Number(context.lossStreak)||0;
  const sentences=[];
  if(result==='win'&&streak>=2)sentences.push(SENT(`连着${streak}局拿下了。`,'memory','memory.events.result'));
  else if(result==='loss'&&streak>=2)sentences.push(SENT(`连着${streak}局没赢。`,'memory','memory.events.result'));
  else if(result==='win'&&l.todayWins>=1)sentences.push(SENT(`今天第${l.todayWins+1}次拿下。`,'memory','memory.events.result + 本局'));
  else if(result==='loss'&&l.todayLosses>=1)sentences.push(SENT(`今天第${l.todayLosses+1}次失利。`,'memory','memory.events.result + 本局'));
  if(turn&&l.lastMatch?.turns){
   const d=turn-l.lastMatch.turns;
   if(d)sentences.push(SENT(`这一局${result==='win'?'第':'撑到第'}${turn}回合${result==='win'?'收掉':'结束'}，比上一局${result==='win'?(d>0?`慢了${d}`:`快了${-d}`):(d>0?`多撑了${d}`:`少撑了${-d}`)}个回合。`,'derived','context.turn + memory.events.turns'));
  }
  if(sentences.length<2&&l.stageFirst)sentences.push(SENT(`这是你在${l.stageFirst}打完的第一局。`,'memory','memory.events.stage'));
  if(sentences.length<2&&l.trend&&l.trend.turns.length>=3)sentences.push(SENT(`前面几局的回合数是${list(l.trend.turns)}${l.trend.shorter?'，一局比一局收得快':''}。`,'derived','memory.events.turns'));
  // 第一次打、记忆里什么都没有时，也有一条真实的：这一局的交换比。
  // 但这句话局内那条已经说过就不再重复（话题 damage-trade 谁先说谁占）。
  const tradeFree=!usedTopics.has('damage-trade')&&sg.turns>=3;
  if(sentences.length<2&&tradeFree)sentences.push(SENT(`这一局你打出去${sg.dealt}点伤害，自己挨了${sg.taken}点。`,'derived','game.history'));
  // 结算的情绪必须落在这场结算的事实上，而且不能重复上面已经说过的那件事：
  // 这一局的交换比（打出去多少、挨了多少）是最适合承载「漂亮/可惜」的独立读数，
  // 它只有在上面没被用过时才拿来当情绪句——同一句话不说第二遍。
  const closers=[],tradeUsed=sentences.some(s=>/打出去\d+点伤害/.test(s.text));
  const trade=!tradeUsed&&sg.turns>=3&&sg.dealt>0?{dealt:sg.dealt,taken:sg.taken}:null;
  if(result==='win'){
   if(trade)closers.push(AFFECT('praise',trade.dealt>=trade.taken?`这一局你打出去${trade.dealt}点、只挨了${trade.taken}点，打得漂亮。`:`打出去${trade.dealt}点、挨了${trade.taken}点还是拿下了，这一局漂亮。`,'game.history'));
   else if(turn)closers.push(AFFECT('praise',`第${turn}回合收掉，这一下收得漂亮。`,'context.turn'));
   else if(streak>=2)closers.push(AFFECT('praise',`连着${streak}局拿下，这几下漂亮。`,'memory.events.result'));
  }else{
   if(trade)closers.push(AFFECT('pity',`这一局你打出去${trade.dealt}点、挨了${trade.taken}点，还是没翻过来，可惜。`,'game.history'));
   else if(turn)closers.push(AFFECT('pity',`撑到第${turn}回合还是没翻过来，可惜。`,'context.turn'));
   else if(l.count)closers.push(AFFECT('pity',`这第${l.count+1}局还是没拿下来，可惜。`,'memory.events.result + 本局'));
  }
  sentences.push(...closers);
  add({id:`result:${result}:${streak}`,topic:'result',extraTopics:tradeFree?[]:[],klass:'result',priority:90,tags:[],sentences,evidence:[
   `本机对战记录：已结束 ${l.count} 场，${l.wins}胜${l.losses}负；今天（同一自然日）已记录 ${l.todayCount} 局，${l.todayWins}胜${l.todayLosses}负，加上这一局是第 ${l.todayWins+1} 次拿下 / 第 ${l.todayLosses+1} 次失利（来源：memory.events）。`,
   l.trend?`最近三局的回合数为 ${l.trend.turns.join('、')}（来源：memory.events.turns）。`:'',
   `本局${turn?`第 ${turn} 回合`:''}${resultWord(result)}${turn&&l.lastMatch?.turns?`，上一局第 ${l.lastMatch.turns} 回合结束，相差 ${Math.abs(turn-l.lastMatch.turns)} 回合`:''}，${result==='loss'?`连败 ${streak} 局`:`连胜 ${streak} 局`}（来源：context）。`,
   `本局我方造成 ${sg.dealt} 点、承受 ${sg.taken} 点（来源：game.history）。`,
  ].filter(Boolean)});
 }
 // 每条关于这一局的观察都要挂在一条跨局记录上：那正是陪练不可替代的部分。
 // 局内读数（live / faint）自己没有记忆时，借一句优先级最高的跨局观察放在末尾；
 // 字数额度不够时它会被整句丢掉，但那时前面那句也是玩家自己算不出来的统计。
 // 借用的那句也必须是这一局还没说过的：本局已经提过「这套阵容」之后，
 // 后面的局内观察就不能再把那句话抄一遍——那正是「重复的信息不要重复出现」。
 const anchor=out.filter(r=>MEMORY_KLASSES.includes(r.klass)&&!usedIds.has(r.id)&&!(r.topic&&usedTopics.has(r.topic)))
  .sort((a,b)=>b.priority-a.priority)
  .map(r=>({reading:r,sentence:r.sentences.find(s=>s.kind==='memory')})).find(x=>x.sentence)||null;
 if(anchor)for(const r of out){
  if(!['live','faint','result'].includes(r.klass))continue;
  if(r.sentences.some(s=>s.kind==='memory'||s.text===anchor.sentence.text))continue;
  if(r.sentences.length>=3)continue;
  r.sentences=[...r.sentences,SENT(anchor.sentence.text,'memory',anchor.sentence.source)];
  r.borrowedTopic=anchor.reading.topic||null;
  r.borrowedExtra=anchor.reading.extraTopics||[];
 }
 return rankReadings(out,goal);
}
const MEMORY_KLASSES=['rematch','habit','type','stage','return','trend'];

// 句序：chat（接住玩家这句话）→ memory/derived（玩家不知道的事）→ affect（情绪落点）→ situation。
// 情绪句固定在信息之后、处境之前，并且只要它存在就只保留两条信息句——
// 这样 2–3 句的窗口里永远有它的位置，不会被别的句子挤出去。
const KIND_RANK={chat:0,memory:1,derived:1,affect:2,situation:3,presence:4};
function orderSentences(list=[]){
 const sorted=[...list].filter(s=>s&&s.text).sort((a,b)=>(KIND_RANK[a.kind]??9)-(KIND_RANK[b.kind]??9));
 const affects=sorted.filter(s=>s.kind==='affect');
 if(!affects.length)return sorted.slice(0,3);
 const info=sorted.filter(s=>s.kind==='memory'||s.kind==='derived');
 const chat=sorted.filter(s=>s.kind==='chat');
 const lead=chat.length?[chat[0],...info.slice(0,2)]:info.slice(0,2);
 return [...lead,affects[0]].slice(0,3);
}

function rankReadings(rows,goal){
 return rows.map(r=>({...r,score:r.priority+(goal&&r.tags.includes(goal)?12:0)}))
  .sort((a,b)=>b.score-a.score||b.priority-a.priority)
  .map(({score,...r})=>r);
}
function emptyLedger(){return {count:0,wins:0,losses:0,todayCount:0,todayWins:0,todayLosses:0,daysAgo:null,lastMatch:null,recentTurns:[],currentRoster:[],currentTeam:[],session:null,rematch:null,hazard:null,stage:null,stageFirst:null,flow:null,trend:null,potion:null};}
function emptySignals(){return {turns:0,dealt:0,taken:0,healedByEnemy:0,dealtSeries:[],takenBy:{},activeTurns:{},lastFallen:null,dry:null,fading:null,soak:null,trade:null,standoff:null,clutch:null};}

// 事件 → 观察类别。一个事件只挑它那一类里优先级最高的一条。
export const READING_CLASSES={
 return:['return'],rematch:['rematch'],stage:['stage'],type:['type'],
 habit:['habit'],trend:['trend'],clutch:['clutch'],live:['live'],'first-faint':['faint','live'],result:['result'],
 'streak-loss':['result'],'streak-win':['result'],
};
// 本局已经用掉的观察：ids 是观察编号，topics 是话题（同一件事一局只提一次——
// 「最先倒下的总是它」在减员那一刻说过，就不该在第 8 回合再说一遍）。
export function usedSet({ids=null,topics=null}={}){
 const asSet=v=>v instanceof Set?v:new Set(v||[]);
 if(ids instanceof Set||Array.isArray(ids)||topics)return {ids:asSet(ids),topics:asSet(topics)};
 return {ids:new Set(),topics:new Set()};
}
// 一条观察可能同时说掉几件事：topics 记的就是它一次用掉的全部话题。
export function readingTopics(r){return r?[r.topic,...(r.extraTopics||[]),r.borrowedTopic,...(r.borrowedExtra||[])].filter(Boolean):[];}
export function readingsFor(event,bundle={},used=null){
 const classes=READING_CLASSES[event]||[];
 if(!classes.length)return [];
 const {ids,topics}=usedSet(used||{});
 return companionReadings(bundle,{ids,topics}).filter(r=>classes.includes(r.klass)&&!ids.has(r.id)&&!readingTopics(r).some(t=>topics.has(t)));
}

// 档位字数上限内的取舍：整句丢弃，不截半句（截半句会造出无法核对的话）。
export function compose(parts=[],limit=80){
 let out='';
 for(const part of parts){if(!part?.text)continue;const next=out+part.text;if(next.length>limit)break;out=next;}
 return out||null;
}
// 必留句（收尾）先占预算，可选句只往中间塞得下的部分塞。
export function fitSentences(sentences=[],limit=80,tail=null){
 const budget=limit-(tail?.text.length||0),fitted=[];let text='';
 for(const s of sentences){if(!s?.text)continue;if(text.length+s.text.length>budget)break;text+=s.text;fitted.push(s);}
 if(tail)return {text:text+tail.text,parts:[...fitted,tail]};
 return text?{text,parts:fitted}:null;
}

// ── 自检：这条话到底有没有信息 ──────────────────────────────────────────────
// 复述屏幕的写法（「X连着2回合被草系按着打」「还剩2只」「血线反过来了」）。
export const SCREEN_ECHO=/还剩\s*[0-9一二三]\s*只|被[^，。；]{0,6}系(按着打|压着打|克着打)|血线(反过来|反超|追回来)|补位不占回合|下一回合由你决定|请选择(下一只|行动)/;
// 自我中心的情绪：第一人称 + **陪练自己的状态或举动**（急、慌、紧张、坐不住、跟着念…）。
// 这一条保持禁止，禁的是「谁在感受」而不是「有没有情绪」——「我看得有点急」
// 「我在旁边都跟着念出来了」把玩家变成来看 AI 着急的旁观者，正是这一版要修掉的原句。
// 反过来说，第一人称**见证**一个局面（「我看着都悬」）不被这条拦：「悬」是对局面的判断，
// 落点仍然在真实事件上。两种说法的差别就是下面这两张词表的差别。
export const SELF_STATE='开心|难过|伤心|生气|失望|高兴|兴奋|着急|急(?!着)|慌|愣|懵|心疼|紧张|不服|来气|坐不住|捏把汗|跟着念|数着';
export const SELF_CENTERED_EMOTION=new RegExp(`(我|咱)[^，。；！？]{0,6}(${SELF_STATE})`);
// 与情绪词无关的自我中心说法：把陪练自己放进画面（我在旁边、我盯着、我替你）。
export const SELF_FOCUS=/我(盯着|跟着|在旁边|替你|坐不住|捏把汗)/;
export const FILLER=/加油|别灰心|你已经很棒|再接再厉|下次一定|一定可以|你可以的|不要放弃|没关系的|放轻松|我一直都在|我陪着你|你不是一个人/;
export const COMPANION_KINDS=['memory','derived','situation','presence','affect','chat'];
// 有落点的情绪句要过三关：说出五种立场之一、不含第一人称感受、并且带一个能对回
// 同一条观察的锚点（数字，或同一句里出现过的名字）。第三关就是「情绪不能空降」。
export const GROUNDED_AFFECT=/\d|[一二三四五六七八九十]/;
export function checkCompanionStance(text,{parts=[],klass=null}={}){
 const affect=(parts||[]).find(p=>p&&p.kind==='affect')||null,reasons=[];
 if(!affect){if(STANCE_REQUIRED.includes(klass))reasons.push('no-grounded-affect');return {valid:reasons.length===0,reasons,stance:null};}
 const sentence=String(affect.text||'');
 if(!AFFECT_WORDS.test(sentence))reasons.push('stance-word-missing');
 if(SELF_CENTERED_EMOTION.test(sentence)||SELF_FOCUS.test(sentence))reasons.push('self-centered-affect');
 const others=(parts||[]).filter(p=>p&&p.kind!=='affect').map(p=>String(p.text||'')).join(' ');
 const anchored=GROUNDED_AFFECT.test(sentence)||sharedToken(sentence,others);
 if(!anchored)reasons.push('affect-without-anchor');
 return {valid:reasons.length===0,reasons,stance:sentence,anchored};
}
// 两个句子之间共享的「可核对 token」：数字，或 2 字以上的中文名字（宠物名、属性名）。
function sharedToken(a,b){
 const tokens=v=>[...String(v).matchAll(/\d+|[A-Za-z]{3,}|[\u4e00-\u9fa5]{2,4}/g)].map(m=>m[0]);
 const inB=new Set(tokens(b));
 return tokens(a).some(t=>inB.has(t));
}

// 逐条自检：句子级来源（parts）齐的时候，要求至少一句是跨局记录或跨回合统计，
// 至多一句是纯处境/陪坐、至多一句情绪、至多一句接话，且一条里不能只有一句。
export function checkCompanionInformation(text,{parts=[],requireStance=false,klass=null}={}){
 const t=String(text??'').trim(),reasons=[];
 if(!t)return {valid:false,reasons:['empty-text']};
 if(SCREEN_ECHO.test(t))reasons.push('restates-screen');
 if(SELF_CENTERED_EMOTION.test(t)||SELF_FOCUS.test(t))reasons.push('speaker-feeling');
 if(FILLER.test(t))reasons.push('empty-encouragement');
 if(parts.length){
  const kinds=parts.map(p=>p.kind);
  const informative=kinds.filter(k=>k==='memory'||k==='derived').length;
  const soft=kinds.filter(k=>k==='situation'||k==='presence').length;
  if(!informative)reasons.push('no-new-information');
  if(soft>1)reasons.push('too-much-filler');
  if(kinds.filter(k=>k==='affect').length>1)reasons.push('too-many-affects');
  if(kinds.filter(k=>k==='chat').length>1)reasons.push('too-many-chat');
  if(parts.length<2)reasons.push('too-short');
  if(parts.length>3)reasons.push('too-many-sentences');
  if(kinds.some(k=>!COMPANION_KINDS.includes(k)))reasons.push('unlabeled-sentence');
  if(requireStance){
   const stance=checkCompanionStance(t,{parts,klass});
   reasons.push(...stance.reasons);
  }
 }
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],counts:{memory:parts.filter(p=>p.kind==='memory').length,derived:parts.filter(p=>p.kind==='derived').length,affect:parts.filter(p=>p.kind==='affect').length}};
}

// ── 闲聊线程：玩家先开口时，陪练要接住话 ────────────────────────────────────
// 题目要求「能闲聊」，而上一版这里只有统计播报：玩家说一句家常话，陪练回一条战绩，
// 两轮下来各说各的。闲聊的判据不是「有没有用」，而是「有没有接住」：先说一句回应
// 玩家这句话本身（chat），再落一件自己真的记得的事（memory），有情绪就落在同一件事上。
// 连续两轮必须接得住，所以每条线程都写了两版：开场（opener）与续说（followup）。
// 认线程用两个来源——玩家上一轮说的话、陪练上一轮的回话（模型改写过也认得出玩家那句），
// 所以第二轮不会各说各的。
//
// ── 第三次修正：账本还是空的时候，闲聊通道也必须接得住（freshMemory）────────────
// 上面那两版都要求「落一件真的记得的事」（`if(!built.memory)return null`），而
// `decideRegister` 又在没有任何记录时提前返回 R0。两条加在一起，全新玩家（freshMemory）
// 说「你好」「今天有点累」「随便陪我聊两句」，拿到的是同一句「我在。」——面试官打开 Demo
// 看到的第一句话就是这三个字，CHAT_THREADS 在空账本下等于不存在。修法是给每条线程补一版
// 「空账本」接话，两条纪律同时成立：
//   1. 接住句子本身（问候回问候，说累接累，要人陪聊就应一声）。用词只来自玩家这一轮
//      自己说的话（名字也是他自己说的），所以一条记录都没有也不会编造过去；
//   2. 第二句说实话：`memory.events` 里一局都还没有。这是可核对的事实（空账本），
//      不是安慰，也不是编出来的「上次」。
// 有记录时行为不变：接完话落一件真的记得的事（跨局记录 / 本命 / 答对过的题）。
const PET_NAMES=SPECIES.map(s=>s.name).join('|');
// 战术问句是军师的活：这类句子不走闲聊线程，免得陪练抢答。
const TACTICAL_HINT=/怎么打|怎么用|怎么配|怎么选|建议|该不该|怎么办|咋办|该怎么|换上|换成|换掉|技能|能量|克制|属性|先手|防御|守住|培养|加点|阵容|战术|值得|哪个好/;
// 这一句家常话是哪一类：问候、说心情（累／烦）、要人陪聊、问陪练自己。这几张词表只决定
// 「先接住哪一句」，不新增任何关于过去的事实——空账本下接话里的每个字都出自玩家这一轮。
const GREETING_LINE=/^(你?好|您好|hi|hello|嗨|早|早安|晚安|在吗|在么|在不在)/i;
const TIRED_LINE=/累|疲惫|没精神|困/;
const UPSET_LINE=/烦|难受|心情|压力|撑不住|不想玩|不想打/;
const MOOD_LINE=new RegExp(`${TIRED_LINE.source}|${UPSET_LINE.source}`);
const CHAT_ASK_LINE=/陪我聊|随便聊|聊聊|说说话|唠|闲聊|说两句/;
// 空账本的第二句。它确实是「关于过去」的一句话，但说的是**没有记录**这件事本身，
// 所以它一个编造的过去都不含：memory.events 为空，正是「一局都还没记上」。
const EMPTY_LEDGER_OPEN='你打的局我这儿一局都还没记上，等你打完第一局我就能接上话。';
const EMPTY_LEDGER_MOOD='你打的局我这儿还没记上——先不聊对局，想说什么都行。';
const EMPTY_LEDGER_MORE='账本还是空的，今天这些话我记着；第一局打完就能聊具体的了。';
function emptyLedgerLine(continuing=false,mood=false){
 return continuing?EMPTY_LEDGER_MORE:(mood?EMPTY_LEDGER_MOOD:EMPTY_LEDGER_OPEN);
}
// 接住玩家这一句：问候回问候，说累接累，要人陪聊就应一声。
// 开场与续说两版出自同一个函数，所以第二轮的接话一定不是开场那句。
function selfLine(message,continuing){
 const t=String(message||'');
 if(continuing){
  if(TIRED_LINE.test(t))return '还累着啊——那就接着说。';
  if(UPSET_LINE.test(t))return '还烦着啊——那接着说。';
  if(CHAT_ASK_LINE.test(t))return '还聊我啊，那我接着说。';
  if(GREETING_LINE.test(t))return '还在，接着聊。';
  return '还聊我啊，那我再说一件。';
 }
 if(TIRED_LINE.test(t))return '今天累了就先缓着。';
 if(UPSET_LINE.test(t))return '烦就先搁着，不聊对局也行。';
 if(CHAT_ASK_LINE.test(t))return '行，聊两句。';
 if(GREETING_LINE.test(t))return '你好，我是小芽。';
 return '我在——小芽，一直跟着你的那只。';
}
// 玩家这一轮自己提到的伙伴名：空账本下唯一能说出口的名字，因为它出自玩家这句话。
function namedPet(message){const m=String(message||'').match(new RegExp(PET_NAMES));return m?m[0]:null;}
export const CHAT_THREADS=[
 {id:'self',
  match:new RegExp(`你是谁|你叫什么|你叫啥|小芽|陪练|在吗|你在吗|你在干嘛|你还?记得我吗|认识我吗|陪我聊|随便聊|聊聊|你好|您好|hi|hello|嗨|早|${MOOD_LINE.source}`,'i'),
  signature:/小芽|陪练/,
  opener:(f,{message=''}={})=>({chat:selfLine(message,false),memory:linesOf(f).length?`你打过的那${linesOf(f).length}局我都留着底。`:null}),
  followup:(f,{message=''}={})=>({chat:selfLine(message,true),memory:habitLine(f)})},
 {id:'away',
  match:/好久没|好久不见|很久没|最近忙|几天没|一段时间没|回来了|回坑|没怎么玩|没时间玩/,
  signature:/上次来|隔了\d+天|好久/,
  // 「你上次来是 N 天前」只有在真有那一天的记录时才是真话；空账本下只接住「我回来了」。
  opener:(f,{message=''}={})=>linesOf(f).length&&f.daysAgo!==null
   ?{chat:'你回来啦。',memory:`你上次来是${f.daysAgo}天前，那天打了${sessionCount(f)}局，${sessionWins(f)}胜${sessionLosses(f)}负。`}
   :{chat:'回来就好，先坐会儿。',memory:null},
  followup:(f,{message=''}={})=>linesOf(f).length&&f.daysAgo!==null
   ?{chat:'接着说你不在的这段——',memory:habitLine(f)||`你上次来是${f.daysAgo}天前，那天的记录我还留着。`}
   :{chat:'接着说你不在的这段，我听着。',memory:null}},
 {id:'pet',
  match:new RegExp(`本命|最喜欢|最爱|最常带|哪只|哪一只|你记得.{0,6}(队伍|伙伴|宠物)|${PET_NAMES}`),
  signature:new RegExp(PET_NAMES),
  opener:(f,{message=''}={})=>{
   const pet=knownPet(f);
   if(pet&&petFaints(f)>0)return {chat:`${pet}啊。`,memory:`你最近${linesOf(f).length}局的记录里，它倒下过${petFaints(f)}次。`};
   if(!linesOf(f).length){const said=namedPet(message);return {chat:said?`${said}啊。`:'想聊哪只都行。',memory:null};}
   return null;},
  followup:(f,{message=''}={})=>{
   const pet=knownPet(f),falls=petFirstFallen(f);
   if(pet&&falls)return {chat:`还说${pet}——`,memory:`最先倒下的有${falls.times}次是它，最近一次在第${falls.lastTurn}回合。`};
   if(pet&&petFaints(f)>0)return {chat:`还说${pet}——`,memory:`它在这${linesOf(f).length}局里一共倒下过${petFaints(f)}次。`};
   if(!linesOf(f).length){const said=namedPet(message)||pet;return {chat:said?`还说${said}——`:'还聊伙伴啊，那我接着说。',memory:null};}
   return null;}},
 {id:'record',
  match:/战绩|胜率|赢了几|输了几|几胜|几负|打了几局|多少局|账本/,
  signature:/这几局|今天第\d+次|^\d+胜|胜\d*负/,
  opener:(f,{message=''}={})=>linesOf(f).length
   ?{chat:'想问账本啊，我给你念真的。',memory:`最近${linesOf(f).length}局${winCount(f)}胜${lossCount(f)}负，${todayCount(f)>0?`其中${todayCount(f)}局是今天打的`:'今天的还没记上'}。`}
   :{chat:'账本啊——',memory:null},
  followup:(f,{message=''}={})=>linesOf(f).length
   ?{chat:'接着说这几局——',memory:longestTurns(f)?`回合数是${linesOf(f).slice(-3).map(e=>num(e.turns,1)||'?').join('、')}，${paceWords(f)}`:'这几局的回合数我都记着。'}
   :{chat:'接着说——',memory:null}},
];
function linesOf(f){return (f?.history||[]).filter(e=>e&&typeof e.result==='string');}
function winCount(f){return linesOf(f).filter(e=>e.result==='win').length;}
function lossCount(f){return linesOf(f).filter(e=>e.result==='loss').length;}
function todayCount(f){const key=dayKey(Date.now());return linesOf(f).filter(e=>dayKeyOf(e.time)===key).length;}
function lastDayRows(f){const last=linesOf(f).at(-1);return last?linesOf(f).filter(e=>dayKeyOf(e.time)===dayKeyOf(last.time)):[];}
function sessionCount(f){return lastDayRows(f).length;}
function sessionWins(f){return lastDayRows(f).filter(e=>e.result==='win').length;}
function sessionLosses(f){return lastDayRows(f).filter(e=>e.result==='loss').length;}
function longestTurns(f){return Math.max(0,...linesOf(f).map(e=>num(e.turns,1)||0))||null;}
function paceWords(f){
 const t=linesOf(f).slice(-3).map(e=>num(e.turns,1)).filter(Boolean);
 if(t.length<3)return '有几局打得比平时久。';
 const rising=t.every((v,i)=>i===0||v>=t[i-1]),falling=t.every((v,i)=>i===0||v<=t[i-1]);
 if(falling&&t.at(-1)<t[0])return '一局比一局收得快。';
 if(rising&&t.at(-1)>t[0])return '一局比一局拖得久。';
 return '最长的一局打得最久。';
}
// 「你带得最多的那只」：本命优先（玩家自己说过），否则数一数哪只最常在记录里倒下。
function knownPet(f){
 if(f?.favorite)return f.favorite;
 const tally={};
 for(const e of linesOf(f))for(const n of names(e.faints))tally[n]=(tally[n]||0)+1;
 const top=Object.entries(tally).sort((a,b)=>b[1]-a[1])[0];
 return top?top[0]:null;
}
function petAppearances(f){const pet=knownPet(f);return pet?linesOf(f).filter(e=>names(e.faints).includes(pet)).length:0;}
function petFaints(f){return petAppearances(f);}
// 它「最先倒下」过几次、最近一次在第几回合——续说那一轮换一件事讲，不重复开场那句。
function petFirstFallen(f){
 const pet=knownPet(f);
 if(!pet)return null;
 const rows=linesOf(f).filter(e=>name(e.firstFallen)===pet);
 if(!rows.length)return null;
 const turns=rows.map(e=>num(e.firstLossTurn,1)).filter(Boolean);
 return {times:rows.length,lastTurn:turns.at(-1)||null};
}
// 「记得你」的最小版本：最先倒下的总是同一只。只有跨局数得出来，也是复现旧习惯那句话。
function habitLine(f){
 const tally={};
 for(const e of linesOf(f)){const n=name(e.firstFallen);if(n)tally[n]=(tally[n]||0)+1;}
 const top=Object.entries(tally).sort((a,b)=>b[1]-a[1])[0];
 if(!top||top[1]<2)return null;
 const turns=linesOf(f).filter(e=>name(e.firstFallen)===top[0]).map(e=>num(e.firstLossTurn,1)).filter(Boolean);
 return turns.length>=2?`最先倒下的${top[0]}已经${top[1]}次了，最近一次在第${turns.at(-1)}回合——这个习惯我还记着。`:`最先倒下的${top[0]}已经${top[1]}次了，这个我还记着。`;
}
export function chatThread(text=''){const t=String(text||'');return CHAT_THREADS.find(thread=>thread.match.test(t))||null;}
// 上一轮聊的是哪个话题：先看玩家自己那句话，再看陪练的回话。
export function previousChatThread(memory={}){
 const dialogue=(memory.dialogue||[]).filter(x=>x&&typeof x.content==='string');
 const lastUser=[...dialogue].reverse().find(x=>x.role==='user');
 const own=lastUser?chatThread(lastUser.content):null;
 if(own)return own;
 const lastAssistant=[...dialogue].reverse().find(x=>x.role==='assistant');
 return lastAssistant?CHAT_THREADS.find(t=>t.signature.test(lastAssistant.content))||null:null;
}
// 闲聊回复：接住这句话 + 一件自己记得的事 +（有的话）落在同一件事上的情绪。
// 返回 null 表示「这句不是闲聊」或「没有可核对的经历」，交给原来的观察通道。
export function chatReply({message='',memory={},facts=null,intent='other',limit=REGISTERS.R1.limit,now=Date.now()}={}){
 const f=facts||companionFacts(memory,{},now);
 const text=String(message||'');
 if(TACTICAL_HINT.test(text))return null;
 const hasRecord=linesOf(f).length>0;
 // 有记录时的「说心情」（烦、难受）仍然走原来的关切通道：那时真的有事可以关切，
 // 闲聊不该把它换成一句家常。一条记录都没有时没有可关切的事，接住这句话本身就是回应。
 if(hasRecord&&MOOD_LINE.test(text)&&intent!=='chat')return null;
 const own=chatThread(text);
 const prev=previousChatThread(memory);
 // 上一轮已经开了一个话题时，这一轮哪怕是个问句也先接着那个话题说——
 // 「各说各的」正是这样断掉的。真正的战术问句由 TACTICAL_HINT 挡在上面。
 if(!own&&!prev&&intent!=='chat'&&intent!=='other')return null;
 const thread=own||prev;
 if(!thread)return null;
 const continuing=Boolean(prev&&(!own||own.id===prev.id));
 const opts={message:text,continuing};
 // 续说版本拼不出来（例如那天没有习惯记录）就退回开场版本，宁可少一句也不空着。
 const built=(continuing?thread.followup(f,opts):thread.opener(f,opts))||thread.opener(f,opts);
 if(!built)return null;
 // 第二句：先落一件真的记得的事（跨局记录 / 本命 / 答对过的题）。
 // 一条记录都没有时，说实话——账本还是空的，第一局打完才有得聊。这句话也是可核对的
 // 事实（memory.events 为空），不是安慰，更不是编出来的「上次」。
 const second=built.memory
  ?{text:built.memory,source:'memory.events'}
  :hasRecord?null
  :f.knowsFavorite?{text:`你说过本命是${f.favorite}，这个我记着。`,source:'memory.favorite'}
  :f.lessons.length?{text:`你答对过的${list(f.lessons)}，我这儿记着。`,source:'memory.lessons'}
  :{text:emptyLedgerLine(continuing,MOOD_LINE.test(text)),source:'memory.events（空账本）'};
 if(!second)return null;
 const affects=[],last=linesOf(f).at(-1);
 if(thread.id==='record'&&last){
  if(last.result==='win')affects.push(AFFECT('praise','最近这一局是拿下的，收得漂亮。','memory.events.result'));
  else if(last.result==='loss')affects.push(AFFECT('pity','最近这一局没拿下来，可惜。','memory.events.result'));
 }
 const sentences=[SENT(built.chat,'chat','本轮消息'),SENT(second.text,'memory',second.source),...affects];
 const fit=fitSentences(sentences,limit);
 if(!fit)return null;
 return {text:fit.text,parts:fit.parts,thread:thread.id,continued:continuing,emptyLedger:!hasRecord,evidence:[
  `闲聊线程「${thread.id}」：你这一轮说的是「${text.slice(0,24)}」，${continuing?'接着上一轮同一个话题往下说':'开了一个新话题'}（来源：本轮消息 + memory.dialogue 的上一轮）。`,
  hasRecord?`跨局记录：已结束 ${linesOf(f).length} 场，${winCount(f)}胜${lossCount(f)}负（来源：memory.events）。`
   :'跨局记录：memory.events 里一局都还没有（空账本）。这一轮只能说实话「还没记上」，不许提任何过去，也不许编一局出来。',
  hasRecord&&f.daysAgo!==null?`最近一次记录在 ${f.daysAgo} 天前（来源：memory.events.time）。`:'',
  hasRecord&&knownPet(f)?`记录里最常出现的是 ${knownPet(f)}，它出现过 ${petAppearances(f)} 次、倒下过 ${petFaints(f)} 次（来源：memory.events.faints）。`:'',
  hasRecord?`回合数记录：${linesOf(f).map(e=>num(e.turns,1)||'?').join('、')}（来源：memory.events.turns）。`:'',
 ].filter(Boolean)};
}

// ── 被动通道：玩家先开口 ────────────────────────────────────────────────────
// 陪练只按**玩家自己那句话**判断意图与线程。模型路径上 coach/client.js 会把
// RESPONSE_INSTRUCTIONS 拼在 message 后面一起送进来，那段的开头就是「回答要求：」，
// 里面有「技能」「能量」「防御」「复盘」这些词——照着整条 message 判断，
// 一句「你好」会被 TACTICAL_HINT 当成战术提问，接话通道直接让开，又只剩「我在。」。
// memory.js 读存档里的对话切的是同一个标记（readMemory 的 split('\n回答要求：')），
// 这里对齐同一把尺子：附加说明是给模型的，不是玩家说的话。
export const ANSWER_REQUIREMENTS='\n回答要求：';
export function playerWords(message){return String(message??'').split(ANSWER_REQUIREMENTS)[0];}
// R0 在这里是最短承接句（聊天通道不能真的空消息，runCoach 会拒绝空文本）；
// 真正的「不发消息」只存在于主动通道（coach.js 返回 null）。
export function companion(context={},memory={},message=''){
 const now=Date.now(),words=playerWords(message),intent=intentOf(words);
 const state=companionState(memory,context,{playerInitiated:true,intent,message:words},now);
 const f=state.facts;
 const cross=companionLedger(memory,liveGame(context),now);
 const bundle={cross,signals:emptySignals(),context:{goal:f.goal,turn:f.live?.turn||null},now};
 const readings=companionReadings(bundle);
 const pick=classes=>readings.find(r=>classes.includes(r.klass))||null;
 const CLASSES=['rematch','return','habit','type','stage','trend','live','last'];
 const limit=REGISTERS[state.register]?.limit||REGISTERS.R1.limit;
 // followupReply 是「接住追问」的修复句，不是一条新观察，所以不参加信息量自检。
 let register=state.register,text=null,reading=null,parts=[],observed=true,chat=null;
 if(register==='R0')text='我在。';
 else if(register==='R1'||register==='R2'){
  // 玩家主动搭话（寒暄、家常、问陪练自己）先走闲聊线程：接住这句话，再落一件记得的事。
  // 战术问句与倾诉不走这里——前者是军师的活，后者由 R2/R3 的关切句接。
  chat=chatReply({message:words,memory,facts:f,intent,limit,now});
  if(chat){text=chat.text;parts=chat.parts;}
  else if(register==='R1'){
   reading=pick(CLASSES);
   if(reading){const fit=fitSentences(reading.sentences,limit);text=fit?.text||null;parts=fit?.parts||[];}
  }
 }
 if(!text&&register==='R3'){
  const lead=state.lossStreak>=2?SENT(`连着${state.lossStreak}局没赢。`,'memory','memory.events.result'):null;
  const r=pick(CLASSES);
  const body=[lead,...(r?r.sentences:[])].filter(Boolean).slice(0,2);
  const fit=body.length?fitSentences(body,limit,SENT('到这儿也行，想继续我就在。','presence',null)):null;
  if(fit){text=fit.text;parts=fit.parts;reading=r;}
 }else if(!text&&intent==='followup'){text=followupReply(memory).text;observed=false;}
 else if(!text&&register==='R2'){
  // R2 是玩家真的问了一句话：给两条观察（各带自己的来源），而不是把 R1 那句重说一遍。
  reading=pick(CLASSES);
  const second=reading?readings.find(r=>r!==reading&&CLASSES.includes(r.klass)):null;
  const body=reading?[...(f.preference==='brief'?reading.sentences.slice(0,1):reading.sentences.slice(0,2)),...(second?[second.sentences[0]]:[])].slice(0,3):[];
  const offer=f.live&&!f.live.over&&body.length<2?SENT('这一局想聊哪一步，说一声就行。','presence','context.battle'):null;
  const fit=body.length?fitSentences(body,limit,offer):null;
  if(fit){text=fit.text;parts=fit.parts;}
 }
 // 说出来的每一句都要过自检：没有新信息、或者又变成复述屏幕，就当这条不存在。
 if(observed&&text&&text!=='我在。'&&!checkCompanionInformation(text,{parts}).valid){text=null;reading=null;parts=[];chat=null;}
 // 该档位需要的事实一条都拼不出来时，降到 R0 只说承接句：档位要么真的用上，要么明说降到最低。
 if(!text){register='R0';text='我在。';state.register='R0';state.registerReason='该档位需要的事实在本机记录里一条都找不到，降到最短承接句';reading=null;parts=[];chat=null;}
 return publicPacket({text,register,state,intent,reading,chat});
}

// 被动通道手里只有 buildContext 的快照（history 被裁空），把它当成一个「没有回合记录的对局」读。
function liveGame(context={}){
 const b=context.battle;
 if(!b||!Array.isArray(b.player?.pets))return null;
 return {stageName:context.stageName||null,turn:b.turn,result:b.result||null,player:b.player,enemy:b.enemy,history:[]};
}

function followupReply(memory){
 const last=(memory.dialogue||[]).filter(x=>x?.role==='assistant'&&typeof x.content==='string').at(-1)?.content;
 if(!last)return {text:'这句我还没接准。你说的是哪一处？',source:'memory.dialogue'};
 const quote=last.replace(/[？?]+/g,'，').replace(/[。；，、\s]+$/,'').slice(0,36).replace(/[。；，、\s]+$/,'');
 return {text:`你是在接着刚才那句问：${quote}。可以指出哪一点不对，我接着核对。`,source:'memory.dialogue'};
}

// 每个数字都出现在依据里：这样模型改写后的答案也能通过 checkGroundedAnswer 的数字核对，
// 不会因为「引用了陪练模板里的真实数字」被误判成编造。
function publicPacket({text,register,state,intent,reading=null,chat=null}){
 const f=state.facts,history=f.history;
 const wins=history.filter(e=>e.result==='win').length,losses=history.filter(e=>e.result==='loss').length,draws=history.filter(e=>e.result==='draw').length;
 const evidence=[`本机对战记录：已结束${history.length}场，${wins}胜${losses}负${draws?draws+'平':''}（来源：memory.events，最多保留12场，预制场景不写入）。`];
 if(f.last){
  const bits=[f.stage,f.turns?`${f.turns}回合`:null,resultWord(f.result),f.faints.length?`${f.faints.join('、')}倒下`:null,
   f.firstLossTurn&&f.firstFallen?`首个减员在第${f.firstLossTurn}回合（${f.firstFallen}）`:null,
   f.survivors!==null?`结束时还有${f.survivors}只站着`:null,
   f.enemy.length?`对手${f.enemy.join('、')}`:null,f.potion!==null?`结束剩回复药${f.potion}瓶`:null].filter(Boolean);
  evidence.push(`最近一局：${bits.join('、')}（来源：${f.source}，规则${f.last.rulesVersion||'未知'}）。`);
 }
 // 跨局记录里的每一类数字都进依据：闲聊与观察引用的是同一份账，模型改写时也核得动。
 if(f.daysAgo!==null)evidence.push(`最近一次记录在${f.daysAgo}天前（来源：memory.events.time）。`);
 const turns=(history.map(e=>Number.isInteger(e.turns)?e.turns:null).filter(Boolean));
 if(turns.length)evidence.push(`各局回合数：${turns.join('、')}（来源：memory.events.turns）。`);
 const firstFallens=history.map(e=>e.firstFallen).filter(Boolean);
 if(firstFallens.length)evidence.push(`各局首个减员：${firstFallens.join('、')}（来源：memory.events.firstFallen）。`);
 const fallenNames=[...new Set(history.flatMap(e=>Array.isArray(e.faints)?e.faints:[]))];
 if(fallenNames.length)evidence.push(`记录里倒下过的伙伴：${fallenNames.join('、')}（${fallenNames.length}只，来源：memory.events.faints）。`);
 // 这一条用了哪段跨局记录：模型看到的依据与模板说的是同一件事。
 if(reading?.evidence?.length)evidence.push(...reading.evidence);
 if(chat?.evidence?.length)evidence.push(...chat.evidence);
 evidence.push(`语气档位 ${register}（${REGISTERS[register].name}）：${state.registerReason}。`);
 evidence.push(`档位依据：${state.reasons.slice(0,-1).join('；')}。`);
 const settings=[`交流偏好${f.preference||'未设置'}`,`玩法目标${f.goal||'未设置'}`,`本命${f.favorite||'未设置'}`].join('、');
 evidence.push(`你的设置：${settings}（来源：你明确表达过才会记录）。`);
 if(f.lessons.length)evidence.push(`课程记录：${f.lessons.join('、')}（${f.lessons.length}条答对过的练习，不等于熟练掌握）。`);
 return {text,evidence,register,companionState:{register,engagement:state.engagement,consideration:state.consideration,momentum:state.momentum,lossStreak:state.lossStreak,winStreak:state.winStreak,reasons:state.reasons},replyConstraints:replyConstraints(register,'companion',{emptyLedger:!history.length&&!f.lessons.length,continuing:Boolean(chat?.continued),chat:Boolean(chat)}),intent,chatThread:chat?.thread||null,chatContinued:Boolean(chat?.continued),silent:register==='R0'};
}

// 模型路径下的档位约束：随证据包一起送到服务端（server.js 把整个证据包作为 game_evidence 发给模型）。
// forbid 里的每一条与 checkCompanionRestraint / checkCompanionInformation 的硬线一一对应：
// 复述屏幕、播报自己的情绪、空泛安慰、评价水平、说教、战术指挥，一条都不留。
// allow 里写清这一轮**该有**的东西：情绪不是被禁止的，被禁止的是把情绪落在自己身上。
export function replyConstraints(register,voice='companion',{emptyLedger=false,continuing=false,chat=false}={}){
 const r=REGISTERS[register];
 // 空账本时送模型的那句话要换掉：原来写的是「至少一句要来自跨局记录（memory.events）」，
 // 而 memory.events 是空的——照这句写，模型只能编一局出来。这时宁可明说：不许提过去。
 const grounding=emptyLedger
  ?'本机还没有任何对战记录（memory.events 为空）：不许提过去，也不许编一局出来——只接住玩家这句话本身，并说明记录还是空的。'
  :'至少一句要来自跨局记录（memory.events）或跨回合统计（game.history），否则不如不说；';
 // 第二轮是在接着上一轮说：这一点也要写给模型。实测里只给「上一轮说过什么」不够，
 // 模型会把第二轮当成一个新问题答，读起来就是「各说各的」。
 const threading=continuing?'这一轮是接着上一轮同一个话题说：正文里要让人听得出是接着说的（「还聊」「接着说」这类词），不要另起一件不相干的事。':'';
 // 闲聊通道的一轮：模型的毛病是把「没有记录」讲成「等你打完再来」——那是把人挡回去。
 // 空账本时唯一该做的是接住这句话，所以这一条要和「不许提过去」分开写清楚。
 const smallTalk=chat?'这一轮是玩家主动搭话：先用一句话回他这句话本身（问候就回问候，说累就接住累，想聊天就应一声），再落事实；不要用「等你打完一回合再来」这类把人挡回去的说法。':'';
 return {register,voice,maxChars:r.limit,maxQuestions:r.maxQuestions,allowAdvice:r.advice,
  forbid:['复述屏幕上已经写着的事','播报自己的情绪（「我看得有点急」这类第一人称感受）','空泛安慰','评价玩家水平','说教',r.advice?'':'给建议','战术指挥',emptyLedger?'提任何过去的事（「上次」「之前」「上回」这类说法）':''].filter(Boolean),
  allow:['对真实事件的可惜/漂亮/悬/憋屈/松口气（必须落在具体回合、数字或记录上）','跨局记录与偏好（玩家以前说过、打过的事）'],
  instruction:`本轮档位 ${register}（${r.name}）：正文不超过${r.limit}字，${r.maxQuestions?'最多一个问句':'不要问句'}，只写有本机记录支撑的事实。${grounding}${threading}${smallTalk}不要复述屏幕上已经写着的事（谁被克制、还剩几只、第几回合的进度），也不要说自己的感受——情绪要落在这一局真实发生的事上（可惜、漂亮、悬、憋屈、松口气），不是落在你自己身上。`};
}

// 两条声线。自我中心的情绪在任何声线下都拦——「我看得有点急」正是这一版要修掉的方向：
// 共情是理解对方的处境，不是播报自己的情绪。
export const VOICES={companion:'陪练',sober:'克制'};

// 说教：把一次选择说成「你以后要怎样」。
const PREACH=/你应该|你必须|你最好|下一次?别|以后别|要记住|下次记得|不该|别再|得改|认真点|长点记性/;
// 战术指令：告诉玩家这一手该出什么。这是军师的活——陪练只评论，不指挥。
const TACTICAL_OVERREACH=/建议(你)?(换|用|改|选|出)|不如(换|用|选)|最好(换|用|选|是)|换(掉|上|成)|改用|别用|不要用|先(出|放|上)[^。，]{0,4}(技能|招)|集火|先打|留着(技能|药)|把(药|回复药)(吃|用)了/;

// 克制扫描（docs/COMPANION-DESIGN.md §3.5 的五条，落地为可失败、可回退的检查）。
// 复述屏幕 / 自我中心的情绪 / 空泛安慰 / 水平羞辱 / 说教 / 战术越界 / 没有记录支撑的过去，任何声线下都拦。
// 注意第三条：拦的是「情绪落在陪练自己身上」，不是情绪本身——落在事件上的
// 可惜/漂亮/悬/憋屈/松口气必须放行，否则「有情绪」这一项又被这条扫描做成 0。
export function checkCompanionRestraint(text,{register='R2',facts={},previousAssistant='',voice='companion'}={}){
 const t=String(text??''),reasons=[],registerInfo=REGISTERS[register]||REGISTERS.R2;
 if(!t.trim())return {valid:false,reasons:['empty-text'],register,limit:registerInfo.limit,voice};
 if(t.length>registerInfo.limit)reasons.push(`over-limit:${t.length}>${registerInfo.limit}`);
 const questions=(t.match(/[？?]/g)||[]).length;
 if(questions>registerInfo.maxQuestions)reasons.push(`too-many-questions:${questions}>${registerInfo.maxQuestions}`);
 if(SELF_CENTERED_EMOTION.test(t)||SELF_FOCUS.test(t))reasons.push('speaker-feeling');
 if(SCREEN_ECHO.test(t))reasons.push('restates-screen');
 if(FILLER.test(t))reasons.push('empty-encouragement');
 if(/菜|太弱|你错了|你不行|水平不够|速度意识差|手残|瞎打|乱打|不会玩|没天赋|水平差/.test(t))reasons.push('skill-insult');
 if(PREACH.test(t))reasons.push('preach');
 if(TACTICAL_OVERREACH.test(t))reasons.push('tactical-overreach');
 if(/(记得|上次|之前|上回|我们已经|上一场|那一局|连着|最近)/.test(t)&&!facts.allowPast)reasons.push('unsupported-past-claim');
 if(/速度判断/.test(t)&&!(facts.lessons||[]).includes('速度判断'))reasons.push('lesson-not-recorded');
 if(register!=='R3'&&register!=='R0'&&/[？?]\s*$/.test(t.trim())&&/[？?]\s*$/.test(String(previousAssistant||'').trim()))reasons.push('consecutive-questions');
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],register,limit:registerInfo.limit,voice};
}

// ═══════════════════════════════════════════════════════════════════════════
// 在场层（presence）：陪练在对局中间说话的依据、预算、出现方式与时长。
//
// 触发只决定「现在轮到哪一类观察」，说不说得出来由观察本身决定：
// 那一类没有真实素材，proactiveReading 返回 null，这一回合就不说话。宁可少说，不说废话。
// ═══════════════════════════════════════════════════════════════════════════

// 陪练自己的预算。它与军师（coach/experience.js 的 STRATEGIST_LIMITS + strategistSession）
// **完全分开**：军师把额度用光不会让陪练闭嘴，陪练说满也不会动军师一次。
// cooldownTurns=3：话变长了，两次开口之间至少隔 3 个回合，不然左下角会连成一片。
export const COMPANION_LIMITS={maxPerMatch:4,cooldownTurns:3,reducedAfterDismissals:2,quietAfterDismissals:4};
export const COMPANION_EVENTS=['result','streak-loss','streak-win','first-faint','return','rematch','stage','type','habit','trend','clutch','live'];

// 一局内的陪练记账。与 coach/memory.js 的 adaptiveGate 读同一份 dismiss 记录、同一个 7 天窗口，
// 但**不共用**军师的 session：近 7 天被主动关掉 2 次降到每局 1 次，4 次降到 0 次。
// 这条推断永远排在安静档、点掉即静音之后（见 coach.js 的 coachEvent 判定顺序）。
export function companionSession(memory=null,{now=Date.now()}={}){
 const dismissals=(memory?.journal||[]).filter(e=>e?.kind==='dismiss'&&Number.isFinite(Date.parse(e.time||''))&&now-Date.parse(e.time)<7*DAY).length;
 const limit=dismissals>=COMPANION_LIMITS.quietAfterDismissals?0:dismissals>=COMPANION_LIMITS.reducedAfterDismissals?1:COMPANION_LIMITS.maxPerMatch;
 // readings 是本局已经用掉的那几条观察：一个事实一局只说一次，换一件事才接着说。
 return {count:0,lastTurn:null,dismissed:false,said:new Set(),readings:new Set(),topics:new Set(),limit,
  reason:`近7天主动关闭${dismissals}次 → 本局上限${limit}次（来源：memory.journal 的 dismiss，与 adaptiveGate 同一个 7 天窗口）`};
}

// 陪练的样子：头像用已有的宠物形象（engine.js 的 SPECIES.icon），不新增美术资源。
// 芽角鹿是名字里带「芽」的那只，正好当小芽的门面。
export const COMPANION_AVATAR={species:'deer',name:'小芽',role:'陪练'};
export function companionAvatar(){
 const s=SPECIES.find(x=>x.id===COMPANION_AVATAR.species)||SPECIES[0];
 return {icon:s.icon,name:`${COMPANION_AVATAR.name} · ${COMPANION_AVATAR.role}`,species:s.id,speciesName:s.name};
}

// 气泡停留时长 = 15 秒 + 每 10 个字加 3 秒。军师那条在顶部、要短（玩家正在做决策，它挡视线）；
// 陪练在左下角、远离操作区，留久一点不挡事——两条的时长约束不共用同一套逻辑。
export const COMPANION_BUBBLE={baseMs:15000,perTenCharsMs:3000,maxMs:60000,position:'bottom-left'};
export function bubbleDurationMs(text){
 const chars=String(text??'').replace(/\s+/g,'').length;
 return Math.min(COMPANION_BUBBLE.maxMs,COMPANION_BUBBLE.baseMs+Math.floor(chars/10)*COMPANION_BUBBLE.perTenCharsMs);
}

// 陪练与军师不同时出现。军师条（#live-coach）在场时陪练排队，条消失后再补上。
// 两条边界：排队超过 maxWaitMs 就丢掉（补一句已经过期的话不如不说）；
// 刚显示过就至少占满 minVisibleMs 再让下一次显示——否则会被军师条切成一闪一闪，
// 闪一下比不说更烦，而且那半秒谁也读不完。
export const COMPANION_DEFER={maxWaitMs:20000,minVisibleMs:5000};
export function companionCueSlot({barVisible=false,queuedAt=0,now=0,holdUntil=0}={}){
 if(queuedAt&&now-queuedAt>COMPANION_DEFER.maxWaitMs)return {action:'drop',reason:`排队超过 ${COMPANION_DEFER.maxWaitMs}ms，这条已经不新鲜了`};
 if(barVisible)return {action:'hold',reason:'军师条在场：陪练让位，等它收起来再说'};
 if(now<holdUntil)return {action:'hold',reason:`刚显示过，${COMPANION_DEFER.minVisibleMs}ms 内不再重开，免得一闪一闪`};
 return {action:queuedAt?'show':'idle',reason:'军师条不在场'};
}

// 陪练何时开口（纯函数，可脱开 DOM 单测）。一次只返回一个事件：同一回合最多说一句。
// 顺序就是优先级：先看结算，再看真实减员，然后按「跨局记忆 → 局内读数」走。
// 每个候选事件都先问一遍「这一类现在真的有话可说吗」（readingsFor），
// 没素材的事件根本不会被提出来，所以不会占着窗口说一句废话。
export function companionEvents(game,{said=[],session=null,winStreak=0,lossStreak=0,cross=null,signals=null,now=Date.now()}={}){
 const seen=said instanceof Set?said:new Set(Array.isArray(said)?said:[]);
 const sg=signals||companionSignals(game);
 const turn=Number.isInteger(game?.turn)?game.turn:0;
 // 没传账本时至少从这一局本身算一份：这样「这张地图是第一次来」这类不依赖记忆的
 // 跨局口径在结算时也成立（它靠的是「记录里没有这张图」，不是「记录里有」）。
 const ledger=cross||companionLedger({},game,now);
 const bundle={cross:ledger,signals:sg,context:{turn,result:game?.result||null,winStreak,lossStreak,goal:null,faint:faintFact(sg)},now};
 // 「现在有没有话说」要和真正开口时的筛选用同一套账（已用掉的观察、已经提过的话题）
 // 与同一把尺（fitReading：字数 + 信息量 + 克制扫描）。否则会出现「每回合都提议 live，
 // 但 live 一次都发不出来」——那等于白占窗口，浏览器实测里真的发生过。
 const used=session?{ids:session.readings,topics:session.topics}:null;
 const sayable=event=>{
  if(seen.has(event))return false;
  const register=eventRegister(event,{lossStreak});
  return readingsFor(event,bundle,used).some(r=>fitReading(r,register));
 };
 // 整局结束：先看跨局里程碑，其次才是普通结算。结算也要过同一把尺——
 // 这一局所有能说的都被说过时，收尾那句宁可不说，也不重说一遍。
 if(game?.result){
  const closing=game.result==='win'&&winStreak>=2?'streak-win':game.result==='loss'&&lossStreak>=3?'streak-loss':'result';
  return sayable(closing)?[closing]:[];
 }
 // 开局两句之内先说「跨局」那一类（这套阵容打过几次、隔了几天、上一局最先倒的是谁）：
 // 玩家刚坐下来的时候最需要的是「它记得我」，不是复述这一回合发生了什么。
 if(turn<=2&&sayable('return'))return ['return'];
 if(sayable('rematch'))return ['rematch'];
 // 真实减员：这一句优先于剩下的所有观察（它是这一局里最重的一件事）。
 if(sg.lastFallen&&sayable('first-faint'))return ['first-faint'];
 // clutch 单列一类：它是「贴着血皮撑过来」这一件事，与 live 的其它读数不共用同一张票，
 // 否则一局里先说过一次 live，这一局就再也说不出「悬／松口气」了。
 for(const event of ['habit','type','stage','trend','clutch','live'])if(sayable(event))return [event];
 return [];
}

// 首次减员的真实事实：最后倒下的那一只（从回合记录里读，不看队伍顺序），
// 以及它这一局一个人扛了多少、在场上待了几个回合。
function faintFact(sg,petHint=null){
 const pet=sg?.lastFallen?.pet||petHint||null;
 if(!pet)return null;
 const taken=(sg?.takenBy||{})[pet]||0;
 const vals=Object.values(sg?.takenBy||{});
 return {pet,taken,most:taken>0&&taken===Math.max(0,...vals),total:sg?.taken||0,turns:(sg?.activeTurns||{})[pet]||0};
}

// 事件 → 档位。结算沿用原有档位（连败进收尾陪坐 R3）；在场的话一律 R4（2–3 句）。
export function eventRegister(event,{lossStreak=0}={}){
 if(event==='result'||event==='streak-win')return proactiveRegister({lossStreak:event==='streak-win'?0:lossStreak});
 if(event==='streak-loss')return 'R3';
 return 'R4';
}

// ── 主动侧文案（coach.js 调用）────────────────────────────────────────────────
// 只读 context.signals（game.history 的派生读数）与 context.cross（跨局账本）。
// 挑出该事件对应类别里优先级最高的一条观察，按档位字数上限取整句；一句都拼不出来就返回 null。
// 一条观察能不能真的说出口：字数装得下、过信息量自检、过克制扫描。三关都过才有话。
// 结算与减员这两类还要过第四关：必须带一句有落点的情绪（STANCE_REQUIRED）。
// 去掉情绪就会直接说不出话——这就是「把有情绪做回 0」的负向验证所依赖的那条线。
export function fitReading(reading,register='R4'){
 if(!reading)return null;
 const limit=REGISTERS[register]?.limit||REGISTERS.R4.limit;
 const tail=register==='R3'?SENT('到这儿也行，想继续我就在。','presence',null):null;
 const fit=fitWithStance(orderSentences(reading.sentences),limit,tail);
 if(!fit)return null;
 const requireStance=STANCE_REQUIRED.includes(reading.klass);
 const check=checkCompanionInformation(fit.text,{parts:fit.parts,requireStance,klass:reading.klass});
 const restraint=checkCompanionRestraint(fit.text,{register,facts:{allowPast:true,lessons:[]}});
 if(!check.valid||!restraint.valid)return null;
 return {...fit,register,stance:fit.parts.find(p=>p.kind==='affect')?.text||null};
}
// 字数取舍：情绪句先占位，再往剩下的额度里塞信息句。
// 反过来（先塞信息句、装不下就丢掉情绪句）会让「结算与减员必须有情绪」变成
// 一条靠不住的规则——句子一长，那两类就悄悄退回到统计播报。
function fitWithStance(sentences=[],limit=80,tail=null){
 const affect=sentences.find(s=>s?.kind==='affect')||null;
 // 一条话最多 3 句（收尾那句 presence 也算在内），所以带收尾时正文只留 2 句。
 const headCap=Math.max(1,(tail?2:3)-(affect?1:0));
 const head=[];
 let text='';
 const budget=limit-(tail?.text.length||0)-(affect?affect.text.length:0);
 for(const s of sentences){
  if(!s?.text||s===affect)continue;
  if(head.length>=headCap)break;
  if(text.length+s.text.length>budget)break;
  text+=s.text;head.push(s);
 }
 const parts=[...head,...(affect?[affect]:[]),...(tail?[tail]:[])];
 if(!parts.length)return null;
 return {text:parts.map(p=>p.text).join(''),parts};
}
export function proactiveReading(event,context={},register='R4',{used=null,now=Date.now()}={}){
 const signals=context.signals||emptySignals();
 const cross=context.cross||context.ledger||emptyLedger();
 const goal=context.goal||null;
 const fallback=event==='streak-loss'?'loss':event==='streak-win'?'win':null;
 const faint=context.faint||faintFact(signals,context.fallen?.length?context.fallen.at(-1):null);
 const bundle={cross,signals,context:{turn:context.turn||signals.turns||null,result:context.result||fallback,
  winStreak:context.winStreak||0,lossStreak:context.lossStreak||0,items:context.items||null,goal,faint},now};
 const reading=readingsFor(event,bundle,used)[0];
 const fit=fitReading(reading,register);
 if(!fit)return null;
 // 这一句消耗掉的话题：自己的，加上借用那句话所属的。
 const topics=readingTopics(reading);
 return {text:fit.text,readingId:reading.id,topics,parts:fit.parts,evidence:reading.evidence,register};
}
export function proactiveText(event,context={},register='R4',options={}){
 const reading=proactiveReading(event,context,register,options);
 return reading?reading.text:null;
}

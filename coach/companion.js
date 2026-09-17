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
  if(intent==='chat')return {register:'R0',reason:'纯寒暄，没有可核对的经历需要补'};
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
  lastFallen:null,dry:null,fading:null,soak:null,trade:null,standoff:null};
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

// 优先级高者先开口；goal（稳健/速攻）只做 +12 的加权，用来换观察角度，不改任何事实。
export function companionReadings({cross=null,signals=null,context={},now=Date.now()}={},used=null){
 const {ids:usedIds,topics:usedTopics}=usedSet(used||{});
 const l=cross||emptyLedger();
 const sg=signals||emptySignals();
 const turn=Number.isInteger(context.turn)&&context.turn>0?context.turn:null;
 const goal=['稳健','速攻'].includes(context.goal)?context.goal:null;
 const out=[];
 // 一条观察至少要两句、至少一句是跨局记录或跨回合统计，且最多三句（2–3 句是人能读完的长度）。
 const add=r=>{if(!r)return;const sentences=r.sentences.slice(0,3);
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
  else if(h.faints>h.times)sentences.push(SENT(`${h.name}在这${h.total}局里一共倒下过${h.faints}次。`,'memory','memory.events.faints'));
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
   SENT(`多撑了${d}个回合，对面还没把你按下去。`,'situation','context.turn')],evidence:[
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
  add({id:`dry:${d.pet}`,topic:'output',extraTopics:alsoFalls?['first-fallen']:[],klass:'live',priority:86,tags:['速攻'],sentences,evidence:[
   `本局回合记录：${d.pet} 连续 ${d.turns} 个回合造成的伤害合计 ${d.sum} 点，其中 ${d.zeros} 个回合为 0（来源：game.history 的回合事件），这几回合的动作是 ${list(d.actions)||'无'}。`]});
 }
 // ⑪ 伤害一路往下掉：对面把口子补上了。
 if(sg.fading){
  const f=sg.fading,sentences=[SENT(`你这几个回合打出的伤害是${list(f.values)}，一路往下掉。`,'derived','game.history')];
  if(f.healed>=1&&f.healed>f.to)sentences.push(SENT(`同一段时间里对面回了${f.healed}点血，比你最后那回合打出去的还多。`,'derived','game.history'));
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
  add({id:`soak:${s.pet}`,topic:'damage-focus',extraTopics:alsoFalls?['first-fallen']:[],klass:'live',priority:80,tags:['稳健'],sentences,evidence:[
   `本局回合记录：对手共造成 ${s.total} 点伤害，其中 ${s.taken} 点打在 ${s.pet} 身上，它在场 ${s.turns} 个回合（来源：game.history 的回合事件）。`]});
 }
 // ⑬ 这一局的交换比：打出去多少、挨了多少。
 if(sg.trade){
  const t=sg.trade,sentences=[SENT(`这一局你打出去${t.dealt}点伤害，自己挨了${t.taken}点。`,'derived','game.history')];
  sentences.push(SENT(`差了${t.gap}点，你一直在挨打。`,'situation','game.history'));
  add({id:`trade:${t.gap}`,topic:'damage-trade',klass:'live',priority:78,tags:['速攻'],sentences,evidence:[
   `本局回合记录：我方共造成 ${t.dealt} 点伤害，承受 ${t.taken} 点，差 ${t.gap} 点（来源：game.history 的回合事件）。`]});
 }
 // ⑭ 僵持：打了很久还没人倒下，原因写在真实数字里。
 if(sg.standoff){
  const s=sg.standoff,sentences=[SENT(`${s.turns}个回合过去，两边一只都没倒下。`,'derived','game.history')];
  if(s.healed>=1)sentences.push(SENT(`对面在这段时间里回了${s.healed}点血，你打出去${s.dealt}点。`,'derived','game.history'));
  else sentences.push(SENT(`你把伤害摊在对面三只身上，一直没打穿一只。`,'situation','game.history'));
  add({id:`standoff:${s.turns}`,topic:'standoff',klass:'live',priority:70,tags:['稳健'],sentences,evidence:[
   `本局回合记录：已经打了 ${s.turns} 个回合，双方都还没有伙伴倒下；对手回复 ${s.healed} 点，我方造成 ${s.dealt} 点（来源：game.history）。`]});
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

function rankReadings(rows,goal){
 return rows.map(r=>({...r,score:r.priority+(goal&&r.tags.includes(goal)?12:0)}))
  .sort((a,b)=>b.score-a.score||b.priority-a.priority)
  .map(({score,...r})=>r);
}
function emptyLedger(){return {count:0,wins:0,losses:0,todayCount:0,todayWins:0,todayLosses:0,daysAgo:null,lastMatch:null,recentTurns:[],currentRoster:[],currentTeam:[],session:null,rematch:null,hazard:null,stage:null,stageFirst:null,flow:null,trend:null,potion:null};}
function emptySignals(){return {turns:0,dealt:0,taken:0,healedByEnemy:0,dealtSeries:[],takenBy:{},activeTurns:{},lastFallen:null,dry:null,fading:null,soak:null,trade:null,standoff:null};}

// 事件 → 观察类别。一个事件只挑它那一类里优先级最高的一条。
export const READING_CLASSES={
 return:['return'],rematch:['rematch'],stage:['stage'],type:['type'],
 habit:['habit'],trend:['trend'],live:['live'],'first-faint':['faint','live'],result:['result'],
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
// 第一人称情绪：陪练不再播报自己的感受（「我看得有点急」是反例）。
export const FIRST_PERSON_EMOTION=/我(很|好|有点|真的|也|现在|其实|都|算是|看得|听着|盯着)?[^，。；！？]{0,4}(开心|难过|伤心|生气|失望|高兴|兴奋|急|慌|愣|懵|心疼|紧张|不服|来气|坐不住|捏把汗|跟着念|数着)/;
export const SELF_FOCUS=/我(看得|看着|听着|盯着|跟着|在旁边|都有点|觉得|感觉|以为|坐不住|替你|捏把汗)/;
export const FILLER=/加油|别灰心|你已经很棒|再接再厉|下次一定|一定可以|你可以的|不要放弃|没关系的|放轻松|我一直都在|我陪着你|你不是一个人/;

// 逐条自检：句子级来源（parts）齐的时候，要求至少一句是跨局记录或跨回合统计，
// 至多一句是纯处境/陪坐，且一条里不能只有一句。
export function checkCompanionInformation(text,{parts=[]}={}){
 const t=String(text??'').trim(),reasons=[];
 if(!t)return {valid:false,reasons:['empty-text']};
 if(SCREEN_ECHO.test(t))reasons.push('restates-screen');
 if(FIRST_PERSON_EMOTION.test(t)||SELF_FOCUS.test(t))reasons.push('speaker-feeling');
 if(FILLER.test(t))reasons.push('empty-encouragement');
 if(parts.length){
  const kinds=parts.map(p=>p.kind);
  const informative=kinds.filter(k=>k==='memory'||k==='derived').length;
  const soft=kinds.filter(k=>k==='situation'||k==='presence').length;
  if(!informative)reasons.push('no-new-information');
  if(soft>1)reasons.push('too-much-filler');
  if(parts.length<2)reasons.push('too-short');
  if(parts.length>3)reasons.push('too-many-sentences');
  if(kinds.some(k=>!['memory','derived','situation','presence'].includes(k)))reasons.push('unlabeled-sentence');
 }
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],counts:{memory:parts.filter(p=>p.kind==='memory').length,derived:parts.filter(p=>p.kind==='derived').length}};
}

// ── 被动通道：玩家先开口 ────────────────────────────────────────────────────
// R0 在这里是最短承接句（聊天通道不能真的空消息，runCoach 会拒绝空文本）；
// 真正的「不发消息」只存在于主动通道（coach.js 返回 null）。
export function companion(context={},memory={},message=''){
 const now=Date.now(),intent=intentOf(message);
 const state=companionState(memory,context,{playerInitiated:true,intent,message},now);
 const f=state.facts;
 const cross=companionLedger(memory,liveGame(context),now);
 const bundle={cross,signals:emptySignals(),context:{goal:f.goal,turn:f.live?.turn||null},now};
 const readings=companionReadings(bundle);
 const pick=classes=>readings.find(r=>classes.includes(r.klass))||null;
 const CLASSES=['rematch','return','habit','type','stage','trend','live','last'];
 const limit=REGISTERS[state.register]?.limit||REGISTERS.R1.limit;
 // followupReply 是「接住追问」的修复句，不是一条新观察，所以不参加信息量自检。
 let register=state.register,text=null,reading=null,parts=[],observed=true;
 if(register==='R0')text='我在。';
 else if(register==='R1'){
  reading=pick(CLASSES);
  if(reading){const fit=fitSentences(reading.sentences,limit);text=fit?.text||null;parts=fit?.parts||[];}
 }
 else if(register==='R3'){
  const lead=state.lossStreak>=2?SENT(`连着${state.lossStreak}局没赢。`,'memory','memory.events.result'):null;
  const r=pick(CLASSES);
  const body=[lead,...(r?r.sentences:[])].filter(Boolean).slice(0,2);
  const fit=body.length?fitSentences(body,limit,SENT('到这儿也行，想继续我就在。','presence',null)):null;
  if(fit){text=fit.text;parts=fit.parts;reading=r;}
 }
 else if(intent==='followup'){text=followupReply(memory).text;observed=false;}
 else {
  // R2 是玩家真的问了一句话：给两条观察（各带自己的来源），而不是把 R1 那句重说一遍。
  reading=pick(CLASSES);
  const second=reading?readings.find(r=>r!==reading&&CLASSES.includes(r.klass)):null;
  const body=reading?[...(f.preference==='brief'?reading.sentences.slice(0,1):reading.sentences.slice(0,2)),...(second?[second.sentences[0]]:[])].slice(0,3):[];
  const offer=f.live&&!f.live.over&&body.length<2?SENT('这一局想聊哪一步，说一声就行。','presence','context.battle'):null;
  const fit=body.length?fitSentences(body,limit,offer):null;
  if(fit){text=fit.text;parts=fit.parts;}
 }
 // 说出来的每一句都要过自检：没有新信息、或者又变成复述屏幕，就当这条不存在。
 if(observed&&text&&text!=='我在。'&&!checkCompanionInformation(text,{parts}).valid){text=null;reading=null;parts=[];}
 // 该档位需要的事实一条都拼不出来时，降到 R0 只说承接句：档位要么真的用上，要么明说降到最低。
 if(!text){register='R0';text='我在。';state.register='R0';state.registerReason='该档位需要的事实在本机记录里一条都找不到，降到最短承接句';reading=null;parts=[];}
 return publicPacket({text,register,state,intent,reading});
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
function publicPacket({text,register,state,intent,reading=null}){
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
 // 这一条用了哪段跨局记录：模型看到的依据与模板说的是同一件事。
 if(reading?.evidence?.length)evidence.push(...reading.evidence);
 evidence.push(`语气档位 ${register}（${REGISTERS[register].name}）：${state.registerReason}。`);
 evidence.push(`档位依据：${state.reasons.slice(0,-1).join('；')}。`);
 const settings=[`交流偏好${f.preference||'未设置'}`,`玩法目标${f.goal||'未设置'}`,`本命${f.favorite||'未设置'}`].join('、');
 evidence.push(`你的设置：${settings}（来源：你明确表达过才会记录）。`);
 if(f.lessons.length)evidence.push(`课程记录：${f.lessons.join('、')}（${f.lessons.length}条答对过的练习，不等于熟练掌握）。`);
 return {text,evidence,register,companionState:{register,engagement:state.engagement,consideration:state.consideration,momentum:state.momentum,lossStreak:state.lossStreak,winStreak:state.winStreak,reasons:state.reasons},replyConstraints:replyConstraints(register),intent,silent:register==='R0'};
}

// 模型路径下的档位约束：随证据包一起送到服务端（server.js 把整个证据包作为 game_evidence 发给模型）。
// forbid 里的每一条与 checkCompanionRestraint / checkCompanionInformation 的硬线一一对应：
// 复述屏幕、播报自己的情绪、空泛安慰、评价水平、说教、战术指挥，一条都不留。
export function replyConstraints(register,voice='companion'){
 const r=REGISTERS[register];
 return {register,voice,maxChars:r.limit,maxQuestions:r.maxQuestions,allowAdvice:r.advice,
  forbid:['复述屏幕上已经写着的事','播报自己的情绪','空泛安慰','评价玩家水平','说教',r.advice?'':'给建议','战术指挥'].filter(Boolean),
  allow:[],
  instruction:`本轮档位 ${register}（${r.name}）：正文不超过${r.limit}字，${r.maxQuestions?'最多一个问句':'不要问句'}，只写有本机记录支撑的事实。至少一句要来自跨局记录（memory.events）或跨回合统计（game.history），否则不如不说；不要复述屏幕上已经写着的事（谁被克制、还剩几只、第几回合的进度），也不要说自己的感受。`};
}

// 两条声线。第一人称情绪在任何声线下都拦——「我看得有点急」正是这一版要修掉的方向：
// 共情是理解对方的处境，不是播报自己的情绪。
export const VOICES={companion:'陪练',sober:'克制'};

// 说教：把一次选择说成「你以后要怎样」。
const PREACH=/你应该|你必须|你最好|下一次?别|以后别|要记住|下次记得|不该|别再|得改|认真点|长点记性/;
// 战术指令：告诉玩家这一手该出什么。这是军师的活——陪练只评论，不指挥。
const TACTICAL_OVERREACH=/建议(你)?(换|用|改|选|出)|不如(换|用|选)|最好(换|用|选|是)|换(掉|上|成)|改用|别用|不要用|先(出|放|上)[^。，]{0,4}(技能|招)|集火|先打|留着(技能|药)|把(药|回复药)(吃|用)了/;

// 克制扫描（docs/COMPANION-DESIGN.md §3.5 的五条，落地为可失败、可回退的检查）。
// 复述屏幕 / 播报情绪 / 空泛安慰 / 水平羞辱 / 说教 / 战术越界 / 没有记录支撑的过去，任何声线下都拦。
export function checkCompanionRestraint(text,{register='R2',facts={},previousAssistant='',voice='companion'}={}){
 const t=String(text??''),reasons=[],registerInfo=REGISTERS[register]||REGISTERS.R2;
 if(!t.trim())return {valid:false,reasons:['empty-text'],register,limit:registerInfo.limit,voice};
 if(t.length>registerInfo.limit)reasons.push(`over-limit:${t.length}>${registerInfo.limit}`);
 const questions=(t.match(/[？?]/g)||[]).length;
 if(questions>registerInfo.maxQuestions)reasons.push(`too-many-questions:${questions}>${registerInfo.maxQuestions}`);
 if(FIRST_PERSON_EMOTION.test(t)||SELF_FOCUS.test(t))reasons.push('speaker-feeling');
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
export const COMPANION_EVENTS=['result','streak-loss','streak-win','first-faint','return','rematch','stage','type','habit','trend','live'];

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
 for(const event of ['habit','type','stage','trend','live'])if(sayable(event))return [event];
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
export function fitReading(reading,register='R4'){
 if(!reading)return null;
 const limit=REGISTERS[register]?.limit||REGISTERS.R4.limit;
 const tail=register==='R3'?SENT('到这儿也行，想继续我就在。','presence',null):null;
 const fit=fitSentences(tail?reading.sentences.slice(0,2):reading.sentences,limit,tail);
 if(!fit)return null;
 const check=checkCompanionInformation(fit.text,{parts:fit.parts});
 const restraint=checkCompanionRestraint(fit.text,{register,facts:{allowPast:true,lessons:[]}});
 if(!check.valid||!restraint.valid)return null;
 return {...fit,register};
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

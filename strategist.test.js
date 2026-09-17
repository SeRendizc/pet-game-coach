// 局内主动提示（军师）的触发边界。
// 每个用例都要同时回答两件事：什么时候该说，以及「不该说的时候真的不说」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,step,legalActions,active,ITEMS,SKILLS,rankEnemyActions} from './engine.js';
import {observe,assessDecision,attentionState,trackAttention,STRATEGIST_LIMITS,HESITATION,
 strategistSession,strategistTrigger,strategicIncident,incidentInfo,
 lethalOption,hesitationSignal,actionLabel,hoverLabel} from './coach/experience.js';

// 一个确定性的玩家策略：优先用零消耗的「撞击」，否则用第一个非防御技能。
// 打满一局也只用它，所以每个用例都能重放同一盘。
const policy=acts=>acts.find(a=>a.kind==='skill'&&a.id==='strike')||acts.find(a=>a.kind==='skill'&&a.id!=='guard')||acts[0];

// 走一局，并把每个「出招前 / 出招后」的快照交给回调。
function playMatch(seed,visit){
 let g=createGame(seed);
 for(let i=0;i<60&&!g.result;i++){
  const acts=legalActions(g);
  if(!acts.length)break;
  const action=structuredClone(policy(acts));
  const ranked=g.phase==='battle'?rankEnemyActions({...g,player:g.enemy,enemy:g.player}):null;
  const decision=g.phase==='battle'?assessDecision(g,action,ranked||[]):null;
  const next=step(g,action);
  const after=next.history.filter(h=>h.type==='turn').at(-1)?.after||null;
  if(visit({before:g,action,decision,after,next,ranked})===false)return {game:next,stopped:true};
  g=next;
 }
 return {game:g,stopped:false};
}
// 找一个「有必杀可选、却没选它」的真实回合（用引擎枚举，不构造假的分数）。
function findMissedFinish(seed){
 let hit=null;
 playMatch(seed,({before,action,decision,after})=>{
  if(hit)return false;
  const kill=lethalOption(before);
  if(!kill||kill.action.kind!=='skill')return;
  if(before.phase!=='battle'||JSON.stringify(action)===JSON.stringify(kill.action))return;
  if(!decision||decision.reasonable)return;
  hit={game:before,action,decision,after,kill};return false;
 });
 return hit;
}
function attentionWith(hovers){
 const s=attentionState(0);
 for(const [action,time] of hovers)trackAttention(s,'2:battle',action,time);
 return s;
}
const freeze=game=>structuredClone(game);

// ── 一、倒下（已有，保留）────────────────────────────────────────────────────
test('军师在伙伴倒下时开口，补位理由来自真实血量，且不当成胜率',()=>{
 const g=freeze(createGame(3));
 g.player.pets[0].hp=0;g.phase='replace';g.replaceSide='player';g.replaceQueue=null;
 const trigger=strategistTrigger({game:g,session:strategistSession(),now:1000,mode:'gentle'});
 assert(trigger, '倒下且轮到补位时必须开口');
 assert.equal(trigger.reason,'fall');
 assert.equal(trigger.lesson,'换宠承伤');
 assert.equal(trigger.basis.freeAction,true);
 assert.match(trigger.text,/烬尾狐倒下了/);
 assert.match(trigger.text,/补位不占回合/);
 assert.match(trigger.text,/不是胜率/);
 assert(!/胜率 \d/.test(trigger.text));
 trigger.consume();
});

test('倒下触发不会在没人倒下、或已经说过一次之后重复开口',()=>{
 const g=freeze(createGame(3));
 assert.equal(strategistTrigger({game:g,session:strategistSession(),now:1000,mode:'gentle'}),null,'满血时不该说');
 const down=freeze(g);down.player.pets[0].hp=0;down.phase='replace';down.replaceSide='player';
 const session=strategistSession();
 const first=strategistTrigger({game:down,session,now:1000,mode:'gentle'});
 assert(first);first.consume();
 const later=freeze(down);later.turn=9;later.player.pets[1].hp=0;
 assert.equal(strategistTrigger({game:later,session,now:999999,mode:'gentle'}),null,'同一理由本局不重复');
 assert.equal(strategistTrigger({game:down,session,now:999999,mode:'quiet'}),null,'安静档一律不说');
 assert.equal(strategistTrigger({game:{...down,mode:'pvp-live'},session:strategistSession(),now:1,mode:'gentle'}),null,'线上竞技不说');
});

// ── 二、犹豫不决 ─────────────────────────────────────────────────────────────
test('犹豫触发沿用 trackAttention 的悬停记录与 shouldNudge 门槛',()=>{
 const g=createGame(1);
 const scanning=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const signal=hesitationSignal(scanning,{now:12000,turn:'2:battle'});
 assert(signal,'两个选项来回扫过 8 秒以上才成立');
 assert.equal(signal.hovers,3);
 assert.equal(signal.kinds.length,2);
 const trigger=strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'});
 assert(trigger);assert.equal(trigger.reason,'hesitation');
 assert.equal(trigger.basis.kind,'scanning');
 assert.equal(trigger.basis.distinct,2);
 assert.match(trigger.text,/来回看了大约 12 秒/);
 assert.match(trigger.text,/火花/,'措辞要用玩家看得懂的名字');
 assert.match(trigger.text,/由你决定/);
});

test('悬停记录是对象时也要能分出「不同选项」（app.js 现在就存对象）',()=>{
 const g=createGame(1);
 const att=attentionWith([[{kind:'skill',id:'ember'},0],[{kind:'skill',id:'pursuit'},4000],[{kind:'skill',id:'ember'},8000]]);
 const signal=hesitationSignal(att,{now:12000,turn:'2:battle'});
 assert(signal,'对象形态的悬停同样要成立');
 assert.equal(signal.kinds.length,2,'两个不同选项不能被序列化成同一个 [object Object]');
 assert.equal(signal.hovers,3);
 const trigger=strategistTrigger({game:g,attention:att,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'});
 assert(trigger);assert.match(trigger.text,/火花|余烬追猎/);
 assert(!/\[object Object\]/.test(trigger.text));
 // 同一个对象反复悬停仍然只算一个选项。
 const same=attentionWith([[{kind:'skill',id:'ember'},0],[{kind:'skill',id:'ember'},4000],[{kind:'skill',id:'ember'},8000]]);
 assert.equal(hesitationSignal(same,{now:12000,turn:'2:battle'}),null);
});

test('犹豫不成立的时候真的不说：只看一个选项、看得太短、安静档、已提示过、已关闭',()=>{
 const g=createGame(1);
 const one=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"ember"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 assert.equal(hesitationSignal(one,{now:12000,turn:'2:battle'}),null,'来回只看同一个选项，不算犹豫');
 assert.equal(strategistTrigger({game:g,attention:one,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'}),null);

 const scanning=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:6000,turn:'2:battle',mode:'gentle'}),null,'思考时间不够长');
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'quiet'}),null,'安静档');
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'critical'}),null,'仅关键风险档不接管犹豫');
 assert.equal(strategistTrigger({game:g,attention:null,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'}),null,'没有悬停证据');
 assert.equal(strategistTrigger({game:{...g,result:'win'},attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'}),null,'本局已结束');
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle',inMatch:false}),null,'不在对局中（分屏对方回合、面板打开等）');

 const session=strategistSession();
 const shown=strategistTrigger({game:g,attention:scanning,session,now:12000,turn:'2:battle',mode:'gentle'});
 shown.consume();
 assert.equal(strategistTrigger({game:g,attention:scanning,session,now:90000,turn:'2:battle',mode:'gentle'}),null,'同一回合不重复开口');
 const laterTurn=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"vine"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 assert.equal(strategistTrigger({game:{...g,turn:3},attention:laterTurn,session,now:90000,turn:'3:battle',mode:'gentle'}),null,'同一理由本局不重复');

 const dismissed=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const closed=strategistSession();closed.dismissed=true;
 assert.equal(strategistTrigger({game:g,attention:dismissed,session:closed,now:12000,turn:'2:battle',mode:'gentle'}),null,'玩家点掉后本局静音');
});

test('犹豫复用 shouldNudge：45 秒冷却与本局两次上限都算数',()=>{
 const scanning=()=>attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const g=createGame(1);
 const state=scanning();
 assert(shouldNudgeOk(state,12000,'2:battle'),'刚够门槛时成立');
 assert.equal(hesitationSignal({...state,lastShown:0,shownTurn:'x'},{now:44000,turn:'2:battle'}),null,'45 秒冷却内不成立');
 assert(hesitationSignal({...state,lastShown:0,shownTurn:'x'},{now:46000,turn:'2:battle'}),'超过 45 秒可以再成立');
 assert.equal(hesitationSignal({...state,count:2,shownTurn:'x'},{now:200000,turn:'9:battle'}),null,'每局 2 次上限');
 assert(strategistTrigger({game:g,attention:state,session:strategistSession(),ranked:rankEnemyActions({...g,player:g.enemy,enemy:g.player}),now:12000,turn:'2:battle',mode:'gentle'}));
});
function shouldNudgeOk(state,now,turn){return hesitationSignal(state,{now,turn})!==null;}

// ── 三、明显策略错误且造成后果 ────────────────────────────────────────────────
test('策略错误必须同时有真实分差和 after 快照上的后果',()=>{
 const found=findMissedFinish(1);
 assert(found,'测试需要一局真实对局里「有必杀却没打」的回合');
 const {game,action,decision,after,kill}=found;
 const incident=strategicIncident(game,{action,gap:decision.scoreGap,after});
 assert(incident);assert.equal(incident.kind,'missed-finish');
 assert(incident.gap>5);
 assert.equal(incident.enemyAfterHp>0,true,'对手确实活过了这一回合');
 assert.equal(JSON.stringify(incident.lethal),JSON.stringify(kill.action));
 const trigger=strategistTrigger({game,session:strategistSession(),incident:{action,gap:decision.scoreGap,after},now:1,mode:'gentle'});
 assert(trigger);assert.equal(trigger.reason,'mistake');
 assert.equal(trigger.kind,'missed-finish');
 assert.equal(trigger.basis.heuristic,true);
 assert.equal(trigger.basis.notWinRate,true);
 assert.match(trigger.text,/收尾机会/);
 assert.match(trigger.text,/不是胜率/);
 assert.match(trigger.text,new RegExp(String(Math.round(decision.scoreGap*10)/10)));
});

test('不该说的时候真的不说：分差太小、选了更强的一手、对手已被收掉、整局已结束',()=>{
 const found=findMissedFinish(1);
 assert(found);
 const {game,action,decision,after,kill}=found;
 assert.equal(strategicIncident(game,{action,gap:5,after}),null,'分差 <= 5 属于近似合理，不判错');
 assert.equal(strategicIncident(game,{action,gap:4.9,after}),null);
 assert.equal(strategicIncident(game,{action:kill.action,gap:40,after}),null,'选了必杀本身就没有这一条');
 assert.equal(strategicIncident(game,{gap:40,after}),null,'没有行动就没有可判定的选择');
 assert.equal(strategicIncident(game,{action:null,gap:40,after}),null,'行动为空同样不判定');
 assert.equal(strategicIncident(game,{action:{kind:'escape'},gap:40,after}),null,'撤退不按出招判错');
 assert.equal(strategicIncident(game,{action,gap:40,after:{...after,result:'win'}}),null,'整局结束交给复盘的老师');
 assert.equal(strategicIncident({...game,phase:'replace'},{action,gap:40,after}),null,'补位回合不按出招判错');
 assert.equal(strategistTrigger({game,session:strategistSession(),incident:{action,gap:40,after},now:1,mode:'quiet'}),null,'安静档');
 assert.equal(strategistTrigger({game,session:strategistSession(),incident:{action,gap:5,after},now:1,mode:'gentle'}),null,'分差不够就不开口');
});

test('可救却减员是真实枚举分差 + after 里的倒下，不是「有药就该吃」',()=>{
 let hit=null;
 playMatch(2,({before,action,decision,after})=>{
  if(hit)return false;
  const inc=strategicIncident(before,{action,gap:decision?.scoreGap,after});
  if(inc&&inc.kind==='preventable-faint'){hit={before,action,decision,after,inc};return false;}
 });
 assert(hit,'测试需要一局真实对局里「伙伴在还有药的时候倒下」的回合');
 const {before,action,decision,after,inc}=hit;
 assert(inc.beforeHp>0);
 assert.equal(after.player.pets[before.player.active].hp<=0,true);
 assert(inc.potions>0);
 const text=strategistTrigger({game:before,session:strategistSession(),incident:{action,gap:decision.scoreGap,after},now:1,mode:'gentle'}).text;
 assert.match(text,/倒下了/);
 assert.match(text,/回复药/);
 assert.match(text,/有药不等于那回合吃药一定更好/);
 assert(!/你应该|你必须/.test(text));
});

// ── 四、三类的共同克制：上限、理由去重、每回合一次、冷却、点掉即静音 ──────────────
test('一局打满也只有这三次开口，理由不重复，且都来自三类之一',()=>{
 const reasons=[];
 const session=strategistSession();
 let now=0;
 playMatch(1,({before,action,decision,after})=>{
  now+=90000;                                   // 假设玩家每回合都思考很久，冷却不再是瓶颈
  const attention=attentionWith([['{"kind":"skill","id":"strike"}',now-12000],['{"kind":"skill","id":"ember"}',now-8000],['{"kind":"skill","id":"strike"}',now-1000]]);
  const packet=before.phase==='replace'?observe(before):null;
  const incident=before.phase==='battle'?{...incidentInfo(before,decision),action}:null;
  const trigger=strategistTrigger({game:before,attention,session,packet,incident,ranked:rankEnemyActions({...before,player:before.enemy,enemy:before.player}),after,now,turn:`${before.turn}:${before.phase}`,mode:'gentle'});
  if(!trigger)return;
  trigger.consume();
  reasons.push(trigger.reason);
 });
 assert(reasons.length<=STRATEGIST_LIMITS.maxPerMatch,`每局最多 ${STRATEGIST_LIMITS.maxPerMatch} 次，实际 ${reasons.length}`);
 assert.equal(new Set(reasons).size,reasons.length,'同一理由不重复');
 assert(reasons.every(r=>['fall','hesitation','mistake'].includes(r)));
});

test('冷却与每回合一次是硬约束：刚说过就不会连着说',()=>{
 const g=createGame(1);
 // ① 冷却：说过一次之后，冷却窗口里的下一个回合也不说。
 const session=strategistSession();
 const down=freeze(g);down.player.pets[0].hp=0;down.phase='replace';down.replaceSide='player';
 const first=strategistTrigger({game:down,session,now:100000,mode:'gentle'});
 assert(first);first.consume();
 const hover=()=>attentionWith([['{"kind":"skill","id":"ember"}',100000],['{"kind":"skill","id":"pursuit"}',104000],['{"kind":"skill","id":"ember"}',108000]]);
 const tooSoon=strategistTrigger({game:{...g,turn:2},attention:hover(),session,now:100000+STRATEGIST_LIMITS.cooldownMs-1,turn:'2:battle',mode:'gentle'});
 assert.equal(tooSoon,null,'冷却未到不说');
 const later=strategistTrigger({game:{...g,turn:3},attention:hover(),session,now:100000+STRATEGIST_LIMITS.cooldownMs+1,turn:'3:battle',mode:'gentle'});
 assert(later,'冷却过去、换一个回合可以成立');
 assert.equal(later.reason,'hesitation');
 later.consume();
 // ② 每回合一次：同回合内即使冷却已过也不再开口。
 const again=strategistTrigger({game:{...g,turn:3},attention:hover(),session,now:300000,turn:'3:battle',mode:'gentle'});
 assert.equal(again,null,'同一回合不重复开口');
 // ③ 每局上限：三类各一次之后，第 4 次一定为 null。
 const capped=strategistSession();
 capped.hints=STRATEGIST_LIMITS.maxPerMatch;
 assert.equal(strategistTrigger({game:{...g,turn:9},attention:hover(),session:capped,now:9e6,turn:'9:battle',mode:'gentle'}),null,'达到每局上限');
});

// ── 五、展示与措辞：理由可断言、可解释 ───────────────────────────────────────
test('每条开口都带可读的理由和行动名，不出现胜率或命令句',()=>{
 const g=createGame(1);
 assert.equal(actionLabel(g,'player',{kind:'skill',id:'guard'}),'防御');
 assert.equal(actionLabel(g,'player',{kind:'skill',id:'ember'}),SKILLS.ember.name);
 assert.equal(actionLabel(g,'player',{kind:'item',id:'potion',target:0}),ITEMS.potion.name);   // 两个都是字符串，不会把对象拼进去
 assert.equal(hoverLabel(g,{action:'{"kind":"skill","id":"ember"}'}),SKILLS.ember.name,'旧记录里存的是 JSON 字符串');
 const scanning=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"switch","target":1}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const trigger=strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'});
 assert(trigger);
 assert.match(trigger.text,/你在.+之间来回看了/);
 assert.match(trigger.text,/换宠|防御|火花|撞击/);
 assert(!/胜率[：: ]*\d/.test(trigger.text),'不能用胜率数字');
 assert(!/你应该|你必须/.test(trigger.text),'不用命令句');
 assert.equal(typeof trigger.consume,'function');
});

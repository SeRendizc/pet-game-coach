// 局内主动提示的归属层：军师。
//
// 陪练（coach/companion.js + coach.js 的 coachEvent）管的是闲聊、情绪与记忆——
// 本局第一次有人倒下、整局结束。战术提示不属于它，所以局内主动层放在这里。
//
// 军师只在三种「确实值得打断」的情形开口：
//   fall     伙伴倒下、必须补位（不可逆，而补位是免费动作）
//   hesitate 犹豫不决——复用 trackAttention 的悬停记录 + shouldNudge 的门槛
//   mistake  明显策略错误且造成后果——复用 compareTurnAlternatives/rankEnemyActions
//            的真实枚举分差，并且必须有 after 快照上的实际后果
//
// 克制不是「尽量少说」的口号，而是这里的硬约束：
//   · 每局总上限 3 次，每类触发各 1 次（reason 去重，所以第 2、3 只倒下不会再说）
//   · 同一回合只允许一次开口
//   · 同一理由（lesson）本局不重复
//   · 两次开口至少间隔 COOLDOWN_MS
//   · 复用 shouldNudge（每局 ≤2 次 / 45 秒冷却 / 本回合一次 / 关闭后本场静音）
//     与 adaptiveGate（近 7 天被关闭 2 次即降频）
//   · 安静档在最前面短路：任何触发都不例外
import {SKILLS,ITEMS,damage,effectiveSpeed,legalActions,active} from '../engine.js';
import {shouldNudge} from './experience.js';

export const STRATEGIST_LIMITS={maxPerMatch:3,cooldownMs:60000,finishGap:5};
export const HESITATION={minHovers:3,minDistinct:2,minAgeMs:8000};
// 分差阈值复用 coach/experience.js assessDecision 的判定：<=5 视为近似合理，不能算「明显错误」。
export const REASONABLE_GAP=5;

export function strategistSession(){return {hints:0,said:new Set(),lastAt:-Infinity};}
export function resetStrategist(){return strategistSession();}

function playable(game){return !!game&&['pve','pvp-local'].includes(game.mode)&&!game.result;}
function round1(n){return Math.round(n*10)/10;}
function turnKey(game){return `${game.turn}:${game.phase}`;}
function sameAction(a,b){return !!a&&!!b&&a.kind===b.kind&&(a.id??null)===(b.id??null)&&(a.target??null)===(b.target??null);}
// 同分时的稳定偏好：先选不会花掉整回合、也不放弃本回合的选择（换宠/道具次之，撤退最后）。
// 只影响并列时的措辞，不改变任何枚举分数。
function strength(a){return (a?.kind==='item'?10:0)+(a?.kind==='switch'?5:0)+(a?.kind==='escape'?-10:0);}
function pick(ranked){
 const rows=(Array.isArray(ranked)?ranked:[]).filter(x=>x&&x.action);
 if(!rows.length)return null;
 return [...rows].sort((a,b)=>(Number.isFinite(b.score)?b.score:-Infinity)-(Number.isFinite(a.score)?a.score:-Infinity)||strength(b.action)-strength(a.action))[0];
}
export function actionLabel(game,side,a){
 if(!a)return '行动';
 if(a.kind==='skill')return a.id==='guard'?'防御':(SKILLS[a.id]?.name||a.id);
 if(a.kind==='switch')return `换上${game?.[side]?.pets?.[a.target]?.name||'伙伴'}`;
 if(a.kind==='item')return ITEMS[a.id]?.name||a.id;
 return '撤退';
}
function lessonFor(a){
 if(!a)return '行动取舍';
 if(a.kind==='switch')return '换宠承伤';
 if(a.id==='guard')return '防御节奏';
 if(a.kind==='item')return '道具时机';
 const sk=a.kind==='skill'?SKILLS[a.id]:null;
 if(sk?.heal)return '危险血线';
 return '行动取舍';
}
// 收尾机会：用 engine 的伤害公式枚举合法攻击，看是否存在一击结束本回合的选择。
// 与 coach/experience.js 的 decisiveOpportunity 同源，但不要求「双方都残血」。
export function lethalOption(game){
 if(!playable(game)||game.phase!=='battle')return null;
 const p=active(game,'player'),q=active(game,'enemy');
 if(!p||!q||p.hp<=0||q.hp<=0)return null;
 return legalActions(game).filter(a=>a.kind==='skill'&&SKILLS[a.id]?.power)
  .map(a=>({action:a,hit:damage(p,q,SKILLS[a.id])}))
  .filter(x=>x.hit>=q.hp).sort((a,b)=>a.hit-b.hit)[0]||null;
}

// —— 明显策略错误 + 严重后果：两个条件都成立才成立 ——
// ① 真实枚举的一回合分差 > 5（compareTurnAlternatives/rankEnemyActions 的结果，
//    是启发式评分，不是胜率；措辞里也这么说）
// ② 后果落在 after 快照上，只有两种：
//    可救却减员（该回合有回复药可用却仍在 after 里倒下）
//    该收尾没收尾（有必杀可选，对手在 after 里仍然活着）
export function strategicIncident(game,{action,gap=null,after=null}={}){
 if(!playable(game)||game.phase!=='battle'||!action||action.kind==='escape')return null;
 if(!Number.isFinite(gap)||gap<=REASONABLE_GAP)return null;
 if(after?.result||after?.phase==='ended')return null;          // 整局已结束：交给复盘的老师
 const p=active(game,'player'),q=active(game,'enemy');
 if(!p||!q||p.hp<=0)return null;
 const mine=after?.player?.pets?.[game.player.active];
 const theirHp=after?.enemy?.pets?.[game.enemy.active]?.hp??q.hp;
 const potions=game.player.items?.potion||0;
 if(mine&&mine.hp<=0&&p.hp>0&&potions>0&&action.id!=='potion')
  return {kind:'preventable-faint',gap,action,pet:p.name,beforeHp:p.hp,potions,fallback:{kind:'skill',id:'guard'}};
 const kill=lethalOption(game);
 if(kill&&!sameAction(action,kill.action)&&theirHp>0&&(mine?mine.hp>0:true))
  return {kind:'missed-finish',gap,action,pet:p.name,lethal:kill.action,lethalHit:kill.hit,enemyHp:q.hp,enemyAfterHp:theirHp};
 return null;
}

// app.js 在出招前调用：把「当时是否还有收尾机会」留到回合结算后再说。
export function incidentInfo(game,decision){
 if(!decision||typeof decision.reasonable!=='boolean')return null;
 const kill=lethalOption(game),q=active(game,'enemy');
 return {reasonable:decision.reasonable,gap:Number.isFinite(decision.scoreGap)?decision.scoreGap:null,
  lesson:decision.lesson||null,hadLethal:!!kill,lethal:kill?kill.action:null,lethalHit:kill?kill.hit:null,
  enemyHp:q?q.hp:null};
}

// 犹豫不决：复用 attentionState / trackAttention / shouldNudge，不另造计数。
// shouldNudge 已经包含「本回合已提示过、45 秒冷却、每局 ≤2 次、关闭后静音、安静档」，
// 这里只补军师自己的要求：至少扫过两个不同选项，且确实纠结了一段时间。
export function hesitationSignal(attention,{now=0,turn=null,mode='gentle',active=true,risk=false}={}){
 if(!attention||attention.dismissed)return null;
 if(!shouldNudge(attention,{now,turn,mode,active,risk}))return null;
 const scan=(attention.hovers||[]).filter(x=>x&&x.action);
 const kinds=[...new Set(scan.map(x=>x.action))];
 const held=now-(attention.since||0);
 if(kinds.length<HESITATION.minDistinct||scan.length<HESITATION.minHovers||held<HESITATION.minAgeMs)return null;
 return {kinds,held,hovers:scan.length};
}

function fallText(game,packet){
 const fallen=game.player.pets.find(x=>x.hp<=0),alive=game.player.pets.filter(x=>x.hp>0&&x.id!==fallen?.id);
 const ranked=(packet?.actions||[]).filter(a=>a.kind==='switch');
 const best=ranked.map(a=>({action:a,pet:game.player.pets[a.target]})).filter(x=>x.pet&&x.pet.hp>0).sort((a,b)=>(b.pet.hp+b.pet.energy*10)-(a.pet.hp+a.pet.energy*10))[0]||null;
 const others=alive.filter(x=>x.id!==best?.pet?.id);
 if(!fallen)return null;
 return `${fallen.name}倒下了。${best?`先让${best.pet.name}补位（还剩 ${best.pet.hp}HP、${best.pet.energy}豆）`:'现在没有健康的伙伴可以补位'}；补位不占回合，选好再决定出招。`
  +(others.length?`另外${others.map(x=>`${x.name}（${x.hp}HP、${x.energy}豆）`).join('、')}也可以比较。`:'')
  +'这是按下一回合攻守分支排的，不是胜率。';
}
function mistakeText(game,incident){
 if(incident.kind==='missed-finish')
  return `刚才这回合有收尾机会：${actionLabel(game,'player',incident.lethal)}对当时的${active(game,'enemy')?.name||'对手'}算 ${incident.lethalHit} 伤害，对手只剩 ${incident.enemyHp}HP，你选了${actionLabel(game,'player',incident.action)}，它在 ${incident.enemyAfterHp}HP 活过了这回合。分差 ${round1(incident.gap)} 是一回合启发式评分，不是胜率，也不代表改这一手就一定能赢。`;
 if(incident.kind==='preventable-faint')
  return `${incident.pet}在 ${incident.beforeHp}HP 时倒下了，背包里还有 ${incident.potions} 瓶回复药。有药不等于那回合吃药一定更好，但这是当时可以先比较的分支。`;
 return null;
}
function hesitateText(game,signal,alt){
 const names=signal.kinds.slice(0,3).map(a=>actionLabel(game,'player',a)).join('、');
 return `你在${names}之间来回看了大约 ${Math.round(signal.held/1000)} 秒。${alt?`如果只是要找一件先定下来的事：「${actionLabel(game,'player',alt.action)}」是真实枚举里分最高的分支。`:'拿不准时，先比较对手留场和换宠两种分支。'}由你决定，不用回我。`;
}

// 军师该不该开口。纯函数：不碰 DOM、不碰记忆，只读 game / attention / session。
// 返回 null（不说）或 {reason,kind,lesson,text,basis}（说，并带上可断言的理由）。
export function strategistTrigger({game,attention=null,session=null,packet=null,incident=null,ranked=null,after=null,now=0,turn=null,mode='gentle',inMatch=true}={}){
 if(!inMatch||!playable(game))return null;
 if(mode==='quiet')return null;                                   // 安静档：任何触发都不例外
 if(game.phase==='ended')return null;
 const s=session||strategistSession();
 if(s.hints>=STRATEGIST_LIMITS.maxPerMatch)return null;
 const tkey=turn||turnKey(game);
 if(s.said.has(`turn:${tkey}`))return null;                        // 同一回合只开口一次
 if(Number.isFinite(s.lastAt)&&now-s.lastAt<STRATEGIST_LIMITS.cooldownMs)return null;
 const reason=game.phase==='replace'?'fall':incident?'mistake':'hesitation';
 if(s.said.has(reason))return null;                                // 同一理由本局不重复
 const mark=(reason,lesson,tkey,now)=>{s.hints++;s.lastAt=now;s.said.add(reason);s.said.add(`turn:${tkey}`);if(lesson)s.said.add(`lesson:${lesson}`);};
 if(reason==='fall'){
  if(!active(game,'player')||active(game,'player').hp>0)return null;
  const text=fallText(game,packet);if(!text)return null;
  return {reason,lesson:'换宠承伤',text,basis:{kind:'forced-replacement',turn:game.turn,freeAction:true},consume:()=>mark(reason,'换宠承伤',tkey,now)};
 }
 if(reason==='mistake'){
  const inc=strategicIncident(game,{action:incident.action,gap:incident.gap,after:after||incident.after});
  if(!inc)return null;
  const text=mistakeText(game,inc);if(!text)return null;
  const lesson=incident.lesson||lessonFor(incident.action);
  return {reason,kind:inc.kind,lesson,text,basis:{kind:inc.kind,gap:inc.gap,heuristic:true,notWinRate:true,consequence:inc.kind},consume:()=>mark(reason,lesson,tkey,now)};
 }
 const signal=hesitationSignal(attention,{now,turn:tkey,mode,active:true,risk:false});
 if(!signal)return null;
 const alt=pick(ranked||packet?.ranked);
 const lesson=lessonFor(alt?.action||packet?.actions?.[1]);
 return {reason,lesson,text:hesitateText(game,signal,alt),basis:{kind:'scanning',hovers:signal.hovers,distinct:signal.kinds.length,heldMs:signal.held,notWinRate:true},consume:()=>mark(reason,lesson,tkey,now)};
}

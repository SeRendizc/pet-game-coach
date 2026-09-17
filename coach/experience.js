import {strategist} from './strategist.js';
import {active,multiplier,actionName,legalActions,SKILLS,ITEMS,damage,effectiveSpeed} from '../engine.js';
// incident 来自 coach/experience.js 军师触发层的真实枚举结果（分差 + after 快照上的后果）。
// 只有军师判定为「明显错误且造成后果」时才传进来，所以这里只是把理由写成一句可核对的话。
export function observe(game,{incident=null}={}){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result)return null;
 const p=active(game,'player'),q=active(game,'enemy'),packet=strategist({battle:game,mode:game.mode});
 const reason=incident?'这一手有明显更差的替代':game.phase==='replace'?'伙伴倒下，需要补位':multiplier(q.type,p.type)>1?'当前处于属性劣势':p.energy<=1?'能量不足，留意恢复节奏':game.turn===1?'开场对位分析':'回合结束，重新评估局面';
 return {...packet,reason,turn:game.turn,action:packet.actions?.[0],title:packet.actions?.[0]?`可考虑：${actionName(game,'player',packet.actions[0])}`:'先选择补位伙伴',lesson:incident?.lesson||(game.phase==='replace'||reason==='当前处于属性劣势'?'换宠承伤':p.energy<=1?'能量管理':'行动取舍')};
}
export function feedback(h,hint){
 if(!h||!hint||h.before.turn!==hint.turn)return null;
 const same=JSON.stringify(h.action)===JSON.stringify(hint.action);
 return {text:`第 ${h.before.turn} 回合：${same?'你选择了建议行动':'你选择了另一种行动'}。${h.events.filter(x=>!x.startsWith('──')).join(' ')}`,lesson:hint.lesson,quiz:lessonFor(h)};
}
export function archiveRound(game,old=null){
 const h=game?.history?.filter(x=>x.type==='turn').at(-1);if(!h||game.preview)return old;
 const id=game.id||old?.current?.id||`legacy-${game.initialSeed}-${game.stageId}`;
 const current={id,version:game.version,stageName:game.stageName,stageId:game.stageId,result:game.result,history:structuredClone(game.history)};
 let completed=old?.completed||[];
 if(game.result)completed=[...completed.filter(m=>m.id!==id),current].slice(-3);
 return {version:2,lastTurn:structuredClone(h),stage:game.stageName||'训练场',current,completed};
}
export function reverseRounds(log){const groups=[];for(const line of log){if(!groups.length||line.startsWith('──'))groups.push([]);groups.at(-1).push(line);}return groups.reverse().flat();}
// Escape before applying a deliberately small Markdown subset. Raw HTML is never interpreted.
export function markdown(text){const safe=String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));return safe.split(/\n+/).map(line=>'<p>'+line.replace(/^#{1,6}\s+/,'').replace(/^[-*]\s+/,'• ').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>')+'</p>').join('');}
export function concise(text,limit=180){if(text.length<=limit)return text;const part=text.slice(0,limit-1),end=Math.max(part.lastIndexOf('。'),part.lastIndexOf('！'),part.lastIndexOf('？'));return (end>limit/2?part.slice(0,end+1):part)+'…';}

export function lessonFor(h){
 if(h.action.kind==='switch')return {id:'换宠承伤',question:'换宠后，新上场的伙伴本回合会不会受到对手攻击？',yes:'可能会',no:'一定不会',explanation:'换宠先结算，随后对手可能攻击新伙伴。换宠时也要看它能否承伤。'};
 if(h.action.id==='ember'||h.action.id==='pursuit')return {id:'灼烧追击',question:'目标已经灼烧时，余烬追猎的基础威力会提高吗？',yes:'会提高',no:'不会',explanation:'余烬追猎对灼烧目标威力额外 +18；同时仍要考虑对手换宠或防御。'};
 if(h.action.id==='guard')return {id:'防御节奏',question:'防御可以连续两回合使用吗？',yes:'不可以',no:'可以',explanation:'本游戏不能连续防御。它能减伤和恢复能量，但下一回合要重新选择行动。'};
 return {id:'先制与速度',question:'速度更快，就一定能在先制技能前出手吗？',yes:'不一定',no:'一定',explanation:'先比较行动优先级，再比较速度。同优先级时速度才决定出手顺序。'};
}

// Interaction signals are weak evidence of hesitation, never evidence of low skill.
export function attentionState(now=0){return {turn:null,since:now,hovers:[],lastShown:-Infinity,count:0,shownTurn:null,dismissed:false};}
export function trackAttention(state,turn,action,now){
 if(state.turn!==turn){state.turn=turn;state.since=now;state.hovers=[];}
 if(action&&state.hovers.at(-1)?.action!==action)state.hovers.push({action,time:now});
 state.hovers=state.hovers.filter(x=>now-x.time<=15000).slice(-8);
 return state;
}
export function shouldNudge(state,{now,turn,mode='gentle',active=true,risk=false}){
 if(!active||mode==='quiet'||state.dismissed||state.count>=2||state.shownTurn===turn||now-state.lastShown<45000)return false;
 if(mode==='critical'&&!risk)return false;
 const scanning=state.hovers.length>=3&&new Set(state.hovers.map(x=>x.action)).size>=2&&now-state.since>=8000;
 return scanning||now-state.since>=20000;
}
export function attentionText(game,action){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result)return null;
 const p=active(game,'player');
 if(action?.kind==='switch')return game.phase==='replace'?'这次是免费补位，不占回合。选好后再决定下一步。':'换宠会用掉这回合，新伙伴还可能挨一下；先看看它的血量。';
 if(action?.id==='guard')return '防御能减伤、额外回2豆，但挡不住已有中毒或灼烧，也不能连用。';
 if(action?.kind==='item')return '吃药也占一回合，随后不能再出招；先确认恢复后能扛住这一下。';
 if(p.energy<=1)return '豆不多了。零消耗技能也能输出并等回合末回1豆，不一定要停下来吃果。';
 const q=active(game,'enemy');
 if(q.status?.kind==='burn'&&p.skills.includes('pursuit'))return '对面已经灼烧，追猎会增伤；不过如果两招都能收掉，就不必只看谁数字大。';
 return '拿不准时，先看对方留场和换宠两种情况。回合回顾里可以展开比较，由你决定。';
}

export function decisiveOpportunity(game){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result||game.phase!=='battle')return null;
 const p=active(game,'player'),q=active(game,'enemy');
 if(p.hp<=0||q.hp<=0||p.hp/p.maxHp>.35||q.hp/q.maxHp>.35)return null;
 const attacks=legalActions(game).filter(a=>a.kind==='skill'&&SKILLS[a.id].power).map(a=>({action:a,hit:damage(p,q,SKILLS[a.id]),cost:SKILLS[a.id].cost})).filter(x=>x.hit>=q.hp).sort((a,b)=>a.cost-b.cost);
 if(!attacks.length)return null;const best=attacks[0],sk=SKILLS[best.action.id];
 return {id:`finish:${p.id}:${q.id}`,turn:game.turn,action:best.action,text:`双方都残血，但你还有进攻机会：${sk.name}对留场且不防御的目标算${best.hit}伤害，对方${q.hp}HP。先别只盯着回血；对方防御${game.enemy.items.potion?'或治疗':''}会改变收尾条件。`,evidence:{hp:q.hp,damage:best.hit,guarded:damage(p,q,sk,true),playerSpeed:effectiveSpeed(p),enemySpeed:effectiveSpeed(q)}};
}

export function assessDecision(before,action,ranked){
 const candidate=ranked.find(x=>JSON.stringify(x.action)===JSON.stringify(action));
 if(!candidate||!ranked[0]||before.phase==='replace'||action.kind==='escape')return null;
 const gap=ranked[0].score-candidate.score;
 const lesson=action.kind==='switch'?'换宠承伤':action.id==='guard'?'防御节奏':before.player.pets[before.player.active].energy<=2?'能量管理':'行动取舍';
 return {lesson,reasonable:gap<=5,scoreGap:Math.round(gap*10)/10,basis:'一回合启发式分差<=5为近似合理，不等于全局最优'};
}

export function watchCandidate(game,watches=[]){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result||game.phase!=='battle')return null;
 const p=active(game,'player'),q=active(game,'enemy');
 for(const w of watches){if(w.matchId!==game.id||w.expiresTurn<game.turn)continue;
  if(w.kind==='energy'&&p.energy<=1)return {id:w.id,text:`你让我留意豆数：${p.name}现在${p.energy}豆。零消耗招式也能行动，防御可额外回能，但不能连用。`};
  if(w.kind==='finish'){
   const a=legalActions(game).find(a=>a.kind==='skill'&&SKILLS[a.id].power&&damage(p,q,SKILLS[a.id])>=q.hp);
   if(a)return {id:w.id,text:`你让我留意收尾：${SKILLS[a.id].name}对当前目标算${damage(p,q,SKILLS[a.id])}伤害，对方${q.hp}HP；换宠、防御或治疗会改变这个条件。`};
  }
 }return null;
}

export function readArchive(raw){
 try{
  const a=typeof raw==='string'?JSON.parse(raw):raw;if(!a||typeof a!=='object')return null;
  const validTurn=h=>h&&h.type==='turn'&&h.before&&h.after&&h.action&&Array.isArray(h.events)&&['player','enemy'].every(side=>Array.isArray(h.before[side]?.pets)&&h.before[side].pets.length===3&&Array.isArray(h.after[side]?.pets)&&h.after[side].pets.length===3);
  const validMatch=m=>m&&typeof m.id==='string'&&Array.isArray(m.history)&&m.history.length<=250&&m.history.every(h=>h.type!=='turn'||validTurn(h));
  if(a.version===2)return {...a,lastTurn:validTurn(a.lastTurn)?a.lastTurn:null,current:validMatch(a.current)?a.current:null,completed:Array.isArray(a.completed)?a.completed.filter(validMatch).slice(-3):[]};
  return validTurn(a.lastTurn)?{lastTurn:a.lastTurn,stage:a.stage}:null;
 }catch{return null;}
}

export function taskStamp({epoch,matchId=null,rulesVersion='0.6',now=Date.now(),ttl=20000}){return {epoch,matchId,rulesVersion,createdAt:now,validUntil:now+ttl};}
export function taskIsCurrent(stamp,{epoch,matchId=null,rulesVersion='0.6',now=Date.now()}){return stamp.epoch===epoch&&stamp.matchId===matchId&&stamp.rulesVersion===rulesVersion&&now<=stamp.validUntil;}


// ─────────────────────────────────────────────────────────────────────────────
// 局内主动提示的归属层：军师。
//
// 陪练（coach/companion.js + coach.js 的 coachEvent）管的是闲聊、情绪与记忆——
// 本局第一次有人倒下、整局结束。战术提示不属于它，所以局内主动层放在这里。
// 放在 experience.js（而不是新文件）是因为它本来就是「局内体验」这一层，而且
// browser.test.js 要求浏览器模块都在 server.js 的 publicAssets 静态名单里；
// 本任务不允许改 server.js，所以不新增文件。
//
// 军师只在三种「确实值得打断」的情形开口：
//   fall      伙伴倒下、必须补位（不可逆，而补位是免费动作）
//   hesitate  犹豫不决——复用上面的 trackAttention 悬停记录 + shouldNudge 的门槛
//   mistake   明显策略错误且造成后果——复用 rankEnemyActions 的真实枚举分差，
//             并且必须有 after 快照上的实际后果
//
// 克制不是「尽量少说」的口号，而是这里的硬约束：
//   · 每局总上限 3 次，每类触发各 1 次（reason 去重，所以第 2、3 只倒下不会再说）
//   · 同一回合只允许一次开口
//   · 同一理由（lesson）本局不重复
//   · 两次开口至少间隔 COOLDOWN_MS
//   · 复用 shouldNudge（每局 ≤2 次 / 45 秒冷却 / 本回合一次 / 关闭后本场静音）
//     与 adaptiveGate（近 7 天被关闭 2 次即降频）
//   · 安静档在最前面短路；玩家点掉任意一条即本局静音
export const STRATEGIST_LIMITS={maxPerMatch:3,cooldownMs:60000};
export const HESITATION={minHovers:3,minDistinct:2,minAgeMs:8000};
// 分差阈值复用下面 assessDecision 的判定：<=5 视为近似合理，不能算「明显错误」。
export const REASONABLE_GAP=5;

// 一局内军师自己的记账：说了几次、说过什么理由、上次什么时候说的。
// dismissed 在玩家点掉任意一条军师提示时置位——点掉就是「这局别再打断我」。
export function strategistSession(){return {hints:0,said:new Set(),lastAt:-Infinity,dismissed:false};}
export function resetStrategist(){return strategistSession();}

function playable(game){return !!game&&['pve','pvp-local'].includes(game.mode)&&!game.result;}
function round1(n){return Math.round(n*10)/10;}
function turnKey(game){return `${game.turn}:${game.phase}`;}
function sameAction(a,b){return !!a&&!!b&&a.kind===b.kind&&(a.id??null)===(b.id??null)&&(a.target??null)===(b.target??null);}
// 同分时的稳定偏好：先选不放弃本回合的选择（换宠/道具次之，撤退最后）。
// 只影响并列时的措辞，不改变任何枚举分数。
function preferred(a){return (a?.kind==='item'?10:0)+(a?.kind==='switch'?5:0)+(a?.kind==='escape'?-10:0);}
function pickRanked(ranked){
 const rows=(Array.isArray(ranked)?ranked:[]).filter(x=>x&&x.action);
 if(!rows.length)return null;
 return [...rows].sort((a,b)=>(Number.isFinite(b.score)?b.score:-Infinity)-(Number.isFinite(a.score)?a.score:-Infinity)||preferred(b.action)-preferred(a.action))[0];
}
export function actionLabel(game,side,a){
 if(!a)return '行动';
 if(a.kind==='skill')return a.id==='guard'?'防御':(SKILLS[a.id]?.name||a.id);
 if(a.kind==='switch')return `换上${game?.[side]?.pets?.[a.target]?.name||'伙伴'}`;
 if(a.kind==='item')return ITEMS[a.id]?.name||a.id;
 return '撤退';
}
function lessonOf(a){
 if(!a)return '行动取舍';
 if(a.kind==='switch')return '换宠承伤';
 if(a.id==='guard')return '防御节奏';
 if(a.kind==='item')return '道具时机';
 const sk=a.kind==='skill'?SKILLS[a.id]:null;
 if(sk?.heal)return '危险血线';
 return '行动取舍';
}
// 收尾机会：用 engine 的伤害公式枚举合法攻击，看是否存在一击结束本回合的选择。
// 与上面的 decisiveOpportunity 同源，但不要求「双方都残血」。
export function lethalOption(game){
 if(!playable(game)||game.phase!=='battle')return null;
 const p=active(game,'player'),q=active(game,'enemy');
 if(!p||!q||p.hp<=0||q.hp<=0)return null;
 return legalActions(game).filter(a=>a.kind==='skill'&&SKILLS[a.id]?.power)
  .map(a=>({action:a,hit:damage(p,q,SKILLS[a.id])}))
  .filter(x=>x.hit>=q.hp).sort((a,b)=>a.hit-b.hit)[0]||null;
}

// —— 明显策略错误 + 严重后果：两个条件都成立才成立 ——
// ① 真实枚举的一回合分差 > 5（rankEnemyActions/compareTurnAlternatives 的结果，
//    是启发式评分，不是胜率；措辞里也这么说）
// ② 后果落在 after 快照上，只有两种：
//    可救却减员（该回合还有回复药，伙伴仍在 after 里倒下）
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
  return {kind:'preventable-faint',gap,action,pet:p.name,beforeHp:p.hp,potions};
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
  lesson:decision.lesson||null,hadLethal:!!kill,lethal:kill?kill.action:null,lethalHit:kill?kill.hit:null,enemyHp:q?q.hp:null};
}

// 犹豫不决：复用 attentionState / trackAttention / shouldNudge，不另造计数。
// shouldNudge 已经包含「本回合已提示过、45 秒冷却、每局 ≤2 次、关闭后静音、安静档」，
// 这里只补军师自己的要求：至少扫过两个不同选项，且确实纠结了一段时间。
export function hesitationSignal(attention,{now=0,turn=null,mode='gentle',active=true,risk=false}={}){
 if(!attention||attention.dismissed)return null;
 if(!shouldNudge(attention,{now,turn,mode,active,risk}))return null;
 const scan=(attention.hovers||[]).filter(x=>x&&x.action);
 // 区分「不同选项」用行动的原始标识：对象要序列化，否则每个对象都变成 "[object Object]"，
 // 两个不同选项会被算成同一个，犹豫永远不成立。
 const scanKey=a=>typeof a==='string'?a:JSON.stringify(a);
 const kinds=[...new Set(scan.map(x=>scanKey(x.action)))];
 const held=now-(attention.since||0);
 if(kinds.length<HESITATION.minDistinct||scan.length<HESITATION.minHovers||held<HESITATION.minAgeMs)return null;
 return {kinds,held,hovers:scan.length};
}

// 悬停记录现在存的是解析后的 action 对象；早期存的是 DOM 的 data-action 字符串。
// 两种都要能翻译成玩家看得懂的名字，否则措辞里会冒出 {"kind":"skill"...}。
export function hoverLabel(game,record){
 const raw=typeof record==='string'?record:record?.action;
 if(typeof raw!=='string')return actionLabel(game,'player',raw);
 try{return actionLabel(game,'player',JSON.parse(raw));}catch{return raw.slice(0,20);}
}
function fallText(game,packet){
 const fallen=game.player.pets.find(x=>x.hp<=0);
 if(!fallen)return null;
 const scored=(packet?.actions||[]).filter(a=>a.kind==='switch');
 const listed=(scored.length?scored:legalActions(game).filter(a=>a.kind==='switch'))
  .map(a=>({action:a,pet:game.player.pets[a.target]})).filter(x=>x.pet&&x.pet.hp>0);
 const byState=[...listed].sort((a,b)=>(b.pet.hp+b.pet.energy*10)-(a.pet.hp+a.pet.energy*10));
 const best=listed[0]||null;   // scored 时是分支评分第一，否则已按 HP/能量排好
 const others=byState.filter(x=>x.pet.id!==best?.pet?.id);
 const basis=scored.length?'这是按下一回合攻守分支排的，不是胜率。':'这是按剩余 HP 与能量排的，不是胜率。';
 return `${fallen.name}倒下了。${best?`先让${best.pet.name}补位（还剩 ${best.pet.hp}HP、${best.pet.energy}豆）`:'现在没有健康的伙伴可以补位'}；补位不占回合，选好再决定出招。`
  +(others.length?`另外${others.map(x=>`${x.pet.name}（${x.pet.hp}HP、${x.pet.energy}豆）`).join('、')}也可以比较。`:'')
  +basis;
}
function mistakeText(game,incident){
 if(incident.kind==='missed-finish')
  return `刚才这回合有收尾机会：${actionLabel(game,'player',incident.lethal)}对当时的${active(game,'enemy')?.name||'对手'}算 ${incident.lethalHit} 伤害，对手只剩 ${incident.enemyHp}HP，你选了${actionLabel(game,'player',incident.action)}，它在 ${incident.enemyAfterHp}HP 活过了这回合。分差 ${round1(incident.gap)} 是一回合启发式评分，不是胜率，也不代表改这一手就一定能赢。`;
 if(incident.kind==='preventable-faint')
  return `${incident.pet}在 ${incident.beforeHp}HP 的回合倒下了（这一手之前它还活着），背包里还有 ${incident.potions} 瓶回复药。有药不等于那回合吃药一定更好，但这是当时可以先比较的分支。`;
 return null;
}
function hesitateText(game,signal,alt){
 const names=signal.kinds.slice(0,3).map(x=>hoverLabel(game,x)).join('、');
 return `你在${names}之间来回看了大约 ${Math.round(signal.held/1000)} 秒。${alt?`如果只是要找一件先定下来的事：「${actionLabel(game,'player',alt.action)}」是真实枚举里分最高的分支。`:'拿不准时，先比较对手留场和换宠两种分支。'}由你决定，不用回我。`;
}

// 军师该不该开口。纯函数：不碰 DOM、不碰记忆，只读 game / attention / session。
// 返回 null（不说）或 {reason,kind,lesson,text,basis,consume}（说，并带上可断言的理由）。
// consume() 把这次开口记进本局记账；app.js 只在真的显示之后才调用它。
export function strategistTrigger({game,attention=null,session=null,packet=null,incident=null,ranked=null,after=null,now=0,turn=null,mode='gentle',inMatch=true}={}){
 if(!inMatch||!playable(game))return null;
 if(mode==='quiet')return null;                                   // 安静档：任何触发都不例外
 if(game.phase==='ended')return null;
 const s=session||strategistSession();
 if(s.dismissed)return null;                                      // 玩家点掉了本局的军师提示
 if(s.hints>=STRATEGIST_LIMITS.maxPerMatch)return null;
 const tkey=turn||turnKey(game);
 if(s.said.has(`turn:${tkey}`))return null;                        // 同一回合只开口一次
 if(Number.isFinite(s.lastAt)&&now-s.lastAt<STRATEGIST_LIMITS.cooldownMs)return null;
 const reason=game.phase==='replace'?'fall':incident?'mistake':'hesitation';
 if(s.said.has(reason))return null;                                // 同一理由本局不重复
 const mark=(lesson)=>{s.hints++;s.lastAt=now;s.said.add(reason);s.said.add(`turn:${tkey}`);if(lesson)s.said.add(`lesson:${lesson}`);};
 if(reason==='fall'){
  if(!active(game,'player')||active(game,'player').hp>0)return null;
  const text=fallText(game,packet);if(!text)return null;
  return {reason,lesson:'换宠承伤',text,basis:{kind:'forced-replacement',turn:game.turn,freeAction:true},consume:()=>mark('换宠承伤')};
 }
 if(reason==='mistake'){
  const inc=strategicIncident(game,{action:incident.action,gap:incident.gap,after:after||incident.after});
  if(!inc)return null;
  const text=mistakeText(game,inc);if(!text)return null;
  const lesson=incident.lesson||lessonOf(incident.action);
  return {reason,kind:inc.kind,lesson,text,basis:{kind:inc.kind,gap:inc.gap,heuristic:true,notWinRate:true,consequence:inc.kind},consume:()=>mark(lesson)};
 }
 const signal=hesitationSignal(attention,{now,turn:tkey,mode,active:true,risk:false});
 if(!signal)return null;
 const alt=pickRanked(ranked)||pickRanked(packet?.ranked)||(packet?.actions?.[1]?{action:packet.actions[1]}:null);
 const lesson=lessonOf(alt?.action);
 return {reason,lesson,text:hesitateText(game,signal,alt),basis:{kind:'scanning',hovers:signal.hovers,distinct:signal.kinds.length,heldMs:signal.held,notWinRate:true},consume:()=>mark(lesson)};
}

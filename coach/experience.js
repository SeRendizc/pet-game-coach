import {strategist} from './strategist.js';
import {active,multiplier,actionName,legalActions,SKILLS,damage,effectiveSpeed} from '../engine.js';
export function observe(game){
 if(!game||game.mode!=='pve'||game.result)return null;
 const p=active(game,'player'),q=active(game,'enemy'),packet=strategist({battle:game,mode:game.mode});
 const reason=game.phase==='replace'?'伙伴倒下，需要补位':multiplier(q.type,p.type)>1?'当前处于属性劣势':p.energy<=1?'能量不足，留意恢复节奏':game.turn===1?'开场对位分析':'回合结束，重新评估局面';
 return {...packet,reason,turn:game.turn,action:packet.actions?.[0],title:packet.actions?.[0]?`可考虑：${actionName(game,'player',packet.actions[0])}`:'先选择补位伙伴',lesson:game.phase==='replace'||reason==='当前处于属性劣势'?'换宠承伤':p.energy<=1?'能量管理':'行动取舍'};
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
 if(!game||game.mode!=='pve'||game.result)return null;
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
 if(!game||game.mode!=='pve'||game.result||game.phase!=='battle')return null;
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
 if(!game||game.mode!=='pve'||game.result||game.phase!=='battle')return null;
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

import {stageOptions} from '../content.js';
import {SPECIES,createGame,SKILLS,damage,rankEnemyActions,actionName} from '../engine.js';
import {trainingCapacity} from '../progression.js';
function pet(context){const id=context.focus||'fox';return createGame(0,[id,...SPECIES.filter(p=>p.id!==id).slice(0,2).map(p=>p.id)],{pets:context.profile.pets}).player.pets[0];}
export function teacher(context){
 const p=pet(context),v=context.profile.pets[p.id],used=Object.values(v.points).reduce((a,b)=>a+b,0),free=trainingCapacity(v.level)-used;
 const target=createGame(0,undefined,stageOptions(context.stageId||'meadow')).enemy.pets[0];
 const preferred=context.goal==='速攻'?'atk':context.goal==='稳健'||['turtle','shroom','badger'].includes(p.id)?'hp':p.speed<=target.speed&&p.speed+3>target.speed?'speed':'atk';
 const chosen=[preferred,'atk','hp','speed'].find(k=>v.points[k]<5);const stat={hp:'耐久',atk:'力量',speed:'敏捷'}[chosen]||'保留资源';
 const budget=context.profile.tokens<1?'你目前没有训练点，可以先完成一场训练。':free===0?'当前培养格已满，可升级解锁，或免费重置后重新分配。':`还有 ${free} 个培养格、${context.profile.tokens} 个训练点。可以先试一次${stat}，再去训练场比较效果。`;
  const attack=p.skills.map(id=>SKILLS[id]).find(sk=>sk.power);
 const comparison=`当前关卡首发 ${target.name}，速度 ${target.speed}。敏捷培养：速度 ${p.speed} → ${p.speed+3}，${(p.speed>target.speed)===(p.speed+3>target.speed)?'没有改变与该对手的同优先级先后关系':'能改变与该对手的同优先级先后关系'}。力量培养：攻击 ${p.atk} → ${p.atk+4}，${attack?attack.name+'在对手不换宠、不防御时伤害 '+damage(p,target,attack)+' → '+damage({...p,atk:p.atk+4},target,attack):''}。耐久培养：生命 ${p.maxHp} → ${p.maxHp+12}。`;
 const reserve=context.favorite&&context.favorite!==p.id&&context.profile.tokens<=2;
 const reserveText=reserve?`先留给你的本命${SPECIES.find(x=>x.id===context.favorite)?.name||'伙伴'}`:'也可以先保留1点，实战后再分配';
 const headline=reserve?reserveText:free<=0?'培养格已满':context.profile.tokens<1?'先拿一点训练点':'先试1点'+stat;
 const reason=free<=0?(v.level<5?'再升一级解锁1格，或免费重置。':'已到最高等级，可以免费重置分配。'):context.profile.tokens<1?'完成一场训练就能获得。':chosen==='atk'?`攻击 ${p.atk} → ${p.atk+4}，提高每次出招的伤害。`:chosen==='hp'?`生命 ${p.maxHp} → ${p.maxHp+12}，多留一点承伤空间。`:`速度 ${p.speed} → ${p.speed+3}，超过该关首发的 ${target.speed}。`;
 return {headline,reason:reserve?'训练点不多，这只先不急着投入。':reason,goal:context.goal||null,favorite:context.favorite||null,reserveOption:reserveText,comparisons:[['生命',p.maxHp,p.maxHp+12],['攻击',p.atk,p.atk+4],['速度',p.speed,p.speed+3]],brief:free<=0||context.profile.tokens<1?budget:`${p.name}可先试1点${stat}。速度${p.speed}对${target.speed}，${p.speed>target.speed?'已经更快，不必急着加敏捷':p.speed+3>target.speed?'加敏捷能超过对手':'加一次敏捷仍不能稳拿先手'}。`,text:`${p.name}先考虑${stat}。当前关卡首发${target.name}速度${target.speed}，你的速度${p.speed}，${p.speed>target.speed?'已经更快，暂时不需要靠敏捷抢先手':p.speed===target.speed?'目前平速，不能保证先手':'目前较慢，要看加点后能否超过'}。${budget}`,evidence:[reserveText,`玩家明确目标：${context.goal||'未设置'}；本命：${context.favorite||'未设置'}。`,comparison,`当前生命 ${p.maxHp}，攻击 ${p.atk}，防御 ${p.def}，速度 ${p.speed}。`,'一次培养：生命 +12 / 攻击 +4 / 速度 +3；不会替你执行加点。'],method:'读取当前宠物与资源 → 职责建议 → 训练验证'};
}
export function makeQuiz(context,{variant=0}={}){
 const p=pet(context),offset=[2,4,3][variant%3],enemy=p.speed+offset;
 const answer=offset<3?'先':offset>3?'后':'不确定';
 return {id:`speed:${p.id}:${p.speed}:${enemy}`,variant,question:`假设练习（不是当前敌人的面板）：${p.name}速度 ${p.speed}，对手速度 ${enemy}。培养一次敏捷（+3），双方技能优先级相同，你会先出手、后出手，还是无法确定？`,answer,explanation:`培养后速度 ${p.speed}+3=${p.speed+3}，对手 ${enemy}。${answer==='不确定'?'同速时由随机过程决定，不能保证先手。':answer==='先'?'同优先级下速度更高，先出手。':'同优先级下速度仍更低，后出手。'}`,lesson:'速度比较：同优先级时，速度更高者先行动。',evidenceIds:['tactic:priority','tactic:speed-tie','tactic:training']};
}
export function review(context){const h=context.lastTurn;if(!h)return {text:'暂时没有回合记录。完成一个回合后再来，我会按当时的信息解释。',evidence:[]};return {text:`第 ${h.before.turn} 回合的事实记录：${h.events.filter(x=>!x.startsWith('──')).join(' ')} 下一次先检查属性、出手优先级和速度。单次输赢不能直接证明选择对错。`,evidence:['来源：实际回合日志；未把事后结果当作决策正确性的唯一依据。'],method:'读取已完成回合 → 事实复盘'};}

export function summarizeMatch(match){
 const turns=match?.history?.filter(h=>h.type==='turn')||[];if(!turns.length)return null;
 const remaining=s=>s.pets.filter(p=>p.hp>0).length;
 const counts={switches:0,guards:0,items:0,attacks:0,escapes:0};
 const ranked=turns.map((h,i)=>{
  const a=h.action;if(a.kind==='escape')counts.escapes++;else if(a.kind==='switch')counts.switches++;else if(a.kind==='item')counts.items++;else if(a.id==='guard')counts.guards++;else counts.attacks++;
  const lost=remaining(h.before.player)-remaining(h.after.player),kills=remaining(h.before.enemy)-remaining(h.after.enemy);
  const loss=h.before.player.pets.reduce((n,p,j)=>n+Math.max(0,p.hp-h.after.player.pets[j].hp),0);
  return {h,importance:(lost+kills)*100+loss+(a.kind==='switch'?15:0),i};
 });
 const selected=ranked.slice().sort((a,b)=>b.importance-a.importance).slice(0,3).sort((a,b)=>a.i-b.i);
 return {remainingItems:structuredClone(turns.at(-1).after.player.items),id:match.id||'current',rulesVersion:match.version,stage:match.stageName||match.stage||'训练场',result:match.result||'ongoing',rounds:turns.length,counts,
  team:turns[0].before.player.pets.map(p=>p.name),survivors:remaining(turns.at(-1).after.player),
  keyTurns:selected.map(({h})=>({id:`${match.id||'current'}:turn:${h.before.turn}`,turn:h.before.turn,hpBefore:h.before.player.pets.concat(h.before.enemy.pets).map(p=>({name:p.name,hp:p.hp})),hpAfter:h.after.player.pets.concat(h.after.enemy.pets).map(p=>({name:p.name,hp:p.hp})),playerPet:h.before.player.pets[h.before.player.active].name,playerActionCancelled:h.events.some(e=>e.includes('你的宠物已倒下，原定行动取消')),action:h.action,events:h.events.filter(x=>!x.startsWith('──')),analysis:analyzeTurn(h,{rulesVersion:match.version}),alternatives:compareTurnAlternatives(h,match.version)}))};
}
export function analyzeTurn(h,{rulesVersion='0.6'}={}){
 if(!h)return '缺少这回合的原始记录。';
 if(rulesVersion!=='0.6')return '这条记录的规则版本与当前计算器不匹配，只展示原始事件，不重新推算伤害。';
 const p=h.before.player.pets[h.before.player.active],q=h.before.enemy.pets[h.before.enemy.active];
 const a=h.action;
 if(a.kind==='escape')return '选择撤退后直接结束对局，没有再消耗技能或承受敌方行动，也不获得本场成长奖励。';
 if(a.kind==='switch'){
  const incoming=h.before.player.pets[a.target],after=h.after.player.pets[a.target];
  return `换上${incoming.name}占用了整回合，生命从${incoming.hp}到${after.hp}。这次用当回合输出机会换取新对位；还要看它是否承担后续反制职责，不能只因最后赢了就说这次换宠正确。`;
 }
 if(a.kind==='item')return `这一回合用道具取代出招，随后仍给对手行动机会。${p.name}回合前${p.hp}HP，结束时${h.after.player.pets[h.before.player.active].hp}HP；要比较恢复带来的生存空间与放弃进攻的成本。`;
 if(a.id==='guard')return `这次防御用了整回合输出机会换减伤与回能；回合前${p.energy}豆。下回合不能连续防御，要提前留攻击、换宠或道具的接续。`;
 const sk=SKILLS[a.id];if(!sk)return '当前规则已无法识别该技能，保留原始记录，不补造计算。';
 if(sk.power){const hit=damage(p,q,sk),guarded=damage(p,q,sk,true);return `${sk.name}对当时${q.name}的直接伤害：不防御${hit}、防御${guarded}，目标当时${q.hp}HP。${hit>=q.hp?'具备静止目标的收尾条件':'单次直接攻击不足以收尾'}；这是事前条件比较，对方治疗、换宠及先出手都可能改变结果。`;}
 return `选择${sk.name}时要承担放弃本回合攻击的成本；结合原始记录核对实际恢复与后续承伤。`;
}
export function reviewMatch(context){
 const m=context.lastMatch;if(!m)return {text:'暂时没有可用的完整对局记录。旧版只存了最后一回合的历史无法还原整局。新版本会保存完整对局；如果当前对局还在页面里，可直接从现有记录复盘。',evidence:[],scope:'match'};
 const outcome={win:'胜利',loss:'失利',draw:'平局',escaped:'撤退',ongoing:'尚未结束'}[m.result]||m.result;
 const key=m.keyTurns.slice().sort((a,b)=>(b.alternatives?.gap||0)-(a.alternatives?.gap||0))[0];
 const lesson=m.result==='loss'&&m.remainingItems?.potion>0?`结束时还剩${m.remainingItems.potion}瓶回复药。下次在伙伴进入危险血线时，先比较吃药、换宠和继续攻击，别等倒下再救；有药不代表那回合吃药一定更好。`:key?.alternatives?.gap>5?`第${key.turn}回合值得回看：当时可比较「${key.alternatives.rows[0].name}」，这是事前一回合评分，不代表改这一手就一定能赢。`:null;
 const theme=lesson|| (m.counts.guards+m.counts.items>m.rounds/2?'这局防御和道具占了一半以上，重点看看哪些回合可以转为进攻。':m.counts.switches>=4?'这局有多次轮换，重点看换入承伤是否换来了后续机会。':'先看造成减员或生命变化较大的回合，比较当时还有哪些选择。');
 return {brief:lesson||`${m.stage}，${outcome}。先回看第${key?.turn||1}回合，比较当时的其他选择。`,textFacts:m,text:`${m.stage}，共${m.rounds}回合，${outcome}。攻击/其他技能${m.counts.attacks}次、防御${m.counts.guards}次、道具${m.counts.items}次、换宠${m.counts.switches}次${m.counts.escapes?`、撤退${m.counts.escapes}次`:""}。${theme}`,scope:'match',matchId:m.id,
  evidence:[`整局统计：${JSON.stringify({rounds:m.rounds,counts:m.counts,remainingItems:m.remainingItems})}`,...m.keyTurns.map(k=>`[${k.id}] 第${k.turn}回合：${k.events.join(' ')}\n${k.analysis}\n${k.alternatives?.text||''}`)],choices:m.keyTurns.map(k=>`详看第${k.turn}回合`),method:'完整回合统计 → 减员与生命变化选点 → 事前条件分析（不等于全局最优）'};
}

export function compareTurnAlternatives(h,version='0.6'){
 if(!h||version!=='0.6'||h.action.kind==='escape'||h.before.phase!=='battle')return null;
 const g={...structuredClone(h.before),version,mode:'pve',seed:0,initialSeed:0,result:null,history:[],log:[],frames:[]};
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player});
 const actual=ranked.find(x=>JSON.stringify(x.action)===JSON.stringify(h.action));
 if(!actual||!ranked[0])return null;
 const rows=ranked.slice(0,2).map(x=>({action:x.action,name:actionName(g,'player',x.action),expected:x.expected,worst:x.worst,score:x.score}));
 return {rows,actualScore:actual.score,gap:ranked[0].score-actual.score,
  text:rows.map(x=>`${x.name}：平均分${x.expected.toFixed(1)}、最坏分${x.worst.toFixed(1)}`).join('；')+`。你的选择${ranked[0].score-actual.score<=5?'与最高分接近，不能因排序不同就判错':'在此一回合评分下较低，可比较别的分支，但不能据此断言长期策略错误'}。只用回合前公开状态枚举，不把对方实际出招当成预先已知。`};
}

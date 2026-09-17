import {TACTIC_CARDS,REFERENCE_CARDS} from '../content.js';
import {RULES_VERSION} from '../engine.js';
export {RULES_VERSION};
export const cards=[...TACTIC_CARDS,...REFERENCE_CARDS];
import {rankEnemyActions,active,actionName,SKILLS,damage,legalActions,effectiveSpeed} from '../engine.js';
export function strategist(context){
 const g=context.battle;
 if(context.mode==='pvp-live')return {text:'正式 PVP 赛中不提供战术建议，结束后再复盘。',evidence:[]};
 if(!g||g.result)return {text:'进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。',evidence:[]};
 if(g.phase==='replace'){
  const candidates=legalActions(g).filter(a=>a.kind==='switch').map(action=>{
   const next=structuredClone(g);next.player.active=action.target;next.phase='battle';
   const ranked=rankEnemyActions({...next,player:next.enemy,enemy:next.player});
   return {action,pet:g.player.pets[action.target],score:ranked[0]?.score??-Infinity,nextAction:ranked[0]?.action};
  }).sort((a,b)=>b.score-a.score);
  const best=candidates[0],fallen=active(g,'player'),q=active(g,'enemy');
  if(!best)return {text:'目前没有可补位的存活伙伴。',evidence:[]};
  return {text:`${fallen.name}倒下了，先让${best.pet.name}补位。它还剩${best.pet.hp}HP、${best.pet.energy}豆；补位免费，选好后再决定出招。这是按下一回合的攻守分支比较，对手仍可能换宠。`,
   actions:candidates.map(c=>c.action),evidence:[`当前对手${q.name}：${q.hp}HP、${q.energy}豆。倒下后的补位不占回合，也不会触发一次额外攻击。`,...candidates.map(c=>`${c.pet.name}：${c.pet.hp}HP、${c.pet.energy}豆${c.pet.status?'，'+c.pet.status.kind:''}；补位后下一回合最佳分支评分${c.score.toFixed(1)}（非胜率，不计免费补位为承伤回合）。`)]};
 }
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player});
 const best=ranked[0]?.action;if(!best)return {text:'当前没有可分析的合法行动。',evidence:[]};
 const p=active(g,'player'),q=active(g,'enemy');
 const evidence=[`${p.name}：${p.hp}/${p.maxHp} HP，能量 ${p.energy}，速度 ${effectiveSpeed(p)}。`,`${q.name}：${q.hp}/${q.maxHp} HP，能量 ${q.energy}，速度 ${effectiveSpeed(q)}。`];
 if(best.kind==='skill'&&SKILLS[best.id].power)evidence.push(`若对手不换宠、不防御，${SKILLS[best.id].name}对当前目标计算伤害为 ${damage(p,q,SKILLS[best.id])}；实际结算受对手行动影响。`);
 const text=`这一回合优先考虑「${actionName(g,'player',best)}」。${ranked[1]?'可比较的备选是「'+actionName(g,'player',ranked[1].action)+'」。':''}这是结合双方合法行动的一回合风险比较，不能保证后续最优或获胜。`;
 const knowledge=searchKnowledge(context.query||'换宠 预判 能量 '+(q.status?'灼烧 追猎':'先手'),{limit:3,game:g,rulesVersion:g.version});
 evidence.push(...knowledge.cards.map(c=>`[${c.id}] ${c.principle} 注意：${c.counterexample} 条件：${c.applicability.status}`));
 evidence.push(...ranked.slice(0,2).map(x=>`${actionName(g,'player',x.action)}：平均局面分 ${x.expected.toFixed(1)}，最坏分 ${x.worst.toFixed(1)}（启发式评分，非胜率）。对方换宠分支：${x.switchScore===null?'无合法换宠':x.switchScore.toFixed(1)}。`));
 return {text,evidence,knowledge:knowledge.cards,actions:ranked.slice(0,2).map(x=>x.action),method:'合法行动枚举 → 共用结算器 → 平均收益与最坏情况比较'};
}

const aliases = [['奶', '治疗'], ['秒杀', '击倒 收尾'], ['蓝量', '能量'], ['先动', '先手 速度'], ['肉盾', '承伤 防御']];
function tokens(text) {
  let s = String(text).toLowerCase();
  for (const [from, to] of aliases) if (s.includes(from)) s += ' ' + to;
  return new Set([...s.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g)].flatMap(m =>
    /^[a-z0-9]+$/.test(m[0]) ? [m[0]] : Array.from({length:m[0].length-1}, (_,i)=>m[0].slice(i,i+2))));
}

// Concept expansion is inspectable domain vocabulary, not a pretrained embedding model.
const concepts=[
 ['轮换 换宠 挡刀 换上 双换 读换 反复换 车轮 转场','换宠 承伤 行动成本 预判'],
 ['补血 奶 回满 药水 回复 治疗 续命','治疗 回复药 净消耗'],
 ['豆 豆子 蓝 能量 缺蓝 空蓝 回蓝','能量 防御 恢复 成本'],
 ['抢速 超车 抢先 先动 优先 后手','先手 速度 优先级'],
 ['残血 收割 秒掉 补刀 斩杀','收尾 击倒 溢出'],
 ['站着挨打 挂毒 耗死 毒伤 烧伤','异常 中毒 灼烧 回合末'],
 ['堵住 招架 格挡 穿盾 破盾','防御 穿透 重击'],
 ['看不懂 随机 种子 复现','随机 种子 同速'],
];
function expandQuery(query){let out=String(query);for(const [terms,expansion] of concepts)if(terms.split(' ').some(t=>out.includes(t)))out+=' '+expansion;return out;}
export function searchKnowledge(query, {rulesVersion=RULES_VERSION, limit=3, budget=2400,strategy='lexical',game=null}={}) {
 if (!Number.isInteger(limit)||limit<1||limit>10||!Number.isFinite(budget)||budget<0)throw Error('Invalid retrieval budget');
 const eligible=cards.filter(c=>c.game==='pet-coach'&&c.rulesVersion===rulesVersion&&c.status==='active');
 const q=tokens(strategy==='lexical'?query:expandQuery(query));
 const docs=eligible.map(c=>[tokens(c.title+' '+c.keywords),tokens(c.principle+' '+c.counterexample)]);
 const df=new Map();for(const fields of docs)for(const t of new Set([...fields[0],...fields[1]]))df.set(t,(df.get(t)||0)+1);
 const ranked=eligible.map((card,i)=>{
  const fields=docs[i];let score=0;
  for(const t of q){const tf=fields[0].has(t)?3:fields[1].has(t)?1:0;
   score+=strategy==='lexical'?tf:tf*Math.log(1+(eligible.length-(df.get(t)||0)+.5)/((df.get(t)||0)+.5));}
  return {...card,score,applicability:applicability(card,game)};
 }).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
 const result=[];let used=0;
 for(const card of ranked){const size=JSON.stringify(card).length;if(used+size>budget)continue;result.push(card);used+=size;if(result.length===limit)break;}
 return {rulesVersion,cards:result,usedCharacters:used,method:strategy==='lexical'?'weighted lexical / Chinese bigrams':'IDF lexical + domain concept expansion',missing:!result.length};
}
export function applicability(card,game){
 const absent=[];
 if(!game)return {status:'reference-only',missing:['当前战况'],verified:[]};
 if(game.version!==card.rulesVersion)return {status:'version-mismatch',missing:['匹配规则版本'],verified:[]};
 const p=active(game,'player'),q=active(game,'enemy');
 const checks={'battle':!!p&&!!q,'burn':q?.status?.kind==='burn','reserve':game.player.pets.some((x,i)=>x.hp>0&&i!==game.player.active),'energy':p?.energy<=2,'potion':game.player.items.potion>0,'poison':p?.status?.kind==='poison','slow':!!p?.speedDown||!!q?.speedDown};
 for(const key of card.conditions||['battle'])if(!checks[key])absent.push(key);
 return {status:absent.length?'conditions-not-met':'candidate',missing:absent,verified:(card.conditions||['battle']).filter(k=>checks[k]),warning:'匹配条件不等于建议最优；还需比较合法行动及对手分支'};
}
export function resolveCitation(id,rulesVersion=RULES_VERSION){return cards.find(c=>c.id===id&&c.rulesVersion===rulesVersion&&c.status==='active')||null;}
export function verifyCitations(ids,rulesVersion=RULES_VERSION){return {valid:ids.every(id=>!!resolveCitation(id,rulesVersion)),missing:ids.filter(id=>!resolveCitation(id,rulesVersion))};}

export function buildKnowledgePacket(query, game=null, options={}) {
  // Deny before retrieving or calculating tactical evidence.
  if (game && game.mode!=='pve') return {blocked:true, reason:'Live tactical evidence is restricted to PVE'};
  if (game && game.version!==RULES_VERSION) return {blocked:true, reason:'Unverified rules version'};
  const retrieved=searchKnowledge(query, {...options, game, rulesVersion:game?.version || options.rulesVersion || RULES_VERSION});
  const comparisons=[];
  if (game && !game.result && game.phase==='battle') {
    const p=active(game,'player'), q=active(game,'enemy');
    if(p.hp>0 && q.hp>0) for(const action of legalActions(game).filter(a=>a.kind==='skill' && SKILLS[a.id].power)) {
      const skill=SKILLS[action.id];
      const hit=damage(p,q,skill), guarded=damage(p,q,skill,true);
      comparisons.push({evidenceId:`turn:${game.turn}:damage:${action.id}`,skill:action.id,name:skill.name,cost:skill.cost,
        unguardedDamage:hit,guardedDamage:guarded,canKOStationaryUnguardedTarget:hit>=q.hp,
        assumption:'仅比较当前目标直接伤害；未计对方治疗、换宠、先击倒我方与回合末异常，非行动胜率。'});
    }
  }
  return {blocked:false, ...retrieved, turn:game?.turn ?? null, comparisons,
    instruction:'卡片是待验证的战术假设。引用卡片时核对反例与 requiredEvidence；缺少分支计算不得声称唯一最优或玩家失误。'};
}

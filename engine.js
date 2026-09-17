export const RULES_VERSION='0.6';
export const DIFFICULTIES = {easy:{name:'轻松',description:'简单出招，适合熟悉技能'},normal:{name:'标准',description:'优先伤害与治疗，适合日常训练'},hard:{name:'挑战',description:'模拟双方行动，兼顾收益与风险'}};
export const TYPES = { fire: '火', water: '水', leaf: '草', normal: '普通', rock:'岩', electric:'雷',wind:'风' };
export const SKILLS = {
 focus:{name:'蓄势',type:'normal',cost:2,buff:'atk',desc:'攻击提高15%，最多2层；持续3次在场回合末，主动换宠清空'},
 shell:{name:'护甲',type:'normal',cost:2,buff:'def',desc:'防御提高15%，最多2层；持续3次在场回合末，主动换宠清空'},
 dispel:{name:'破势',type:'normal',cost:2,power:16,dispel:true,desc:'命中后清除目标攻防强化；防御可阻挡驱散'},
 gust:{name:'风刃',type:'wind',cost:2,power:27,desc:'稳定风系攻击'},
 tempest:{name:'回旋风暴',type:'wind',cost:4,power:42,desc:'高消耗风系爆发'},
 clearwind:{name:'清风',type:'wind',cost:1,clearEnvironment:true,desc:'移除当前环境；不造成伤害，不移除异常'},

  stonebreak:{name:'碎岩冲击',type:'rock',power:26,cost:3,pierce:true,desc:'岩系攻击，穿过防御技能减伤'},
  gravel:{name:'砾石弹',type:'rock',power:22,cost:2,desc:'稳定的岩系攻击'},
  staticbolt:{name:'迟滞电弧',type:'electric',power:18,cost:2,slow:6,desc:'命中后目标速度降低6，影响下一回合；防御可挡，换宠后保留但暂停计时'},
  discharge:{name:'蓄能放电',type:'electric',power:40,cost:4,desc:'高消耗雷系爆发，注意后续能量'},
  strike: {name:'撞击',type:'normal',power:18,cost:0,desc:'无消耗，稳定攻击'},
  ember: {name:'火花',type:'fire',power:27,cost:2,desc:'火系攻击；施加灼烧 2 回合',status:'burn'},
  flare: {name:'舍身烈焰',type:'fire',power:50,cost:4,recoil:.2,desc:'高爆发；承受实际伤害 20% 的反伤'},
  pursuit: {name:'余烬追猎',type:'fire',power:24,cost:2,burnBonus:18,desc:'对灼烧目标威力 +18，适合火花后追击'},
  dash: {name:'疾爪',type:'normal',power:16,cost:0,priority:1,desc:'先制攻击，优先于普通攻击'},
  crush: {name:'破甲重击',type:'normal',power:30,cost:3,pierce:true,desc:'无视防御技能减伤，不施加灼烧'},
  drain: {name:'生息藤',type:'leaf',power:24,cost:2,drain:.4,desc:'吸取实际伤害 40% 的生命'},
  moss: {name:'苔息',cost:3,heal:28,desc:'恢复自身 28 HP，按速度行动'},
  wave: {name:'水流弹',type:'water',power:29,cost:2,desc:'水系攻击'},
  tide: {name:'潮汐重击',type:'water',power:42,cost:4,desc:'高伤害水系攻击'},
  vine: {name:'藤鞭',type:'leaf',power:29,cost:2,desc:'草系攻击'},
  spore: {name:'毒孢子',type:'leaf',power:12,cost:2,desc:'草系攻击；施加中毒 3 回合',status:'poison'},
  guard: {name:'防御',cost:0,priority:3,desc:'本回合减伤 65%，阻挡新异常，额外恢复 2 能量；不可连续使用'},
};
export const SPECIES = [
  {id:'fox',name:'烬尾狐',icon:'🦊',type:'fire',maxHp:98,atk:27,def:17,speed:38,skills:['dash','ember','pursuit','guard'],bio:'高速游击',trait:'火花挂灼烧，追猎增伤；疾爪先制收尾'},
  {id:'turtle',name:'潮甲龟',icon:'🐢',type:'water',maxHp:132,atk:22,def:30,speed:13,skills:['strike','wave','tide','guard'],bio:'守势水盾',trait:'防御时额外恢复 8 HP，适合承接换入伤害',guardHeal:8},
  {id:'deer',name:'芽角鹿',icon:'🦌',type:'leaf',maxHp:108,atk:27,def:21,speed:29,skills:['strike','vine','drain','guard'],bio:'吸血续航',trait:'生息藤吸血；速度与持续作战兼顾'},
  {id:'lion',name:'炽鬃狮',icon:'🦁',type:'fire',maxHp:116,atk:34,def:18,speed:19,skills:['strike','crush','flare','guard'],bio:'破防重炮',trait:'重击穿过防御技能减伤；烈焰高爆发但反伤，无灼烧'},
  {id:'otter',name:'溪刃獭',icon:'🦦',type:'water',maxHp:100,atk:30,def:17,speed:34,skills:['dash','wave','tide','guard'],bio:'先制速攻',trait:'疾爪抢先收尾，水流与潮汐负责爆发'},
  {id:'shroom',name:'苔盾菇',icon:'🍄',type:'leaf',maxHp:126,atk:21,def:27,speed:11,skills:['strike','spore','moss','guard'],bio:'毒疗消耗',trait:'孢子中毒配合苔息恢复，怕高速爆发'},
  {id:'badger',name:'砾背獾',icon:'🦡',type:'rock',maxHp:120,atk:25,def:30,speed:15,skills:['gravel','stonebreak','strike','guard'],bio:'守势反击',trait:'防御时若遭攻击，向存活攻击者反击4点；碎岩可穿过防御减伤',guardCounter:4},
  {id:'sparrow',name:'鸣电雀',icon:'🐦',type:'electric',maxHp:94,atk:25,def:18,speed:31,skills:['staticbolt','discharge','dash','guard'],bio:'控速突袭',trait:'迟滞电弧降低速度，下一回合争先；低血量，铺垫时需要承伤'},
  {id:'falcon',name:'岚翎隼',icon:'🦅',type:'wind',maxHp:92,atk:29,def:17,speed:40,skills:['dash','gust','tempest','guard'],bio:'高速清场',trait:'速度高，可移除环境；血量低，怕岩与雷'},
  {id:'moth',name:'云绒蛾',icon:'🦋',type:'wind',maxHp:110,atk:21,def:24,speed:25,skills:['gust','shell','clearwind','guard'],bio:'防守支援',trait:'护甲与清风改变对局条件；直接输出偏低'},
  {id:'rhino',name:'晶角犀',icon:'🦏',type:'rock',maxHp:128,atk:27,def:31,speed:10,skills:['gravel','focus','stonebreak','guard'],bio:'慢速蓄势',trait:'蓄势后进攻，怕驱散和水草克制'},
  {id:'marten',name:'伏光貂',icon:'🐾',type:'electric',maxHp:90,atk:32,def:16,speed:35,skills:['dash','discharge','focus','guard'],bio:'爆发抢攻',trait:'输出高但脆，蓄势时需要承受攻击'},
];
const extraSkills={fox:['focus','dispel'],turtle:['shell','dispel'],deer:['focus','shell'],lion:['focus','dispel'],otter:['focus','dispel'],shroom:['shell','dispel'],badger:['shell','dispel'],sparrow:['focus','dispel'],falcon:['clearwind','dispel'],moth:['dispel','tempest'],rhino:['shell','dispel'],marten:['staticbolt','dispel']};
for(const p of SPECIES)p.learnset=[...p.skills,...extraSkills[p.id]];
export const HELD_ITEMS={none:{name:'不携带',desc:'没有被动效果'},shellCharm:{name:'守心石',desc:'满血时第一次受攻击伤害减少15%，每局一次'},energySeed:{name:'蓄能籽',desc:'在场存活回合末能量≤1时额外恢复2点，每局一次'}};
export const ENVIRONMENTS={rain:{name:'细雨',turns:4,multipliers:{water:1.1,fire:.9},desc:'前4回合水系伤害×1.1、火系×0.9；清风可提前移除'},gale:{name:'山风',turns:4,multipliers:{wind:1.1,rock:.9},desc:'前4回合风系伤害×1.1、岩系×0.9；清风可提前移除'}};
export const ITEMS = {
  potion:{name:'回复药',desc:'为任意存活队友恢复 45 HP',count:3},
  cleanse:{name:'净化药',desc:'清除任意存活队友的异常',count:2},
  ether:{name:'能量果',desc:'为任意存活队友恢复 4 能量',count:2},
};
// Relationships are explicit; no type immunities or same-type attack bonus.
export const TYPE_ADVANTAGES={fire:['leaf'],water:['fire','rock'],leaf:['water','rock'],rock:['fire','electric','wind'],electric:['water','wind'],wind:['leaf']};
export function multiplier(a,b){
 if(a==='normal')return 1;
 if(TYPE_ADVANTAGES[a]?.includes(b))return 1.5;
 if(a===b||TYPE_ADVANTAGES[b]?.includes(a))return .75;
 return 1;
}
export function effectiveSpeed(p){return Math.max(1,p.speed-(p.speedDown?.amount||0));}
export function damage(attacker,defender,skill,guard=false) {
  return Math.max(1,Math.round((skill.power+(skill.burnBonus&&defender.status?.kind==='burn'?skill.burnBonus:0)+attacker.atk*(1+.15*(attacker.buffs?.atk?.stacks||0))*.6-defender.def*(1+.15*(defender.buffs?.def?.stacks||0))*.4)*multiplier(skill.type,defender.type)*(guard&&!skill.pierce?.35:1)*(attacker.environment?.multipliers?.[skill.type]||1)*(defender.heldItem==='shellCharm'&&!defender.heldUsed&&defender.hp===defender.maxHp?.85:1)));
}
export function createGame(seed=17,team=['fox','turtle','deer'],options={}) {
  if (team.length!==3 || new Set(team).size!==3 || team.some(id=>!SPECIES.some(p=>p.id===id))) throw Error('请选择三只不同的宠物');
  const make = (ids,enemy=false)=>({active:0,pets:ids.map(id=>{
    const p=structuredClone(SPECIES.find(p=>p.id===id));
    const trained=enemy?options.enemyPets?.[id]:options.pets?.[id];
    const level=trained?.level||(enemy?(options.enemyLevel||1):1);
    const points=trained?.points||{};
    if(Array.isArray(trained?.loadout)&&trained.loadout.length===4&&new Set(trained.loadout).size===4&&trained.loadout.every(x=>p.learnset.includes(x)))p.skills=[...trained.loadout];
    p.heldItem=Object.hasOwn(HELD_ITEMS,trained?.heldItem)?trained.heldItem:'none';p.heldUsed=false;p.buffs={};p.environment=options.environment?structuredClone(ENVIRONMENTS[options.environment]):null;
    p.level=level;p.maxHp+=(level-1)*5+(points.hp||0)*12;
    p.atk+=(level-1)+(points.atk||0)*4;p.def+=level-1;p.speed+=(points.speed||0)*3;
    return {...p,hp:p.maxHp,energy:5,status:null,lastGuard:false};
  }),items:Object.fromEntries(Object.entries(ITEMS).map(([k,v])=>[k,v.count]))});
  const enemyTeams=[['shroom','otter','lion'],['lion','turtle','deer'],['otter','fox','shroom']];
  return {version:RULES_VERSION,environment:options.environment?structuredClone(ENVIRONMENTS[options.environment]):null,stageId:options.stageId||null,stageName:options.stageName||null,preview:!!options.preview,difficulty:DIFFICULTIES[options.difficulty]?options.difficulty:'hard',mode:options.mode||'pve',seed:seed>>>0,initialSeed:seed>>>0,turn:1,phase:'battle',result:null,replaceQueue:null,replaceSide:null,player:make(team),enemy:make(options.enemyTeam||enemyTeams[(seed>>>0)%3],true),history:[],log:[options.mode==='pvp-local'?'本地对战开始。双方各选行动后同时结算；换宠占用整回合。':'PVE 训练开始。双方行动同时决定；火克草，草克水，水克火。']};
}
export function active(g,side) {return g[side].pets[g[side].active];}
function random(g) {g.seed=(Math.imul(g.seed,1664525)+1013904223)>>>0;return g.seed/4294967296;}
export function legalActions(g,side='player') {
  if(g.result) return [];
  const s=g[side], p=active(g,side), swaps=s.pets.flatMap((p,i)=>p.hp>0&&i!==s.active?[{kind:'switch',target:i}]:[]);
  if(p.hp<=0) return swaps;
  if(g.phase==='replace' && side===(g.replaceSide||'player')) return swaps;
  const skills=p.skills.filter(id=>SKILLS[id].cost<=p.energy && !(id==='guard'&&p.lastGuard) && !(SKILLS[id].heal&&p.hp===p.maxHp) && !(SKILLS[id].clearEnvironment&&!g.environment)).map(id=>({kind:'skill',id}));
  const items=Object.keys(ITEMS).flatMap(id=>s.items[id]>0?s.pets.flatMap((p,i)=>p.hp>0&&((id==='potion'&&p.hp<p.maxHp)||(id==='ether'&&p.energy<6)||(id==='cleanse'&&p.status))?[{kind:'item',id,target:i}]:[]):[]);
  return [...skills,...swaps,...items,{kind:'escape'}];
}
function same(a,b) {return a.kind===b.kind && a.id===b.id && a.target===b.target;}
export function actionName(g,side,a) {
  if(a.kind==='skill') return SKILLS[a.id].name;
  if(a.kind==='switch') return `换上${g[side].pets[a.target].name}`;
  if(a.kind==='item') return `${ITEMS[a.id].name} → ${g[side].pets[a.target].name}`;
  return '撤退';
}
// Enumerate both sides' legal actions against a shared resolver. No pending player action.
function strength(s) {
  return s.pets.reduce((v,p)=>v+(p.hp>0?90+p.hp/p.maxHp*80+p.energy*2+Object.values(p.buffs||{}).reduce((n,b)=>n+b.stacks*5,0)-(p.status?p.status.remaining*(p.status.kind==='burn'?4:5):0):0),0)
    +s.items.potion*9+s.items.cleanse*3+s.items.ether*3;
}
export function evaluate(g,side='enemy') {
  const other=side==='enemy'?'player':'enemy';
  const living=s=>g[s].pets.some(p=>p.hp>0);
  if(!living(side)||!living(other))return living(side)?10000:living(other)?-10000:0;
  let value=strength(g[side])-strength(g[other]);
  const p=active(g,side),q=active(g,other);
  if(p.hp>0&&q.hp>0)value+=(multiplier(p.type,q.type)-multiplier(q.type,p.type))*9+(effectiveSpeed(p)>effectiveSpeed(q)?2:-2);
  return value;
}
export function rankEnemyActions(g,{goal=null}={}) {
  const actions=legalActions(g,'enemy').filter(a=>a.kind!=='escape');
  const replies=legalActions(g,'player').filter(a=>a.kind!=='escape');
  if(!replies.length)return actions.map(action=>({action,score:0}));
  // Plausible player actions have more weight; every legal reply still contributes to the risk floor.
  const rawWeights=replies.map(a=>{
    const p=active(g,'player'),q=active(g,'enemy');
    if(a.kind==='skill')return a.id==='guard'?(p.energy<2?3:1):SKILLS[a.id].heal||SKILLS[a.id].buff||SKILLS[a.id].clearEnvironment?1:Math.max(1,damage(p,q,SKILLS[a.id])/18);
    if(a.kind==='item')return a.target===g.player.active?2:.4;
    return 1;
  });
  const total=rawWeights.reduce((a,b)=>a+b,0);
  // 目标偏好只改「平均收益」与「最坏分支」的权重，不改任何规则、不伪造胜率：
  // 稳健把最坏情况看重一些，速攻更看平均收益并更不愿意浪费回合换宠。
  // 三种权重用的都是同一批枚举结果，所以换偏好只会改变排序，不会改变可比的事实。
  const w=goal==='稳健'?{expected:.45,worst:.55}:goal==='速攻'?{expected:.82,worst:.18}:{expected:.65,worst:.35};
  const switchPenalty=goal==='速攻'?2.5:goal==='稳健'?1:1.5;
  return actions.map(action=>{
    const scores=replies.map(reply=>{
      // Both tie orders are evaluated, so search cannot exploit a hidden RNG outcome.
      const state={...g,history:[],log:[],frames:[]};
      return (evaluate(resolveTurn(state,reply,action,{simulation:true,tieFirst:'player'}))+evaluate(resolveTurn(state,reply,action,{simulation:true,tieFirst:'enemy'})))/2;
    });
    const expected=scores.reduce((v,n,i)=>v+n*rawWeights[i]/total,0);
    const score=expected*w.expected+Math.min(...scores)*w.worst-(action.kind==='switch'?switchPenalty:0);
    return {action,score,expected,worst:Math.min(...scores),switchScore:replies.some(a=>a.kind==='switch')?Math.min(...scores.filter((_,i)=>replies[i].kind==='switch')):null};
  }).sort((a,b)=>b.score-a.score);
}
export function chooseEnemy(g) {
  if(!g.difficulty||g.difficulty==='hard') {
    const recent=(g.history||[]).filter(h=>h.type==='turn').slice(-3);
    let streak=0; for(const h of recent.reverse()){if(h.opponent?.kind!=='switch')break;streak++;}
    // Behavioural inertia, not a rule restriction: a clearly safer switch can still win.
    return rankEnemyActions(g).map(x=>({...x,score:x.score-(x.action.kind==='switch'?streak*6:0)})).sort((a,b)=>b.score-a.score)[0].action;
  }
  const actions=legalActions(g,'enemy').filter(a=>a.kind!=='escape'),p=active(g,'enemy'),q=active(g,'player');
  if(g.difficulty==='easy') {
    // Reproducible choice without looking at the submitted action or changing RNG state.
    const skills=actions.filter(a=>a.kind==='skill');
    const choices=skills.length?skills:actions;
    const roll=(Math.imul(g.seed^g.turn,1103515245)+12345)>>>0;
    return choices[roll%choices.length];
  }
  return actions.map(a=>{
    let score=-20;
    if(a.kind==='skill') {
      const sk=SKILLS[a.id];
      score=sk.power?damage(p,q,sk)-sk.cost*2+(sk.status&&!q.status?7:0):sk.heal?Math.min(sk.heal,p.maxHp-p.hp)*.8:p.energy<2?24:2;
    }
    if(a.kind==='item'&&a.target===g.enemy.active)score=a.id==='potion'?Math.min(45,p.maxHp-p.hp)*.8:a.id==='cleanse'&&p.status?12:0;
    return {action:a,score};
  }).sort((a,b)=>b.score-a.score)[0].action;
}
function snapshot(g) {return structuredClone({version:g.version,mode:g.mode,environment:g.environment,turn:g.turn,phase:g.phase,player:g.player,enemy:g.enemy});}
export function step(original,action) {
  if(!legalActions(original).some(a=>same(a,action)))throw Error('当前行动不可用');
  return resolveTurn(original,action,original.phase==='replace'||action.kind==='escape'?null:chooseEnemy(original));
}
export function resolveTurn(original,action,opponent,options={}) {
  const g=structuredClone(original);
  const actingSide=g.phase==='replace'?(g.replaceSide||'player'):'player';
  if(!legalActions(g,actingSide).some(a=>same(a,action))) throw Error('当前行动不可用');
  const before=snapshot(g), start=g.log.length;
  g.frames=[];let frameStart=g.log.length;
  const capture=side=>{if(!options.simulation)g.frames.push({side,state:snapshot(g),text:g.log.slice(frameStart).filter(t=>!t.startsWith('──')).join(' ')});frameStart=g.log.length;};
  if(g.phase==='replace') {
    const side=g.replaceSide||'player';
    g[side].active=action.target;
    g.log.push(`${side==='player'?'你':'对手'}派出了${active(g,side).name}。强制补位不消耗回合。`);
    if(Array.isArray(g.replaceQueue)&&g.replaceQueue.length){
      g.replaceQueue=g.replaceQueue.filter(x=>x!==side);
      if(g.replaceQueue.length)g.replaceSide=g.replaceQueue[0];
      else {g.replaceQueue=null;g.replaceSide=null;g.phase='battle';}
    } else {g.replaceSide=null;g.phase='battle';}
    g.history.push({type:'replacement',before,action:structuredClone(action),after:snapshot(g)});return g;
  }
  g.log.push(`── 第 ${g.turn} 回合 ──`);
  if(action.kind==='escape') {
    g.result='escaped';g.phase='ended';g.log.push('你撤离了训练赛。本场记为撤退，可重新挑战。');
    g.history.push({type:'turn',before,action:structuredClone(action),opponent:null,events:g.log.slice(start),after:snapshot(g),result:g.result});return g;
  }
  const priority=a=>a.kind==='switch'?5:a.kind==='item'?4:SKILLS[a.id].priority||0;
  const moves=[{side:'player',a:action},{side:'enemy',a:opponent}].map(m=>({...m,actor:g[m.side].active,speed:effectiveSpeed(active(g,m.side)),tie:options.tieFirst?(options.tieFirst===m.side?1:0):random(g)})).sort((a,b)=>priority(b.a)-priority(a.a)||b.speed-a.speed||b.tie-a.tie);
  const guards={player:false,enemy:false};
  for(const side of ['player','enemy']) for(const p of g[side].pets) p.lastGuard=false;
  for(const {side,a,actor} of moves) {
    try {
    const other=side==='player'?'enemy':'player', label=side==='player'?'你':'对手', s=g[side];
    if(s.pets[actor].hp<=0) {g.log.push(`${label}的宠物已倒下，原定行动取消。`);continue;}
    if(a.kind==='switch') {active(g,side).buffs={};s.active=a.target;g.log.push(`${label}换上了${active(g,side).name}。`);continue;}
    if(a.kind==='item') {
      const target=s.pets[a.target];s.items[a.id]--;
      if(a.id==='potion') {const healed=Math.min(45,target.maxHp-target.hp);target.hp+=healed;g.log.push(`${label}对${target.name}使用回复药，恢复 ${healed} HP。`);}
      if(a.id==='ether') {const recovered=Math.min(4,6-target.energy);target.energy+=recovered;g.log.push(`${label}对${target.name}使用能量果，恢复 ${recovered} 能量。`);}
      if(a.id==='cleanse') {target.status=null;g.log.push(`${label}净化了${target.name}的异常。`);}
      continue;
    }
    const p=active(g,side), q=active(g,other), sk=SKILLS[a.id];p.energy-=sk.cost;
    if(a.id==='guard') {guards[side]=true;p.lastGuard=true;p.energy=Math.min(6,p.energy+2);if(p.guardHeal){const n=Math.min(p.guardHeal,p.maxHp-p.hp);p.hp+=n;g.log.push(`${p.name}的守势特性恢复 ${n} HP。`);}g.log.push(`${label}的${p.name}防御：本回合减伤 65%，阻挡新异常，额外恢复 2 能量。`);continue;}
    if(sk.buff){p.buffs??={};p.buffs[sk.buff]={stacks:Math.min(2,(p.buffs[sk.buff]?.stacks||0)+1),remaining:3};g.log.push(`${p.name}使用${sk.name}，${sk.buff==='atk'?'攻击':'防御'}强化${p.buffs[sk.buff].stacks}层。`);continue;}
    if(sk.clearEnvironment){g.environment=null;for(const team of ['player','enemy'])for(const pet of g[team].pets)pet.environment=null;g.log.push(`${p.name}使用清风，场地环境已移除。`);continue;}
    if(sk.heal){const n=Math.min(sk.heal,p.maxHp-p.hp);p.hp+=n;g.log.push(`${label}的${p.name}使用${sk.name}，恢复 ${n} HP。`);continue;}
    if(q.hp<=0) {g.log.push(`${label}失去攻击目标。`);continue;}
    const hit=damage(p,q,sk,guards[other]), actual=Math.min(q.hp,hit);q.hp-=actual;
    if(q.heldItem==='shellCharm'&&!q.heldUsed&&q.hp+actual===q.maxHp){q.heldUsed=true;g.log.push(`${q.name}的守心石触发一次减伤。`);}
    if(sk.dispel&&!guards[other]){q.buffs={};g.log.push(`${q.name}的攻防强化被清除。`);}
    g.log.push(`${label}的${p.name}使用${sk.name}，对${q.name}造成 ${actual} 伤害${multiplier(sk.type,q.type)>1?'（属性克制）':''}${guards[other]?(sk.pierce?'（穿透防御）':'（防御减伤）'):''}。`);
    if(sk.recoil){const n=Math.min(p.hp,Math.ceil(actual*sk.recoil));p.hp-=n;g.log.push(`${p.name}受到 ${n} 反伤。`);}
    if(sk.drain){const n=Math.min(p.maxHp-p.hp,Math.round(actual*sk.drain));p.hp+=n;g.log.push(`${p.name}吸取生命，恢复 ${n} HP。`);}
    if(sk.slow&&q.hp>0&&!guards[other]){q.speedDown={amount:sk.slow,remaining:2};g.log.push(`${q.name}速度降低 ${sk.slow}，下一回合生效。`);}
    if(guards[other]&&q.guardCounter&&q.hp>0&&p.hp>0){const n=Math.min(p.hp,q.guardCounter);p.hp-=n;g.log.push(`${q.name}的守势反击造成 ${n} 伤害。`);}
    if(sk.status && q.hp>0 && !guards[other] && !q.status) {q.status={kind:sk.status,remaining:sk.status==='burn'?2:3};g.log.push(`${q.name}陷入${sk.status==='burn'?'灼烧':'中毒'}。`);}
    } finally {capture(side);}
  }
  for(const side of ['player','enemy']) {
    const p=active(g,side);
    if(p.hp>0 && p.status) {const tick=Math.min(p.hp,p.status.kind==='burn'?6:8);p.hp-=tick;g.log.push(`${p.name}受到${p.status.kind==='burn'?'灼烧':'中毒'}伤害 ${tick}。`);if(--p.status.remaining<=0)p.status=null;}
    if(p.speedDown&&--p.speedDown.remaining<=0)p.speedDown=null;
    if(p.hp>0&&p.heldItem==='energySeed'&&!p.heldUsed&&p.energy<=1){p.energy=Math.min(6,p.energy+2);p.heldUsed=true;g.log.push(`${p.name}的蓄能籽恢复2能量。`);}
    for(const stat of Object.keys(p.buffs||{}))if(--p.buffs[stat].remaining<=0)delete p.buffs[stat];
    if(p.hp>0) p.energy=Math.min(6,p.energy+1);
    capture(side);
  }
  if(g.environment&&--g.environment.turns<=0){g.environment=null;for(const side of ['player','enemy'])for(const pet of g[side].pets)pet.environment=null;g.log.push('场地环境结束。');}
  for(const side of ['player','enemy']) if(active(g,side).hp<=0) {active(g,side).buffs={};g.log.push(`${active(g,side).name}倒下了。`);}
  const alive=side=>g[side].pets.some(p=>p.hp>0);
  if(!alive('player')||!alive('enemy')) {g.result=!alive('player')&&!alive('enemy')?'draw':alive('player')?'win':'loss';g.phase='ended';g.log.push({draw:'双方宠物全部倒下，本场平局。',win:'训练赛胜利！',loss:'训练赛结束，你的队伍已全部倒下。'}[g.result]);}
  else {
    if(options.manualReplace) {
      const queue=[];
      if(active(g,'enemy').hp<=0)queue.push('enemy');
      if(active(g,'player').hp<=0)queue.push('player');
      g.replaceQueue=queue.length?queue:null;g.replaceSide=queue[0]||null;
      if(queue.length)g.phase='replace';
    } else {
      if(active(g,'enemy').hp<=0) {g.enemy.active=g.enemy.pets.map((p,i)=>({i,score:p.hp>0?multiplier(p.type,active(g,'player').type)*20-multiplier(active(g,'player').type,p.type)*15+p.hp/p.maxHp*10:-Infinity})).sort((a,b)=>b.score-a.score)[0].i;g.log.push(`对手派出了${active(g,'enemy').name}。`);}
      if(active(g,'player').hp<=0)g.phase='replace';
    }
    g.turn++;
    if(g.turn>80){g.result='draw';g.phase='ended';g.log.push('达到 80 回合上限，本场平局。');}
  }
  if(!options.simulation)g.history.push({type:'turn',before,action:structuredClone(action),opponent,events:g.log.slice(start),after:snapshot(g),result:g.result});
  return g;
}

// 本地对战的对手阵容：12 只里随机选 3 只，各自从可学技能里选 4 个、带一件携带物，
// 等级由调用方按玩家队伍适配传入。用同一个 seed 可复现，不读取玩家选择。
export function buildVersusOpponent(seed=17,{level=1,team:chosen=null}={}){
 let state=seed>>>0;
 const rnd=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 const takeOne=arr=>arr.splice(Math.floor(rnd()*arr.length),1)[0];
 let team;
 if(Array.isArray(chosen)&&chosen.length===3&&new Set(chosen).size===3&&chosen.every(id=>SPECIES.some(p=>p.id===id))){
  // 对手自己选的三只：技能、携带物与等级仍由这里补齐，保证合法且与玩家适配。
  team=chosen.map(id=>SPECIES.find(p=>p.id===id));
 } else {
  const pool=[...SPECIES];team=[];
  while(team.length<3&&pool.length)team.push(takeOne(pool));
 }
 const itemPool=Object.keys(HELD_ITEMS).filter(k=>k!=='none');
 const enemyPets={};
 for(const base of team){
  const learn=[...base.learnset],loadout=[];
  while(loadout.length<4&&learn.length)loadout.push(takeOne(learn));
  enemyPets[base.id]={level:Math.max(1,Math.min(5,Math.round(level))),points:{hp:0,atk:0,speed:0},loadout,heldItem:itemPool.length?itemPool[Math.floor(rnd()*itemPool.length)]:'none'};
 }
 return {enemyTeam:team.map(p=>p.id),enemyPets};
}

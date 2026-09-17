// V02 calibration study (headless, no model calls).
// Measures switch rate / win rate / match length / 10-turn threshold reachability for the two
// magic numbers that currently have no empirical backing:
//   (1) engine.js chooseEnemy: consecutive-switch inertia cost = 6 points per consecutive switch,
//       implicitly capped at 18 because only the last 3 turns are inspected.
//   (2) progression.js settle: first PVE win within 10 turns of a stage grants +1 training point.
// The enemy chooser is RE-IMPLEMENTED here with parameters because engine.js must not be modified.
// The re-implementation is asserted equal to chooseEnemy() at the shipped values (penalty 6, cap 18).
import {writeFileSync,mkdirSync} from 'node:fs';
import {createGame,legalActions,resolveTurn,chooseEnemy,rankEnemyActions,active,SKILLS,damage,multiplier,effectiveSpeed} from '../engine.js';
import {STAGES,stageOptions} from '../content.js';

const SHIPPED_PENALTY=6, SHIPPED_CAP=18, SHIPPED_THRESHOLD=10;
const rng=seed=>{let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);};

// ── enemy chooser with parameterised inertia ────────────────────────────────────────────────
// engine.js counts the trailing run of enemy switches among the last 3 turns and subtracts
// streak*6 from every switch candidate, i.e. effective penalty = min(streak,3)*6 = min(streak*6,18).
function enemyRanked(g,{penalty=SHIPPED_PENALTY,cap=SHIPPED_CAP,window=3}={}){
 const recent=(g.history||[]).filter(h=>h.type==='turn').slice(-window);
 let streak=0;for(const h of recent.slice().reverse()){if(h.opponent?.kind!=='switch')break;streak++;}
 const applied=penalty>0?Math.min(streak,cap/penalty):0;
 return rankEnemyActions(g).map(x=>({...x,streak,applied,score:x.score-(x.action.kind==='switch'?applied*penalty:0)})).sort((a,b)=>b.score-a.score);
}
function enemyChoose(g,cfg){return enemyRanked(g,cfg)[0].action;}

// ── player policies (the "human" side) ──────────────────────────────────────────────────────
const attacks=(g,side='player')=>legalActions(g,side).filter(a=>a.kind==='skill'&&SKILLS[a.id].power);
function bestDamage(g){
 const p=active(g,'player'),q=active(g,'enemy');
 const list=attacks(g).map(a=>({a,d:damage(p,q,SKILLS[a.id])})).sort((x,y)=>y.d-x.d||SKILLS[x.a.id].cost-SKILLS[y.a.id].cost);
 if(list.length)return list[0].a;
 const legal=legalActions(g).filter(a=>a.kind!=='escape');
 const guard=legal.find(a=>a.kind==='skill'&&a.id==='guard');if(guard)return guard;
 return legal[0];
}
function oneTurnRank(g){
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player}).filter(x=>x.action.kind!=='escape');
 return ranked.length?ranked[0].action:legalActions(g).filter(a=>a.kind!=='escape')[0];
}
// Switches only when the active pet is at a type disadvantage and a healthy counter exists.
function switchSeeking(g){
 const s=g.player,p=active(g,'player'),q=active(g,'enemy');
 const disadvantage=multiplier(q.type,p.type)>multiplier(p.type,q.type);
 if(disadvantage&&p.hp/p.maxHp<.75){
  const options=s.pets.flatMap((x,i)=>x.hp>0&&i!==s.active&&x.hp/x.maxHp>=.5&&multiplier(x.type,q.type)>=1?[{i,score:multiplier(x.type,q.type)*100+x.hp}]:[]).sort((a,b)=>b.score-a.score);
  if(options.length)return {kind:'switch',target:options[0].i};
 }
 return bestDamage(g);
}
function randomPolicy(g,rand){
 const legal=legalActions(g).filter(a=>a.kind!=='escape');
 return legal[Math.floor(rand()*legal.length)];
}
const POLICIES={'greedy-damage':g=>bestDamage(g),'one-turn-rank':g=>oneTurnRank(g),'switch-seeking':g=>switchSeeking(g),'random':(g,ctx)=>randomPolicy(g,ctx.rand)};

// ── match runner ────────────────────────────────────────────────────────────────────────────
function playMatch({seed,team,options={},player='one-turn-rank',enemyCfg={},enemy='hard'}){
 const rand=rng(seed*7919+13);
 let g=createGame(seed,team,{...options,difficulty:enemy});
 let playerSwitches=0,enemySwitches=0,turns=0,enemySwitchStreak=0,maxEnemySwitchStreak=0,enemySwitchTurns=0,plans=0;
 let guard=0;
 while(!g.result&&guard++<400){
  const replacing=g.phase==='replace';
  const action=replacing?legalActions(g).filter(a=>a.kind==='switch')[0]||legalActions(g)[0]:POLICIES[player](g,{rand});
  if(!action){g.result='stuck';break;}
  const opponent=replacing?null:enemyChoose(g,enemyCfg);
  if(action.kind==='switch')playerSwitches++;
  if(opponent){plans++;if(opponent.kind==='switch'){enemySwitches++;enemySwitchTurns++;enemySwitchStreak++;maxEnemySwitchStreak=Math.max(maxEnemySwitchStreak,enemySwitchStreak);}else enemySwitchStreak=0;}
  const before=g.turn;
  g=resolveTurn(g,action,opponent);
  if(g.turn!==before)turns++;
 }
 const rounds=(g.history||[]).filter(h=>h.type==='turn').length;
 return {seed,team:team.join('+'),player,result:g.result,rounds,turns,
  playerSwitches,enemySwitches,enemyPlans:plans,
  playerSwitchRate:plans?playerSwitches/plans:0,enemySwitchRate:plans?enemySwitches/plans:0,
  maxEnemySwitchStreak,win:g.result==='win',draw:g.result==='draw',loss:g.result==='loss',stuck:g.result==='stuck'};
}

// ── self-check: parameterised chooser must reproduce shipped chooseEnemy ────────────────────
function verifyChooser(n=400){
 let checked=0,mismatch=0;
 for(let s=0;s<n;s++){
  let g=createGame(1000+s*13,['fox','turtle','deer'],{difficulty:'hard'});
  const rand=rng(s+5);let guard=0;
  while(!g.result&&guard++<40){
   const legal=legalActions(g).filter(a=>a.kind!=='escape');
   if(!legal.length)break;
   const a=legal[Math.floor(rand()*legal.length)];
   const shipped=chooseEnemy(g),mine=enemyChoose(g,{penalty:SHIPPED_PENALTY,cap:SHIPPED_CAP});
   checked++;if(JSON.stringify(shipped)!==JSON.stringify(mine))mismatch++;
   g=resolveTurn(g,a,shipped);
  }
 }
 return {statesChecked:checked,mismatch};
}

// ── aggregation helpers ─────────────────────────────────────────────────────────────────────
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
function pct(sorted,q){if(!sorted.length)return null;const i=Math.min(sorted.length-1,Math.max(0,Math.round(q*(sorted.length-1))));return sorted[i];}
function summarize(rows){
 const wins=rows.filter(r=>r.win),losses=rows.filter(r=>r.loss),draws=rows.filter(r=>r.draw),stuck=rows.filter(r=>r.stuck);
 const lengths=rows.map(r=>r.rounds).sort((a,b)=>a-b);
 const winLengths=wins.map(r=>r.rounds).sort((a,b)=>a-b);
 return {n:rows.length,wins:wins.length,losses:losses.length,draws:draws.length,stuck:stuck.length,
  winRate:rows.length?wins.length/rows.length:null,
  meanRounds:mean(rows.map(r=>r.rounds)),p50Rounds:pct(lengths,.5),p90Rounds:pct(lengths,.9),
  meanWinRounds:mean(winLengths),p50WinRounds:pct(winLengths,.5),
  playerSwitchRate:mean(rows.map(r=>r.playerSwitchRate)),
  enemySwitchRate:mean(rows.map(r=>r.enemySwitchRate)),
  maxEnemySwitchStreakP95:pct(rows.map(r=>r.maxEnemySwitchStreak).sort((a,b)=>a-b),.95),
  consecutiveEnemySwitchMatches:rows.filter(r=>r.maxEnemySwitchStreak>=2).length/rows.length,
  longestEnemySwitchStreakEver:Math.max(0,...rows.map(r=>r.maxEnemySwitchStreak))};
}
// Win-within-T rates. Reachability is computed over WINS (does the bonus fire?) and over ALL
// matches (how often any given attempt earns it).
function swiftCurve(rows,thresholds){
 const wins=rows.filter(r=>r.win);
 return Object.fromEntries(thresholds.map(T=>[T,{
  ofWins:wins.length?wins.filter(r=>r.rounds<=T).length/wins.length:null,
  ofAllMatches:rows.length?rows.filter(r=>r.win&&r.rounds<=T).length/rows.length:null,
  n:wins.filter(r=>r.rounds<=T).length}]));
}

// ── studies ─────────────────────────────────────────────────────────────────────────────────
const SEEDS=Number(process.env.SEEDS||24);
const seeds=Array.from({length:SEEDS},(_,i)=>100+i*37);
const compositions={
 'starter fox/turtle/deer':['fox','turtle','deer'],
 'burn lion/shroom/otter':['lion','shroom','otter'],
 'speed sparrow/badger/moth':['sparrow','badger','moth'],
 'wind falcon/rhino/marten':['falcon','rhino','marten'],
 'stall turtle/shroom/badger':['turtle','shroom','badger'],
 'glass fox/sparrow/falcon':['fox','sparrow','falcon']};
const TRAINING={L1_none:{level:1,points:{hp:0,atk:0,speed:0}},L3_partial:{level:3,points:{hp:2,atk:2,speed:0}},L5_full:{level:5,points:{hp:5,atk:3,speed:0}}};
const trainOptions=spec=>Object.fromEntries(['fox','turtle','deer','lion','shroom','otter','sparrow','badger','moth','falcon','rhino','marten'].map(id=>[id,{...spec}]));

const report={generatedAt:new Date().toISOString(),rulesVersion:'0.6',method:'Headless engine simulation; simplified player policies, NOT human play. Enemy = engine.js chooseEnemy re-implemented with parameters and asserted identical at shipped values.',
 shipped:{inertiaPenaltyPerConsecutiveSwitch:SHIPPED_PENALTY,inertiaCap:SHIPPED_CAP,swiftWinThresholdTurns:SHIPPED_THRESHOLD},
 seedsPerArm:SEEDS,chooserVerification:verifyChooser()};

// Study A: composition x player policy (difficulty standard, level-1 teams)
report.studyA_composition={};
for(const [name,team] of Object.entries(compositions)){
 for(const pol of Object.keys(POLICIES)){
  report.studyA_composition[name+' | '+pol]=summarize(seeds.map(seed=>playMatch({seed,team,player:pol,enemy:'normal'})));
 }
 report.studyA_composition[name+' | ALL']=summarize(Object.keys(POLICIES).flatMap(pol=>seeds.map(seed=>playMatch({seed,team,player:pol,enemy:'normal'}))));
}

// Study B: training profile x stage (real stage enemy teams, difficulty standard)
const stageSample=[];
report.studyB_training={};
for(const stage of STAGES){
 for(const [tname,spec] of Object.entries(TRAINING)){
  for(const pol of ['greedy-damage','one-turn-rank']){
   const rows=seeds.map(seed=>playMatch({seed,team:['fox','turtle','deer'],options:{pets:trainOptions(spec),mode:'pve',...stageOptions(stage.id)},player:pol,enemy:'normal'}));
   stageSample.push(...rows.map(r=>({...r,stage:stage.id,train:tname,pol})));
   report.studyB_training[stage.id+' | '+tname+' | '+pol]=summarize(rows);
  }
 }
}

// Study C: difficulty x player policy (stage 1 enemy team)
report.studyC_difficulty={};
for(const diff of ['easy','normal','hard']){
 for(const pol of Object.keys(POLICIES)){
  report.studyC_difficulty[diff+' | '+pol]=summarize(seeds.map(seed=>playMatch({seed,team:['fox','turtle','deer'],options:{mode:'pve',...stageOptions('meadow')},player:pol,enemy:diff})));
 }
}

// Study D: inertia sweep. Same seeds, same player policies; only the enemy penalty changes.
const inertiaArms=[0,3,6,9,12,18].map(penalty=>({penalty,cap:SHIPPED_CAP}));
inertiaArms.push({penalty:6,cap:12},{penalty:6,cap:24},{penalty:6,cap:SHIPPED_CAP,window:5});
const inertiaRows={};
for(const arm of inertiaArms){
 const key=`penalty=${arm.penalty},cap=${arm.cap}${arm.window?', '+arm.window+'-turn window':''}`;
 const rows=[];
 for(const pol of ['switch-seeking','one-turn-rank']){
  for(const seed of seeds){
   const row=playMatch({seed,team:['fox','turtle','deer'],options:{mode:'pve',...stageOptions('meadow')},player:pol,enemy:'hard',enemyCfg:arm});
   rows.push({...row,pol});
  }
 }
 inertiaRows[key]=rows;
}
report.studyD_inertia=Object.fromEntries(Object.entries(inertiaRows).map(([k,v])=>[k,{...summarize(v),byPolicy:Object.fromEntries(['switch-seeking','one-turn-rank'].map(p=>[p,summarize(v.filter(r=>r.pol===p))]))}]));

// Suppression analysis: how often does the inertia cost actually flip the enemy's top choice,
// and what score margin does it give up? Measured on live trajectories, not on static snapshots.
function suppressionProbe(cfg){
 const rows=[];
 for(const seed of seeds.slice(0,10)){
  let g=createGame(seed,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'hard'});
  const rand=rng(seed+3);let guard=0;
  while(!g.result&&guard++<200){
   if(g.phase!=='replace'){
    const ranked=enemyRanked(g,cfg),raw=enemyRanked(g,{penalty:0,cap:1e9});
    if(raw[0].action.kind==='switch'){
     const flipped=ranked[0].action.kind!=='switch';
     rows.push({turn:g.turn,streak:raw[0].streak,flipped,rawTop:raw[0].score,chosen:ranked[0].score,loss:raw[0].score-ranked[0].score});
    }
    const legal=legalActions(g).filter(a=>a.kind!=='escape');
    g=resolveTurn(g,legal[Math.floor(rand()*legal.length)],ranked[0].action);
   } else {g=resolveTurn(g,legalActions(g)[0],null);}
  }
 }
 const switchTop=rows.length;
 const flipped=rows.filter(r=>r.flipped).length;
 return {switchOpportunities:switchTop,suppressed:flipped,suppressedRate:switchTop?flipped/switchTop:null,
  meanScoreGivenUp:mean(rows.filter(r=>r.flipped).map(r=>r.loss)),
  byStreak:Object.fromEntries([...new Set(rows.map(r=>r.streak))].sort().map(s=>[s,{n:rows.filter(r=>r.streak===s).length,suppressed:rows.filter(r=>r.streak===s&&r.flipped).length}]))};
}
report.studyD_suppression={shipped:suppressionProbe({penalty:SHIPPED_PENALTY,cap:SHIPPED_CAP}),none:suppressionProbe({penalty:0,cap:1e9}),strong:suppressionProbe({penalty:18,cap:18})};

// Study E: swift-win threshold sweep on real stage matches (hard + standard difficulty).
const swiftRows=[];
for(const stage of STAGES)for(const diff of ['normal','hard'])for(const pol of ['greedy-damage','one-turn-rank']){
 for(const seed of seeds.slice(0,16)){
  swiftRows.push({...playMatch({seed,team:['fox','turtle','deer'],options:{mode:'pve',...stageOptions(stage.id)},player:pol,enemy:diff}),stage:stage.id,diff,pol});
 }
}
const THRESHOLDS=[6,8,10,12,14,16,20,25,30,40];
report.studyE_swift={
 shippedThreshold:SHIPPED_THRESHOLD,
 overallWindow:swiftCurve(swiftRows,THRESHOLDS),
 byStage:Object.fromEntries(STAGES.map(s=>[s.id,swiftCurve(swiftRows.filter(r=>r.stage===s.id),THRESHOLDS)])),
 byPolicy:Object.fromEntries(['greedy-damage','one-turn-rank'].map(p=>[p,swiftCurve(swiftRows.filter(r=>r.pol===p),THRESHOLDS)])),
 byDifficulty:Object.fromEntries(['normal','hard'].map(d=>[d,swiftCurve(swiftRows.filter(r=>r.diff===d),THRESHOLDS)])),
 winRoundDistribution:(()=>{const sorted=swiftRows.filter(r=>r.win).map(r=>r.rounds).sort((a,b)=>a-b);return {n:sorted.length,min:pct(sorted,0),p10:pct(sorted,.1),p25:pct(sorted,.25),p50:pct(sorted,.5),p75:pct(sorted,.75),p90:pct(sorted,.9),max:pct(sorted,1)};})(),
 sampledMatches:swiftRows.length};

report.caveats=['Player side is a scripted policy, not a human; absolute win rates are not player win rates.',
 'Only the enemy uses the inertia cost; the player is never charged it (matches engine.js).',
 'Match length uses history entries of type turn, exactly like progression.js settle().',
 'The +1 swift bonus is once per stage, so reachability is only meaningful per stage.'];
mkdirSync('reports',{recursive:true});
writeFileSync('reports/balance-calibration.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({chooserVerification:report.chooserVerification,
 studyD:Object.fromEntries(Object.entries(report.studyD_inertia).map(([k,v])=>[k,{winRate:+v.winRate.toFixed(3),enemySwitchRate:+v.enemySwitchRate.toFixed(3),playerSwitchRate:+v.playerSwitchRate.toFixed(3),meanRounds:+v.meanRounds.toFixed(1)}])),
 suppression:report.studyD_suppression,
 swift10:Object.fromEntries(Object.entries(report.studyE_swift.byStage).map(([k,v])=>[k,v[10]])),
 swiftOverall:report.studyE_swift.overallWindow[10],winRoundDistribution:report.studyE_swift.winRoundDistribution},null,2));

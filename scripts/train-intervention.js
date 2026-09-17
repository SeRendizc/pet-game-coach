import {gzipSync} from 'node:zlib';
import {writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {rng,stateKey,permitted,initial,transition,greedy,episode} from '../training/intervention.js';
mkdirSync('reports',{recursive:true});
const trajectoryPath='reports/intervention-training.jsonl.gz',validationPath='reports/intervention-validation.jsonl.gz';writeFileSync(trajectoryPath,'');writeFileSync(validationPath,'');
const seeds=[17,71,199],runs=[],curves=[],checkpoints=[];
for(const seed of seeds){
 const r=rng(seed),table={};
 for(let e=0;e<6000;e++){
  let s=initial(1000+Math.floor(r()*800000));const episodeSeed=s.seed,rows=[];
  for(let t=0;t<24;t++){
   const key=stateKey(s),q=table[key]??=[0,0];
   const epsilon=.25*(1-e/6000)+.03;
   const a=r()<epsilon?(permitted(s,1)&&r()<.5?1:0):greedy(table,s);
   const out=transition(s,a),nextQ=table[stateKey(out.next)]||[0,0];
   const target=out.reward+(t===23?0:.85*Math.max(nextQ[0],permitted(out.next,1)?nextQ[1]:-Infinity));
   const oldQ=q[a];q[a]+=.06*(target-q[a]);rows.push({step:t,state:key,action:a,reward:out.reward,next:stateKey(out.next),oldQ,newQ:q[a],shown:out.shown,helpful:out.helpful,untreatedCorrect:out.untreatedCorrect,violation:out.violation});s=out.next;
  }
  appendFileSync(trajectoryPath,gzipSync(JSON.stringify({split:'train',trainingSeed:seed,episode:e,episodeSeed,persona:s.persona,rows})+'\n'));
  if((e+1)%500===0){const validation=Array.from({length:100},(_,i)=>episode(900000+i,s=>greedy(table,s)));appendFileSync(validationPath,gzipSync(validation.map(x=>JSON.stringify({split:'validation',trainingSeed:seed,episodes:e+1,...x})).join('\n')+'\n'));const returns=validation.map(x=>x.return);curves.push({seed,episodes:e+1,validationReturn:returns.reduce((a,b)=>a+b,0)/returns.length});}
 }
 checkpoints.push({seed,table});
}
const policyKinds=['none','rule','untrained','q-learning'];
function stats(values){const mean=values.reduce((a,b)=>a+b,0)/values.length;const sd=Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/(values.length-1));return {mean,sd,ci95HalfWidth:1.96*sd/Math.sqrt(values.length)};}
const report={rulesVersion:'0.6',simulation:'Explicit intervention MDP v2 with novice/skilled/explorer/quiet/favorite personas; simplified player model, NOT human outcomes or LLM training',trainingEpisodesPerSeed:6000,trainingSeeds:seeds,validationSeeds:[900000,900099],testSeeds:[1000000,1000499],parameters:{alpha:.06,gamma:.85,horizon:24},results:[],curves};
const traces=[];const testPath='reports/intervention-evaluation.jsonl.gz';writeFileSync(testPath,'');
for(const shift of [false,true])for(const {seed,table} of checkpoints)for(const name of policyKinds){
 const random=rng(seed+88);
 const policy=s=>name==='none'?0:name==='rule'?Number(permitted(s,1)&&s.risk>=1):name==='untrained'?Number(permitted(s,1)&&random()<.5):greedy(table,s);
 const eps=Array.from({length:500},(_,i)=>episode(1000000+i,policy,{shift}));
 appendFileSync(testPath,gzipSync(eps.map(e=>JSON.stringify({split:'test',trainingSeed:seed,shift,policy:name,...e})).join('\n')+'\n'));
 const rows=eps.flatMap(x=>x.rows),sum=k=>rows.reduce((n,x)=>n+Number(x[k]),0);
 report.results.push({trainingSeed:seed,shift,policy:name,n:eps.length,return:stats(eps.map(x=>x.return)),hintsPerEpisode:sum('shown')/eps.length,incrementalHelpfulPerEpisode:sum('helpful')/eps.length,burdenPerEpisode:sum('burden')/eps.length,violations:sum('violation'),byRisk:Object.fromEntries([0,1,2].map(risk=>{const subset=rows.filter(x=>Number(x.state.split(':')[0])===risk);return [risk,{decisions:subset.length,hints:subset.filter(x=>x.shown).length,incrementalHelp:subset.filter(x=>x.helpful).length}];})),byPreference:Object.fromEntries(['gentle','critical','quiet'].map(pref=>{const subset=eps.filter(x=>x.preference===pref);return [pref,{episodes:subset.length,hints:subset.reduce((n,e)=>n+e.rows.filter(x=>x.shown).length,0)}];})),independentBaseAccuracy:sum('untreatedCorrect')/rows.length,knowledgeGain:stats(eps.map(x=>x.knowledgeGain))});
 if(!shift&&seed===17&&name==='q-learning')traces.push(...eps.slice(0,12));
}
mkdirSync('checkpoints',{recursive:true});mkdirSync('reports',{recursive:true});
const auditPolicies={always:()=>1,never:()=>0,skillOnly:s=>Number(s.skill===2),riskOnly:s=>Number(s.risk===2)};
report.rewardAudits=Object.fromEntries(Object.entries(auditPolicies).map(([name,policy])=>{const eps=Array.from({length:500},(_,i)=>episode(1100000+i,policy));const rows=eps.flatMap(e=>e.rows);return [name,{n:500,meanReturn:eps.reduce((n,e)=>n+e.return,0)/500,violations:rows.filter(r=>r.violation).length,alreadyCorrectHints:rows.filter(r=>r.shown&&r.untreatedCorrect).length,incrementalHelpful:rows.filter(r=>r.helpful).length,falseAttribution:rows.filter(r=>r.helpful&&r.untreatedCorrect).length}];}));
report.trajectoryFiles={train:trajectoryPath,validation:validationPath,test:testPath,format:'gzip concatenated JSONL; complete episodes with state/action/reward/next and Q updates for training'};
// Select solely on validation, not held-out test reward.
const selected=checkpoints.slice().sort((a,b)=>curves.findLast(x=>x.seed===b.seed).validationReturn-curves.findLast(x=>x.seed===a.seed).validationReturn)[0];
writeFileSync('checkpoints/intervention-policy.json',JSON.stringify({version:1,algorithm:'tabular Q-learning',actions:['silent','short-cue'],selectedSeed:selected.seed,selection:'final validation return',deployment:'experimental; hard constraints always applied',table:selected.table},null,2));
writeFileSync('reports/intervention.json',JSON.stringify(report,null,2));writeFileSync('reports/intervention-trajectories.jsonl',traces.map(x=>JSON.stringify(x)).join('\n')+'\n');
console.log(JSON.stringify({selectedSeed:selected.seed,results:report.results.filter(x=>x.trainingSeed===selected.seed).map(x=>({shift:x.shift,policy:x.policy,reward:+x.return.mean.toFixed(3),hints:+x.hintsPerEpisode.toFixed(2),incrementalHelp:+x.incrementalHelpfulPerEpisode.toFixed(2),violations:x.violations}))},null,2));

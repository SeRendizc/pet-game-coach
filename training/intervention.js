// Small sequential MDP for coach timing. No LLM weights, no real-user exploration.
export function rng(seed){let s=seed>>>0;return ()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);}
export function stateKey(s){return [s.risk,s.confidence,s.skill,s.fatigue>1?1:0,s.preference].join(':');}
export function permitted(s,a){return a===0||s.preference!=='quiet'&&s.confidence===1&&s.fatigue<4&&(s.preference!=='critical'||s.risk===2);}
export function greedy(table,s){const values=table[stateKey(s)]||[0,0];return permitted(s,1)&&values[1]>values[0]?1:0;}
export const PERSONAS=['novice','skilled','explorer','quiet','favorite'];
export function initial(seed,{shift=false,persona=null}={}){
 const r=rng(seed), sampled=r()<.35?2:r()<.55?1:0;
 persona=persona||PERSONAS[Math.floor(r()*PERSONAS.length)];
 const skill=persona==='skilled'?2:persona==='novice'?0:sampled;
 const sampledPref=['gentle','gentle','critical','quiet'][Math.floor(r()*4)];
 const preference=persona==='quiet'?'quiet':sampledPref;
 return {seed,persona,step:0,risk:Math.floor(r()*3),confidence:r()<.85?1:0,skill,fatigue:0,preference,knowledge:skill/3,learnRate:shift?.018:.035,tolerance:shift?.25+r()*.3:.4+r()*.4,random:r};
}
export function transition(s,a){
 // Shared random draws permit paired baselines with the same potential untreated outcome.
 const r=s.random,draw=r(),adoption=r(),nextRisk=Math.floor(r()*3),nextConfidence=r()<.85?1:0;
 const base=Math.min(.97,.25+s.skill*.27+s.knowledge*.18);
 const untreatedCorrect=draw<base;
 const shown=permitted(s,a)&&a===1;
 const willingness=(s.persona==='explorer'?.6:s.persona==='favorite'?.55:.85)*(s.learnRate<.03?.8:1);
 const helpful=shown&&!untreatedCorrect&&adoption<Math.max(.15,willingness-s.fatigue*.12);
 const correct=untreatedCorrect||helpful;
 const learning=helpful?s.learnRate:0;
 const benefit=helpful?[.3,1,2][s.risk]:0;
 const burden=shown?(.16+(1-s.tolerance)*.5+s.fatigue*.13):0;
 const reward=benefit-burden+learning*2;
 const next={...s,step:s.step+1,risk:nextRisk,confidence:nextConfidence,fatigue:Math.max(0,s.fatigue+(shown?1:-.7)),knowledge:Math.min(1,s.knowledge+learning)};
 return {next,reward,shown,helpful,correct,untreatedCorrect,burden,benefit,violation:a===1&&!permitted(s,a)};
}
export function episode(seed,policy,options={}){
 let s=initial(seed,options);const rows=[];
 for(let t=0;t<24;t++){const a=policy(s),out=transition(s,a);rows.push({step:t,state:stateKey(s),action:a,reward:out.reward,shown:out.shown,helpful:out.helpful,correct:out.correct,untreatedCorrect:out.untreatedCorrect,burden:out.burden,benefit:out.benefit,violation:out.violation});s=out.next;}
 return {seed,persona:s.persona,preference:s.preference,skill:s.skill,rows,return:rows.reduce((a,x)=>a+x.reward,0),knowledgeGain:s.knowledge-s.skill/3};
}

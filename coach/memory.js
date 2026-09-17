import {SPECIES} from '../engine.js';
export function freshMemory(){return {version:1,preference:null,lessons:[],events:[],pendingQuiz:null,dialogue:[],lastTopic:null,journal:[],reflections:{},goal:null,favorite:null,ruleReferenceId:null,quizCount:0,watches:[]};}
// 已结束对局里可以核对的事实字段。旧存档没有这些字段，读回来就是空数组 / null，
// 陪练只能少说一句，不能拿默认值把它补成一句听起来具体的话。
const factNames=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.length<=12).slice(0,3):[];
const factCount=v=>Number.isInteger(v)&&v>=0&&v<=9?v:null;
const readEventFacts=e=>({enemy:factNames(e.enemy),faints:factNames(e.faints),...(Number.isInteger(e.firstLossTurn)&&e.firstLossTurn>0?{firstLossTurn:e.firstLossTurn}:{}),...(typeof e.firstFallen==='string'&&e.firstFallen.length<=12?{firstFallen:e.firstFallen}:{}),survivors:Number.isInteger(e.survivors)&&e.survivors>=0&&e.survivors<=3?e.survivors:null,items:e.items&&typeof e.items==='object'?{potion:factCount(e.items.potion),cleanse:factCount(e.items.cleanse),ether:factCount(e.items.ether)}:null});
export function readMemory(raw){try{const m=JSON.parse(raw);if(m?.version!==1)return freshMemory();return {version:1,preference:['brief','detailed'].includes(m.preference)?m.preference:null,lessons:Array.isArray(m.lessons)?m.lessons.filter(x=>typeof x==='string').slice(-12):[],events:Array.isArray(m.events)?m.events.filter(x=>x&&typeof x.result==='string').slice(-12).map(e=>({...e,...readEventFacts(e)})):[],pendingQuiz:m.pendingQuiz&&typeof m.pendingQuiz.explanation==='string'&&typeof m.pendingQuiz.question==='string'&&['先','后','不确定'].includes(m.pendingQuiz.answer)?m.pendingQuiz:null,dialogue:Array.isArray(m.dialogue)?m.dialogue.filter(x=>x&&['user','assistant'].includes(x.role)&&typeof x.content==='string').slice(-8).map(x=>({...x,content:(x.role==='user'?x.content.split('\n回答要求：不要向玩家报内部局面评分')[0]:x.content).slice(0,600)})):[],lastTopic:typeof m.lastTopic==='string'?m.lastTopic:null,journal:Array.isArray(m.journal)?m.journal.filter(e=>e&&typeof e.id==='string'&&typeof e.time==='string').slice(-240):[],reflections:m.reflections&&typeof m.reflections==='object'?Object.fromEntries(Object.entries(m.reflections).filter(([k,v])=>v&&Array.isArray(v.evidenceIds))):{},watches:Array.isArray(m.watches)?m.watches.filter(w=>w&&['energy','finish'].includes(w.kind)&&typeof w.matchId==='string'&&Number.isInteger(w.expiresTurn)).slice(0,1):[],quizCount:Number.isInteger(m.quizCount)&&m.quizCount>=0?m.quizCount:0,goal:['稳健','速攻'].includes(m.goal)?m.goal:null,ruleReferenceId:typeof m.ruleReferenceId==='string'?m.ruleReferenceId:null,favorite:typeof m.favorite==='string'?m.favorite:null};}catch{return freshMemory();}}
export function rememberPreference(memory,message){
 const next=structuredClone(memory);
 if(/本命|最喜欢|主养/.test(message)){const favorite=SPECIES.find(p=>message.includes(p.name));if(favorite)next.favorite=favorite.id;}
 if(/记住|以后|我想/.test(message)){if(/稳一点|稳健|打得稳/.test(message))next.goal='稳健';else if(/速攻|主动些|快攻/.test(message))next.goal='速攻';}
 if(/记住.{0,10}(简短|短一点)|以后.{0,10}(简短|短一点)/.test(message))next.preference='brief';
 if(/记住.{0,10}(详细|多解释)|以后.{0,10}(详细|多解释)/.test(message))next.preference='detailed';
 return next;
}
// 记住一局真实对战。除结果与回合数外，一并记住对手阵容、我方倒下顺序、
// 首个减员发生的回合，以及结束时剩余的道具——陪练的「具体」只能来自这些字段。
// 首个减员必须成对记录（回合 + 当时倒下的那只），否则「X 在第 N 回合倒下」可能是假的。
export function matchFacts(game){
 const pets=game?.player?.pets||[],turns=(game?.history||[]).filter(h=>h.type==='turn');
 let firstLossTurn=null,firstFallen=null;
 for(const h of turns){const before=h.before?.player?.pets||[],after=h.after?.player?.pets||[];const i=after.findIndex((p,j)=>p&&p.hp<=0&&before[j]&&before[j].hp>0);if(i>=0){firstLossTurn=h.before.turn;firstFallen=after[i]?.name||pets[i]?.name||null;break;}}
 const items=game?.player?.items;
 return {enemy:factNames((game?.enemy?.pets||[]).map(p=>p?.name)),faints:factNames(pets.filter(p=>p&&p.hp<=0).map(p=>p.name)),
  ...(Number.isInteger(firstLossTurn)?{firstLossTurn,firstFallen}:{}),survivors:pets.filter(p=>p&&p.hp>0).length,
  items:{potion:factCount(items?.potion),cleanse:factCount(items?.cleanse),ether:factCount(items?.ether)}};
}
export function rememberBattle(memory,game){if(!game?.result||game.preview)return memory;const m=structuredClone(memory);if(game.id&&m.events.some(e=>e.id===game.id))return m;m.events.push({id:game.id||null,result:game.result,stage:game.stageName||'训练场',turns:game.turn,time:new Date().toISOString(),source:'local-game',rulesVersion:game.version,...matchFacts(game)});m.events=m.events.slice(-12);return m;}

// Evidence-bearing local memory. Behavioural hypotheses never override explicit controls.
export function recordCoachEvent(memory,event){
 const m=structuredClone(memory);m.journal??=[];
 if(!event?.id||!event.matchId||!Number.isInteger(event.turn))return m;
 if(m.journal.some(e=>e.id===event.id))return m;
 m.journal.push({...event,time:event.time||new Date().toISOString(),rulesVersion:event.rulesVersion||'0.6',source:'local-game',confidence:event.confidence??1});
 m.journal=m.journal.slice(-240);return m;
}
export function rememberDecision(memory,{matchId,turn,lesson,reasonable,prompted,scoreGap,rulesVersion,caseKey}){
 let m=recordCoachEvent(memory,{id:`${matchId}:decision:${turn}`,kind:'decision',matchId,turn,lesson,reasonable,prompted,scoreGap,rulesVersion,caseKey,confidence:.6});
 const relevant=m.journal.filter(e=>e.kind==='decision'&&e.lesson===lesson&&!e.prompted);
 const recent=relevant.slice(-6),good=recent.filter(e=>e.reasonable);
 m.reflections??={};
 if(recent.length>=3)m.reflections[lesson]={label:good.length>=3&&good.length/recent.length>=.75?'多次独立选择合理，可减少该类提示':'继续观察，暂不判断掌握',reduceHints:good.length>=3&&good.length/recent.length>=.75,evidenceIds:recent.map(e=>e.id),confidence:.6,updatedAt:new Date().toISOString(),basis:'一回合启发式比较，不等于真正掌握'};
 return m;
}
export function adaptiveGate(memory,{lesson,risk=false,mode='gentle',now=Date.now()}){
 if(mode==='quiet')return {allow:false,reason:'explicit-quiet'};
 if(mode==='critical'&&!risk)return {allow:false,reason:'explicit-critical'};
 const journal=memory.journal||[];
 const dismissals=journal.filter(e=>e.kind==='dismiss'&&now-Date.parse(e.time)<7*86400000);
 if(dismissals.length>=2&&!risk)return {allow:false,reason:'recent-dismissals'};
 const reflection=memory.reflections?.[lesson];
 const backed=reflection?.evidenceIds?.length>=3&&reflection.evidenceIds.every(id=>journal.some(e=>e.id===id));
 if(backed&&reflection.reduceHints&&!risk)return {allow:false,reason:'independent-success'};
 return {allow:true,reason:risk?'actionable-risk':'no-reliable-suppression-evidence'};
}
export function deleteMemoryEvidence(memory,id){
 const m=structuredClone(memory);m.journal=(m.journal||[]).filter(e=>e.id!==id);m.dialogue=[];m.lastTopic=null;
 for(const [key,value]of Object.entries(m.reflections||{}))if(value.evidenceIds.includes(id))delete m.reflections[key];
 return m;
}
export function memorySummary(memory){
 const rows=Object.entries(memory.reflections||{}).map(([k,v])=>`${k}：${v.label}（${v.evidenceIds.length}条记录）`);
 const base=rows.length?rows.join('；'):'还没有足够的独立行动证据，不判断你是否熟练。';
 const transfers=Object.keys(memory.reflections||{}).map(lesson=>transferAssessment(memory,lesson)).filter(x=>x.independentAttempts).map(x=>`${x.lesson}：${x.status}（${x.independentAttempts}次独立行动，${x.distinctMatches}局）。`);
 const audit=coachSelfAudit(memory);return [base,...transfers,audit.evidenceIds.length?`小芽自身记录：${audit.fallbacks}次降级、${audit.dismissals}次被关闭；${audit.action}。`:''].filter(Boolean).join('\n');
}


export function transferAssessment(memory,lesson){
 const rows=(memory.journal||[]).filter(e=>e.kind==='decision'&&e.lesson===lesson&&!e.prompted&&e.caseKey);
 const recent=rows.slice(-8),cases=new Set(recent.map(e=>e.caseKey)),matches=new Set(recent.map(e=>e.matchId));
 const reasonable=recent.filter(e=>e.reasonable).length;
 return {lesson,independentAttempts:recent.length,reasonable,distinctSituations:cases.size,distinctMatches:matches.size,evidenceIds:recent.map(e=>e.id),status:recent.length>=3&&cases.size>=2&&matches.size>=2&&reasonable/recent.length>=.75?'出现跨局独立迁移迹象，仍需观察':'尚不足以判断迁移',causalClaim:false};
}
export function coachSelfAudit(memory){
 const rows=(memory.journal||[]).filter(e=>['coach-fallback','dismiss','stale'].includes(e.kind)).slice(-12);
 return {evidenceIds:rows.map(e=>e.id),fallbacks:rows.filter(e=>e.kind==='coach-fallback').length,dismissals:rows.filter(e=>e.kind==='dismiss').length,stale:rows.filter(e=>e.kind==='stale').length,action:rows.filter(e=>e.kind==='dismiss').length>=2?'降低普通提示频率':rows.filter(e=>e.kind==='coach-fallback').length>=2?'保留可靠本地证据，优先检查模型回答':'继续观察',confidence:rows.length>=3?.6:.2};
}

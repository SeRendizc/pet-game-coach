import {TOOL_CONTRACTS,validToolArgs,executeTool} from './toolbox.js';
import {isLiveMatch} from './policy.js';
export const MATCH_REVIEW_REQUEST='总结整局：先说这局的走向，再选一个有证据的亮点或值得复盘的选择。没有突出亮点就不硬夸，获胜不必挑错，失利不把单回合评分当必然败因。说清宠物和具体回合，80字以内。';
import {strategist,searchKnowledge,RULES_VERSION,cards,resolveCitation} from './strategist.js';
import {teacher,makeQuiz,review,summarizeMatch,reviewMatch,analyzeTurn,compareTurnAlternatives} from './teacher.js';
import {companion} from './companion.js';
import {rememberPreference} from './memory.js';
// Local provider boundary. Future server provider may phrase this evidence packet with DeepSeek.
export const localProvider={name:'local',async generate(packet){return packet.text;}};
export function buildContext(game,profile,focus,archive=null,stageId='meadow',message=''){
 const current=game?.history?.length?game:archive?.current;
 const previous=archive?.completed?.at(-1);
 const source=/本局|当前.*局/.test(message)||game&&!/上一局/.test(message)?current:/上一局/.test(message)?previous||((game?.result)?game:null):game?.result?game:previous||current;
 const requested=message.match(/第\s*(\d+)\s*回合/);
 const selected=requested?source?.history?.find(h=>h.type==='turn'&&h.before.turn===Number(requested[1])):null;
 return {evidenceIndex:(source?.history||[]).filter(h=>h.type==='turn').map(h=>({id:(source.id||'current')+':turn:'+h.before.turn,turn:h.before.turn,rulesVersion:source.version,events:h.events})),mode:game?.mode||'camp',focus,stageId,profile:structuredClone(profile),lastMatch:summarizeMatch(source),
 evidenceRulesVersion:requested?source?.version:game?.version||archive?.current?.version||'unknown',
 requestedTurn:requested?Number(requested[1]):null,
 lastTurn:requested?selected||null:game?.history.filter(x=>x.type==='turn').at(-1)||(!game?archive?.lastTurn:null)||null,
 battle:game?{environment:structuredClone(game.environment||null),energyLimit:6,id:game.id,version:game.version,mode:game.mode,phase:game.phase,result:game.result,turn:game.turn,seed:0,player:structuredClone(game.player),enemy:structuredClone(game.enemy),history:[],log:[],frames:[]}:null};
}
export async function runCoach({message,role='auto',context,memory,conversation=[],provider=localProvider}){
 context={...context,goal:memory.goal||null,favorite:memory.favorite||null};
 let next=rememberPreference(memory,message),packet,route=role,locked=false;
 const previous=Array.isArray(conversation)&&conversation.length?conversation.slice(-8):(memory.dialogue||[]);
 const followup=/^[？?]+$|什么意思|为什么|为啥|没懂|说反|连续性|接着|然后呢/.test(message);
 const ruleCard=cards.find(c=>c.id.startsWith('rule:')&&message.includes(c.title.split(' ')[0])&&/消耗|威力|优先级|面板|介绍|多少/.test(message));
 const situational=/咋办|怎么办|怎么救|救一下|救命|分析|输了|输在哪|打不过|damn/i.test(message);
 const matchRequest=/整局|整场|上一局|一整局/.test(message)||/复盘|回顾/.test(message)&&!/回合/.test(message)||(situational||followup)&&!!(context.battle?.result||!context.battle&&context.lastMatch);
 const quizRequest=/小测|练习题|出.{0,5}题/.test(message);
 if(isLiveMatch(context))return {text:'本地与正式 PVP 赛中不提供战术分析或教学，结束后我们再聊。',evidence:[],memory:next,route:'policy',provider:'local'};
 if(next.goal!==memory.goal){next.lastTopic='preference';packet={text:`记住了，你更想${next.goal==='稳健'?'打得稳一些，培养时我会优先比较生存空间':'打得主动些，培养时我会优先比较输出和先手'}。这个偏好随时可以改。`,evidence:['来源：你明确表达的玩法目标。']};locked=true;}
 else if(next.preference!==memory.preference)packet={text:'记住了，以后'+(next.preference==='brief'?'简短说。':'多解释一点。'),evidence:['来源：你刚才明确表达的偏好。']};
 else if(followup&&memory.lastTopic==='watch'){packet={text:next.watches?.length?'刚才的委托只在当前对局有效，未来10回合内符合条件时提醒一次。静默设置仍优先，也可以说“取消提醒”。':'刚才的条件提醒已经取消或触发完成，不会继续等待。',evidence:[]};locked=true;route='guide';}
 else if(/取消.*提醒|取消.*委托/.test(message)){next.lastTopic='watch';next.watches=[];packet={text:'已取消你委托的条件提醒，平时的提醒档位不变。',evidence:[]};locked=true;route='guide';}
 else if(/提醒/.test(message)&&/能量|豆|收尾/.test(message)){next.lastTopic='watch';const kind=/收尾/.test(message)?'finish':'energy';if(!context.battle?.id||context.battle.result)packet={text:'先进入一场训练，我才能把这个提醒绑定到当前对局。',evidence:[]};else{next.watches=[{id:`watch:${context.battle.id}:${kind}`,matchId:context.battle.id,kind,expiresTurn:context.battle.turn+10,once:true}];packet={text:`好，这局接下来10回合，${kind==='finish'?'合法攻击满足当前目标的直接收尾条件':'场上伙伴能量降到1豆或以下'}时提醒一次。仍遵守你的安静设置，随时可以说“取消提醒”。`,evidence:['只检查公开状态；收尾条件不保证对方留场或不防御。']};}locked=true;route='guide';}
 else if(/种子|随机编号/.test(message)||followup&&memory.lastTopic==='seed'){
   packet={text:'首页的“种子”是随机编号，不是宠物或培养材料。它用于复现随机过程：同一规则版本、阵容、成长、难度和操作序列下，同一个编号可重现对战。正常玩保持默认就好，改它不会直接增强宠物。',evidence:['来源：engine.js createGame / random；首页 seed 输入框。']};route='guide';locked=true;next.lastTopic='seed';
 }else if(ruleCard||followup&&memory.lastTopic==='rules'){const card=ruleCard||resolveCitation(memory.ruleReferenceId);packet=card?{text:card.principle,evidence:[`[${card.id}] ${card.counterexample} 来源：${card.authority.join('、')}，规则${card.rulesVersion}。`]}:{text:'这条规则依据已不可用，需要重新核对。',evidence:[]};next.lastTopic='rules';next.ruleReferenceId=card?.id||null;route='guide';locked=true;}else if(quizRequest){
   const quiz=makeQuiz(context,{variant:next.quizCount||0});next.quizCount=(next.quizCount||0)+1;next.pendingQuiz=quiz;packet={text:quiz.question,evidence:[],choices:['先出手','后出手','不确定','先不做了']};route='teacher';locked=true;next.lastTopic='quiz';
 }else if(memory.pendingQuiz&&!/复盘|回顾|整局|整场|上一局|详看第.+回合/.test(message)){
   const quiz=memory.pendingQuiz;
   if(/取消|不做|跳过/.test(message)){next.pendingQuiz=null;packet={text:'好，先放着。继续玩就行。',evidence:[]};locked=true;route='teacher';}
   else if(/^(我选|选|应该|是)?[「“"]?(先(出手)?|后(出手)?|不确定)[」”"]?[。！! ]*$/.test(message.trim())){
     const answer=message.includes('不确定')?'不确定':message.includes('先')?'先':'后';
     const correct=answer===quiz.answer;packet={text:(correct?'答对了。':'这里应选“'+quiz.answer+'出手”。')+quiz.explanation,evidence:[quiz.lesson],quizResult:{correct,lesson:quiz.lesson}};
     if(correct&&!next.lessons.includes(quiz.lesson))next.lessons.push(quiz.lesson);next.pendingQuiz=null;route='teacher';locked=true;next.lastTopic='quiz';
   }else if(followup){packet={text:'刚才这道题还在等你作答，我不该先报答案。'+quiz.question,evidence:[],choices:['先出手','后出手','不确定','先不做了']};route='teacher';locked=true;}
 }else if(followup&&memory.lastTopic==='quiz'){
   packet={text:'你是在接着问刚才的小测。'+(previous.filter(x=>x.role==='assistant').at(-1)?.content||'可以重新出一道题，我们一步步来。'),evidence:[]};route='teacher';locked=true;
 }else if(matchRequest){packet=reviewMatch(context);route='teacher';next.lastTopic='match-review';locked=true;}
 else if(/复盘|回顾|详看第.+回合/.test(message)){packet=context.requestedTurn&&!context.lastTurn?{text:`这份对局记录里没有第 ${context.requestedTurn} 回合，不能用其他回合替代。`,evidence:[]}:review(context);if(context.lastTurn)packet={...packet,evidence:[...packet.evidence,compareTurnAlternatives(context.lastTurn,context.evidenceRulesVersion||'0.6')?.text].filter(Boolean),text:`第 ${context.lastTurn.before.turn} 回合：${analyzeTurn(context.lastTurn,{rulesVersion:context.evidenceRulesVersion||'0.6'})}`};route='teacher';next.lastTopic='review';locked=true;}
 if(!packet&&followup&&['review','match-review'].includes(memory.lastTopic)){packet=memory.lastTopic==='match-review'?reviewMatch(context):review(context);route='teacher';locked=true;}
 if(!packet){
   if(role==='auto')route=/培养|加点|成长/.test(message)?'teacher':(/怎么打|建议|这回合|换宠|技能|先手|能量|豆|属性|克制|防御|预判/.test(message)||situational&&context.battle)?'strategist':'companion';
   if(followup&&['teacher','strategist'].includes(memory.lastTopic))route=memory.lastTopic;
   packet=route==='strategist'?strategist({...context,query:message}):route==='teacher'?teacher(context):companion(context,next,message);next.lastTopic=route;
 }
 const deterministic=locked&&!['review','match-review'].includes(next.lastTopic);
 const useModel=provider.name!=='local'&&!deterministic;
 if(!locked&&next.preference==='brief'&&packet.text.length>160)packet={...packet,text:packet.text.slice(0,157)+'…'};
 packet={...packet,publicState:context.battle,latestEvents:context.lastTurn?.events||[],playerMessage:message,conversation:previous,taskState:{topic:next.lastTopic,pendingQuestion:next.pendingQuiz?.question||null},interfaceContext:{screen:context.mode==='camp'?'首页营地与培养':'对战',focus:context.focus,stageId:context.stageId}};
 if(useModel&&provider.plan&&['strategist','teacher'].includes(route)){
   const result=await gatherAgentEvidence({message,context,plan:provider.plan,retrieve:provider.retrieve});
   packet={...packet,toolTrace:result.trace,agentStop:result.stopped};
 }
 const text=useModel?await provider.generate(packet):packet.text;
 if(typeof text!=='string'||!text.trim())throw Error('教练暂时没有生成有效回答');
 const rejected=useModel&&text.length>360;
 const finalText=rejected?packet.text:text;
 next.dialogue=[...previous,{role:'user',content:message},{role:'assistant',content:finalText}].slice(-8);
 return {...packet,text:finalText,memory:next,route,provider:rejected?'local-fallback':useModel?provider.name:'local',verified:!useModel,localOnly:deterministic,fallbackReason:rejected?'模型输出过长，显示已核验的本局分析':undefined};
}

// Bounded tool loop: planner may choose a different tool after inspecting receipts.
// No game mutations and no arbitrary code/URL tools are exposed.
export async function gatherAgentEvidence({message,context,plan,limit=2,retrieve=null}){
 if(isLiveMatch(context))return {trace:[],stopped:'policy'};
 const trace=[];const seen=new Set();
 for(let i=0;i<Math.min(3,limit);i++){
  let choice;try{choice=await plan({message,screen:context.mode,tools:Object.keys(TOOL_CONTRACTS),contracts:TOOL_CONTRACTS,receipts:trace,remaining:limit-i});}catch{return {trace,stopped:'planner-failed'};}
  if(choice?.stop===true)return {trace,stopped:'complete'};
  const name=choice?.tool,args=choice?.args||{};
  if(!Object.hasOwn(TOOL_CONTRACTS,name))return {trace,stopped:'invalid-tool'};
  if(!validToolArgs(name,args))return {trace,stopped:'invalid-arguments'};
  const key=JSON.stringify([name,args]);if(seen.has(key))return {trace,stopped:'repeated-tool'};seen.add(key);
  let result;try{result=name==='search_rules'&&retrieve?await retrieve(args.query,{game:context.battle,rulesVersion:context.battle?.version||RULES_VERSION}):executeTool(name,args,context,message);}catch(error){return {trace,stopped:error.message==='policy'?'policy':'invalid-arguments'};}
  // Reject oversized receipts rather than cutting JSON or losing evidence identifiers.
  if(JSON.stringify(result).length>10000)return {trace,stopped:'receipt-budget'};
  trace.push({id:`tool:${i+1}`,tool:name,args,result});
 }
 return {trace,stopped:'tool-budget'};
}

// UTF-8 bytes are used as a conservative engineering budget, not advertised as the
// provider's exact tokenizer. Original archives remain outside the prompt.
export function assembleContext(payload,{window=32768,output=512,system=4096,tools=2048}={}){
 const budget=window-output-system-tools;
 if(budget<1024)throw Error('上下文预算不足');
 const bytes=x=>new TextEncoder().encode(JSON.stringify(x)).length;
 const p=structuredClone(payload),m=p.memory||{};
 const journal=m.journal||[];
 const task=/复盘|回顾|整局|上一局|分析|输/.test(p.message)||p.context.battle?.result?'review':/培养|加点/.test(p.message)?'training':'battle';
 m.journal=journal.filter(e=>task==='review'?e.matchId===p.context.lastMatch?.id:e.kind==='dismiss').slice(-6);
 m.reflections=Object.fromEntries(Object.entries(m.reflections||{}).map(([k,v])=>[k,{...v,evidenceIds:v.evidenceIds.filter(id=>m.journal.some(e=>e.id===id))}]).filter(([k,v])=>v.evidenceIds.length>=3));
 m.events=(m.events||[]).slice(-3);m.dialogue=[];
 if(task!=='review'){delete p.context.lastMatch;p.context.evidenceIndex=[];}
 p.conversation=(p.conversation||[]).slice(-8);
 while(bytes(p)>budget&&p.context.evidenceIndex?.length>1)p.context.evidenceIndex.shift();
 while(bytes(p)>budget&&p.conversation.length)p.conversation.shift();
 if(bytes(p)>budget){m.journal=[];m.reflections={};m.events=[];}
 // Evidence objects are removed whole, never sliced into invalid/truncated JSON.
 while(bytes(p)>budget&&p.context.lastMatch?.keyTurns?.length>1)p.context.lastMatch.keyTurns.pop();
 if(bytes(p)>budget)throw Error('当前证据超过上下文预算，请缩小到一个回合；原始记录仍保留在本机。');
 return {payload:p,audit:{task,window,outputReserve:output,systemReserve:system,toolReserve:tools,estimatedInput:bytes(p),estimate:'UTF-8 byte upper budget; not exact model token count',retainedEvidenceIds:[...(p.context.lastMatch?.keyTurns||[]).map(x=>x.id),...(m.journal||[]).map(x=>x.id)]}};
}

export function checkGroundedAnswer(answer){
 const reasons=[],text=answer.text||'',facts=JSON.stringify({evidence:answer.evidence||[],tools:answer.toolTrace||[],state:answer.publicState,events:answer.latestEvents,summary:answer.textFacts});
 if(/先看.{0,8}(?:对手|它).{0,6}出招|看(?:到|完)对手.{0,5}(?:出招|行动)再/.test(text))reasons.push('simultaneous-action-order');
 if(/必胜|稳赢|保证获胜|一定能赢|百分之百|100%/.test(text))reasons.push('unsupported-certainty');
 if(answer.scope!=='match'&&answer.publicState){for(const side of ['player','enemy'])for(const pet of answer.publicState[side]?.pets||[]){const start=text.lastIndexOf(pet.name);if(start<0)continue;const clause=text.slice(start+pet.name.length).split(/[。；，]/)[0];if(/满豆|满能量/.test(clause)&&pet.energy<6)reasons.push('energy-not-full:'+pet.id);}}
 // Bind explicit remaining-HP claims to that turn's after snapshot, not any number in the packet.
 for(const k of answer.textFacts?.keyTurns||[]){
  const block=text.match(new RegExp('第\\s*'+k.turn+'\\s*回合([\\s\\S]*?)(?=第\\s*\\d+\\s*回合|$)'))?.[1]||'';
  for(const pet of k.hpAfter||[]){
   if((k.hpAfter||[]).filter(x=>x.name===pet.name).length!==1)continue;
   const claim=block.match(new RegExp(pet.name+'[^。；]{0,30}?还(?:剩|有)\\s*(\\d+)\\s*(?:血|HP)'));
   if(claim&&!/回合前|出招前|开始时|当时/.test(claim[0])&&Number(claim[1])!==pet.hp)reasons.push('after-hp-mismatch:'+k.turn+':'+pet.name);
  }
 }
 // Bind cancelled actions to their turn, rather than accepting a number from another turn.
 for(const k of answer.textFacts?.keyTurns||[]){
  if(!k.playerActionCancelled&&!k.events?.some(e=>e.includes('你的宠物已倒下，原定行动取消')))continue;
  const part=text.match(new RegExp('第\\s*'+k.turn+'\\s*回合([^。；]*)(?:[。；]|$)'))?.[1]||'';
  if(/(?:撞|打|造成|输出)[^，。；]{0,8}\d+/.test(part)&&!/(?:未|没|无法|取消|本来|假如|如果|预计|可能|可造成)/.test(part))reasons.push('cancelled-action-claimed-as-hit:'+k.turn);
 }
 const supported=new Set((facts.match(/-?\d+(?:\.\d+)?/g)||[]).map(Number));
 for(const n of text.match(/-?\d+(?:\.\d+)?/g)||[])if(!supported.has(Number(n))&&!['1','2','3'].includes(n))reasons.push('unsupported-number:'+n);
 const available=new Set((answer.knowledge||[]).map(c=>c.id));
 for(const id of text.match(/(?:tactic|ui|rule):[a-z:-]+/g)||[])if(!available.has(id))reasons.push('unsupported-citation:'+id);
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],scope:'Narrow numeric/citation/certainty guard; not a proof of all natural language correctness'};
}
export function fitModelMessages(messages,{window=32768,output=512,reserve=1024}={}){
 const budget=window-output-reserve,bytes=x=>new TextEncoder().encode(JSON.stringify(x)).length;
 const copy=structuredClone(messages);
 // Never silently trim the final evidence-bearing request or hard system rules.
 while(bytes(copy)>budget&&copy.length>2)copy.splice(1,1);
 if(bytes(copy)>budget)throw Error('模型输入预算不足，保留本地证据回答');
 return copy;
}

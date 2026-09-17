// 陪练（Companion）：状态模型 → 语气档位 → 真实事件模板 → 克制扫描。
// 设计依据 docs/COMPANION-DESIGN.md §3；实现说明 docs/COMPANION-IMPLEMENTATION.md。
//
// 三条纪律（任何模板都必须满足，由 checkCompanionRestraint 事后扫描）：
//   1. 只引用本机真实记录（memory.events / lessons / dialogue / journal / 当前对局）里存在的字段；
//   2. 每个档位有字数上限与问句上限（R0 不说 / R1 就事论事 / R2 具体关切 / R3 收尾陪坐）；
//   3. 没有任何真实经历时只输出最短承接句，不编造过去。
import {SPECIES} from '../engine.js';
import {isLiveMatch} from './policy.js';

const DAY=86400000;
export const REGISTERS={
 R0:{name:'不说',limit:8,maxQuestions:0,advice:false},
 R1:{name:'就事论事',limit:40,maxQuestions:0,advice:false},
 R2:{name:'具体关切',limit:80,maxQuestions:1,advice:true},
 R3:{name:'收尾陪坐',limit:30,maxQuestions:0,advice:false},
};
export const REGISTER_ORDER=['R0','R1','R2','R3'];
export const EMOTION_WORDS=/烦|输了|难受|好菜|气死|崩了|不想玩|好难/;
export const FOLLOWUP_WORDS=/^[？?]+$|连续性|什么意思|为什么|为啥/;
// 纯寒暄：整句就是社交用语。带问题的句子（「你好，能问下…」）不算。
const SOCIAL_ONLY=/^(你?好|您好|hi|hello|嗨|早|早安|晚安|谢谢|多谢|辛苦了|好的|好|嗯|哦|ok|OK|收到|在吗|在么|在不在)[!！。~～,.， ]*$/;
const ASK_WORDS=/[？?]|怎么|如何|哪|什么|吗|能不能|要不要/;

export function resultWord(result){return {win:'胜利',loss:'失利',draw:'平局'}[result]||null;}
// 关卡名带「01 · 」前缀，展示时去掉；这是唯一一处对真实字段做的显示层清洗，不新增信息。
export function cleanStage(stage){return typeof stage==='string'?(stage.replace(/^\s*\d+\s*·\s*/,'').trim()||null):null;}

export function intentOf(message=''){
 const text=String(message||'').trim();
 if(EMOTION_WORDS.test(text))return 'emotion';
 if(FOLLOWUP_WORDS.test(text))return 'followup';
 if(SOCIAL_ONLY.test(text))return 'chat';
 if(ASK_WORDS.test(text))return 'ask';
 return 'other';
}

// 真实素材：全部来自本机记忆与当前局面，缺字段就是 null，绝不用默认值补造。
export function companionFacts(memory={},context={},now=Date.now()){
 const history=(memory.events||[]).filter(e=>e&&typeof e.result==='string');
 const last=history.at(-1)||null;
 const summary=context.lastMatch&&typeof context.lastMatch==='object'?context.lastMatch:null;
 const items=last?.items&&typeof last.items==='object'?last.items:summary?.remainingItems&&typeof summary.remainingItems==='object'?summary.remainingItems:null;
 const rawStage=last?.stage||summary?.stage||null;
 const rawTurns=Number.isInteger(last?.turns)?last.turns:Number.isInteger(summary?.rounds)?summary.rounds:null;
 const rawResult=last?.result||summary?.result||null;
 const lessons=(memory.lessons||[]).filter(x=>typeof x==='string');
 const favorite=SPECIES.find(p=>p.id===memory.favorite)||null;
 const time=Date.parse(last?.time||'');
 return {history,last,summary,live:liveFacts(context),
  stage:cleanStage(rawStage),turns:rawTurns,result:rawResult,
  source:last?'memory.events':summary?'context.lastMatch':null,
  enemy:Array.isArray(last?.enemy)?last.enemy.filter(x=>typeof x==='string'):[],
  faints:Array.isArray(last?.faints)?last.faints.filter(x=>typeof x==='string'):[],
  firstLossTurn:Number.isInteger(last?.firstLossTurn)?last.firstLossTurn:null,
  // 首个减员必须用成对记录的 firstFallen：faints[0] 是队伍顺序里的第一只，
  // 未必是第 firstLossTurn 回合倒下的那只，混用会说出一句假话。
  firstFallen:typeof last?.firstFallen==='string'?last.firstFallen:null,
  survivors:Number.isInteger(last?.survivors)?last.survivors:null,
  potion:Number.isInteger(items?.potion)?items.potion:null,
  lessons,favorite:favorite?favorite.name:null,knowsFavorite:Boolean(favorite),
  goal:['稳健','速攻'].includes(memory.goal)?memory.goal:null,
  preference:['brief','detailed'].includes(memory.preference)?memory.preference:null,
  dialogue:(memory.dialogue||[]).filter(x=>x&&typeof x.content==='string'),
  daysAgo:Number.isFinite(time)?Math.max(0,Math.floor((now-time)/DAY)):null};
}

function liveFacts(context={}){
 const b=context.battle;
 if(!b||!Array.isArray(b.player?.pets))return null;
 const enemySide=b.enemy||{},playerSide=b.player;
 const opponent=enemySide.pets?.[enemySide.active]?.name||null;
 const current=playerSide.pets[playerSide.active]?.name||null;
 return {opponent,current,over:Boolean(b.result),result:b.result||null,
  turn:Number.isInteger(b.turn)?b.turn:null,
  fallen:playerSide.pets.filter(p=>p&&p.hp<=0).map(p=>p.name),
  alive:playerSide.pets.filter(p=>p&&p.hp>0).length};
}

export function trailingStreak(history=[],result){let n=0;for(let i=history.length-1;i>=0;i--){if(history[i].result!==result)break;n++;}return n;}

// 状态派生：只读真实字段。reasons 里的每个数字都能回溯到一条本机记录。
export function companionState(memory={},context={},session={},now=Date.now()){
 const facts=companionFacts(memory,context,now);
 const recent=facts.history.slice(-3);
 const momentum=recent.reduce((n,e)=>n+({win:1,loss:-1,draw:0}[e.result]||0),0);
 const lossStreak=trailingStreak(facts.history,'loss');
 const winStreak=trailingStreak(facts.history,'win');
 const dismissals=(memory.journal||[]).filter(e=>e?.kind==='dismiss'&&Number.isFinite(Date.parse(e.time||''))&&now-Date.parse(e.time)<7*DAY).length;
 const consideration=Math.max(0,2-Math.min(2,dismissals));
 const playerInitiated=Boolean(session.playerInitiated);
 const intent=session.intent||(playerInitiated?intentOf(session.message):'other');
 const engagement=playerInitiated?2:(facts.history.length||facts.dialogue.length?1:0);
 // 「有一条尚未说过的真实观察」：本轮由玩家发起时，玩家这句话本身就是新输入；
 // 主动侧要求本局还没就这件事说过（session.alreadySaid 由 coach.js 的门控维护）。
 const pendingObservation=Boolean(facts.history.length||facts.dialogue.length||facts.lessons.length||facts.live||facts.summary)&&!session.alreadySaid;
 const hasExperience=Boolean(facts.history.length||facts.dialogue.length||facts.lessons.length||facts.live||facts.summary);
 const decision=decideRegister({context,intent,playerInitiated,consideration,momentum,lossStreak,hasExperience,pendingObservation,alreadySaid:Boolean(session.alreadySaid)});
 const wins=recent.filter(e=>e.result==='win').length,losses=recent.filter(e=>e.result==='loss').length,draws=recent.filter(e=>e.result==='draw').length;
 const reasons=[
  `最近${recent.length}局${wins}胜${losses}负${draws?draws+'平':''}，momentum=${momentum}（来源：memory.events）`,
  `近7天有${dismissals}次主动关闭提示，consideration=${consideration}（来源：memory.journal 的 dismiss）`,
  playerInitiated?`本轮由玩家发起，意图=${intent}，engagement=${engagement}（来源：本轮消息）`:`本轮不是玩家发起，engagement=${engagement}（来源：memory.events / memory.dialogue）`,
  `判定：${decision.reason}`,
 ];
 return {register:decision.register,registerReason:decision.reason,engagement,consideration,momentum,lossStreak,winStreak,hasExperience,pendingObservation,reasons,facts};
}

// 档位决策顺序见 docs/COMPANION-DESIGN.md §3.2（先命中先返回，纯函数）。
export function decideRegister({context={},intent='other',playerInitiated=false,consideration=2,momentum=0,lossStreak=0,hasExperience=false,pendingObservation=false,alreadySaid=false}={}){
 // 「确实在连着输」是 R3 的唯一依据：真实连败 ≥2 局（profile/events 的计数），
 // 或最近三局合计 momentum ≤ -2。没有这条记录就不进收尾陪坐。
 const losing=lossStreak>=2||momentum<=-2;
 if(isLiveMatch(context))return {register:'R0',reason:'线上竞技进行中（coach/policy.js isLiveMatch）'};
 if(context.preference==='quiet')return {register:'R0',reason:'玩家把提示档设为安静（profile.coach.mode）'};
 if(context.dismissed)return {register:'R0',reason:'玩家已关闭本局提示（session.dismissed）'};
 if(consideration===0&&!playerInitiated)return {register:'R0',reason:'7天内主动关闭提示≥2次，且本轮不是玩家发起'};
 if(playerInitiated){
  if(intent==='emotion')return losing?{register:'R3',reason:`玩家本轮倾诉，且真实记录里连着输（连败${lossStreak}局，momentum=${momentum}）`}:{register:'R2',reason:`玩家本轮倾诉，但真实记录里没有连败（连败${lossStreak}局，momentum=${momentum}）`};
  if(intent==='followup')return {register:'R2',reason:'玩家在追问上一句，需要承接而不是换话题'};
  if(intent==='chat')return {register:'R0',reason:'纯寒暄，没有可核对的经历需要补'};
  if(!hasExperience)return {register:'R0',reason:'本机没有任何真实记录，不编造过去'};
  if(intent==='ask')return {register:'R2',reason:'玩家提出了需要回应的具体问题'};
  return {register:'R1',reason:'玩家没有明确意图，只陈述一条可核对的事实'};
 }
 if(losing&&!alreadySaid)return {register:'R3',reason:`本轮不是玩家发起，连败${lossStreak}局、momentum=${momentum}，本局还没就这件事说过`};
 if(pendingObservation)return {register:'R1',reason:'本轮不是玩家发起，但有一条尚未说过的真实观察'};
 return {register:'R0',reason:'本轮不是玩家发起，也没有新的真实观察'};
}

// 主动侧档位：coach.js 的 5 个门控决定「说不说」，这里只决定「用哪个档位说」。
// 连败 ≥2（profile.lossStreak，真实计数）时收尾陪坐，否则只做事实陈述。
export function proactiveRegister({lossStreak=0}={}){return Number.isFinite(lossStreak)&&lossStreak>=2?'R3':'R1';}

// —— 模板素材：每个片段都自带来源，compose 只做「按档位字数上限取舍」，不新增内容 ——
function matchClause(f){
 const single=f.faints.length===1?f.faints[0]:null,count=f.faints.length>1?`倒下${f.faints.length}只`:null;
 const bits=['上一场',f.stage||'',f.turns?`${f.turns}回合`:'',resultWord(f.result)?`，${resultWord(f.result)}`:'',single?`，${single}倒下`:count?`，${count}`:''];
 if(bits.join('')==='上一场')return null;
 return {text:bits.join('')+'。',source:f.source};
}
function observations(f){
 const out=[];
 if(f.firstLossTurn&&f.firstFallen)out.push({text:`${f.knowsFavorite&&f.firstFallen===f.favorite?'你的本命':''}${f.firstFallen}在第${f.firstLossTurn}回合倒下。`,tags:['速攻'],source:'memory.events.firstLossTurn'});
 if(f.potion!==null)out.push({text:`结束时还剩${f.potion}瓶回复药。`,tags:['稳健'],source:'memory.events.items'});
 if(f.survivors!==null)out.push({text:`结束时还有${f.survivors}只伙伴站着。`,tags:['稳健'],source:'memory.events.survivors'});
 if(f.lessons.length)out.push({text:`练过的课程有${f.lessons.slice(-2).join('、')}。`,tags:[],source:'memory.lessons'});
 if(f.daysAgo!==null&&f.daysAgo>=3)out.push({text:`上一次记录是${f.daysAgo}天前。`,tags:[],source:'memory.events.time'});
 if(f.live?.opponent)out.push({text:`本局对手是${f.live.opponent}。`,tags:[],source:'context.battle'});
 if(f.enemy.length)out.push({text:`上一场对手是${f.enemy.join('、')}。`,tags:['速攻'],source:'memory.events.enemy'});
 return out;
}
function pickObservation(f){const all=observations(f);return all.find(o=>f.goal&&o.tags.includes(f.goal))||all.find(o=>!o.tags.length)||all[0]||null;}
function offerClause(f){
 if(f.live&&!f.live.over)return {text:'想聊这一回合就说一声。',source:'context.battle'};
 if(f.firstLossTurn)return {text:`想回看第${f.firstLossTurn}回合说一声。`,source:'memory.events.firstLossTurn'};
 if(f.summary?.rounds)return {text:'想看整局记录说一声。',source:'context.lastMatch'};
 if(f.lessons.length)return {text:'想接着练就说一声。',source:'memory.lessons'};
 return null;
}
// 按上限拼接：超限的片段整条丢弃，不截半句（截半句会造出无法核对的话）。
export function compose(parts=[],limit=80){
 let out='';
 for(const part of parts){if(!part?.text)continue;const next=out+part.text;if(next.length>limit)break;out=next;}
 return out||null;
}

// 被动通道：玩家先开口。R0 在这里是最短承接句（聊天通道不能真的空消息，
// runCoach 会拒绝空文本）；真正的「不发消息」只存在于主动通道（coach.js 返回 null）。
export function companion(context={},memory={},message=''){
 const now=Date.now(),intent=intentOf(message);
 const state=companionState(memory,context,{playerInitiated:true,intent,message},now);
 const f=state.facts;
 const fact=matchClause(f),obs=pickObservation(f),offer=offerClause(f);
 let register=state.register,text=null;
 if(register==='R0')text='我在。';
 else if(register==='R1')text=compose([fact,obs],REGISTERS.R1.limit);
 else if(register==='R3')text=compose([r3Lead(f,state),{text:'到这儿也行，想继续我就在。'}],REGISTERS.R3.limit);
 else if(intent==='followup')text=followupReply(memory).text;
 else text=compose(f.preference==='brief'?[fact,obs]:[fact,obs,offer],REGISTERS.R2.limit);
 // 该档位需要的事实一条都拼不出来时，降到 R0 只说承接句：档位要么真的用上，要么明说降到最低。
 if(!text){register='R0';text='我在。';state.register='R0';state.registerReason='该档位需要的事实在本机记录里一条都找不到，降到最短承接句';}
 return publicPacket({text,register,state,intent});
}

// R3 开头只允许引用真实记录：有连败说连败，否则说最近一局，两者都没有就不说事实。
function r3Lead(f,state){
 if(state.lossStreak>=2)return {text:`连着${state.lossStreak}局没赢。`,source:'memory.events'};
 if(f.stage||f.turns)return {text:`${f.stage||''}${f.turns?f.turns+'回合':''}这一局。`,source:f.source};
 return {text:'到这儿也行。',source:null};
}

function followupReply(memory){
 const last=(memory.dialogue||[]).filter(x=>x?.role==='assistant'&&typeof x.content==='string').at(-1)?.content;
 if(!last)return {text:'这句我还没接准。你说的是哪一处？',source:'memory.dialogue'};
 const quote=last.replace(/[？?]+/g,'，').replace(/[。；，、\s]+$/,'').slice(0,36).replace(/[。；，、\s]+$/,'');
 return {text:`你是在接着刚才那句问：${quote}。可以指出哪一点不对，我接着核对。`,source:'memory.dialogue'};
}

// 每个数字都出现在依据里：这样模型改写后的答案也能通过 checkGroundedAnswer 的数字核对，
// 不会因为「引用了陪练模板里的真实数字」被误判成编造。
function publicPacket({text,register,state,intent}){
 const f=state.facts,history=f.history;
 const wins=history.filter(e=>e.result==='win').length,losses=history.filter(e=>e.result==='loss').length,draws=history.filter(e=>e.result==='draw').length;
 const evidence=[`本机对战记录：已结束${history.length}场，${wins}胜${losses}负${draws?draws+'平':''}（来源：memory.events，最多保留12场，预制场景不写入）。`];
 if(f.last){
  const bits=[f.stage,f.turns?`${f.turns}回合`:null,resultWord(f.result),f.faints.length?`${f.faints.join('、')}倒下`:null,
   f.firstLossTurn&&f.firstFallen?`首个减员在第${f.firstLossTurn}回合（${f.firstFallen}）`:null,
   f.survivors!==null?`结束时还有${f.survivors}只站着`:null,
   f.enemy.length?`对手${f.enemy.join('、')}`:null,f.potion!==null?`结束剩回复药${f.potion}瓶`:null].filter(Boolean);
  evidence.push(`最近一局：${bits.join('、')}（来源：${f.source}，规则${f.last.rulesVersion||'未知'}）。`);
 }
 evidence.push(`语气档位 ${register}（${REGISTERS[register].name}）：${state.registerReason}。`);
 evidence.push(`档位依据：${state.reasons.slice(0,-1).join('；')}。`);
 const settings=[`交流偏好${f.preference||'未设置'}`,`玩法目标${f.goal||'未设置'}`,`本命${f.favorite||'未设置'}`].join('、');
 evidence.push(`你的设置：${settings}（来源：你明确表达过才会记录）。`);
 if(f.lessons.length)evidence.push(`课程记录：${f.lessons.join('、')}（${f.lessons.length}条答对过的练习，不等于熟练掌握）。`);
 return {text,evidence,register,companionState:{register,engagement:state.engagement,consideration:state.consideration,momentum:state.momentum,lossStreak:state.lossStreak,winStreak:state.winStreak,reasons:state.reasons},replyConstraints:replyConstraints(register),intent,silent:register==='R0'};
}

// 模型路径下的档位约束：随证据包一起送到服务端（server.js 把整个证据包作为 game_evidence 发给模型）。
export function replyConstraints(register){
 const r=REGISTERS[register];
 return {register,maxChars:r.limit,maxQuestions:r.maxQuestions,allowAdvice:r.advice,
  forbid:['空泛安慰','评价玩家水平','第一人称情绪断言',r.advice?'':'给建议'].filter(Boolean),
  instruction:`本轮档位 ${register}（${r.name}）：正文不超过${r.limit}字，${r.maxQuestions?'最多一个问句':'不要问句'}，只写有本机记录支撑的事实。`};
}

// 克制扫描（docs/COMPANION-DESIGN.md §3.5 的五条，落地为可失败、可回退的检查）。
export function checkCompanionRestraint(text,{register='R2',facts={},previousAssistant=''}={}){
 const t=String(text??''),reasons=[],registerInfo=REGISTERS[register]||REGISTERS.R2;
 if(!t.trim())return {valid:false,reasons:['empty-text'],register,limit:registerInfo.limit};
 if(t.length>registerInfo.limit)reasons.push(`over-limit:${t.length}>${registerInfo.limit}`);
 const questions=(t.match(/[？?]/g)||[]).length;
 if(questions>registerInfo.maxQuestions)reasons.push(`too-many-questions:${questions}>${registerInfo.maxQuestions}`);
 if(/我(很|好|有点|真的|也|现在|其实)(开心|难过|伤心|生气|失望|高兴|兴奋)/.test(t))reasons.push('first-person-emotion');
 if(/加油|别灰心|你已经很棒|再接再厉|下次一定|一定可以|你可以的|不要放弃|没关系的|放轻松/.test(t))reasons.push('empty-encouragement');
 if(/菜|太弱|你错了|你不行|水平不够|速度意识差/.test(t))reasons.push('skill-insult');
 if(/(记得|上次|之前|上回|我们已经|上一场|那一局|连着)/.test(t)&&!facts.allowPast)reasons.push('unsupported-past-claim');
 if(/速度判断/.test(t)&&!(facts.lessons||[]).includes('速度判断'))reasons.push('lesson-not-recorded');
 if(register!=='R3'&&register!=='R0'&&/[？?]\s*$/.test(t.trim())&&/[？?]\s*$/.test(String(previousAssistant||'').trim()))reasons.push('consecutive-questions');
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],register,limit:registerInfo.limit};
}

// —— 主动侧模板（coach.js 调用）：引用刚发生的真实对局事实，不引用记忆外的内容 ——
export function proactiveText(event,context={},register='R1'){
 const f=companionFacts({},context,Date.now());
 const stage=f.stage||context.stage||null,turns=Number.isInteger(context.turn)&&context.turn>0?context.turn:null;
 const fallen=Array.isArray(context.fallen)?context.fallen:[];
 const alive=Number.isInteger(context.alive)?context.alive:null;
 const opponent=context.opponent||null;
 if(event==='first-faint'){
  const who=fallen.at(-1);
  const parts=[who?{text:`${who}倒下了。`}:{text:'有伙伴倒下了。'},alive!==null?{text:`还剩${alive}只。`}:null,{text:'补位不占回合，你先选。'}];
  return compose(parts,REGISTERS[register].limit);
 }
 if(event==='result'){
  const streak=Number.isInteger(context.lossStreak)?context.lossStreak:null;
  if(register==='R3'&&streak!==null&&streak>=2)return compose([{text:`连着${streak}局没赢。`},{text:'到这儿也行，想继续我就在。'}],REGISTERS.R3.limit);
  if(context.result==='win')return compose([{text:`${stage||''}${turns?turns+'回合':''}打完，拿下了。`},{text:'回营地可以继续培养。'}],REGISTERS.R1.limit);
  return compose([{text:`${stage||''}${turns?turns+'回合':''}结束，失利。`},opponent?{text:`对手是${opponent}。`}:null,alive!==null?{text:`还剩${alive}只。`}:null],REGISTERS.R1.limit);
 }
 return null;
}

// 陪练（Companion）：状态模型 → 语气档位 → 真实事件模板 → 克制扫描 → 在场层。
// 设计依据 docs/COMPANION-DESIGN.md §3；实现说明 docs/COMPANION-IMPLEMENTATION.md。
//
// 四条纪律（任何模板都必须满足，由 checkCompanionRestraint 事后扫描）：
//   1. 只引用本机真实记录（memory.events / lessons / dialogue / journal / 当前对局）里存在的字段；
//   2. 每个档位有字数上限与问句上限（R0 不说 / R1 就事论事 / R2 具体关切 / R3 收尾陪坐 / R4 在场搭话）；
//   3. 没有任何真实经历时只输出最短承接句，不编造过去；
//   4. 陪练可以有自己的情绪，也可以吐槽局面和选择，但**不评价玩家的水平**、不给战术指令、不说教。
//      第 4 条是按 voice 分开执行的：companion voice 放开第一人称情绪，sober voice（旧口径）仍然拦。
import {SPECIES,SKILLS,TYPES,multiplier} from '../engine.js';
import {isLiveMatch} from './policy.js';

const DAY=86400000;
export const REGISTERS={
 R0:{name:'不说',limit:8,maxQuestions:0,advice:false},
 R1:{name:'就事论事',limit:40,maxQuestions:0,advice:false},
 R2:{name:'具体关切',limit:80,maxQuestions:1,advice:true},
 R3:{name:'收尾陪坐',limit:30,maxQuestions:0,advice:false},
 // R4 是这一轮新增的「在场」档：陪练在对局中间插一句自己的看法。
 // 它比 R1 长（2–3 行）、比 R2 短，并且**不允许问句**——在场的话不是提问。
 R4:{name:'在场搭话',limit:60,maxQuestions:0,advice:false},
};
export const REGISTER_ORDER=['R0','R1','R2','R3','R4'];
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
// forbid 里的四条与 checkCompanionRestraint 的硬线一一对应；第一人称情绪与轻度吐槽不再列入禁止项，
// 因为陪练声线明确允许它们——送模型的约束与事后扫描必须说同一件事，否则模型会一直被回退。
export function replyConstraints(register,voice='companion'){
 const r=REGISTERS[register];
 return {register,voice,maxChars:r.limit,maxQuestions:r.maxQuestions,allowAdvice:r.advice,
  forbid:['空泛安慰','评价玩家水平','说教',r.advice?'':'给建议','战术指挥'].filter(Boolean),
  allow:voice==='companion'?['第一人称情绪','对局面和选择的轻度吐槽']:[],
  instruction:`本轮档位 ${register}（${r.name}）：正文不超过${r.limit}字，${r.maxQuestions?'最多一个问句':'不要问句'}，只写有本机记录支撑的事实。${voice==='companion'?'可以说自己的感受或吐槽刚才的局面，但不要评价玩家的水平、不要给战术指令。':''}`};
}

// 两条声线。陪练有自己的情绪是这一轮明确放开的东西，所以默认就是 companion；
// sober 保留旧口径（不出现第一人称情绪），给「只想被克制地陪」的场景留一个开关。
// 两种声线共用同一组硬线：空泛安慰 / 说教 / 战术指令 / 水平羞辱，一条都不放。
export const VOICES={companion:'陪练',sober:'克制'};
export const FIRST_PERSON_EMOTION=/我(很|好|有点|真的|也|现在|其实|都|算是|看得|听着|盯着)?[^，。；！？]{0,4}(开心|难过|伤心|生气|失望|高兴|兴奋|急|慌|愣|懵|心疼|紧张|不服|来气|坐不住|捏把汗|跟着念|数着)/;
// 说教：把一次选择说成「你以后要怎样」。
const PREACH=/你应该|你必须|你最好|下一次?别|以后别|要记住|下次记得|不该|别再|得改|认真点|长点记性/;
// 战术指令：告诉玩家这一手该出什么。这是军师的活——陪练只评论，不指挥。
const TACTICAL_OVERREACH=/建议(你)?(换|用|改|选|出)|不如(换|用|选)|最好(换|用|选|是)|换(掉|上|成)|改用|别用|不要用|先(出|放|上)[^。，]{0,4}(技能|招)|集火|先打|留着(技能|药)|把(药|回复药)(吃|用)了/;

// 克制扫描（docs/COMPANION-DESIGN.md §3.5 的五条，落地为可失败、可回退的检查）。
// voice='companion'（默认）放开第一人称情绪；skill-insult / empty-encouragement / preach /
// tactical-overreach / unsupported-past-claim 在任何声线下都拦。
export function checkCompanionRestraint(text,{register='R2',facts={},previousAssistant='',voice='companion'}={}){
 const t=String(text??''),reasons=[],registerInfo=REGISTERS[register]||REGISTERS.R2;
 if(!t.trim())return {valid:false,reasons:['empty-text'],register,limit:registerInfo.limit,voice};
 if(t.length>registerInfo.limit)reasons.push(`over-limit:${t.length}>${registerInfo.limit}`);
 const questions=(t.match(/[？?]/g)||[]).length;
 if(questions>registerInfo.maxQuestions)reasons.push(`too-many-questions:${questions}>${registerInfo.maxQuestions}`);
 // 第一人称情绪：陪练声线允许，克制声线仍然拦。判的不是「有没有情绪」，而是「说的是谁」——
 // 下面 skill-insult 拦的是把情绪落到玩家身上那种写法。
 if(voice!=='companion'&&FIRST_PERSON_EMOTION.test(t))reasons.push('first-person-emotion');
 if(/加油|别灰心|你已经很棒|再接再厉|下次一定|一定可以|你可以的|不要放弃|没关系的|放轻松/.test(t))reasons.push('empty-encouragement');
 if(/菜|太弱|你错了|你不行|水平不够|速度意识差|手残|瞎打|乱打|不会玩|没天赋|水平差/.test(t))reasons.push('skill-insult');
 if(PREACH.test(t))reasons.push('preach');
 if(TACTICAL_OVERREACH.test(t))reasons.push('tactical-overreach');
 if(/(记得|上次|之前|上回|我们已经|上一场|那一局|连着)/.test(t)&&!facts.allowPast)reasons.push('unsupported-past-claim');
 if(/速度判断/.test(t)&&!(facts.lessons||[]).includes('速度判断'))reasons.push('lesson-not-recorded');
 if(register!=='R3'&&register!=='R0'&&/[？?]\s*$/.test(t.trim())&&/[？?]\s*$/.test(String(previousAssistant||'').trim()))reasons.push('consecutive-questions');
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],register,limit:registerInfo.limit,voice};
}

// ═══════════════════════════════════════════════════════════════════════════
// 在场层（presence）：陪练在对局中间说话的依据、预算、出现方式与时长。
//
// 上一版的主动侧只有两个事件（首次减员、整局结束），一局最多说两次——那是赛后评论员，
// 不是陪练。这一层补的是「真的发生了什么」：从 game.history 的真实回合记录里读出
// 连续被克、连着用同一招、局势逆转、长时间僵持，再加上跨局的连胜/连败里程碑。
// 每一个事件都要能指出是哪几条回合记录让它成立，读不到就返回 null，不成立就不说。
// ═══════════════════════════════════════════════════════════════════════════

// 陪练自己的预算。它与军师（coach/experience.js 的 STRATEGIST_LIMITS + strategistSession）
// **完全分开**：军师把额度用光不会让陪练闭嘴，陪练说满也不会动军师一次。
export const COMPANION_LIMITS={maxPerMatch:4,cooldownTurns:2,reducedAfterDismissals:2,quietAfterDismissals:4};
export const COMPANION_EVENTS=['result','streak-loss','streak-win','first-faint','swing','countered','repeat-skill','stalemate'];

// 一局内的陪练记账。与 coach/memory.js 的 adaptiveGate 读同一份 dismiss 记录、同一个 7 天窗口，
// 但**不共用**军师的 session：近 7 天被主动关掉 2 次降到每局 1 次，4 次降到 0 次。
// 这条推断永远排在安静档、点掉即静音之后（见 coach.js 的 coachEvent 判定顺序）。
export function companionSession(memory=null,{now=Date.now()}={}){
 const dismissals=(memory?.journal||[]).filter(e=>e?.kind==='dismiss'&&Number.isFinite(Date.parse(e.time||''))&&now-Date.parse(e.time)<7*DAY).length;
 const limit=dismissals>=COMPANION_LIMITS.quietAfterDismissals?0:dismissals>=COMPANION_LIMITS.reducedAfterDismissals?1:COMPANION_LIMITS.maxPerMatch;
 return {count:0,lastTurn:null,dismissed:false,said:new Set(),limit,
  reason:`近7天主动关闭${dismissals}次 → 本局上限${limit}次（来源：memory.journal 的 dismiss，与 adaptiveGate 同一个 7 天窗口）`};
}

// 陪练的样子：头像用已有的宠物形象（engine.js 的 SPECIES.icon），不新增美术资源。
// 芽角鹿是名字里带「芽」的那只，正好当小芽的门面。
export const COMPANION_AVATAR={species:'deer',name:'小芽',role:'陪练'};
export function companionAvatar(){
 const s=SPECIES.find(x=>x.id===COMPANION_AVATAR.species)||SPECIES[0];
 return {icon:s.icon,name:`${COMPANION_AVATAR.name} · ${COMPANION_AVATAR.role}`,species:s.id,speciesName:s.name};
}

// 气泡停留时长 = 15 秒 + 每 10 个字加 3 秒。军师那条在顶部、要短（玩家正在做决策，它挡视线）；
// 陪练在左下角、远离操作区，留久一点不挡事——两条的时长约束不共用同一套逻辑。
export const COMPANION_BUBBLE={baseMs:15000,perTenCharsMs:3000,maxMs:60000,position:'bottom-left'};
export function bubbleDurationMs(text){
 const chars=String(text??'').replace(/\s+/g,'').length;
 return Math.min(COMPANION_BUBBLE.maxMs,COMPANION_BUBBLE.baseMs+Math.floor(chars/10)*COMPANION_BUBBLE.perTenCharsMs);
}

// 陪练与军师不同时出现。军师条（#live-coach）在场时陪练排队，条消失后再补上。
// 两条边界：排队超过 maxWaitMs 就丢掉（补一句已经过期的话不如不说）；
// 刚显示过就至少占满 minVisibleMs 再让下一次显示——否则会被军师条切成一闪一闪，
// 闪一下比不说更烦，而且那半秒谁也读不完。
export const COMPANION_DEFER={maxWaitMs:20000,minVisibleMs:5000};
export function companionCueSlot({barVisible=false,queuedAt=0,now=0,holdUntil=0}={}){
 if(queuedAt&&now-queuedAt>COMPANION_DEFER.maxWaitMs)return {action:'drop',reason:`排队超过 ${COMPANION_DEFER.maxWaitMs}ms，这条已经不新鲜了`};
 if(barVisible)return {action:'hold',reason:'军师条在场：陪练让位，等它收起来再说'};
 if(now<holdUntil)return {action:'hold',reason:`刚显示过，${COMPANION_DEFER.minVisibleMs}ms 内不再重开，免得一闪一闪`};
 return {action:queuedAt?'show':'idle',reason:'军师条不在场'};
}

// —— 真实信号：每一项都从 game.history 的回合记录或 game 本身读出来 ——
function turnsOf(game){return (game?.history||[]).filter(h=>h?.type==='turn'&&h.before?.player?.pets&&h.after?.player?.pets);}
// 一方的血量占满血总量的比例。只用真实 hp/maxHp，不引入评分。
function hpShare(side){
 if(!side||!Array.isArray(side.pets))return null;
 const max=side.pets.reduce((n,p)=>n+(Number(p?.maxHp)||0),0);
 if(!max)return null;
 return side.pets.reduce((n,p)=>n+Math.max(0,Number(p?.hp)||0),0)/max;
}
function fainted(side){return (side?.pets||[]).some(p=>p&&p.hp<=0);}

// 陪练能用来说话的真实事实。没有事实的字段是 null，不补默认值。
export function companionSignals(game){
 const out={countered:null,repeat:null,swing:null,stalemate:null,turns:0};
 if(!game||game.result||game.phase==='ended')return out;
 const turns=turnsOf(game);
 out.turns=turns.length;
 if(!turns.length)return out;
 // 连续被克：末尾连续若干个回合里，对手当时在场那只是克制我方当时在场那只是一方。
 // 用 engine.js 的 multiplier 判，不另立一张属性表。
 const countered=t=>{
  const p=t.before.player,q=t.before.enemy,mine=p?.pets?.[p.active],theirs=q?.pets?.[q.active];
  return !!(mine&&theirs&&mine.hp>0&&theirs.hp>0&&multiplier(theirs.type,mine.type)>1);
 };
 let run=0;
 for(let i=turns.length-1;i>=0&&countered(turns[i]);i--)run++;
 if(run>=2){
  const last=turns.at(-1),p=last.before.player,q=last.before.enemy;
  out.countered={times:run,pet:p.pets[p.active].name,type:TYPES[q.pets[q.active].type]||q.pets[q.active].type};
 }
 // 连着用同一招：末尾连续 ≥3 回合的玩家行动是同一个技能。
 const same=t=>t.action?.kind==='skill'&&t.action?.id;
 let repeat=0;
 for(let i=turns.length-1;i>=0&&same(turns[i])&&turns[i].action.id===turns.at(-1).action.id;i--)repeat++;
 if(repeat>=3&&SKILLS[turns.at(-1).action.id])out.repeat={times:repeat,skill:SKILLS[turns.at(-1).action.id].name,id:turns.at(-1).action.id};
 // 局势逆转：开局到现在的血量占比从一侧跨到另一侧（≥60% → ≤40%，或反过来）。
 if(turns.length>=4){
  const shares=turns.map(t=>hpShare(t.after?.player));
  if(!shares.some(s=>s===null)){
   const first=shares[0],now=shares.at(-1);
   if(first>=0.6&&now<=0.4)out.swing={direction:'down',turn:turns.length,from:Math.round(first*100),to:Math.round(now*100)};
   else if(first<=0.4&&now>=0.6)out.swing={direction:'up',turn:turns.length,from:Math.round(first*100),to:Math.round(now*100)};
  }
 }
 // 长时间僵持：打了 ≥8 个回合，双方一只都没倒下。
 if(turns.length>=8&&!turns.some(t=>fainted(t.after?.player)||fainted(t.after?.enemy)))out.stalemate={turns:turns.length};
 return out;
}

// 陪练何时开口（唯一入口，纯函数，可脱开 DOM 单测）。
// 一次只返回一个事件：同一回合最多说一句，其余条件下回合还在就下回合再说。
// said 是本局已经报过的事件名集合；同一事件本局不重复。
export function companionEvents(game,{said=[],winStreak=0,lossStreak=0}={}){
 const seen=said instanceof Set?said:new Set(Array.isArray(said)?said:[]);
 const push=out=>e=>{if(!seen.has(e))out.push(e);};
 // 整局结束：先看跨局里程碑，其次才是普通结算。结束那一回合不再提局内的事。
 if(game?.result){
  const out=[];const add=push(out);
  if(game.result==='win'&&winStreak>=2)add('streak-win');
  else if(game.result==='loss'&&lossStreak>=3)add('streak-loss');
  else add('result');
  return out;
 }
 // 首次减员优先；已经报过就继续往下看别的事件，而不是整局闭嘴（那是「只有两个事件」那一版的写法）。
 if((game?.player?.pets||[]).some(p=>p&&p.hp<=0)&&!seen.has('first-faint'))return ['first-faint'];
 const sig=companionSignals(game);
 const order=['swing','countered','repeat-skill','stalemate'];
 for(const event of order){
  const key=event==='swing'?'swing':event==='countered'?'countered':event==='repeat-skill'?'repeat':'stalemate';
  if(sig[key]&&!seen.has(event))return [event];
 }
 return [];
}

// 事件 → 档位。first-faint / result 沿用原有档位（不破坏既有行为）；
// 在场事件用 R4，连败里程碑用收尾陪坐 R3。
export function eventRegister(event,{lossStreak=0}={}){
 if(event==='result')return proactiveRegister({lossStreak});
 if(event==='first-faint')return 'R1';
 if(event==='streak-loss')return 'R3';
 return 'R4';
}

// —— 主动侧模板（coach.js 调用）：引用刚发生的真实对局事实，不引用记忆外的内容 ——
// 在场事件的措辞全部读 context.signals；读不到那项事实就返回 null（不成立就不说）。
export function proactiveText(event,context={},register='R1'){
 const f=companionFacts({},context,Date.now());
 const stage=f.stage||context.stage||null,turns=Number.isInteger(context.turn)&&context.turn>0?context.turn:null;
 const fallen=Array.isArray(context.fallen)?context.fallen:[];
 const alive=Number.isInteger(context.alive)?context.alive:null;
 const opponent=context.opponent||null;
 const sig=context.signals||{};
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
 if(event==='streak-loss'){
  const streak=Number.isInteger(context.lossStreak)?context.lossStreak:null;
  if(!streak||streak<3)return null;
  return compose([{text:`连着${streak}局没赢。`},{text:'到这儿也行，想继续我就在。'}],REGISTERS.R3.limit);
 }
 if(event==='streak-win'){
  const streak=Number.isInteger(context.winStreak)?context.winStreak:null;
  if(!streak||streak<2)return null;
  return compose([{text:`连着${streak}局拿下了，`},{text:'这个手感我记着。'}],REGISTERS.R4.limit);
 }
 if(event==='countered'){
  const c=sig.countered;
  if(!c)return null;
  return compose([{text:`${c.pet}连着${c.times}个回合被${c.type}系按着打，`},{text:'我看得有点急。'}],REGISTERS.R4.limit);
 }
 if(event==='repeat-skill'){
  const r=sig.repeat;
  if(!r)return null;
  return compose([{text:`又是${r.skill}，连着${r.times}个回合了——`},{text:'我在旁边都跟着念出来。'}],REGISTERS.R4.limit);
 }
 if(event==='swing'){
  const s=sig.swing;
  if(!s)return null;
  const line=s.direction==='down'?`打到第${s.turn}回合，血线反过来了：前面一直是你占上风。`:`打到第${s.turn}回合，血线追回来了——刚才还是落后的。`;
  return compose([{text:line}],REGISTERS.R4.limit);
 }
 if(event==='stalemate'){
  const s=sig.stalemate;
  if(!s)return null;
  return compose([{text:`${s.turns}个回合过去，两边都还没人倒下，`},{text:'我都有点坐不住了。'}],REGISTERS.R4.limit);
 }
 return null;
}

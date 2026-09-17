import {isLiveMatch} from './coach/policy.js';
import {active} from './engine.js';
import {proactiveRegister,proactiveText,cleanStage,companionSignals,eventRegister,COMPANION_LIMITS} from './coach/companion.js';
// Local interaction adapter, not an LLM. Replace this boundary with a server-backed agent later.
export const COACH_NAME='小芽';
// 主动侧的门控（说不说）与档位（怎么说）分开：
// 门控在这里，档位在 coach/companion.js 的 eventRegister / proactiveText。
//
// 判定顺序就是优先级，安静档与「本局别再提醒」永远在最前面，不被任何推断覆盖：
//   1. 线上竞技进行中（isLiveMatch）→ 不说
//   2. 玩家把提示档设为安静 → 不说
//   3. 本局点掉过（session.dismissed）→ 不说
//   4. 本局已经说过 session.limit 次（默认 4 次；近 7 天被关掉 2 次降到 1 次、4 次降到 0 次）→ 不说
//   5. 同一事件本局报过 → 不说
//   6. 两次开口至少隔 COMPANION_LIMITS.cooldownTurns 个回合（结算与里程碑不受此限）→ 不说
// 这份记账（session）与军师的 strategistSession / attention 是**两个独立对象**：
// 军师说满 3 次或把提示叉掉，都不会让陪练的额度变少，反之亦然。
export function coachEvent(event,context,session){
 if(isLiveMatch(context))return null;
 if(context.preference==='quiet')return null;
 if(session.dismissed)return null;
 // 记账兼容：老调用点传的是 {count,lastTurn,dismissed} 这样的普通对象，没有 said。
 // 这里补上，保证「同一事件本局只说一次」对任何形状的 session 都成立。
 if(!(session.said instanceof Set))session.said=new Set(Array.isArray(session.said)?session.said:[]);
 if(session.said.has(event))return null;
 const limit=Number.isInteger(session.limit)?session.limit:COMPANION_LIMITS.maxPerMatch;
 if(session.count>=limit)return null;
 const closing=event==='result'||event==='streak-win'||event==='streak-loss';
 if(!closing&&session.lastTurn!==null&&context.turn-session.lastTurn<COMPANION_LIMITS.cooldownTurns)return null;
 const text=proactiveText(event,context,eventRegister(event,{lossStreak:context.lossStreak||0}));
 if(!text)return null;
 session.count++;session.lastTurn=context.turn;session.said.add(event);return text;
}
export function localReply(question,context){
 if(isLiveMatch(context))return '线上竞技 PVP 赛中不提供战术分析，结束后我们再聊。';
 if(/培养|成长|训练|加点/.test(question))return '营地里每花 1 训练点，可选 +12 生命、+4 攻击或 +3 速度。先想让伙伴承担什么职责；升级会增加培养格，重置会返还点数。';
 if(/狐|狮/.test(question))return '烬尾狐用火花挂灼烧，再用余烬追猎增伤，疾爪还能先制。炽鬃狮不挂灼烧，破甲重击能穿过防御，但舍身烈焰会反伤。它们现在走两种打法。';
 if(/输|烦|难|菜/.test(question))return '可以先缓一缓，不用马上再开一局。你想回看，我会从具体回合聊起。';
 if(/复盘|回顾/.test(question))return context.lastTurn?'最近一回合：'+context.lastTurn.events.filter(x=>!x.startsWith('──')).join(' '):'先完成一个回合，我就能帮你找到对应记录。';
 return '我现在是本地互动演示，还没有接入语言模型。可以先问我“怎么培养”“狐狸和狮子有什么不同”或“回顾上一回合”。';
}
// Read-only allowlist: intentionally excludes RNG, the opponent's pending action, and private server state.
// 主动侧只拿得到 game、profile 与跨局记忆：不用 memory 时（老调用点）连败数退回 profile 的字段，
// 传了 memory 就按真实对战记录算这一局之后的连胜/连败，里程碑才不会差一局。
// 跨局记忆只在被动通道（runCoach）与这三个派生计数上可用。
export function coachContext(game,profile,memory=null){
 const pets=Array.isArray(game?.player?.pets)?game.player.pets:[];
 const mine=game?active(game,'player'):null,opponent=game?active(game,'enemy'):null;
 const events=(memory?.events||[]).filter(e=>e&&typeof e.result==='string');
 const priorLoss=trailing(events,'loss'),priorWin=trailing(events,'win');
 const finished=game?.result==='win'||game?.result==='loss';
 return {mode:game?.mode||'camp',turn:game?.turn||0,result:game?.result||null,preference:profile.coach.mode,
   lossStreak:finished&&game.result==='loss'?priorLoss+1:finished?0:profile.lossStreak,
   winStreak:finished&&game.result==='win'?priorWin+1:0,
   stage:cleanStage(game?.stageName||null),current:mine?.name||null,opponent:opponent?.name||null,
   fallen:pets.filter(p=>p&&p.hp<=0).map(p=>p.name),alive:pets.filter(p=>p&&p.hp>0).length,
   // 在场层要用的真实信号（连续被克 / 连着用同一招 / 局势逆转 / 长时间僵持）全部读自 game 本身。
   signals:companionSignals(game),
   lastTurn:game?.history?.filter(h=>h.type==='turn').at(-1)||null};
}
function trailing(events,result){let n=0;for(let i=events.length-1;i>=0;i--){if(events[i].result!==result)break;n++;}return n;}

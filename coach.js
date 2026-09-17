import {isLiveMatch} from './coach/policy.js';
import {active} from './engine.js';
import {proactiveRegister,proactiveText,cleanStage} from './coach/companion.js';
// Local interaction adapter, not an LLM. Replace this boundary with a server-backed agent later.
export const COACH_NAME='小芽';
// 主动侧的门控（说不说）与档位（怎么说）分开：
// 门控在这里，档位在 coach/companion.js 的 proactiveRegister。
export function coachEvent(event,context,session){
  if(isLiveMatch(context)||context.preference==='quiet'||session.dismissed||session.count>=2)return null;
  if(session.lastTurn!==null&&context.turn-session.lastTurn<3&&event!=='result')return null;
  if(!['result','first-faint'].includes(event))return null;
  const text=proactiveText(event,context,proactiveRegister({lossStreak:context.lossStreak||0}));
  if(!text)return null;
  session.count++;session.lastTurn=context.turn;return text;
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
// 主动侧只拿得到 game 与 profile（app.js 不把 memory 传进来），所以这里的事实全部读自
// 这一局本身：关卡、当前对位、已倒下的伙伴、剩余只数。跨局记忆只在被动通道（runCoach）可用。
export function coachContext(game,profile){
  const pets=Array.isArray(game?.player?.pets)?game.player.pets:[];
  const mine=game?active(game,'player'):null,opponent=game?active(game,'enemy'):null;
  return {mode:game?.mode||'camp',turn:game?.turn||0,result:game?.result||null,preference:profile.coach.mode,lossStreak:profile.lossStreak,
    stage:cleanStage(game?.stageName||null),current:mine?.name||null,opponent:opponent?.name||null,
    fallen:pets.filter(p=>p&&p.hp<=0).map(p=>p.name),alive:pets.filter(p=>p&&p.hp>0).length,
    lastTurn:game?.history?.filter(h=>h.type==='turn').at(-1)||null};
}

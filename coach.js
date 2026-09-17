// Local interaction adapter, not an LLM. Replace this boundary with a server-backed agent later.
export const COACH_NAME='小芽';
export function coachEvent(event,context,session){
  if(context.mode==='pvp-live'||context.preference==='quiet'||session.dismissed||session.count>=2)return null;
  if(session.lastTurn!==null&&context.turn-session.lastTurn<3&&event!=='result')return null;
  let text=null;
  if(event==='result'){
    if(context.result==='loss') text=context.lossStreak>=2?'这两局先告一段落也可以。想继续的话，我陪你换个搭配。':'这局结束了。想再来就再来，想看关键回合我也在。';
    if(context.result==='win')text='拿下了！这次的经验和训练点已经收好，回营地可以继续培养。';
  }
  if(event==='first-faint')text='还有队友在。先按自己的想法选，想聊这回合时叫我。';
  if(!text)return null;
  session.count++;session.lastTurn=context.turn;return text;
}
export function localReply(question,context){
  if(context.mode==='pvp-live')return '正式 PVP 赛中不提供战术分析，结束后我们再聊。';
  if(/培养|成长|训练|加点/.test(question))return '营地里每花 1 训练点，可选 +12 生命、+4 攻击或 +3 速度。先想让伙伴承担什么职责；升级会增加培养格，重置会返还点数。';
  if(/狐|狮/.test(question))return '烬尾狐用火花挂灼烧，再用余烬追猎增伤，疾爪还能先制。炽鬃狮不挂灼烧，破甲重击能穿过防御，但舍身烈焰会反伤。它们现在走两种打法。';
  if(/输|烦|难|菜/.test(question))return '可以先缓一缓，不用马上再开一局。你想回看，我会从具体回合聊起。';
  if(/复盘|回顾/.test(question))return context.lastTurn?'最近一回合：'+context.lastTurn.events.filter(x=>!x.startsWith('──')).join(' '):'先完成一个回合，我就能帮你找到对应记录。';
  return '我现在是本地互动演示，还没有接入语言模型。可以先问我“怎么培养”“狐狸和狮子有什么不同”或“回顾上一回合”。';
}
// Read-only allowlist: intentionally excludes RNG, opponent's pending action, and private server state.
export function coachContext(game,profile){return {mode:game?.mode||'camp',turn:game?.turn||0,result:game?.result||null,preference:profile.coach.mode,lossStreak:profile.lossStreak,lastTurn:game?.history.filter(h=>h.type==='turn').at(-1)||null};}

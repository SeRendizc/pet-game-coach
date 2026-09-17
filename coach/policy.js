// Who may receive tactical help, and when.
//
// A *live* match — online PVP, or the local hot-seat versus mode — gets no in-match
// tactical advice, because both sides are human and one of them would be reading the
// other's options. The very same evidence may be reviewed once the match has ended.
//
// `pvp-local` and `pvp-live` share this policy on purpose: the fairness rule is about
// a human opponent being present, not about whether a socket is open.
const LIVE_MODES=['pvp-live','pvp-local'];
export function isLiveMatch(context){
  const modes=[context?.mode,context?.battle?.mode];
  if(!modes.some(m=>LIVE_MODES.includes(m)))return false;
  const ended=context?.battle?.result||context?.battle?.phase==='ended';
  if(ended)return false;
  // 对局中要不要闭麦是产品开关，不是硬规则。题目要的是「军师在对战场景给建议」，
  // 所以只有在存在第三方受影响时才必须沉默：对面坐着真人。对电脑时双方只有玩家
  // 一方，给建议不损害任何人，教练照常工作。
  return !context?.coachAllowed;
}
export function isVersusMode(mode){return LIVE_MODES.includes(mode);}

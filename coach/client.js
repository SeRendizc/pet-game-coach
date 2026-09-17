import {CoachScheduler} from './scheduler.js';
export const RESPONSE_INSTRUCTIONS='\n回答要求：不要向玩家报内部局面评分，用可见的宠物、技能和状态解释。游戏按回合结算，不按秒；不要编造技能冷却。道具名称只能使用回复药、净化药、能量果，不要把它们叫作解药或以太。双方同时决定，不能先看对手本回合出招再决定自己的行动。复盘中hpBefore是回合开始、hpAfter是结束，不能把行动前生命称作打完还剩。逐回合核对实际事件：行动取消不能说成打出了伤害，事前预测和事后结算必须分开。';
import {runCoach,assembleContext,checkGroundedAnswer} from './runtime.js';
import {checkCompanionRestraint} from './companion.js';
let session=null;
export async function connectionStatus(){const response=await fetch('/api/bootstrap',{cache:'no-store'});if(!response.ok)throw Error('请启动新版本机后端');session=await response.json();return session;}
const scheduler=new CoachScheduler();
export function invalidateCoachRequests(){scheduler.invalidate();}
export function requestCoach(payload){
 const {cache=false,...data}=payload;
 return scheduler.run(JSON.stringify(data),signal=>executeCoach(data,signal),{cache});
}
async function executeCoach(payload,signal){
 const originalMessage=payload.message;
 if((payload.context.battle?.result||!payload.context.battle&&payload.context.lastMatch)&&/优化|总结|分析|输在哪|为什么输|为什么赢|打得怎么样/.test(payload.message)&&!/回合|整局|整场|上一局/.test(payload.message))payload={...payload,message:'关于这份整局战报：'+payload.message};
 const local=await runCoach(payload);
 if(local.localOnly||local.route==='policy')return {...local,stateToken:payload.stateToken};
 payload={...payload,message:payload.message+RESPONSE_INSTRUCTIONS};
 const assembled=assembleContext(payload);
 try{
 if(!session||session.configured===false)await connectionStatus();
 if(session.configured===false)return {...local,stateToken:payload.stateToken,fallbackReason:'未连接模型，显示本局规则分析'};
 // 重启后端会清空内存里的会话，页面上还留着旧 cookie，第一个请求必然 403。
 // 这里重建会话并原样重试一次，不让用户看到一次莫名其妙的失败。
 const send=async()=>{const r=await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json','X-Coach-CSRF':session.csrf},body:JSON.stringify(assembled.payload),signal});let d;try{d=await r.json();}catch{throw Error('后端响应异常');}return {r,d};};
 let {r:response,d:data}=await send();
 if(response.status===403){session=null;await connectionStatus();if(session.configured!==false)({r:response,d:data}=await send());}
 if(!response.ok){if(response.status===403)session=null;throw Error(data.error||('教练请求失败（HTTP '+response.status+'）'));}const validation=checkGroundedAnswer(data);
 // 陪练的档位约束与事实检查走同一条降级路径：模型把 R1 写成安慰、或用问句追问时，
 // 直接回退到 runCoach 已经算好的本机记录模板（local），而不是把越界的话展示给玩家。
 const restraint=data.route==='companion'?companionRestraint(data,payload):{valid:true,reasons:[]};
 if(data.provider==='deepseek'&&!validation.valid){const fallback=await runCoach(payload);data={...fallback,provider:'local-fallback',validation,fallbackReason:'模型回答未通过事实检查，显示本局规则分析',stateToken:payload.stateToken};}
 else if(data.provider==='deepseek'&&!restraint.valid)data={...local,provider:'local-fallback',restraint,restraintCodes:restraint.reasons,fallbackReason:'模型这次说得不太合适，已换成本局规则结论（具体原因记在日志里，不往界面上抛内部代码）',stateToken:payload.stateToken};
 else if(!restraint.valid)data={...data,restraint};
 data.memory={...data.memory,journal:payload.memory.journal||[],reflections:payload.memory.reflections||{},watches:payload.memory.watches||[],quizCount:payload.memory.quizCount||0,goal:data.memory?.goal||payload.memory.goal||null};data.memory.dialogue=(data.memory.dialogue||[]).map(m=>m.role==='user'&&m.content===payload.message?{...m,content:originalMessage}:m);data.contextAudit=assembled.audit;return data;
 }catch(error){if(signal?.aborted||error?.name==='AbortError')throw error;const fallback=await runCoach(payload);
 // 把真实原因带出来，不再一律显示"暂不可用"，否则无法区分会话失效、鉴权失败和超时。
 const why=error?.message||'网络异常';
 // 这句话玩家会直接看到（教练面板顶部），所以不能把内部错误码原样抛出去。
 // 原来的写法会把「教练上下文无效」这类服务端措辞端到玩家面前。
 const friendly=/超时|aborted|timeout/i.test(why)?'等模型太久了，先按本局规则给你结论'
  :/上下文无效|invalid|400/.test(why)?'这次没能把局面传给模型，先按本局规则给你结论'
  :/403|鉴权|auth|会话/.test(why)?'模型连接过期了，正在重连；先按本局规则给你结论'
  :'模型暂时没答上来，先按本局规则给你结论';
 return {...fallback,provider:'local-fallback',fallbackReason:friendly,stateToken:payload.stateToken,contextAudit:assembled.audit};}
}
// 陪练档位扫描用的最小事实集：只判断「有没有真实经历可以支撑过去陈述」和「课程名是否真的记录过」。
function companionRestraint(data,payload){
 const memory=payload.memory||{},dialogue=Array.isArray(memory.dialogue)?memory.dialogue:[];
 const previousAssistant=[...dialogue].reverse().find(x=>x?.role==='assistant'&&typeof x.content==='string')?.content||'';
 return checkCompanionRestraint(data.text,{register:data.register||data.companionState?.register||'R2',facts:{allowPast:Boolean((memory.events||[]).length||(memory.lessons||[]).length||dialogue.length),lessons:memory.lessons||[]},previousAssistant});
}

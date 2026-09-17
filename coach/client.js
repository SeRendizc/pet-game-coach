import {CoachScheduler} from './scheduler.js';
export const RESPONSE_INSTRUCTIONS='\n回答要求：不要向玩家报内部局面评分，用可见的宠物、技能和状态解释。游戏按回合结算，不按秒；不要编造技能冷却。道具名称只能使用回复药、净化药、能量果，不要把它们叫作解药或以太。双方同时决定，不能先看对手本回合出招再决定自己的行动。复盘中hpBefore是回合开始、hpAfter是结束，不能把行动前生命称作打完还剩。逐回合核对实际事件：行动取消不能说成打出了伤害，事前预测和事后结算必须分开。';
import {runCoach,assembleContext,checkGroundedAnswer} from './runtime.js';
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
 const response=await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json','X-Coach-CSRF':session.csrf},body:JSON.stringify(assembled.payload),signal});
 let data;try{data=await response.json();}catch{throw Error('后端响应异常');}
 if(!response.ok){if(response.status===403)session=null;throw Error(data.error||'教练请求失败');}const validation=checkGroundedAnswer(data);if(data.provider==='deepseek'&&!validation.valid){const fallback=await runCoach(payload);data={...fallback,provider:'local-fallback',validation,fallbackReason:'模型回答未通过事实检查，显示本局规则分析',stateToken:payload.stateToken};}
 data.memory={...data.memory,journal:payload.memory.journal||[],reflections:payload.memory.reflections||{},watches:payload.memory.watches||[],quizCount:payload.memory.quizCount||0,goal:data.memory?.goal||payload.memory.goal||null};data.memory.dialogue=(data.memory.dialogue||[]).map(m=>m.role==='user'&&m.content===payload.message?{...m,content:originalMessage}:m);data.contextAudit=assembled.audit;return data;
 }catch(error){if(signal?.aborted||error?.name==='AbortError')throw error;const fallback=await runCoach(payload);return {...fallback,provider:'local-fallback',fallbackReason:'模型请求暂不可用，保留本地依据',stateToken:payload.stateToken,contextAudit:assembled.audit};}
}

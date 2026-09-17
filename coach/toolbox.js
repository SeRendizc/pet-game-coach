import {isLiveMatch} from './policy.js';
import {legalActions,resolveTurn,evaluate,actionName} from '../engine.js';
import {strategist,searchKnowledge,RULES_VERSION} from './strategist.js';
import {teacher} from './teacher.js';
// 有些工具拿的是证据包里**永远不会有**的东西：指定回合的原始事件、分页的整局统计、
// 以及需要计算的对手分支。这类需求不能靠"看看已有证据再决定"来判断，否则模型会
// 因为包里"看起来够了"而跳过。实测 44 条里有 7 条漏调，其中 6 条所需事实本就在包内、
// 但另外那类（指定回合 / 分支模拟 / 分页）只要不调就一定拿不到。
// hard=true 表示：当这一轮出现了对应的需求信号时，必须调用，而不是可选。
export const HARD_TOOLS={
 read_evidence:'玩家问到了某个**具体回合**当时发生了什么，而证据包里只有最近的回合事件',
 simulate_branch:'玩家要求**模拟或比较两个具体行动**的结果，这需要计算，证据包里没有',
 read_match:'玩家要求**整局范围**的统计，或需要翻看更早的回合（证据包只带最近若干回合）',
};
export const TOOL_CONTRACTS={
 read_state:{description:'当前公开局面；不含电脑待执行动作或真实随机种子',arguments:{}},
 search_rules:{description:'检索本地规则和战术反例',arguments:{query:'1..180字符'}},
 compare_actions:{description:'合法行动平均/最坏分支，非胜率',arguments:{}},
 simulate_branch:{description:'比较一个合法行动和一个合法对手行动；同时返回两种同速顺序的假设结果',arguments:{actionIndex:'合法我方行动列表下标',opponentIndex:'合法对手行动列表下标'}},
 inspect_training:{description:'当前培养资源、阈值与目标',arguments:{}},
 read_match:{description:'整局统计与关键回合；可用offset/limit分页',arguments:{offset:'非负整数，默认0',limit:'1..3，默认3'}},
 read_evidence:{description:'按回合读取已保留的原始事件；无记录明确missing',arguments:{turn:'正整数'}},
 read_last_turn:{description:'上个已结算回合的真实事件',arguments:{}}
};
export function validToolArgs(name,args){
 if(!Object.hasOwn(TOOL_CONTRACTS,name)||!args||typeof args!=='object'||Array.isArray(args))return false;
 const allowed=Object.keys(TOOL_CONTRACTS[name].arguments);if(Object.keys(args).some(k=>!allowed.includes(k)))return false;
 const integer=(x,min,max)=>Number.isInteger(x)&&x>=min&&x<=max;
 if(name==='search_rules')return typeof args.query==='string'&&args.query.trim().length>0&&args.query.length<=180;
 if(name==='read_match')return (args.offset===undefined||integer(args.offset,0,999))&&(args.limit===undefined||integer(args.limit,1,3));
 if(name==='read_evidence')return integer(args.turn,1,999);
 if(name==='simulate_branch')return integer(args.actionIndex,0,49)&&integer(args.opponentIndex,0,49);
 return true;
}
export function executeTool(name,args,context,message=''){
 if(isLiveMatch(context))throw Error('policy');
 if(!validToolArgs(name,args))throw Error('invalid-arguments');
 const g=context.battle;
 if(name==='read_state')return {screen:context.mode,focus:context.focus,turn:g?.turn??null,player:g?.player??null,enemy:g?.enemy??null,legalPlayer:g&&!g.result?legalActions(g):[],legalEnemy:g&&!g.result?legalActions(g,'enemy'):[]};
 if(name==='search_rules')return searchKnowledge(args.query,{limit:3,game:g,rulesVersion:g?.version||RULES_VERSION});
 if(name==='compare_actions')return strategist({...context,query:message});
 if(name==='inspect_training')return teacher(context);
 if(name==='read_match'){
  if(!context.lastMatch)return {missing:true};
  const {keyTurns,...summary}=context.lastMatch,offset=args.offset||0,limit=args.limit||3;
  return {...summary,keyTurns:keyTurns.slice(offset,offset+limit),nextOffset:offset+limit<keyTurns.length?offset+limit:null,totalKeyTurns:keyTurns.length,availableTurns:(context.evidenceIndex||[]).map(x=>x.turn)};
 }
 if(name==='read_evidence')return context.evidenceIndex?.find(x=>x.turn===args.turn)||{missing:true,turn:args.turn,reason:'本次请求未加载该原始回合，不能由摘要补造；可指定回合重新提问'};
 if(name==='read_last_turn')return context.lastTurn?{turn:context.lastTurn.before.turn,action:context.lastTurn.action,events:context.lastTurn.events}:{missing:true};
 if(!g||g.result||g.phase!=='battle')return {missing:true,reason:'当前不处于可模拟的正常回合'};
 const action=legalActions(g)[args.actionIndex],opponent=legalActions(g,'enemy')[args.opponentIndex];
 if(!action||!opponent)throw Error('invalid-action-index');
 return {assumption:'双方行动是假设，不是预测或真实对手选择；同时覆盖同速顺序',turn:g.turn,action:actionName(g,'player',action),opponent:actionName(g,'enemy',opponent),branches:['player','enemy'].map(tieFirst=>{const out=resolveTurn({...g,history:[],log:[],frames:[]},action,opponent,{simulation:true,tieFirst});return {tieFirst,score:evaluate(out,'player'),player:out.player.pets.map(p=>({name:p.name,hp:p.hp,energy:p.energy,status:p.status})),enemy:out.enemy.pets.map(p=>({name:p.name,hp:p.hp,energy:p.energy,status:p.status}))};})};
}

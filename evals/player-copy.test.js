import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,buildVersusOpponent,SPECIES} from '../engine.js';
import {strategist,rosterAdvice} from '../coach/strategist.js';
import {observe,decisiveOpportunity,hesitationSignal,dwellSignal,attentionState,trackAttention} from '../coach/experience.js';
import {teacher,reviewMatch} from '../coach/teacher.js';

// 禁止词表：玩家能读到的文案里不得出现这些词。
//
// 起因是反复出现的同一类泄漏——「启发式评分」「枚举」「分支」「平均局面分」这些
// 是代码怎么想，不是玩家怎么读。今天已经为此修过两轮，每次都是人工找；
// 人工找会漏（第二次仍漏了 5 处，第三次又漏了知识卡里的 1 处）。
// 所以改成机械检查：只要这些词出现在可达文案里，测试就失败。
const BANNED=[
  '启发式','枚举','分支','局面分','最坏分','期望值','平均收益',
  'provider','fallback','epoch','token','payload',
  '教练上下文无效','empty-encouragement',
];
const check=(label,strings)=>{
  const hits=[];
  for(const s of strings){
    if(typeof s!=='string')continue;
    for(const w of BANNED)if(s.includes(w))hits.push(`[${label}] ${w} → ${s.slice(0,80)}`);
  }
  return hits;
};

test('no player-facing string uses internal vocabulary',()=>{
  const g=createGame(17,['fox','turtle','deer'],{mode:'pve',difficulty:'normal',...buildVersusOpponent(17,{level:2})});
  const ctx={battle:{...g,history:[],log:[],frames:[]},profile:{pets:{}},focus:'fox',mode:'pve'};
  const hits=[];

  // 军师：短句 + 「查看原因」里的依据 + 引用的知识卡原文
  const packet=strategist({...ctx,query:'这回合怎么打'});
  hits.push(...check('军师短句',[packet.text]));
  hits.push(...check('军师依据',packet.evidence||[]));
  hits.push(...check('引用卡片',(packet.knowledge||[]).map(c=>`${c.principle} ${c.counterexample||''}`)));

  // 阵容建议
  hits.push(...check('阵容建议',rosterAdvice(['fox','turtle','deer'].map(id=>SPECIES.find(p=>p.id===id))).lines));

  // 局内提示
  for(const hp of [g.player.pets[0].maxHp,1]){
    g.player.pets[0].hp=hp;
    const o=observe(g);
    if(o)hits.push(...check('局内提示',[o.title,o.reason,o.text]));
  }
  const cue=decisiveOpportunity(g);
  if(cue)hits.push(...check('收尾提示',[cue.text]));

  // 老师：复盘
  hits.push(...check('整局复盘',JSON.stringify(reviewMatch(ctx)).split('"').filter(x=>x.length>6)));

  assert.deepEqual(hits,[],'玩家可见文案里出现了内部术语：\n'+hits.join('\n'));
});

// G08 验收：原位规则说明、有效伤害条件与状态计时；关闭 AI 也能理解并完成游戏。
//
// "关闭 AI" 在这里有一个可自动验证的强形式：**不导入任何 coach 模块、不做任何网络请求，
// 只用 engine.js + progression.js 把一局从头打到结束**。如果某个规则理解必须依赖模型，
// 这条测试就会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {RULES,RULES_VERSION,SKILLS,ITEMS,SPECIES,createGame,legalActions,step} from './engine.js';
import {newProfile,settle} from './progression.js';
import {rulesSections} from './rules.js';

const root=dirname(fileURLToPath(import.meta.url));
const rulesText=()=>rulesSections().map(s=>`## ${s.title}\n${s.lines.join('\n')}`).join('\n');

// 静态 import 图（只看相对路径的静态 import，不看动态 import）。
function importClosure(entry){
  const seen=new Set(),queue=[entry];
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file))continue;
    seen.add(file);
    const src=readFileSync(join(root,file),'utf8');
    for(const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)){
      const spec=m[1];
      if(!spec.startsWith('.'))continue;
      const resolved=join(dirname(file),spec).split('\\').join('/');
      if(existsSync(join(root,resolved)))queue.push(resolved);
    }
  }
  return [...seen].sort();
}

test('the engine never depends on the coach: rules and settlement are self-contained',()=>{
  const engineGraph=importClosure('engine.js');
  assert.deepEqual(engineGraph,['engine.js'],`engine.js 不应导入任何其他模块，实际：${engineGraph.join(', ')}`);
  const viaProgression=importClosure('progression.js');
  assert.ok(!viaProgression.some(f=>f.startsWith('coach/')),`progression.js 不应依赖教练，实际：${viaProgression.join(', ')}`);
  // 规则页也只依赖引擎与成长模块，不依赖教练，因此断网/未配置密钥时照样可读。
  const rulesGraph=importClosure('rules.js');
  assert.ok(!rulesGraph.some(f=>f.startsWith('coach/')),`rules.js 不应依赖教练，实际：${rulesGraph.join(', ')}`);
});

test('a full PVE match completes with no coach module and no network',()=>{
  // 只用一个"总是用第一个合法行动"的笨策略，证明规则本身足以打完一局。
  const play=(seed,difficulty)=>{
    let game=createGame(seed,['fox','turtle','deer'],{difficulty,stageName:'验收',stageId:'g08'});
    game.id='g08-'+difficulty+'-'+seed;
    let guard=0;
    while(!game.result&&guard++<200){
      const actions=legalActions(game);
      assert.ok(actions.length>0,'只要没结束就必须有合法行动');
      game=step(game,actions[0]);
    }
    return game;
  };
  for(const difficulty of ['easy','normal','hard']){
    const game=play(41,difficulty);
    assert.ok(['win','loss','draw'].includes(game.result),`${difficulty} 未在 200 步内结束：${game.result}`);
    assert.ok(game.turn<=RULES.turnLimit+1,`回合数超过上限 ${RULES.turnLimit}：${game.turn}`);
    // 结束后仍能结算成长，说明"不连模型也能玩完整条链路"。
    const {reward}=settle(newProfile(),game,'g08-'+difficulty);
    assert.ok(reward&&reward.xp>0,`${difficulty} 结算没有奖励`);
  }
});

test('every number needed to finish a match is explained in place',()=>{
  const text=rulesText();
  // 有效伤害条件：公式各项、倍率、防御、穿透、最低伤害、打不出伤害的前提。
  for(const needed of [
    `攻击×${RULES.damage.atkCoefficient}`,`防御×${RULES.damage.defCoefficient}`,`最低 ${RULES.damage.min} 点`,
    `克制 ×${RULES.typeAdvantage}`,`×${RULES.typeResist}`,
    `减伤 ${Math.round(RULES.guard.reduction*100)}%`,`穿过这个减伤`,
    `每层 ±${Math.round(RULES.buff.perStack*100)}%`,`最多 ${RULES.buff.maxStacks} 层`,
    '目标已倒下','能量不够支付消耗','原定行动取消',
  ]) assert.ok(text.includes(needed),`规则页缺少有效伤害条件：${needed}`);
  // 状态计时：两种异常的每回合伤害与持续回合、施加当回合是否结算、后备是否暂停、能否叠加。
  for(const [kind,s] of Object.entries(RULES.status))
    assert.ok(text.includes(`扣 ${s.tick} 点，持续 ${s.turns} 回合`),`规则页缺少 ${kind} 的计时`);
  for(const needed of ['施加的当回合末就会结算第一次','不会被新异常刷新或叠加','换到后备时暂停计时与扣血',
    `持续 ${RULES.slow.turns} 回合`,`${RULES.buff.turns} 次在场回合末后到期`,`每局只触发一次`,
    `持续 ${RULES.energy.max===6?4:4} 回合`,`${RULES.turnLimit} 回合仍未分出胜负记平局`])
    assert.ok(text.includes(needed),`规则页缺少状态计时说明：${needed}`);
  // 每个技能与道具都能查到消耗；每个宠物都有面板。
  for(const [,s] of Object.entries(SKILLS)) assert.ok(text.includes(s.name),`规则页缺少技能 ${s.name}`);
  for(const [,it] of Object.entries(ITEMS)) assert.ok(text.includes(it.name),`规则页缺少道具 ${it.name}`);
  for(const p of SPECIES) assert.ok(text.includes(p.name),`规则页缺少伙伴 ${p.name}`);
});

test('the rules page can be read without opening the coach, and in-battle cards explain skills in place',()=>{
  const app=readFileSync(join(root,'app.js'),'utf8'),html=readFileSync(join(root,'index.html'),'utf8');
  // 规则入口是页头按钮，直接开弹窗，不经过小芽面板。
  assert.match(html,/<button id="rules-toggle">规则<\/button>/);
  assert.match(html,/id="rules-body"/);
  // 出招面板上就带消耗/威力/说明，不必先问教练。
  assert.match(app,/sk\.desc/, '出招按钮必须内联技能说明');
  assert.match(app,/消耗 \$\{sk\.cost\} 豆/,'出招按钮必须内联消耗');
  assert.match(app,/\$\{sk\.power\?'威力 '\+sk\.power/,'出招按钮必须内联威力');
  // 规则页与技能说明同源：都读 SKILLS。
  assert.match(app,/from '\.\/rules\.js'/);
  // 关闭主动提醒是一个纯设置，不需要模型参与。
  assert.match(app,/profile\.coach\.mode==='quiet'/);
});

test('turning the coach off does not disable any rule, and the version stays consistent',()=>{
  const text=rulesText();
  assert.ok(text.includes('不连接模型'),'规则页必须说明不连接模型也能玩');
  assert.ok(text.includes(`规则版本 ${RULES_VERSION}`));
  assert.equal(createGame().version,RULES_VERSION);
  // 静默档只是"不主动说话"，合法行动与结算完全不经过教练。
  const game=createGame(17,undefined,{difficulty:'hard'});
  assert.ok(legalActions(game).length>0);
  assert.ok(!('coach' in game),'对局对象里不应有教练状态');
});

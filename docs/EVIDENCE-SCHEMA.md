# 证据与权限约定

## 对局与决策

运行中对局以crypto.randomUUID生成matchId，规则version当前0.6。一个决策由matchId、turn、phase及客户端contextEpoch区分；局面变更、培养/焦点/偏好变化提升contextEpoch。提示任务另有hintEpoch，关闭或出招即作废。请求回带stateToken；展示前比较发起时epoch与当前epoch。

公开状态由buildContext投影，仅包含双方已公开面板、技能、物品、当前行动阶段。隐藏的真实随机种子不送模型，替换为0；不包含电脑待执行动作。当前对局历史在提示上下文中为空，复盘走独立证据字段，避免把未来事实当实时信息。

## 完整回合

归档条目：id、version、stageId、stageName、result、history。history里的turn包含before、action、opponent、events、after、result，只有已结算回合写入。保留当前对局和最近3场结束对局。回合引用形如 matchId:turn:25。preview不写真实档案，不产生奖励。

## 教练事件

journal事件：id、kind、matchId、turn、rulesVersion、time、source、confidence。
- hint：channel为inline（`app.js:643`）、endgame（`app.js:721`）、watch（`app.js:830`），外加动态的 `role+'-'+trigger.reason`（`app.js:497`，如 `strategist-犹豫不决`）；表示当时已展示，不代表用户看懂或采纳。**原文列的是「inline、attention、endgame 或 watch」——`attention` 这个频道现在全仓库 0 命中**（`grep -rn "'attention'" app.js coach/ server.js` → 0），它在基线提交 `e5417e8` 时存在，属后来的漂移。
- dismiss：用户明确关闭，用于近期普通提示降频。
- decision：lesson、reasonable、prompted、scoreGap；来自公开状态的一回合评分比较，confidence为0.6。

最多240条事件。反思包含evidenceIds、updatedAt、confidence、basis、reduceHints。没有至少3条可回查证据就不应用降频假设；删除证据即使反思失效。记录被保留上限淘汰时，也不能继续凭失去来源的假设调整。

## 知识与工具

卡片字段：id、game、rulesVersion、status、title、keywords、principle、counterexample、requiredEvidence、conditions、authority、inspiration。检索时先版本过滤。resolveCitation与verifyCitations校验存在性；applicability检查条件，返回candidate/conditions-not-met/reference-only，而非真值或最优性。

工具只读，固定白名单；**`search_rules` 只接受 `query`；`simulate_branch{actionIndex,opponentIndex}`、`read_match{offset,limit}`、`read_evidence{turn}` 也接受参数**（`coach/toolbox.js:15-24` 的 `TOOL_CONTRACTS`，由 `validToolArgs` 逐个校验范围；其余工具参数为空。原文写「其余工具参数为空」，与实现不符）；非法参数、重复调用、超大回执及预算耗尽停止。工具返回为证据数据，不具有修改系统权限的能力。

## 条件提醒

watch：id、matchId、kind(energy/finish)、expiresTurn、once。最多1条活动委托，当前回合起10回合内检查一次，触发删除；新开局清除；取消可通过自然语言明确操作。energy使用公开能量<=1，finish按合法技能直接伤害比较并显示防御/换宠/治疗条件。安静模式优先。

## 当前安全边界

PVP-live在runCoach、工具循环和主动提示之前检查。当前本机Demo的模式和快照来自客户端，并非权威认证；这只能演示能力限制，不能保证恶意竞技客户端不会修改mode。生产必须由服务器会话与对局服务决定权限。密钥不写文件/localStorage，进程退出即丢失；RSA-OAEP录入、同源检查和CSRF保护不等同互联网部署的完整安全方案。

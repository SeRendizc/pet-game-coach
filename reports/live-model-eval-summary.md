# S04 真实 DeepSeek 端到端评测（44 条，已完成）

> **归属说明**：本文件描述的是 **2026-09-17 10:33–10:37 UTC 完成的第一次 44 条运行**（当时工具轮次上限=3，规划器提示词为改版前版本）。该次逐条数据已备份为 `reports/live-model-eval-before.json`；`reports/live-model-eval-raw.json` 会被之后的重跑覆盖，**引用第一次运行请以 before 文件为准**。规划器提示词改版后的重跑与改动前后对比另行给出。

- 汇总 JSON：`reports/live-model-eval.json`（`status: COMPLETE`，含逐条原始字段）
- 原始逐条记录：`reports/live-model-eval-raw.json`
- 评测脚本 / 预注册用例集（44 条，每条带 `expect` 与判定依据 `why`）：`scripts/eval-live-s04.js`
- 重算脚本：`scripts/analyze-live-eval.js`
- 运行时间：2026-09-17（UTC 10:33–10:37，闲时档），模型 `deepseek-flash`，服务 `http://127.0.0.1:8765`
- **每条都是一次真实 POST /api/coach，无重试、无模拟 provider**

## 0. 先说结论（含不好看的部分）

| 指标 | 数值 | 分母 |
| --- | --- | --- |
| 执行 / 预注册 | **44 / 44** | — |
| HTTP 200 且有正文 | 44 | 44 |
| HTTP 非 200 / 超时 / 格式失败 | **0** | 44 |
| **工具选择完全正确率**（该不该调 + 首选工具 + 次数 + 停止方式） | **31.25%** | 32 条真正进入工具面的用例 |
| 「该不该调工具」判断正确率 | 71.88% | 32 |
| 首选工具落在允许集合内 | **90.63%** | 32 |
| 调用次数符合预期 | 31.25%（按 3 轮预算重算 **62.50%**） | 32 |
| **多余工具调用率（不该调却调了）** | **75.00%（9/12）** | 12 条"不该调工具且工具面确实打开"的用例 |
| 多余调用占全部工具调用的比例 | **39.06%（25/64）** | 64 次调用 |
| 该调却没调（漏调） | **0.00%** | 20 |
| **模型自己判断"证据够了，停止"** | **1/31 = 3.23%** | 31 |
| 端到端延迟 p50 / p90 | **4284 ms / 6229 ms**（min 16、max 9560、mean 3727） | 44 |
| checkGroundedAnswer 通过率 | 81.82%（36/44） | 44 |
| 其中仅模型输出 | 89.47%（34/38） | 38 |
| 总 token（生成 + 规划，规划为估计） | 输入 206,976 / 输出 4,156 | — |
| 成本估算（闲时价） | **≈ $0.0335**（若按峰时价 ≈ $0.0671） | — |

**最重要的三个负面结果：**

1. **多余工具调用率 75%**：12 条"参数化知识就能回答、不该调工具"的用例里，9 条仍然调了工具；这些调用占全部 64 次工具调用的 39.06%，是纯粹的延迟与成本浪费。这是本项最该被记住的数字。
2. **模型几乎不会自己停止**：31 条进入工具循环的用例中只有 1 条由规划器主动输出 `stop`（3.23%）。结束方式分布：`tool-budget` 16 次、`repeated-tool` 11 次、`planner-failed` 3 次、`complete` 1 次。绝大多数用例是把预算烧完才停，不是判断"够了"才停。
3. **首选工具本身选得不错（90.63%）**：真正的问题不在"选错工具"，而在"该不该调"和"什么时候停"。这与项目原先假设的失败模式不一样。

## 1. 四类用例的分项数字

| 类别 | n | 可判定 | 完全正确率 | 多余调用 | 漏调 | 超预算调用 | 工具面未打开 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cat1 该调工具（需要规则/局面查询） | 12 | 11 | 45.45% | 0 | 0 | 6 | 1 |
| cat2 不该调工具（参数化知识可答） | 12 | 9 | 33.33% | **6** | 0 | 6 | 3 |
| cat3 跨工具补证据 | 10 | 8 | 12.50% | 0 | 0 | 4 | 2 |
| cat4 该停止 | 8 | 2 | 0.00% | **2** | 0 | 2 | 6 |
| control 策略拦截（PVP 赛中） | 1 | 1 | 100% | 0 | 0 | 0 | 1 |
| control 本地路径（整局复盘） | 1 | 1 | 0.00% | 1 | 0 | 1 | 0 |

cat2 的"可判定"只有 9/12，因为 3 条被本地确定性路径直接截胡（未进入模型，见 §4），这 3 条既不算正确也不算错误，而是"没考"。

## 2. 延迟

| 分组 | n | p50 | p90 | min | max | mean |
| --- | --- | --- | --- | --- | --- | --- |
| 全部用例 | 44 | 4284 ms | 6229 ms | 16 ms | 9560 ms | 3727 ms |
| 真实模型调用 | 38 | 4445 ms | — | 892 ms | 9560 ms | — |
| 本地确定性路径 | 6 | 16 ms | — | 16 ms | 58 ms | — |

一次模型用例实际包含 2–4 次外部请求（1 次规划 + 1 次生成，规划最多 3 轮），所以端到端延迟明显高于单次生成延迟；服务端丢掉了规划调用的 usage，客户端无法拆分单段耗时。

## 3. 失败案例清单（**全部列出，未做筛选**）

校验器一共判不通过 8 条。逐条核对文本与工具回执后分类如下——**其中只有 1 条是确凿的模型事实错误**：

| 用例 | 校验器理由 | 核对后的真实分类 |
| --- | --- | --- |
| **c44** | `item-name-drift:解药` | **确凿模型错误：道具名说错。** 本作只有 回复药 / 净化药 / 能量果，模型把净化药写成"解药"（原文"最后3瓶回复药和2瓶解药都没用上"）。这正是该守卫要拦的漂移。 |
| **c31** | `unsupported-number:-250`、`-2406` | 数字来自工具回执的**四舍五入**（证据为 -250.4 / -2405.6），**不是编造**；但模型把内部启发式评分念给玩家（"评分-250；平均-2406、最坏-10000"），系统提示明确禁止"向玩家报内部局面评分" → **真实的表达质量缺陷**，只是守卫以数字理由报了出来。 |
| **c27** | `unsupported-number:64` | 64 = 58 + 6，两个加数都在 read_evidence 回执里（第5回合火花 58、灼烧 6）。**属于派生算术，不是编造数字**；守卫没有算术能力，属校验器局限。 |
| **c04** | `unsupported-certainty` | **校验器误报**：原文是"…对方也可能换宠或出招，**不是稳赢保证**"，否定句被 `稳赢` 正则命中。 |
| c05 / c14 / c15 | `unsupported-number:65` | **校验器误报，且不含模型输出**：这 3 条走的是本地 `rule:skill:guard` 卡片路径（route=guide、provider=local），"减伤 65%"来自卡片 `principle`，而守卫的事实集只取 `evidence/toolTrace/publicState/latestEvents/textFacts`，不含 principle。 |
| c41 | `unsupported-number:40` | **校验器误报，且不含模型输出**：本地出题路径（`makeQuiz`）生成的"对手速度 40"不在事实集里。 |

**三类"典型失败"的实测结果：**

- **道具名说错**：1 例（c44，"解药"）。
- **编造数字**：**0 例**。两处数字告警都能用工具回执解释（求和、四舍五入），没有出现证据里完全不存在的凭据数字。
- **声称必胜/确定性**：**0 例**。唯一相关告警 c04 是否定句误报。
- HTTP 非 200 / 超时 / 格式失败：**0 例**。
- 另有 **3 例规划调用失败**（c18、c19、c24 返回 `planner-failed`，调用数 0）：服务端规划调用抛错（2500 ms 超时或返回非 JSON，客户端无法区分），系统优雅降级为直接生成回答——没有编造工具结果，但这 3 条实际上**没有经过工具决策**，不应被算作"成功避免了多余调用"。

## 4. 路由截胡：13 条用例根本没打开工具面

`casesWhereToolSurfaceWasNeverOffered = 13`。其中 6 条是本地确定性路径（provider=local：c05/c14/c15 本地规则卡、c41 出题、c42、c43 策略拦截），另 7 条被路由成 `companion`（c22、c28、c32、c35、c36、c37、c40）——companion 路由不提供任何工具。因此"工具决策"的实际评测面比预注册的 44 条窄（32 条），这也是为什么 cat4"该停止"只有 2 条可判定。

## 5. 口径与局限（必须一起读）

1. **用例集与判定是我自己写的**（44 条，含 `expect/why`），不是独立盲标集，存在作者偏置。
2. **代码在我评测期间变过**：我最初读到 `coach/runtime.js` 的工具循环是 `limit=2`（最多 2 轮），实际服务运行的是提交版本 `aae9b38` 的 `limit=3`（最多 3 轮，并新增 `applicability` 条件执行校验）。因此"调用次数符合预期 31.25%"是按 2 轮假设判定的，偏严；按系统自身的 3 轮预算重算为 **62.50%**。**多余工具调用率（75%）不受影响**，因为它的预期就是 0 次。
3. **规划 token 是估计值**：服务端只回报生成调用的 usage，规划调用（最多 3 轮）的 usage 被丢弃；我用已知规划 prompt + 项目自带官方 tokenizer 重建计数。这是本报告唯一的估计成分，已在 JSON 的 `tokens` 字段标明。
4. **checkGroundedAnswer 是窄口径数字/引用/确定性守卫，不是正确性证明**；本次 8 条不通过里 6 条经核对属误报或派生值，说明该守卫精度不足（尤其本地路径与否定句）。
5. 延迟测量期间并行有一个纯本地仿真作业（单核占用，机器 15 核），影响可忽略但不为零。

## 6. 逐条明细

```
| id | 类别 | 路由 | 工具轨迹 | 调用数 | 状态 | HTTP | 延迟ms | 生成prompt | 生成completion | 规划输入(估) | 规划输出(估) | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| c01 | cat1-needs-lookup | strategist | read_state | 1 | repeated-tool | 200 | 5590 | 3502 | 48 | 1878 | 21 | 通过 |
| c02 | cat1-needs-lookup | strategist | read_state | 1 | repeated-tool | 200 | 3607 | 3586 | 94 | 1961 | 21 | 通过 |
| c03 | cat1-needs-lookup | strategist | read_evidence | 1 | repeated-tool | 200 | 6640 | 2546 | 88 | 912 | 24 | 通过 |
| c04 | cat1-needs-lookup | strategist | read_last_turn → read_evidence → read_match | 3 | tool-budget | 200 | 4172 | 4023 | 70 | 1492 | 58 | 不通过(unsupported-certainty) |
| c05 | cat1-needs-lookup | guide | — | 0 | — | 200 | 58 | — | — | 400 | 8 | 不通过(unsupported-number:65) |
| c06 | cat1-needs-lookup | strategist | read_last_turn → read_state → read_evidence | 3 | tool-budget | 200 | 4284 | 3769 | 104 | 2601 | 52 | 通过 |
| c07 | cat1-needs-lookup | strategist | read_state → compare_actions → read_last_turn | 3 | tool-budget | 200 | 4051 | 4497 | 126 | 4349 | 50 | 通过 |
| c08 | cat1-needs-lookup | strategist | read_state | 1 | repeated-tool | 200 | 3788 | 3587 | 85 | 1961 | 21 | 通过 |
| c09 | cat1-needs-lookup | teacher | inspect_training → read_state | 2 | repeated-tool | 200 | 4056 | 3127 | 76 | 2949 | 36 | 通过 |
| c10 | cat1-needs-lookup | strategist | read_state | 1 | repeated-tool | 200 | 3569 | 3427 | 70 | 1843 | 21 | 通过 |
| c11 | cat1-needs-lookup | strategist | read_state → read_match → read_evidence | 3 | tool-budget | 200 | 6331 | 5364 | 85 | 5209 | 56 | 通过 |
| c12 | cat1-needs-lookup | strategist | read_state → read_last_turn → compare_actions | 3 | tool-budget | 200 | 6003 | 4553 | 103 | 3473 | 50 | 通过 |
| c13 | cat2-parametric | strategist | search_rules → read_state → search_rules | 3 | tool-budget | 200 | 5035 | 4795 | 35 | 3671 | 68 | 通过 |
| c14 | cat2-parametric | guide | — | 0 | — | 200 | 16 | — | — | 389 | 8 | 不通过(unsupported-number:65) |
| c15 | cat2-parametric | guide | — | 0 | — | 200 | 16 | — | — | 396 | 8 | 不通过(unsupported-number:65) |
| c16 | cat2-parametric | strategist | search_rules → search_rules → read_last_turn | 3 | tool-budget | 200 | 3709 | 3833 | 47 | 3325 | 83 | 通过 |
| c17 | cat2-parametric | strategist | search_rules → search_rules → search_rules | 3 | tool-budget | 200 | 9560 | 2528 | 109 | 3491 | 80 | 通过 |
| c18 | cat2-parametric | strategist | — | 0 | planner-failed | 200 | 8229 | 2316 | 48 | 389 | 8 | 通过 |
| c19 | cat2-parametric | strategist | — | 0 | planner-failed | 200 | 4445 | 2489 | 55 | 389 | 8 | 通过 |
| c20 | cat2-parametric | strategist | search_rules → read_state → read_evidence | 3 | tool-budget | 200 | 4602 | 4296 | 61 | 3760 | 62 | 通过 |
| c21 | cat2-parametric | teacher | search_rules → read_state → search_rules | 3 | tool-budget | 200 | 4391 | 6175 | 59 | 3742 | 86 | 通过 |
| c22 | cat2-parametric | companion | — | 0 | — | 200 | 2314 | 1399 | 59 | 391 | 8 | 通过 |
| c23 | cat2-parametric | strategist | search_rules → search_rules | 2 | complete | 200 | 5766 | 1686 | 60 | 3095 | 58 | 通过 |
| c24 | cat2-parametric | strategist | — | 0 | planner-failed | 200 | 4884 | 2318 | 45 | 390 | 8 | 通过 |
| c25 | cat3-cross-tool | strategist | read_state | 1 | repeated-tool | 200 | 3365 | 3410 | 92 | 1894 | 21 | 通过 |
| c26 | cat3-cross-tool | strategist | read_state → search_rules | 2 | repeated-tool | 200 | 6229 | 4116 | 45 | 4061 | 45 | 通过 |
| c27 | cat3-cross-tool | strategist | read_evidence → search_rules → read_state | 3 | tool-budget | 200 | 4723 | 4423 | 88 | 2232 | 74 | 不通过(unsupported-number:64) |
| c28 | cat3-cross-tool | companion | — | 0 | — | 200 | 2496 | 1401 | 56 | 398 | 8 | 通过 |
| c29 | cat3-cross-tool | strategist | search_rules → read_evidence → read_match | 3 | tool-budget | 200 | 4931 | 4535 | 102 | 1979 | 64 | 通过 |
| c30 | cat3-cross-tool | strategist | read_state | 1 | repeated-tool | 200 | 3276 | 3467 | 74 | 1884 | 21 | 通过 |
| c31 | cat3-cross-tool | strategist | read_last_turn → read_evidence → compare_actions | 3 | tool-budget | 200 | 4746 | 3688 | 85 | 1542 | 53 | 不通过(unsupported-number:-250;unsupported-number:-2406) |
| c32 | cat3-cross-tool | companion | — | 0 | — | 200 | 1362 | 1449 | 90 | 396 | 8 | 通过 |
| c33 | cat3-cross-tool | strategist | read_state → read_last_turn → read_evidence | 3 | tool-budget | 200 | 5049 | 2702 | 55 | 3381 | 52 | 通过 |
| c34 | cat3-cross-tool | teacher | inspect_training | 1 | repeated-tool | 200 | 4832 | 2055 | 84 | 1143 | 23 | 通过 |
| c35 | cat4-should-stop | companion | — | 0 | — | 200 | 1166 | 416 | 40 | 393 | 8 | 通过 |
| c36 | cat4-should-stop | companion | — | 0 | — | 200 | 892 | 406 | 8 | 388 | 8 | 通过 |
| c37 | cat4-should-stop | companion | — | 0 | — | 200 | 922 | 402 | 18 | 386 | 8 | 通过 |
| c38 | cat4-should-stop | strategist | search_rules → read_state | 2 | repeated-tool | 200 | 4455 | 4100 | 20 | 3638 | 41 | 通过 |
| c39 | cat4-should-stop | strategist | read_state → read_last_turn → read_evidence | 3 | tool-budget | 200 | 4620 | 3616 | 96 | 3445 | 52 | 通过 |
| c40 | cat4-should-stop | companion | — | 0 | — | 200 | 1325 | 1397 | 62 | 390 | 8 | 通过 |
| c41 | cat4-should-stop | teacher | — | 0 | — | 200 | 16 | — | — | 390 | 8 | 不通过(unsupported-number:40) |
| c42 | cat4-should-stop | auto | — | 0 | — | 200 | 55 | — | — | 395 | 8 | 通过 |
| c43 | control-policy | policy | — | 0 | — | 200 | 16 | — | — | 395 | 8 | 通过 |
| c44 | control-locked | teacher | read_match → read_evidence → read_match | 3 | tool-budget | 200 | 4375 | 5767 | 131 | 4624 | 62 | 不通过(item-name-drift:解药) |
```

（`生成prompt`/`生成completion` 为 API 回报的精确值；`规划输入(估)`/`规划输出(估)` 为按官方 tokenizer 重建的估计值。`校验` 列为 checkGroundedAnswer 结果。）


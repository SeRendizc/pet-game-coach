# 陪练实现说明（Companion Implementation）

> 配套文档：`docs/COMPANION-DESIGN.md`（设计与实现状态逐条标注）、`docs/CHECKLIST.md` 的 T05（**仍未勾**）。
>
> 日期：2026-09-17。基线：改动前 `npm test` → `tests 150 / pass 149 / fail 1`（当时 `server.test.js` 有一条断言因另一处并行改动而红）；改动后 → `tests 177 / pass 177 / fail 0`（177 里含本轮新增的 `companion.test.js` 12 条，其余增量来自同批其他改动）。
>
> **本文只写已经跑起来、且有测试的东西。** 没做的部分单独列在「§6 仍然是设计的部分」与「§8 已知边界」，不用「部分实现」「理论上支持」这类说法。

---

## 1. 一句话

陪练的**被动通道**（玩家先开口）现在是一个纯函数闭环：

```
真实记录 → companionState() 派生状态 → 决定语气档位 R0–R3 → 按档位填充真实事件模板
        → 证据包（含档位与约束）交给模型改写 → 生成后克制扫描 → 越界则回退模板
```

**主动通道**（对局中不请自来地说话）只做了一半：`coachEvent` 的门控与档位、引用局内真实事实都已实现且可测，但 `app.js` 里唯一的调用点 `notify()` 没有任何调用处，所以气泡在真实 UI 中不会弹出（§8.1）。

改动落在 5 个文件，**没有新增任何模块**（浏览器只允许加载 `server.js` 的 `publicAssets` 白名单里的文件，新增文件会 404，所以 `coach/companion.js` 一个文件承担了状态、档位、模板与扫描）：

| 文件 | 改了什么 |
|---|---|
| `coach/companion.js` | 从 6 行重写为状态模型 / 档位表 / 真实事件模板 / 克制扫描 / 主动侧模板 |
| `coach/memory.js` | `rememberBattle` 记录真实对局事实（对手、倒下顺序、首个减员、剩余道具）；`readMemory` 逐字段校验新增字段 |
| `coach.js` | `coachContext` 补上关卡、当前对位、倒下伙伴、剩余只数；`coachEvent` 接上 `proactiveRegister` + `proactiveText` |
| `coach/client.js` | 陪练路由下增加一次 `checkCompanionRestraint`，越界回退本机模板（复用既有降级路径） |
| `companion.test.js` | 新增 12 条测试；`package.json` 加入 `test` 脚本与 `test:companion` |

**未改动**：`app.js`、`server.js`、`engine.js`、`index.html`、`style.css`（硬性约束），也没有改 `coach/runtime.js`（陪练路由与 `companion(context, memory, message)` 的调用方式保持不变，因此这次改动与同批其他改动互不冲突）。

---

## 2. 状态怎么算（`companionState`）

`coach/companion.js:83`，纯函数，签名与设计一致：`companionState(memory, context, session, now)`。

| 字段 | 算法 | 数据来源（真实字段） |
|---|---|---|
| `momentum` | 最近 3 局 `win=+1 / draw=0 / loss=-1` 求和，范围 −3..+3 | `memory.events[].result` |
| `lossStreak` / `winStreak` | 末尾连续同结果的局数 | 同上 |
| `consideration` | `2 - min(2, 近 7 天 dismiss 条数)` | `memory.journal` 里 `kind==='dismiss'` 且 `time` 在 7 天内——**与 `adaptiveGate` 读同一份数据，不新建计数** |
| `engagement` | 本轮玩家发起 → 2；有真实历史（events 或 dialogue）→ 1；**一条记录都没有 → 0** | 本轮消息 + `memory.events` / `memory.dialogue` |
| `reasons` | 4 条中文原因，每条都写明数值与来源字段 | 上面三项 + 档位判定结论 |

`reasons` 就是「你为什么现在是这个语气」的答案。真实输出示例（对局由引擎实跑，不是手写数据）：

```
最近2局0胜2负，momentum=-2（来源：memory.events）
近7天有1次主动关闭提示，consideration=1（来源：memory.journal 的 dismiss）
本轮由玩家发起，意图=emotion，engagement=2（来源：本轮消息）
判定：玩家本轮倾诉，且真实记录里连着输（连败2局，momentum=-2）
```

**与设计的两处收窄**（不是遗漏，都有理由）：

1. `engagement` 的 0 档：设计写「近 3 天内有对话 → 1；否则 1」，需要一个对话时间戳，而 `memory.dialogue` 的条目只有 `{role, content}`（`coach/runtime.js:79`）。实现改为「有历史 → 1；什么都没有 → 0」，并把 0 用来执行原则 P3：**没有任何真实经历时只输出最短承接句，不进入具体关切**。
2. `engagement` 不参与升档：它只用来判定「有没有可依据的经历」，档位不会被它抬高——表驱动测试遍历 210 种组合断言 `engagement<=2`，且次数上限仍由 `coach.js` / `experience.js` 的既有门控承担。

---

## 3. 档位怎么切换（R0–R3）

决策顺序（先命中先返回，纯函数，`coach/companion.js:110`）：

| 顺序 | 条件 | 档位 |
|---|---|---|
| 1 | 线上竞技进行中（`isLiveMatch`）或 `preference==='quiet'` 或 `session.dismissed` | **R0** |
| 2 | `consideration===0` 且本条不涉及新的真实证据（只在主动通道可达） | **R0** |
| 3 | 玩家发起 + 情绪词 + **真实记录里确实在连着输**（连败 ≥2 或 momentum ≤ −2） | **R3** |
| 4 | 玩家发起：追问 → **R2**；带问题的提问 → **R2**；纯寒暄 → **R0**；无明确意图 → **R1**；本机无任何记录 → **R0** | R2 / R1 / R0 |
| 5 | 非玩家发起 + 在连着输 + 本局尚未就此事说过 | **R3** |
| 6 | 非玩家发起 + 有一条尚未说过的真实观察 | **R1** |
| 7 | 其余 | **R0** |

档位表（`REGISTERS`，`coach/companion.js:12`）与生效方式：

| 档位 | 字数上限 | 问句上限 | 允许建议 | 真实输出示例（引擎实跑的对局） |
|---|---|---|---|---|
| R0 不说 | 8（主动通道 0） | 0 | 否 | `我在。` |
| R1 就事论事 | 40 | 0 | 否 | `上一场青芽草地17回合，失利，倒下3只。烬尾狐在第3回合倒下。` |
| R2 具体关切 | 80 | 1 | 是 | 上面这句 + `想回看第3回合说一声。` |
| R3 收尾陪坐 | 30 | 0 | 否 | `连着2局没赢。到这儿也行，想继续我就在。` |

**档位是真的影响输出，不是算完就丢**，三个通道各有一条测试：

1. **本机模板**（未接模型）：四个档位给出四段不同文本，且长度都在各自上限内（测试 `the register changes the wording, not only the field`）。
2. **模型路径**：档位与 `replyConstraints`（`maxChars` / `maxQuestions` / `forbid` / 一句中文指令）随证据包进入 `game_evidence`（`server.js:96`），模型看到的是「本轮档位 R1：正文不超过40字，不要问句，只写有本机记录支撑的事实」。测试 `runCoach routes to the companion and hands the register to the model` 断言不同档位送出的约束不同（40 / 30 字上限）。
   - **边界**：不能在服务端 system prompt 里另加一段档位指令，因为 `server.js` 不在本轮允许修改的文件里。这件事写在文档里，不假装做到了。
3. **生成后强制**：`coach/client.js:31-34` 对陪练输出跑一次 `checkCompanionRestraint`，命中即回退到本机模板，并把原因写进 `fallbackReason`。测试 `a model reply that breaks the register falls back to the recorded template`（模型回「别灰心，你已经很棒了。」→ 被拦下，显示本机模板）。

**一处有意的重新界定**：设计里 R0 是「0 字，什么都不说」。主动通道确实如此（`coachEvent` 返回 `null`）；但被动通道（玩家先开口的聊天）不能返回空文本——`runCoach` 会以「教练暂时没有生成有效回答」抛错（`coach/runtime.js:76`）。所以 R0 在那里是最短承接句「我在。」（3 字），不新增事实、不评价、不提问。

---

## 4. 真实事件关联：引用了什么，从哪来

陪练说的每一件「过去的事」都必须能在本机记录里指到。字段来源只有两处：

**（1）跨局记录 `memory.events`**（`coach/memory.js:20-29` 新增，读回时逐字段校验 `:5-8`）：

| 字段 | 内容 | 例（引擎实跑：种子 1、青芽草地、17 回合） |
|---|---|---|
| `enemy` | 对手阵容（真实名字） | `['炽鬃狮','潮甲龟','芽角鹿']` |
| `faints` | 我方倒下顺序 | `['烬尾狐','潮甲龟','芽角鹿']` |
| `firstLossTurn` + `firstFallen` | **成对记录**首个减员的回合与那一只 | `3` + `'烬尾狐'` |
| `survivors` | 结束时存活只数 | `0` |
| `items` | 结束时剩余道具 | `{potion:3,cleanse:2,ether:2}` |

`firstLossTurn` 与 `firstFallen` 必须成对，这是一条真实的坑：`faints[0]` 是队伍顺序里的第一只，不一定是第 `firstLossTurn` 回合倒下的那只——混用会说出一句听起来具体、实际上是假的话。测试 `templates cite the real match, the fallen pet and the opponent` 直接比对引擎对象与文本。

**（2）当前局面**（`context.battle` / `context.lastMatch` / `coachContext`）：当前对手、已倒下伙伴、剩余只数、关卡、回合数。

**旧存档的降级是明确的**：没有新字段的记录读回来是 `[]` / `null`，模板就少说一句，绝不补默认值（测试 `companion facts degrade to null instead of default values`：一条只有 `stage` 和 `turns` 的旧记录，输出停在「青芽草地9回合」，不出现「倒下」「回复药」）。

**一条比正则更硬的约束**：陪练文本里的每个数字都必须出现在它自己的 `evidence` 里。否则模型照抄这些真实数字时，会被 `checkGroundedAnswer` 的 `unsupported-number` 判成编造、再被降级一次（假阳性回退）。测试 `every number the companion says is backed by its own evidence` 对 2 份真实存档 × 5 种意图逐个数字核对。

---

## 5. 克制：五条约束与它们的测试

`checkCompanionRestraint(text, {register, facts, previousAssistant})`（`coach/companion.js:230`）实现设计 §3.5 的五条：

| # | 禁止 | 判定 |
|---|---|---|
| 1 | 第一人称情绪断言 | `我(很\|好\|有点\|真的\|也\|现在\|其实)(开心\|难过\|伤心\|生气\|失望\|高兴\|兴奋)` |
| 2 | 空泛鼓励 | `加油 / 别灰心 / 你已经很棒 / 再接再厉 / 下次一定 / 一定可以 / 你可以的 / 不要放弃 / 没关系的 / 放轻松` |
| 3 | 强行追问 | 问号数超过档位上限（R0/R1/R3 = 0，R2 = 1），或连续两轮都以问句结尾 |
| 4 | 水平羞辱 | `菜 / 太弱 / 你错了 / 你不行 / 水平不够 / 速度意识差` |
| 5 | 无证据的过去陈述 | 出现「记得/上次/之前/上回/我们已经/上一场/那一局/连着」时要求本机确有 `events`/`lessons`/`dialogue`；提到「速度判断」时要求 `memory.lessons` 里真有这条课程 |

另外三条可测的行为约束：

- **不因一次失败就弹话**：只有 1 连败时走 R2 具体关切（陈述那一局的真实事实），不进 R3 收尾语气；主动侧同一局最多 2 次、`result` 同局第二次不说话。
- **允许沉默**：`preference==='quiet'`、`pvp-live` 进行中、`session.dismissed`、本机无任何记录，四种情况都返回 R0（主动通道返回 `null`)。
- **旧 bug 已修**：不再无条件说「我们已经练过速度判断了」；`lessons=['灼烧追击']` 时不得出现「速度判断」，`lessons=['速度判断']` 时才允许。

---

## 6. 偏好跨局保持

`rememberPreference` 写入的三类偏好现在都会**改变输出**，且经 `readMemory` 往返后保持一致：

| 偏好 | 怎么影响输出 | 测试断言 |
|---|---|---|
| `preference: brief / detailed` | `brief` 丢掉「想回看第 N 回合说一声」这类可选动作，文本更短 | `brief.length < detailed.length`，且 `brief` 不含「说一声」 |
| `goal: 稳健 / 速攻` | 观察角度不同：稳健优先说「还剩几瓶回复药 / 几只伙伴站着」，速攻优先说「哪只在第几回合倒下」 | 两种目标下 R2 文本不相等，并各自匹配对应的真实字段 |
| `favorite: 本命宠 id` | 只在**那只宠物真的出现在那一局**时才点名，说法是「你的本命烬尾狐在第 3 回合倒下」 | 命中时说「你的本命」，换一只没在场的宠物时不说 |
| 三者合计 | 存盘 → `readMemory` → 同一句话的输出完全相同（跨局、跨刷新保持） | `stored.events.at(-1).firstFallen === last.firstFallen` 且输出文本相等 |

---

## 7. 主动通道（`coachEvent`）

- 门控不变（`coach.js:9-11`）：`isLiveMatch` / `quiet` / `dismissed` / `count>=2` 直接 `null`；非 `result` 事件两次至少隔 3 回合。
- 档位：`proactiveRegister({lossStreak})`——连败 ≥2 → **R3**，否则 **R1**（只陈述事实）。
- 措辞：`proactiveText(event, context, register)` 引用局内真实字段。实跑示例（种子 4、冠军高地、28 回合、胜利、倒下的两只分别是烬尾狐与潮甲龟、结束时剩 1 只、场上对手是潮甲龟——`coachContext` 的实测输出就是这些值）：
  - `first-faint` → `潮甲龟倒下了。还剩1只。补位不占回合，你先选。`
  - `result`（胜）→ `冠军高地28回合打完，拿下了。回营地可以继续培养。`
  - `result`（1 连败）→ `冠军高地28回合结束，失利。对手是潮甲龟。还剩1只。`
  - `result`（2 连败）→ `连着2局没赢。到这儿也行，想继续我就在。`
- **它和被动通道共用同一套档位表与克制扫描**：测试 `proactive companion cites the live match and stays silent by design` 对四条主动文本逐个跑 `checkCompanionRestraint`。

---

## 8. 仍然是设计的部分（没做的，逐条列清）

**§8.1 主动气泡在 UI 里不会弹出。** `app.js:212` 定义了 `notify(event)`，它调用 `coachEvent`；但全仓库检索 `notify` 只有这一处定义，**没有任何调用处**。因此主动侧目前只有函数级与测试级的存在，没有真实触发。修它要给 `notify` 接线（对局中首次倒下与结算处各调一次），而 `app.js` 不在本轮允许修改的文件里。这也意味着「胜负后是否说话的判断」在**真实游玩中**还没有被观察到过。

**§8.2 记忆层一行没动。** 设计 §4.2 的 journal 扩展（`importance` / `poignancy` / `refs` / `lastAccess` / `supersededBy`，以及 `utterance` / `preference` / `milestone` 三类条目）、§4.3 的三因子检索打分（`0.5·recency + 0.3·importance + 0.2·relevance`，权重未标定）、§4.4 的 Reflection 合成（可否定 claim + `supersededBy`）**全部未实现**。本轮只把 `memory.events` 的字段加厚——它是对局摘要，不是玩家的经历条目，不改变这一差距。

**§8.3 「多日未登录后由陪练先开口」未实现。** 只实现了玩家先开口时把「上一次记录是 N 天前」作为一条观察；主动开场需要 §8.1 的调用点。

**§8.4 倾诉原文默认不进模型上下文：未实现。** 设计 §6 R3 的第 3 条缓解要求「倾诉原文默认不进入送给模型的上下文」。当前 `client.js` 会把最近 8 条对话（含玩家原话）放进请求，这一条**没有对应机制**，仍标【仅设计未实现】。

**§8.5 没有服务端档位提示词。** `server.js` 的 system prompt 未改（不允许改），档位约束只能通过证据包字段与客户端事后扫描生效。

**§8.6 没有真人语言评审，也没有密度验证。** 克制扫描能拦住「说了不该说的」，拦不住「说得太频繁」。这是 R1 风险的核心，只能靠真人试玩；U07 与 T05 **都仍未勾**，本轮没有做任何真人测试，也没有据此调整任何文案。

**§8.7 `engagement` 的时间窗口未实现**（见 §2 收窄 1），需要先给 `memory.dialogue` 加时间戳。

**§8.8 模型引用更早一局的数字时会被打回。** `assembleContext` 会带最近 3 条 `memory.events` 进上下文（`coach/runtime.js:195`），而陪练的 `evidence` 只详细描述最近一局。因此模型若引用倒数第二局的回合数，`checkGroundedAnswer` 的 `unsupported-number` 会判它不合格并回退到本机模板。**这是保守方向的失败**（玩家看到的是可核对的模板句，不是错数字），但会让模型改写在这类追问上更常被回退。修法是把陪练用到的 `events` 也写进 `evidence`，属于下一步的事，本轮没做。

---

## 9. 怎么验证

```bash
npm test              # 全量：177 项
npm run test:companion # 只跑陪练：12 项
```

`companion.test.js` 的 12 条测试与它们覆盖的要求：

| 测试 | 覆盖 |
|---|---|
| `companion state is derived from real matches, dismissals and dialogue` | 状态派生（momentum / 连败 / consideration / engagement），原因字段带来源 |
| `register table: silence stays first and engagement never raises the ceiling` | 档位切换（含 210 种组合的表驱动、quiet 与 pvp-live 恒 R0） |
| `the register changes the wording, not only the field` | 四个档位四段不同文本 + 字数/问句上限 + 送模型的约束 |
| `templates cite the real match, the fallen pet and the opponent` | 真实事件引用（关卡、回合、倒下的宠物、对手、首次减员回合） |
| `every number the companion says is backed by its own evidence` | 每个数字都能在自己的依据里核到 |
| `restraint scan rejects the five forbidden shapes and accepts our own templates` | 克制五条（正反用例）+ 自我一致性 |
| `one loss never becomes comfort, and silence stays a real output` | 一次失败不出安慰、静默可用、旧「速度判断」bug 已修 |
| `player preferences survive matches and change the reply` | 偏好跨局保持（brief/detailed、稳健/速攻、本命、存档往返） |
| `runCoach routes to the companion and hands the register to the model` | 路由到陪练、档位与约束真的送达模型 |
| `a model reply that breaks the register falls back to the recorded template` | 模型越界 → 回退本机模板（端到端，mock fetch） |
| `proactive companion cites the live match and stays silent by design` | 主动侧真实事实引用 + 全部门控 + 克制扫描 |
| `companion facts degrade to null instead of default values` | 旧存档降级：缺字段就少说，不补默认值 |

**测试数据不是手写的**：每一局都由引擎真实跑出来（随机出招必输、按枚举推荐出招会赢），测试里的期望值直接从 `game` 对象推导（`loss.player.pets.filter(p=>p.hp<=0).map(p=>p.name)`），因此「引用真实事件」这件事是被比对验证的，不是断言一句写死的文案。

---

## 10. 为什么 T05 仍然不勾

T05 的验收口径包含**真人语言评审**（U07：具体、自然、无水平羞辱；不空泛安慰、不强行提问；使用者觉得烦时降低打扰），本轮只有自动测试；而且主动通道在真实 UI 里没有调用点（§8.1）。两项都写在 `docs/CHECKLIST.md` 的 T05 注释里，**勾选状态没有改动**。

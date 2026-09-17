# `reports/balance-matrix.md` 更新依据（notes）

本文件记录本次更新 `reports/balance-matrix.md` 时的判断依据、数字出处、派生量的算法，以及**没能核实的东西**。它不参与任何评测口径，只用于回溯。

---

## 1. 数据来源与时间线

| 时间（本地） | 事件 | 证据 |
| --- | --- | --- |
| 19:27:10 | 旧规则跑出一份完整矩阵（5796 场 / 398 臂） | 【旧JSON】`generatedAt` = 2026-09-17T11:27:10.617Z |
| 19:30:11 | 旧规则那次运行的 stdout 落盘 | `reports/balance-matrix-stdout.txt` mtime |
| 19:32:21 | 旧版 `reports/balance-matrix.md` 写就 | mtime（与 stdout 的每个数字一致） |
| 20:46:17 | `engine.js` 写入新相克表与同系 ×1 | mtime |
| 20:48:28 | 提交 `3785cb4`（提交信息明确写"5,796 场矩阵是在旧表上跑的，已过期，下一步重跑"） | `git log -1 3785cb4` |
| 20:48:31 | 新规则那次运行**开始** | 【JSON】`generatedAt` = 2026-09-17T12:48:31.439Z |
| 20:51:33 | 新规则运行**结束**并落盘 | `durationMs` = 181586 与 JSON mtime 完全吻合 |

`generatedAt` 是**运行开始**时刻（脚本在 `report` 对象创建时赋值，见 `scripts/eval-balance-matrix.js:359`），`durationMs` 在收尾时赋值（同文件 `:848`）。两者相加正好等于文件 mtime，所以时间线自洽。

## 2. 判定：`reports/balance-matrix-stdout.txt` 是旧规则的产物

三条互相独立的证据（都写进了 `balance-matrix.md` §1.10）：

1. 它的全局行"平局 20/5796、达上限 16、平均回合 17.6±7.3"与【JSON】`global`（35 / 18 / 17.84±8.119）不一致，却与【旧JSON】`global`（20 / 16 / 17.567±7.308）逐项吻合。
2. 它的配对行 `none → shellCharm A=30.3% B=36.4% p=0.0005` 与【JSON】`paired`（36.42% / 43.83% / p=0.0000696）不一致，却与【旧JSON】`paired` 一致。
3. 它打印"studyC 15/15、studyA 30/30 与归档一致"，而用【JSON】重算是 5/15 与 0/30；用【旧JSON】重算才是 15/15 与 30/30。

**结论**：`balance-matrix.md` 的正文数字一律取自【JSON】；stdout 只在 §9 当作旧规则对照引用，并在 §12 明确写出"它没有随本次 JSON 一起重跑"。

## 3. 【JSON】确实出自当前（新规则）`engine.js`：一次独立复现

担心"JSON 会不会是用中间版本的 `engine.js` 跑出来的"，所以做了两步检查：

1. **不覆盖任何产物地重跑脚本**：把同一脚本在系统临时目录里以 `MATRIX_SCALE=0.1` 跑了一遍（脚本用 `process.cwd()` 解析 `reports/balance-matrix.json`，所以从临时目录运行时产物落在临时目录，`reports/` 下的文件没被碰）。临时产物：398 个臂、1246 场（每个臂 2 个种子，`100`、`137`）。
2. **逐场比对**：把临时产物与【JSON】按"臂 key + 种子"对齐，比 `result` 与 `rounds`：**1246 / 1246 完全一致，0 处不一致**。

这一步同时排除了"我自己的手写复现脚本"这条歧路：我最初手写的单场模拟在 `S8 | meadow | T1` 上给出 `loss@15`，而真实脚本给出 `win@11`（与【JSON】一致）——差异出在我简化了补位时的换宠选择（脚本用 `replaceChoice()` 的评分，我取了第一个合法换宠）。所以**以脚本为准**，手写复现只用于定位差异、不作为证据。

## 4. 新旧对照的两个数据源

- **【旧JSON】**：`git show 3785cb4:reports/balance-matrix.json`。它就在仓库历史里，是同一脚本、同一批种子、同样 5796 场 / 398 臂的旧规则输出；与旧版 `balance-matrix.md`、旧 stdout 的每个数字都能对上。
- **【CAL】**：`reports/balance-calibration.json` 的 `studyC_difficulty`，只用于 §9.5 的 studyC 对照值——因为 studyC 的归档基准**不在**【JSON】里（脚本把它写成源码里的字面量 `ARCH`，见 `scripts/eval-balance-matrix.js:951-953`，值取自该归档文件）。
- studyA 的归档基准**在**【JSON】的 `archivedStudyA` 字段里（30 格），所以 §9.6 的对照只用【JSON】即可完成。

## 5. 派生量的算法（都不是 JSON 里的现成字段）

| 量 | 算法 |
| --- | --- |
| 表格里的"标准差" | 合并标准差 `sqrt(Σ sd_i²·(n_i−1) / (N−1))`，与脚本打印 S1 时用的公式相同（`scripts/eval-balance-matrix.js:889`） |
| 胜率的 95% CI | 脚本自己的 `wilson(wins, n)`，对合并后的 n 计算（**不是**把各臂上下界平均）；§7.2 的 S5 每宠行按这个重算过一遍 |
| "阵容合并胜率极差 / 九值标准差" | 由【JSON】与【旧JSON】的 S1 arms 先按阵容合并（n=108），再取 9 个值的极差与总体标准差（§9.3） |
| §9.3 的 `Δ` | 新 − 旧，单位 pp |
| §9.6 的 8 / 7 / 1 / 18 / 11 / 1 等计数 | 由【JSON】S10b arms 的 `bySeed`（重算胜率与平均回合）对【JSON】`archivedStudyA` 逐格比较得出，阈值同脚本：胜率 1e-12、回合 1e-9 |
| normal 难度敌方换宠次数 = 3 | 把各臂的 `enemyKindCounts.switch` 直接相加（池化的 `tactics.byEnemyDifficulty` 只存四舍五入到 4 位的占比 0.0001，还原不出整数，所以不能用它） |

## 6. 发现的两处 JSON 自身口径问题（未改代码，只在报告里写明）

1. `caveats[5]`："`rounds>=80` 必定为平局"**不成立**。5796 场里有 1 场 `rounds=80 result=loss`（`S10 | archived studyA_composition | burn lion/shroom/otter | normal | random`，seed 137）。原因是 `engine.js` 先判全灭（`:284`）再判上限（`:297`），第 80 回合打死一方时不再判平局。旧规则那一轮没有这类记录，所以这句话曾经成立。
2. `caveats[7]`："本次未运行 `npm test`、未改动 `engine.js`/`app.js`/`content.js`"——这是脚本里**写死的字面量**（`scripts/eval-balance-matrix.js:857`），本轮改了 `engine.js`，所以这句与本轮事实不符。任务也点名要求改掉旧报告里同一句陈述；报告 §10.2 记录了这两处。

## 7. 我没能核实 / 数据不足的部分（照实列出）

1. **"属性平衡是否整体变好"无法判断**（这是 §9.6 的结论，不是遗漏）。缺的东西很具体：没有"同一只宠换属性"的对照臂（每个属性只有 2 只不同宠物），也没有"只改相克表"与"只改同系倍率"的消融组。所以"属性"的效应与"宠物面板/技能"的效应在这批数据里不可分离。
2. **stdout 与 JSON 不对齐**：`reports/balance-matrix-stdout.txt` / `-run.log` 仍是旧规则产物。按任务约束我没有重跑脚本（重跑会覆盖 `reports/balance-matrix.json`，而那份 JSON 是本轮要被对齐的基准）。要让三者一致，需要重跑一次 `node scripts/eval-balance-matrix.js`。
3. **`docs/CHECKLIST.md` 里 G07 的说明文字仍写着"用时 180.6 秒"**（旧那轮的数字），与本轮 181.6 秒不一致。按约束我只把这件事写进报告、没有改那份清单。
4. **`pvp-local` 的补位路径没有实机验证**：只在 Node 里复现了 `chooseEnemy()` 在"敌方补位"局面抛错（hard 分支），没有在浏览器里跑过，所以"UI 会卡住"仍是静态阅读的推断（旧报告也是这么写的，本轮保留）。
5. **旧规则那一轮的完整逐场数据只在 git 里**：`reports/balance-matrix.json` 现在只有新规则一份。§9 的旧值全部来自 `git show 3785cb4:reports/balance-matrix.json`，如果将来 rebase/丢弃该提交，这一节就失去出处（因此报告里把 commit 号写在正文中）。
6. **关卡 05（山风）只有 2 个臂、24 场，且两臂全负、12 个种子结果完全相同（标准差 0）**：这批数据的信息量比场次数看起来更少，不足以谈环境对阵容的影响。

## 8. npm test

- 完整 `npm test`：**248 项，248 通过，0 失败**（`node --test` 汇总行）。
- 与 `reports/test-output.txt` 里记录的 **221 项基线**对应的 17 个文件：**221 / 221 通过，0 失败**。
- 差值 27 项来自 `opponent.test.js`（本次会话期间由并行工作新增，已被 `package.json` 的 `test` 脚本收录；单独跑是 27/27 通过）。
- 本次改动只写了 `reports/balance-matrix.md` 与 `reports/balance-matrix-notes.md` 两个文件，没有触碰任何代码或测试文件。

## 9. 本次没有修改的文件（自查）

`engine.js`、`app.js`、`content.js`、`coach/*.js`、`index.html`、`style.css`、`server.js`、`package.json`、`scripts/*`、所有 `*.test.js`、`evals/*`、`docs/CHECKLIST.md`、`reports/balance-matrix.json`、`reports/balance-matrix-stdout.txt`、`reports/balance-matrix-run.log`、`reports/test-output.txt`。

只有以下两个文件被写入：

- `reports/balance-matrix.md`（本次交付物）
- `reports/balance-matrix-notes.md`（本文件）

另有一个临时目录 `/var/folders/.../T/dsh-balcheck/`（系统临时区，脚本冒烟跑与旧 JSON 副本放在那里），不在仓库内。

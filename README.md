# 小兽训练场与小芽游戏教练

面向腾讯IEG面试题的本地PVE宠物对战与LLM Coach原型。当前UI v0.10、规则v0.6，12只宠物、5个关卡、3档电脑难度。小芽支持实时规则建议、可选DeepSeek有界工具调用、整局复盘、原位培养建议、条件提醒、变式练习、带证据的提醒习惯。**浏览器语音已暂停使用**（原因见下）。

## 运行

```sh
cd pet-coach-game
npm start
```

需要Node.js 20+，游戏与测试没有第三方npm依赖。访问 http://127.0.0.1:8765/ 。已有8765服务时只刷新页面；不要同时启动两个进程。连接页 http://127.0.0.1:8765/connect.html 加密录入DeepSeek密钥，密钥只在当前进程内存中。重启会清除连接；不配置模型仍能使用规则建议、复盘、培养和小测。

v0.10 的前后端需同时更新。/api/bootstrap 返回 runtimeVersion=0.10 才说明新后端已运行；重新启动后请在连接页录入密钥。复盘、战况问答走模型解释，规则事实由本地引擎提供；小测判题、设置确认、精确规则查询保留确定性处理。

## 验证与实验

```sh
npm test
npm run build:knowledge
npm run eval:retrieval
npm run train:intervention
```

输出在reports和checkpoints。真实模型联调脚本 `node scripts/eval-live-model.js` 使用已有连接发送合成场景，会消耗少量API额度；不读取或打印密钥。

实验分两条：Q-learning学习干预时机；SmolLM2冻结骨干后训练两个工具输出行，实际更新1152个参数。后者是小型二选一实验，不是DeepSeek微调。线上继续使用规则门控和DeepSeek规划。90条本地知识支持词项/语义混合检索，详细指标和局限见docs/EXPERIMENTS.md。

## 交付入口

- output/pdf/xiaoya-coach-report.pdf：实施与实验报告（版本与验收范围见封面）。
- docs/CHECKLIST.md：逐项完成状态和验收证据。
- docs/IMPLEMENTATION-STATUS.md：当前能力、运行版本及限制。
- docs/DEMO-ACCEPTANCE.md：普通游玩、静默、条件提醒、异步和公平性演示。
- docs/EXPERIMENTS.md：完整实验与资源边界。
- docs/INTERVIEW-GUIDE.md：讲述和追问准备。
- docs/EVIDENCE-SCHEMA.md：事件、证据、任务状态及权限约定。

## 保存范围

成长、偏好、会话与当前/最近3场完整对局归档存在本机localStorage。刷新可以复盘，但不会恢复正在进行的对战到可继续操作状态。旧版没有存下来的历史无法补造。最多240条教练事件；清除记忆同时删除教练档案，游戏成长保留。预制体验不写真实进度。

## 实现边界

无联网PVP、账户与云同步。客户端快照不是生产竞技权限边界。一回合搜索不是全局最优；浏览器语音已停用：本机 macOS Chrome 上无论指定哪个 zh-CN 声音都会播成粤语并伴随结尾爆音，触发点是 speechSynthesis.cancel()，代码保留在 VOICE_FEATURE 开关后，查明原因前不对外宣称有语音能力；上下文先保守裁剪，再使用官方DeepSeek tokenizer计数。已实现6选4配招、两种一次性携带物、强化/驱散和后期环境。真人学习收益、完整多步LLM训练、生产权限认证与独立大样本评测尚未完成。

## 可选本地模型依赖

基础游戏只需Node；语义检索、精确token计数和训练需Python环境。当前机器已安装`.venv-agent`，依赖版本在`requirements-agent.lock.txt`。模型首次下载需网络；启动时语义模型预热，未就绪自动退回词项检索。

```sh
node scripts/eval-semantic.js
node scripts/eval-balance.js
.venv-agent/bin/python scripts/train-tool-router.py
```

配招位于培养栏折叠项；不花训练点，下一场生效。8只基础伙伴与4只战术伙伴分组展示，均可直接体验。

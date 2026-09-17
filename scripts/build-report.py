from reportlab.lib.pagesizes import A4
from pathlib import Path
import json
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,PageBreak,KeepTogether
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.graphics.shapes import Drawing,String,Line
from reportlab.graphics.charts.lineplots import LinePlot
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'output/pdf';OUT.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('CN','/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
INK=colors.HexColor('#20342e');GREEN=colors.HexColor('#34785a');LIGHT=colors.HexColor('#eaf3ed');GREY=colors.HexColor('#57645e')
styles={
 'title':ParagraphStyle('title',fontName='CN',fontSize=25,leading=34,textColor=INK,spaceAfter=16),
 'h':ParagraphStyle('h',fontName='CN',fontSize=17,leading=24,textColor=INK,spaceBefore=12,spaceAfter=10),
 'sub':ParagraphStyle('sub',fontName='CN',fontSize=12,leading=19,textColor=GREEN,spaceBefore=9,spaceAfter=5),
 'p':ParagraphStyle('p',fontName='CN',fontSize=10,leading=17,spaceAfter=9,wordWrap='CJK',textColor=INK),
 'small':ParagraphStyle('small',fontName='CN',fontSize=8,leading=12,spaceAfter=5,wordWrap='CJK',textColor=GREY),
 'cell':ParagraphStyle('cell',fontName='CN',fontSize=9,leading=14,wordWrap='CJK',textColor=INK),
}
story=[]
def p(text,kind='p'):story.append(Paragraph(escape(text),styles[kind]))
def table(rows,widths):
 t=Table([[Paragraph(escape(str(c)),styles['cell']) for c in row] for row in rows],colWidths=widths,repeatRows=1,hAlign='LEFT')
 t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),LIGHT),('VALIGN',(0,0),(-1,-1),'TOP'),('BOTTOMPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),9),('LINEBELOW',(0,0),(-1,0),.8,GREEN),('LINEBELOW',(0,1),(-1,-1),.3,colors.HexColor('#d5dfd8'))]))
 story.extend([t,Spacer(1,12)])
def page(title):
 if story:story.append(PageBreak())
 p(title,'h')
def footer(c,doc):
 c.setFont('CN',8);c.setFillColor(GREY);c.drawString(45,27,'小芽 AI Coach  |  实施与实验报告  |  2026年9月17日');c.drawRightString(550,27,str(doc.page))


p('小芽游戏教练','title')
p('腾讯 IEG 面试题 · 实施与实验报告 v0.10','sub')
p('2026.09.17 | 游戏规则 0.6 | 本地可运行 Demo','small')
p('玩家通常不会停下游戏，主动打开聊天框。小芽要解决的是：何时值得提醒、依据从哪来、玩家行动后怎样及时闭嘴，以及一场结束后怎样帮玩家带走一点经验。')
table([['角色','已经接通的体验','明确边界'],['军师','公开状态与合法行动比较；危险对位、补位和犹豫时给短提示；模型按需查证','一回合启发式，不是胜率或全局最优'],['老师','整局统计与关键回合；培养阈值比较；有答案校验的变式题','记录独立行动，不把答对一次叫掌握'],['陪练','接续对话；明确偏好、本命与玩法目标；静默设置优先','不根据停留断言玩家不会玩']],[52,250,185])
p('核心闭环','sub')
p('游戏事件 → 可见状态 → 合法分支与版本化知识 → 是否值得提醒 → 简短解释 → 玩家选择 → 原始回合证据 → 整局回顾与后续练习。聊天是补充入口，正常游玩也能遇到小芽。')
p('如何体验','sub')
p('项目内执行 npm start，打开 http://127.0.0.1:8765/。选择陪伴风格、三只伙伴和难度，开始训练。DeepSeek 可在 connect.html 加密录入；不配置时保留规则建议，并明确显示本地来源。')
p('本报告不把计划当成果。真实调用、模拟训练、自动测试和真人效果分开报告。当前仍有质量评测、语音听感与组合平衡待验。','small')

page('01 让建议跟上游戏，而不是打断游戏')
p('介入方式','sub')
p('默认一行字幕或短浮动提示，不打开聊天、不自动展开长解释。首次选择关键时搭把手、带我练或安静；设置跨刷新保留。培养页把结论和数值变化放前面，比较表按需展开。')
table([['事件','可以做什么','何时不说'],['伙伴倒下','比较存活队友的下一回合分支，给免费补位建议','没有合法目标或旧局面已变'],['不利对位 / 资源紧张','指出一个可行动的风险，再解释代价','玩家已经关注、重复出现或证据不足'],['停留 / 反复关注','作为弱信号，结合局面判断是否给入口','单纯停留不能证明不会玩'],['整局结束','自动总结走向，选一个有依据的选择供回看','安静模式只留展开入口，不自动请求模型']],[90,205,192])
p('熟练之后应该更少提醒','sub')
p('独立行动与提示后的行动分开记录。连续证据可形成降低提示频率的假设，玩家关闭提示也会提高打扰成本。显式静默永远优先，不被模型推断覆盖。')
p('慢模型处理','sub')
p('每项任务绑定局面、对局和规则版本。玩家出招、改目标、改偏好或离开时取消请求；失效队列不再发送，后端断连会取消上游。即使远端没取消成功，旧答案也不得显示。相同请求合并，自动请求短缓存随局面失效。')
p('语音与字幕','sub')
p('语音可选，支持音量、试听、取消和去重；字幕不依赖声音。浏览器 onstart 已验证，但没有把该事件等同于用户扬声器实际可听或听感舒适。')

page('02 Agent 的职责与工具边界')
p('ReAct 在这里怎么工作','sub')
p('玩家问“只能回血吗”，模型可以先 read_state，再根据回执选择 compare_actions 或 search_rules，而不是每次固定调用全部工具。当前最多两次工具规划；非法参数、重复调用、过长回执和预算耗尽都会停止。展示工具与证据，不展示隐藏思考正文。')
table([['工具','宿主程序实际执行'],['read_state','读取公开队伍、资源与合法行动，排除待执行动作和真实随机种子'],['search_rules','按规则版本检索知识卡，返回反例、条件与引用ID'],['compare_actions / simulate_branch','共用游戏结算器，覆盖对手合法行动和两种同速顺序；不偷看未来'],['read_match / read_evidence','整局统计与关键回合分页；按回合读取原始事件；缺失明确返回'],['inspect_training','读取当前培养资源、目标、本命和加点阈值变化']],[175,312])
p('模型不负责的事','sub')
p('伤害、行动合法性、培养扣点、权限限制和过期校验由程序执行。工具都是只读的，模型不能替玩家出招或加点。PVP 赛中前置拒绝战术请求；本机原型仍接受客户端快照，生产必须改用权威对局服务。')
p('为什么要用 LLM','sub')
p('引擎能算数，但理解“我不想一直换宠”“我想稳一点”和自然追问更适合模型。模型负责理解、选择查证路径和解释；规则计算提供可核对的事实。原来大量本地拦截把对话做死，本轮已让复盘和口语求助真正进入模型。')

page('03 RAG：把知识变成可验证的候选依据')
p('知识规模与来源','sub')
p('49张原创本地化战术卡 + 41条从引擎生成的参考，共90条。卡片携带适用版本、来源、反例、requiredEvidence和条件标记。外部宠物对战经验只提供设计思路；本地属性、能量与换宠规则以引擎为准。')
p('本地多语言 MiniLM 生成384维向量，词项检索与语义候选用RRF融合。冷启动或语义服务失败时退回词项；检索成功不代表战术最优，还需行动分支计算。')
table([['方法','命中@3','MRR','负例拒绝'],['词项','11/14','0.667','1/2'],['纯语义','9/14','0.536','2/2'],['混合','11/14','0.750','1/2']],[145,100,100,142])
p('这20条是曾经使用过的开发评测，4条dev、16条test（其中2负例），不是新的独立盲测。混合提高了本样本排序，没有提高命中条数，也尚未证明最终模型答案更好。','small')
p('32K 上下文怎么办','sub')
p('当前状态与硬偏好优先，原始战报留在窗口之外；按任务带入整局摘要、关键回合和相关知识。工具结果分页，完整对象裁剪，不把JSON截断。用户指定旧回合时重新从本机归档装配；本次未带入的记录明确缺失。')
p('服务器使用官方 DeepSeek V4 tokenizer 与chat template计数，32,768窗口中预留320输出和1,024安全余量。长历史测试保留28HP、6能量和回合ID；真实API计数比本地多2–3 token，以API usage为准。')

page('04 两种 RL 实验：学开口，也学工具选择')
p('实验 A：干预时机 Q-learning','sub')
p('状态包括风险、可信度、熟练度、近期打扰和偏好；动作是沉默或短提示。五类模拟用户，三个种子各6000局，每局24步。显式静默与合法性是硬约束，不让学习器修改。')
table([['策略','回报/局','提示/局','增量帮助/局'],['无提示','0','0','0'],['固定规则','-1.113','5.89','1.38'],['未训练','-0.770','4.55','1.16'],['Q-learning','1.116','1.70','0.86']],[145,105,105,132])
p('只按验证集选择seed71；每策略测试500局，完整各种子数据见JSON。RL提示更少、帮助次数也更少，较高奖励来自帮助与打扰的权衡。偏移下回报0.581，不能外推真人收益。训练432000步、验证86400步、测试288000步均保存完整压缩轨迹。','small')
p('实验 B：语言模型工具输出头 REINFORCE','sub')
p('SmolLM2-135M-Instruct冻结骨干，实际训练read_state与search_rules两个输出行，共1152参数。使用采样奖励、batch baseline、KL正则和梯度裁剪。24条训练、8条验证、16条留出题；三个种子各250轮，按验证挑检查点。')
p('未训练8/16；训练后三个种子均15/16；参数L2变化0.9149–0.9744。保存模型检查点和750行训练轨迹。它是英文二选一工具任务，不是完整多步Agent RL，不是DeepSeek微调，也没有接入真人随机探索。')
p('Agentic RL 的直观含义','sub')
p('把工具选择、是否继续查证等Agent行为放进交互轨迹，按任务结果给予奖励并更新策略。这里分别完成了干预策略训练和很小的模型工具决策训练；二者不能互相冒充。')

page('05 从试玩失败到可复现的修复')
table([['暴露的问题','修复','验收边界'],['明明有局面却反问血量','所有角色获得公开状态与最新事件，倒下口语求助进入补位分析','真实DeepSeek补位读取132HP/5豆，无需重报'],['问整局却只说最后一回合','整局归档、关键回合与指定回合工具；结算自动请求模型','15回合败局与连续追问真实调用'],['5豆说成满豆、取消行动说成命中','补能量语义与回合绑定校验','窄校验，不能证明所有自然语言正确'],['代码改了服务没更新','版本状态与运行态核查，明确重启后的密钥状态','真实调用记录标runtimeVersion'],['预制回答淹没模型','保留确定性规则/判题，复盘和战况交模型解释','降级标来源，不冒充模型回答']],[117,192,178])
p('v0.10 真实模型记录','sub')
p('五条生成：补位、败局分析、连续追问、自动总结、天气规则，3134–3722ms；PVP绕过3ms拒绝且无上游调用。天气问题实际使用search_rules后read_state。原始回答和工具轨迹保存在reports/live-model-v10.json。')
p('仍发现名称漂移：把净化药、能量果叫作解药、以太；数字校验未拦住，已补名称约束，需复验。天气回答对速度顺序解释不足。成功状态码不等于质量合格，S04完整独立评测保持未勾。')
p('本轮114项自动测试通过，覆盖规则结算、权限、上下文、取消、缓存、回合证据和新机制。当前usage只记录最终生成，不能冒充含规划调用的完整成本。')

page('06 游戏复杂度服务于教学')
p('12只伙伴、6类元素、每只6选4技能','sub')
p('保留狐的灼烧追击、狮的破防爆发、龟的防御回复、鹿的吸血续航等职责；增加风系清场与慢速强化伙伴。八只基础与四只战术伙伴分组，所有内容可直接试，不靠数值肝度遮住教练价值。')
p('强化与反制','sub')
p('蓄势/护甲每层提高对应攻防15%，最多2层；持续3次在场回合末，主动换宠或倒下清除。破势攻击后驱散，防御可阻挡。两种携带物每局一次，分别提供满血减伤与低能量补给。')
p('后期环境','sub')
p('细雨与山风持续前4回合，对双方生效；清风可移除。环境是小幅修正而非必带钥匙。换宠仍占一个行动，不能再攻击或吃药；强制补位免费，不额外承伤。')
p('检查而非宣称平衡','sub')
p('新增机制测试已验证持续时间、叠加、驱散、携带物一次性、环境移除和旧存档迁移。660场单宠默认配招对照发现风系支援偏弱；该测试不衡量3v3协同，因此完整组合平衡仍未验收。')
p('接下来如何证明教学有效','sub')
p('先看没有直接提示的独立选择，再换宠物、关卡或资源条件测试迁移。系统已有跨局、多情境的证据标记，但它只叫迁移迹象；真人学习结论需要受控试玩与保留组，不能用胜率或采纳率替代。')

page('07 交付索引、复现与仍待验证的内容')
table([['入口','用途'],['README.md / npm start','启动、模型连接与无密钥降级'],['docs/CHECKLIST.md','保留原任务，每项按证据勾选'],['docs/EXPERIMENTS.md','样本、指标、边界与复现命令'],['reports/live-model-v10.json','真实模型回答、时延、工具与token计数'],['reports/semantic-retrieval.json','词项、语义、混合检索逐题结果'],['reports/intervention.json','三种子策略训练、验证与测试'],['reports/tool-router-rl.json','1152参数工具决策RL结果'],['mechanics.test.js / npm test','机制及全链自动回归']],[220,267])
p('尚未完成的验收','sub')
p('真人语音听感、长局打扰、无提示学习迁移；完整慢模型浏览器演示；独立大样本模型质量与RAG消融；完整3v3配装平衡；生产权威状态认证。保留在清单中，不因三天工期把它们改名为已完成。')
p('公开技术来源','sub')
p('DeepSeek tokenizer与模板：api-docs.deepseek.com/quick_start/token_usage/','small')
p('多语言嵌入：huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2','small')
p('小模型：huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct；revision 12fd25f77366fa6b3b4b768ec3050bf629380bac','small')
p('竞品与领域来源见 docs/LINGBAO-RESEARCH.md、docs/sources/。官方资料、转载与设计推断分开记录。','small')
p('面试可重点演示：不打开聊天也有帮助；模型能依据工具回执接住追问；出招之后旧建议消失；实验失败与局限都有原始记录。')
SimpleDocTemplate(str(OUT/'xiaoya-coach-report.pdf'),pagesize=A4,rightMargin=45,leftMargin=45,topMargin=42,bottomMargin=42,title='小芽游戏教练 v0.10 实施与实验报告',author='小芽项目').build(story,onFirstPage=footer,onLaterPages=footer)
print(OUT/'xiaoya-coach-report.pdf')

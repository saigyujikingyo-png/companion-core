# 研究综述：2026 年哪些神经科学／心灵哲学理论已被代码化并对本项目有用（评审者整理，2026-10-30）

本文由评审者在 2026-10-30 检索整理，对象是本项目六个"研究题"（情感场、显著性、睡眠微调不退化、元记忆、人格漂移、工作空间与主动推断）。每条分"有来源支撑的事实"与"评审者判断／想法"。所有结论以后续实测为准；文中建议不授予任何训练、合并或部署许可。

2026-10-31 定向订正核对了 Sleep v2 与 ContextEcho v3，修正下述效率、锚定与 KL 外推；其余文献保留原评审的核查范围，不视为本项目的实测或验收。固定睡眠加工仍遵循[既有规则](SLEEP-CONSOLIDATION.md)及当前来源、用途、保留、撤销与 `learningAllowed`，本文的候选配方不直接成为运行配置。

**总判断：** 情感调制、惊讶与效用记忆门、睡眠式巩固、表达方式锚定可作为本项目的对照实验候选；论文任务上的结果不能直接证明陪伴质量、人格稳定或目标硬件可行性。主动推断与全局工作空间仍是可借鉴的理论，不是已经验收的组件。

## 一、按研究题对照

### 1. 情感场：喂什么、调什么、值不值

**事实**

- **Auri / CTEM**（Qin 等，arXiv 2605.15812，中国传媒大学 + 中国电信 + MSRA）：情绪状态（体力、效价、唤醒）+ 12 维动机向量 + 行为库（生理／工作／休闲／社交／情绪）+ 主动发起 + 夜间休息与每日记忆更新。96 名 18–26 岁学生、21 天在野研究、混合方法（CLMM／GEE／访谈，κ=0.82）。主研究 N=54 四组消融：去掉情绪模块或行为模块，"人格连贯"评分显著下降；子研究 N=42：完整系统比"只有事实记忆、无情感与行为建模"的基线在情感体验上 3.24→3.67（p=.004）。对照组最大的抱怨是"连续性断裂"。作者自述：因果归因谨慎、时长短、人群窄；代码"未来发布"。
- **Gubernaut**（Sharma，arXiv 2607.24339，2026-07-27）：确定性稳态控制器包在 LLM 外；元层只读三个数（强度、效价、重复率），不看文本；输出"姿态"= 调节指令 + 采样温度上界；无学习参数、无采样。4 生成器 × 4 裁判，16 格中 13 格显著更冷静（p<.05）。局限：控制器闭源，全部 LLM 评判，静态提示消融未做，未测有用性与一致性。
- "Mood Modulates, It Doesn't Gate"（aiXiv 2026-08，AI 作者社区，无代码）：情感与任务状态正交、只在表达层合成；仅有可达性论证，无行为实验。

**判断**：保留"只调制不门控"；元层做成确定性代码；评测直接采用 CTEM 的四组消融设计。连续性是本项目最强处，而 CTEM 的证据说它正是用户最在意的维度。

### 2. 显著性："什么值得记住"

**事实**

- **D-MEM**（Song & Xin，arXiv 2603.14597，2026-03-15；代码 github.com/london-and-tequila/dmem）：RPE = 效用 × (惊讶 + β)，硬效用阈值 τ。惊讶 = 与现有记忆嵌入的余弦距离，对滑动窗口做 z 分数再 sigmoid；效用 = 一次极小的 LLM 调用标 Transient／Short-Term／Persistent。三级路由：SKIP（零成本）、CONSTRUCT_ONLY（O(1) 缓冲）、FULL_EVOLUTION（O(N) 图重构）；影子缓冲存被跳过的原始回合。LoCoMo-Noise（ρ=0.75）比 A-MEM 少用 80.5% token。阈值未公开；外部验证少。
- **Worth Remembering**（Gorlo、Wise、Speranzon、Carlone，MIT，arXiv 2606.03787，2026-06）：贝叶斯惊讶在 V-JEPA-2 潜空间（D=1024）用窗口 W=64 的对角高斯与 ℓ1 代理计算；动态阈值 τ = med + γ·MAD／Φ⁻¹(0.75)，γ=1；峰值过 NMS。只存约 1.7% 的帧；OC-NaVQA 准确率比空间记忆基线高约 12%，"where"误差降 12.4%、"when"降 15.7%；无监督在线事件分割胜过有监督方法。代码未见。
- "从后续使用反推显著性"的在线方法：未找到已发表结果；D-MEM 作者与一个独立复现仓库（enspyrco/memory-consolidation-experiment）均只列假设、未发数据。

**判断**：睡眠规则 v1 可直接采用"D-MEM 门 + Carlone 式动态阈值切事件边界"；嵌入用 TA 自己的底座算，效用判断用 off 档短调用。"被用到的记忆加权"留作本项目自己的实验——本项目有回执账本，比他们更有条件做。

### 3. 睡眠微调而不退化

**事实**

- **Sleep 框架**（Behrouz、Hashemi、Javanmard、Mirrokni，Google Research，[arXiv 2606.03979v2](https://arxiv.org/html/2606.03979v2)，2026-07-10）：以扩容、知识巩固及合成经验研究持续学习。附录 [B.5 Efficiency](https://arxiv.org/html/2606.03979v2#A2.SS5) 已报告相对效率：相同步数时 SFT 的效率约为 Sleep 的 4 倍；达到相同基准性能时，SFT 在 AIME-24／25、HMMT-25 分别需要 4.3／3.6／4.8 倍墙钟时间。该节没有给出这些比较的绝对用时或硬件成本分解，不能据此估算本项目预算。持续学习实验也不等于人格稳定、NVFP4-LoRA 适配、Spark 原生可行性或本项目更新／激活门已获验证。
- **"Contextual Agentic Memory is a Memo, Not True Memory"**（Xu、Dai、Zhang，arXiv 2604.27707，v2 2026-08）：以互补学习系统论证检索式记忆只有"海马"一半，不进权重就没有组合泛化；未巩固的记忆会把投毒无限传下去。纯理论，无实验。
- **2026 持续学习综述**（arXiv 2603.12658）：LoRA 路线证据最多的是 O-LoRA（正交子空间）、MixLoRA（LoRA 专家 + 路由）、SAPT、带回放的指令微调；**没有研究直接测人格／行为漂移**；指标为平均性能、遗忘率、前向／后向迁移。

**判断**：见第二节想法 1。

### 4. 元记忆："记不清"与"确定"

**事实**

- **ESMA**（Park、Meyerson、Qiu、Miikkulainen，arXiv 2602.02605，v2 2026-05-24；代码 github.com/cosmoquester/ESMA）：用进化策略（非梯度）训练模型回答"你知道这个答案吗"；奖励 正确+Yes=2、正确+No=1、错误+No=1、错误+Yes=0，消除"故意答错再说不知道"的激励。Qwen2.5 1.5B／3B／7B、Gemma3 4B、Llama3.2 3B 的元认知 d′ 从 0.04–0.64 升到 0.89–1.02，与 GPT 5.2（0.94）、Claude Sonnet 4.5（0.95）相当；直接准确率多数提升；80% 收益集中在 10% 权重变化；FictionalQA 上有迁移但较弱。作者自述"仍远低于人类"。
- **元认知综述**（arXiv 2607.11881，2026-07）：GPT 系模型基本预测不了自己未来的记忆表现（Huff & Ulakçı）；推荐 meta-d′／M-ratio 评测（AUROC 与 M-ratio 可给出完全相反的排名）；RLHF 可能损害 STEM 任务上的元认知效率；开放式生成的元认知评测"仍未探索"。

**判断**："知道自己不知道"可作为出厂前能力池的研究候选；适配器适用性仍须验证。上线后来源覆盖度只描述可核查程度，不是事实正确率：原件可能错误、过时或冲突，摘要也不能仅凭形式判真假。应分别记录来源可用性、证据质量与经校准的回答置信度，再比较 meta-d′／M-ratio 等评测。

### 5. 人格漂移

**事实**

- **ContextEcho**（Ding 等，[arXiv 2605.24279v3](https://arxiv.org/html/2605.24279v3)，2026-10-29）：用快照后探针研究长编码会话中的可观测表达变化。§3.2 与附录 F/G/J 支持将单次 A-anchor 作为语域干预候选，不证明潜在人格被修复。附录 F 未显示每 30 条消息重复插入的频率优势，同指令 sandwich re-assertion 达到相近的探针评分上限；后者第二次插入紧邻探针，比较并非完全对称。附录 J 的非 bash 格式任务中，A-anchor 未优于结构匹配的非人格 placebo。证据受模型、任务与观察窗口限制，不支持“每周期锚定是唯一确定有效的方法”或“零风险”。

**判断**：可将快照后探针作为 `PERSONA_CONSISTENCY` 的候选测量方式，比较无锚、单次锚与必要的重复提醒；是否使用及频率由本项目对照决定。提示干预无需更新权重，但仍有推理／上下文成本与行为副作用。不得照搬论文的助手身份脚本覆盖 [D2](../TARGET-DECISIONS.md#d2student-v1-的质量优先级) 已确认的私人表达裁量。

### 6. 工作空间与主动推断：理论资产，不是组件

**事实**

- **CTM-AI**（Yu、Zhao、L. Blum、M. Blum、Liang，arXiv 2605.04097，2026-04-30，NeurIPS 2026 海报）：处理器是现成基础模型与 API；SOTA 在 MUStARD（72.28）与 UR-FUNNY（72.13）两个多模态理解基准，StableToolBench 与 WebArena-Lite 提升 10+ 分。不是"推理基准 SOTA"；作者自称 early blueprint。
- **"Theater of Mind" / Global Workspace Agents**（Shang，arXiv 2604.08206，代码 github.com/giansha/Global-Workspace-Agents）：认知 tick 四阶段、Generator／Critic／Meta／Response 代理；**无任何实验**；一个可借的点子：用近期思想的语义熵调 Generator 温度。
- **gwt-context**（github.com/netsky-lab/gwt-context）：有界工作空间的 MCP 运行时；作者的"诚实报告"：只在受控选择任务上有窄收益，不宣称完整 GWT。
- 主动推断：**"Curiosity is Knowledge"**（Li、Parashar、Zhou、Fan，arXiv 2602.06029）给了 EFE 智能体第一个后验一致性与无悔保证；**Furutanpey & Dustdar**（arXiv 2607.16858）用无模型 EFE 估计做内在奖励；均非 LLM。Active Inference Institute 2026-05 通讯：LLM 相关项目（Anima）为提案；pymdp／RxInfer 无面向 LLM 的新版本。

**判断**：不用 pymdp 替换情感场；只借两个概念——EFE 的认知价值作为"下一步选择"里 RECALL／THINK／ASK 的一项打分；恐惧／休息／探索写成对"预期身体状态"的预测误差，而不是六个独立变量。工作空间的价值在可审计的选择与广播，不在智力。

## 二、评审者的想法（未经任何人验证）

1. **更新前模型作为参考的候选实验。** 可研究冻结底座、适配器更新与参考模型 KL 正则；这不等于 Sleep 已验证本机 NVFP4-LoRA 路线，也不预设每晚训练。KL 必须绑定参考模型、输入分布、方向、聚合方式与阈值，只是所测输出分布的约束；逐晚 KL 相加不是人格距离，也不保证长程行为或分布外稳定。人格与能力仍需独立回归、shadow 评估及当前有效产物的回退条件，不能以 KL 达标替代激活门。
2. **睡眠规则 v1 的候选配方。** 仅在当前采集、保存与用途许可内记录经历；D-MEM 分级门与动态事件边界可作整理实验。"世界的回应"权重 ×2、自身输出 ×0.5 只是未验证超参数；进入候选仍须独立满足训练许可和来源门，整理等级不签发训练资格。规则采用冻结版本与 digest，不给某次睡眠临时指定目标。
3. **情感场改成"身体预算"。** 一个标量预算（allostasis）+ 两个预测误差：内感受（温度／负荷／余量 vs 设定点）与社交（期待的回应 vs 实际回应）；输出五个调制参数；元层是 Gubernaut 式确定性代码。六变量松弛保留为基线对照。
4. **锚定消融 + 快照探针。** 比较不同提醒方式和频率的效果、成本与副作用；ContextEcho 的有限实验不确定本项目的最佳频率或唯一方法。工期和效果均待验证，不称为已实现的人格稳定器。
5. **用回执账本做"被用到的记忆"实验。** 给每条记忆记"被召回次数、被引用进陈述的次数、对应行动的结果"，几个月后用它重新校准显著性门。这将是本项目第一个别人做不了的研究结果。
6. **评测照抄 CTEM。** 四组消融（完整、无情感、无行为库、无记忆连续）、三周、用户本人加几位朋友盲评、累积链接混合模型；样本小也行，关键是预注册。
7. **警告。** 模型自评与自生成数据可能自我强化；提高外部反馈权重只是待测对照，不能称为独有解药。执行回执证明相应技术事件，不自动证明反馈内容真实、学习目标正确或人格稳定。

## 三、可直接用的开源件

| 组件 | 用途 | 许可／状态 |
| --- | --- | --- |
| D-MEM（github.com/london-and-tequila/dmem） | 记忆门与三级路由 | 有代码，v1；阈值 τ／β／θ 未公开 |
| ESMA（github.com/cosmoquester/ESMA） | "知道自己知道"训练 | 有代码与脚本 |
| ContextEcho | 表达变化探针与提示干预对照 | v3 的有限实验；不构成人格稳定保证或本项目实施批准 |
| gwt-context（github.com/netsky-lab/gwt-context） | 有界工作空间 MCP 运行时 | 可用；作者自述收益窄 |
| Global-Workspace-Agents（github.com/giansha） | 认知 tick 循环参考实现 | 无实验 |
| Gubernaut（github.com/thegubernaut/Gubernaut_Validation） | 确定性情绪控制器 | 控制器闭源，仅验证数据与脚本 |
| Sleep（Google） | 睡眠式巩固配方 | 无代码，需自实现 |
| CTEM / Auri | 情感＋行为库＋消融方法 | 代码"未来发布" |
| pymdp / RxInfer.jl | 主动推断 | 成熟；只适合小离散状态空间 |

## 四、建议的实验顺序

建议先比较锚定／不锚定与快照探针，再分别评估合法来源上的整理规则、身体预算调制与基线，最后研究带参考模型约束的适配器更新。此顺序只是研究建议；数据积累、在野评测及真实更新各有独立许可与验收，不承诺工期、零风险或人格稳定。旧作业保持暂停，本次不执行这些实验或启动训练。

## 来源

- Auri / CTEM：https://arxiv.org/pdf/2605.15812
- Gubernaut：https://arxiv.org/html/2607.24339v1
- Mood Modulates, It Doesn't Gate：https://aixiv.science/abs/aixiv.260811.000002
- D-MEM：https://www.alphaxiv.org/abs/2603.14597
- Worth Remembering：https://arxiv.org/abs/2606.03787 ；https://www.alphaxiv.org/overview/2606.03787
- Sleep 框架：https://research.google/blog/the-sleep-framework-a-new-way-for-llms-to-retain-knowledge-in-continual-learning/ ；https://arxiv.org/pdf/2606.03979v2
- Memo, Not True Memory：https://arxiv.org/abs/2604.27707
- 持续学习综述（2026）：https://arxiv.org/html/2603.12658v1
- ESMA：https://arxiv.org/html/2602.02605
- 元认知综述（2026）：https://arxiv.org/html/2607.11881v1
- ContextEcho v3：[正文与附录](https://arxiv.org/html/2605.24279v3)、[F 持续性与对照](https://arxiv.org/html/2605.24279v3#A6)、[G 配方消融](https://arxiv.org/html/2605.24279v3#A7)、[J 非 bash 格式任务](https://arxiv.org/html/2605.24279v3#A10)
- CTM-AI：https://arxiv.org/abs/2605.04097 ；Theater of Mind：https://arxiv.org/html/2604.08206 ；gwt-context 诚实报告：https://netsky-lab.github.io/gwt-context/honest-gwt-report.html
- Curiosity is Knowledge：https://arxiv.org/abs/2602.06029 ；Model-free epistemic free-energy：https://arxiv.org/abs/2607.16858 ；Active Inference Institute 2026-05 通讯：https://activeinferenceinstitute.substack.com/p/may-2026-newsletter-active-inference
- memory-consolidation-experiment（惊讶 vs 效用消融，未发结果）：https://github.com/enspyrco/memory-consolidation-experiment

# 研究综述：2026 年哪些神经科学／心灵哲学理论已被代码化并对本项目有用（评审者整理，2026-10-30）

本文由评审者在 2026-10-30 检索整理，对象是本项目六个"研究题"（情感场、显著性、睡眠微调不退化、元记忆、人格漂移、工作空间与主动推断）。每条分"有来源支撑的事实"与"评审者判断／想法"。所有结论以后续实测为准；文中建议不授予任何训练、合并或部署许可。

**一句话总判断：** 2026 年有实证、可直接对应本项目研究题的是四样——情感作为调制（有 96 人、21 天的消融实验）、惊讶×效用的记忆门（有代码）、"新专家 + 以更新前模型为教师"的睡眠式巩固（Google，2026-10-27）、人格锚（23 个前沿模型都漂移，单次锚定可恢复）。主动推断与全局工作空间仍是理论资产，不是组件。

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

- **Sleep 框架**（Behrouz、Hashemi、Javanmard、Mirrokni，Google Research，arXiv 2606.03979，博客 2026-10-27）：清醒期经验存于快记忆；睡眠期"计算—巩固—更新"：计算底座更新但不施加；以**更新前的模型为教师**，把知识蒸馏进**新开的低秩专家**（A: d×d_low，B: d_low×d）；施加更新并重置高频临时参数（"突触修剪"）；"做梦"：随机激活非常规专家生成合成样本，按梯度重要性筛 top-k 加随机样本，二值改进奖励过滤。Qwen3-8B：AIME-24／25、HMMT-25 为 79.2／69.0／46.1，SFT 为 75.5／66.4／43.7；Qwen3-1.7B 上 SFT 在两项退化而 Sleep 提升；SQuAD 持续预训练 46.2 vs SEAL 43.2；在 Llama-3.2-1B、Llama-3B／8B 等标准 Transformer 上也有实验。**没有遗忘指标、没有代码、没有接受更新的门、没有算力成本**；作者自述"迭代自我改进在持续学习里的风险是一个关键考量"。
- **"Contextual Agentic Memory is a Memo, Not True Memory"**（Xu、Dai、Zhang，arXiv 2604.27707，v2 2026-08）：以互补学习系统论证检索式记忆只有"海马"一半，不进权重就没有组合泛化；未巩固的记忆会把投毒无限传下去。纯理论，无实验。
- **2026 持续学习综述**（arXiv 2603.12658）：LoRA 路线证据最多的是 O-LoRA（正交子空间）、MixLoRA（LoRA 专家 + 路由）、SAPT、带回放的指令微调；**没有研究直接测人格／行为漂移**；指标为平均性能、遗忘率、前向／后向迁移。

**判断**：见第二节想法 1。

### 4. 元记忆："记不清"与"确定"

**事实**

- **ESMA**（Park、Meyerson、Qiu、Miikkulainen，arXiv 2602.02605，v2 2026-05-24；代码 github.com/cosmoquester/ESMA）：用进化策略（非梯度）训练模型回答"你知道这个答案吗"；奖励 正确+Yes=2、正确+No=1、错误+No=1、错误+Yes=0，消除"故意答错再说不知道"的激励。Qwen2.5 1.5B／3B／7B、Gemma3 4B、Llama3.2 3B 的元认知 d′ 从 0.04–0.64 升到 0.89–1.02，与 GPT 5.2（0.94）、Claude Sonnet 4.5（0.95）相当；直接准确率多数提升；80% 收益集中在 10% 权重变化；FictionalQA 上有迁移但较弱。作者自述"仍远低于人类"。
- **元认知综述**（arXiv 2607.11881，2026-07）：GPT 系模型基本预测不了自己未来的记忆表现（Huff & Ulakçı）；推荐 meta-d′／M-ratio 评测（AUROC 与 M-ratio 可给出完全相反的排名）；RLHF 可能损害 STEM 任务上的元认知效率；开放式生成的元认知评测"仍未探索"。

**判断**："知道自己不知道"作为出厂前的一个能力池（ESMA 对适配器同样适用，ES 不需要梯度）；上线后用来源覆盖度当代理（有原件可查＝确定，只有摘要＝模糊）；评测用 meta-d′／M-ratio。

### 5. 人格漂移

**事实**

- **ContextEcho**（Ding 等，arXiv 2605.24279，v2 2026-08-27）：三段 3,746–9,716 轮的真实 Claude Code 会话，25 个身份探针，"快照后探针"协议（分叉会话状态不打扰主会话）。**23 个前沿模型全部漂移**（如从"我没有偏好"变为断言偏好），跨厂商；上下文压缩不能可靠重置；**单次锚定**能恢复训练时的语域；漂移对工具续写有帮助，对无工具聊天破坏格式并膨胀长度。框架声称开源，仓库地址需查全文。

**判断**：身份合同不只放会话开头，每个认知周期末尾重新锚一次；"快照后探针"直接做成 `PERSONA_CONSISTENCY` 探针。零训练成本。

### 6. 工作空间与主动推断：理论资产，不是组件

**事实**

- **CTM-AI**（Yu、Zhao、L. Blum、M. Blum、Liang，arXiv 2605.04097，2026-04-30，NeurIPS 2026 海报）：处理器是现成基础模型与 API；SOTA 在 MUStARD（72.28）与 UR-FUNNY（72.13）两个多模态理解基准，StableToolBench 与 WebArena-Lite 提升 10+ 分。不是"推理基准 SOTA"；作者自称 early blueprint。
- **"Theater of Mind" / Global Workspace Agents**（Shang，arXiv 2604.08206，代码 github.com/giansha/Global-Workspace-Agents）：认知 tick 四阶段、Generator／Critic／Meta／Response 代理；**无任何实验**；一个可借的点子：用近期思想的语义熵调 Generator 温度。
- **gwt-context**（github.com/netsky-lab/gwt-context）：有界工作空间的 MCP 运行时；作者的"诚实报告"：只在受控选择任务上有窄收益，不宣称完整 GWT。
- 主动推断：**"Curiosity is Knowledge"**（Li、Parashar、Zhou、Fan，arXiv 2602.06029）给了 EFE 智能体第一个后验一致性与无悔保证；**Furutanpey & Dustdar**（arXiv 2607.16858）用无模型 EFE 估计做内在奖励；均非 LLM。Active Inference Institute 2026-05 通讯：LLM 相关项目（Anima）为提案；pymdp／RxInfer 无面向 LLM 的新版本。

**判断**：不用 pymdp 替换情感场；只借两个概念——EFE 的认知价值作为"下一步选择"里 RECALL／THINK／ASK 的一项打分；恐惧／休息／探索写成对"预期身体状态"的预测误差，而不是六个独立变量。工作空间的价值在可审计的选择与广播，不在智力。

## 二、评审者的想法（未经任何人验证）

1. **昨天的 TA 是今天的教师。** Sleep 框架的巩固步骤——以更新前模型为教师、知识进新的低秩专家——与本机 NVFP4-LoRA 路线天然契合：底座永远冻结，每晚只新增或更新适配器，并用前一天的模型做 KL 正则。这给人格漂移一个可度量的预算：每晚 KL ≤ ε，累计超过即触发回退。漂移从"事后发现"变成"事前限额"。
2. **睡眠规则 v1 的具体配方。** 白天：所有经历进影子缓冲（被动记录）。入睡：D-MEM 的 RPE 门分三级；Carlone 式动态阈值切事件边界；"世界的回应"（回执、人的回复）权重 ×2，TA 自己的输出 ×0.5；只有全图演化级的事件进训练候选；再做 CTEM 式 rest 更新状态。整套规则一个版本号、一个 digest。
3. **情感场改成"身体预算"。** 一个标量预算（allostasis）+ 两个预测误差：内感受（温度／负荷／余量 vs 设定点）与社交（期待的回应 vs 实际回应）；输出五个调制参数；元层是 Gubernaut 式确定性代码。六变量松弛保留为基线对照。
4. **每周期锚 + 快照探针。** 零训练成本的人格稳定器，两周可完成；ContextEcho 的证据说它是目前唯一确定有效的手段。
5. **用回执账本做"被用到的记忆"实验。** 给每条记忆记"被召回次数、被引用进陈述的次数、对应行动的结果"，几个月后用它重新校准显著性门。这将是本项目第一个别人做不了的研究结果。
6. **评测照抄 CTEM。** 四组消融（完整、无情感、无行为库、无记忆连续）、三周、用户本人加几位朋友盲评、累积链接混合模型；样本小也行，关键是预注册。
7. **警告。** Sleep 与 D-MEM 都依赖模型自评与自生成数据，自我强化风险真实，Sleep 作者自己也承认。"世界回应优先"是本项目独有的解药，因为只有本项目有真实回执。

## 三、可直接用的开源件

| 组件 | 用途 | 许可／状态 |
| --- | --- | --- |
| D-MEM（github.com/london-and-tequila/dmem） | 记忆门与三级路由 | 有代码，v1；阈值 τ／β／θ 未公开 |
| ESMA（github.com/cosmoquester/ESMA） | "知道自己知道"训练 | 有代码与脚本 |
| ContextEcho | 人格漂移探针框架 | 声称开源；仓库地址需从论文全文确认 |
| gwt-context（github.com/netsky-lab/gwt-context） | 有界工作空间 MCP 运行时 | 可用；作者自述收益窄 |
| Global-Workspace-Agents（github.com/giansha） | 认知 tick 循环参考实现 | 无实验 |
| Gubernaut（github.com/thegubernaut/Gubernaut_Validation） | 确定性情绪控制器 | 控制器闭源，仅验证数据与脚本 |
| Sleep（Google） | 睡眠式巩固配方 | 无代码，需自实现 |
| CTEM / Auri | 情感＋行为库＋消融方法 | 代码"未来发布" |
| pymdp / RxInfer.jl | 主动推断 | 成熟；只适合小离散状态空间 |

## 四、建议的实验顺序

每周期锚 + 快照探针（两周，零风险）→ D-MEM 门做睡眠规则 v1，只整理不训练（一个月）→ 身体预算版情感场 vs 六变量基线的消融（三周在野）→ "被用到的记忆"数据积累（持续）→ 以昨天为教师的 KL 预算 LoRA（最后，shadow 数周）。

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
- ContextEcho：https://arxiv.org/abs/2605.24279
- CTM-AI：https://arxiv.org/abs/2605.04097 ；Theater of Mind：https://arxiv.org/html/2604.08206 ；gwt-context 诚实报告：https://netsky-lab.github.io/gwt-context/honest-gwt-report.html
- Curiosity is Knowledge：https://arxiv.org/abs/2602.06029 ；Model-free epistemic free-energy：https://arxiv.org/abs/2607.16858 ；Active Inference Institute 2026-05 通讯：https://activeinferenceinstitute.substack.com/p/may-2026-newsletter-active-inference
- memory-consolidation-experiment（惊讶 vs 效用消融，未发结果）：https://github.com/enspyrco/memory-consolidation-experiment

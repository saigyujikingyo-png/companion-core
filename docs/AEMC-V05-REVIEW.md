# AEMC v0.5 研究评审与接入路线

状态：**DESIGN_ONLY / EXPERIMENT_NOT_RUN**。日期：2026-10-26。
这是对用户 AEMC v0.5 RDD 的评审补充，不是原稿全文；未修改用户原稿，未实现或运行本页新算法。
L1.a 已实现的是[声明 lint 与候选 manifest](LEARNING-DESIGN.md#l1a-已实现的窄接口)，不能据此宣布 AEMC、完整学习或记忆质量通过。
本页由 Root/max 研究评审确定边界，Sol 整理；来源访问、元数据/摘要/README 核对均不等于实验复现。

[v0.6 对象中心表征补充](AEMC-V06-REPRESENTATION.md)基于用户本轮粘贴增量，未取得所述完整稿；分离稳定概念registry与可替换latent/原型残差，建议后续SP0独立slice。它不修改本页既有研究记录，也不将ScenePacket或SP1/SP2写成已实现/已实验。

**后续实现注记（2026-10-26）：** [AR0 有界当前召回与同版 RAM 投影](AR0-RETRIEVAL.md)已通过作者139/139、独立最终6/6与本机一次whole413/413；原12项L1差量仅保留TOOL_OUTPUT_ONLY历史证据、未重跑，不将各层相加。CI以发布后对应提交的Actions为准，当前不预报通过。它补齐下面Snapshot缺口中的当前memory-only读取与局部投影重建，不提供原文核验、历史召回或持久fanout；本页算法研究与AR1仍为DESIGN_ONLY / EXPERIMENT_NOT_RUN。

## 1. 采纳的方向

四域分工值得保留：Evidence 保留精选原件，Trace 组织经历痕迹，Schema 表达可泛化结构，Reconstruction 生成带来源的重建。
精选保存应由权限、任务价值、风险与成本决定；不默认记录所有传感器内容、对话或查询答案。
召回可以按需从 gist 进入 anchored，再向独立原件核验；不能把三个名称当成已经实现的质量等级。
个人身份、易变事实、纠正与撤销继续由外部权威存储管理；参数学习主要研究可泛化技能，不能替代事实更新。
云 API 与本地模型共用同一来源/权限底座；GPT-OSS 120B 仅为候选 provider profile，不绑定核心，也未在本轮下载或运行。
果蝇回路、GRU、SSM 都是未来同预算对照候选；生物结构不自动提供效果、低功耗或主观体验证据。
研究目标是可靠检索、来源可核与可测压缩，不是人为制造记忆错误来模拟人类。

## 2. 与当前源码对接

下表只描述现有接口与明确缺口；源码入口为 [Store](../src/store.ts) 和 [curation service](../src/curation.ts)。

| RDD 概念 | 当前实际能力 | 接入前缺口 |
|---|---|---|
| Evidence | event revision 与 `Evidence.selectedText` 保留精选文字 | 没有通用多模态采集/原件层 |
| Trace | derived memory 带来源依赖与 revision | 不能把派生 statement 当作原始事件真值 |
| Schema / Reconstruction | 本批未实现 | 知识结构、泛化、重建标注和独立核验需另立合同 |
| B1 混合检索 | 当前 search 是 FTS phrase/substring 与时间排序 | 不等于已实现 BM25 + vector；需真实 embedding 与融合策略 |
| Graph | dependencies 是用于撤销传播的无环 DAG | 语义关联允许有环，须另作可重建 projection，不能改成同一张图 |
| Snapshot | `curationSnapshot` 检查学习许可及当前有效来源 | 普通/历史召回须独立有界 `RetrievalSnapshot`，不能复用学习入口 |
| Outbox | 全局 pending/acked，没有 consumer ID | graph/vector 双消费者前先有可靠 fanout 或每消费者 cursor |
| 数据库 | SQLite 仍是权威数据与事务边界 | Postgres 等须按规模、恢复与运维实测再决策 |
| 时间 | occurredAt、recordedAt、validFrom/validTo 已有用途 | 不等于完整双时态历史；事实适用期与保留/访问到期须分别定义 |

普通召回能否使用历史证据，不能由 curation 的 learningAllowed 代答；两种读取用途和授权都要显式。
projection、索引和 Schema 可重建；来源修订/删除须能使它们失效，权威正文不能只剩图节点或向量。
在 fanout 完成前，让两个消费者竞争同一个全局 ACK 会丢失投影工作；不得把当前 outbox 当作广播接口。
数据库迁移必须证明来源/撤销/恢复等价，不能因图算法或论文选型就先迁走 SQLite。

## 3. 数学与语义修订

### 3.1 特征与率失真

RDD §3.2 保留 `u` 表示任务价值/风险，另用 `nu = -log p` 表示惊奇，避免一符多义。
每个特征须固定来源、单位、范围、归一化与缺失处理；归一化参数只在 dev 冻结，不能看 holdout 后重定标。

| 特征 | 建议单位/约束 | 解释边界 |
|---|---|---|
| `u` | 预先定义的无量纲价值/风险标度 | 价值与错误代价的权重由任务定义，不冒充事实概率 |
| `nu` | 自然对数下为 nats；`p` 来自指定预测模型 | 噪声和异常也会惊奇，惊奇不是可靠性 |
| 时间/衰减 | 秒与固定时间常数 | 事件发生、入库、事实适用、访问到期分开 |
| 存储/计算成本 | bytes、tokens、耗时与峰值 RAM 分列 | 包含 metadata、索引和冷原件副本，不只计算 gist 正文 |

率失真目标先定义任务失真、预算及可观测成本；连续近似中的 KKT 条件仅在连续、凸、可微且内点等假设下成立。
离散选条、硬权限、非凸压缩器或 top-k 不能直接继承该结论；近似方法与可行性须各自检验。
同根的重复摘要、反复激活或多路径传播不是独立证据，不能反复累积可靠性或奖励。

### 3.2 PPR 与随机重启的可比较条件

先按 query scope 鉴权过滤节点、边与派生统计，再计算权重和归一化；不能让不可见节点的度数影响可见排名。
协议须明确非负权重、边方向、row normalization、初值、restart 分布、dangling 行处理及平分排序。
以下用非负 row-stochastic `P`、列向量 `p_t`，候选初值 `p_0=s_q`；`s_q/q` 归一化，`rho∈(0,1]`、`epsilon_t∈[0,1]`。
所有 B2/B3 分支的 dangling 行都回填同一冻结、确定性的 `s_q`（或另行明确的固定公共分布）。
不得用 B3 当次随机样本重写 dangling 行，否则 `P` 已随样本变动，下面的固定 `P` 对照前提失效。
AR1 冻结 `P`、`p_0`、proposal `q` 与 `epsilon_t` schedule；仅 empirical seed 随公开随机 seed 变化。

在固定 `P`、固定 query proposal `q` 的线性更新下：

```text
E[p_(t+1)] = (1-rho) P^T E[p_t]
             + rho [(1-epsilon_t) s_q + epsilon_t q]
```

因此必须有 B3-mean：用同一个 `q` 的确定性均值替代采样，区分改变分布的收益与随机性的收益。
该等式不自动证明有限 top-k 排名相同；非线性截断、自适应采样或未来自适应 `P/q` 应另立实验。
只运行 `T=10` 且未检查残差时称“有限步传播”，不能称算法已收敛。
邻接与 seed 的缺失/无效状态必须有明确拒绝或回退规则，不能默默把越权节点变成 restart 支持。

### 3.3 Epistemic 字段

将 origin、verification、missingness 分开，unknown 独立保留，不用单一“置信度”吞掉它们。
`verified` 必须绑定具体独立证据或可复核程序；同根的重写、模型自述和一致措辞不是独立核验。
entropy、图分数、LLM 自信与缺失比例均不能直接解释为校准的事实概率。
重建文本标明原件锚点、推断与缺失；无原件可核时不能借“生成合理”升级为 verified。

## 4. 下一研究协议草案

状态仍是未冻结、未执行的建议，不称 preregistered；下列数字是候选协议，不是科学 power 证明或产品容量。

### AR0：合同与失效 fixture

下段保留初始研究计划；后续已实现范围和未完成的 AR0b 持久投影门见[AR0 合同及验收矩阵](AR0-RETRIEVAL.md)。

先冻结 query/source scope、来源 revision、读取用途、时间可见性、输出预算与当前权限复核入口。
覆盖撤销、consent off→on、空/非空 scope purge、解绑、未来事件、越权邻居和重复根的阴性 fixture。
检索 snapshot、投影 fanout/cursor 与撤销后重建合同先落地，再讨论带语义图的性能对照。
toy vector 只用于排序、预算和权限机制 fixture，不能把它称为语义 B1 或 embedding 基准。

### AR1：仅文本检索对照

先不生成答案、不训练、不接多模态、不迁库；只比较原始证据检索与必要的固定图构建。

| 分支 | 改变量 | 控制 |
|---|---|---|
| B1 hybrid | 实际 BM25 + 真实 embedding/vector 融合 | 明确 tokenizer、版本、许可与融合权重 |
| B2 deterministic PPR | 固定授权图上的确定性传播 | 同一检索候选、文本预算与 tie-break |
| B3-mean | 使用固定 `q` 的 restart 均值 | 与 sampled 相同 `P/p_0/q/epsilon_t` |
| B3-sampled | empirical restart seed | 只在已冻随机变量处采样，不改图或 dangling 行 |

建议语料 300 个 synthetic events / 60 个独立家族，20 家族 dev、40 家族 heldout，每家族约 3 个 query。
同根改写、摘要、翻译与重复版本都同组，不能靠文本变换增加独立样本数。
检索语料可以包含测试问题对应的证据，这是检索任务；gold answers/test questions 不参与 graph 抽取、embedding 训练或调参。
每问只使用在该问时间点之前已 ingested 且当前 authority 允许的 sources；事件时间和入库时间不能混淆。
执行前冻结真实 embedding/tokenizer 的版本与许可、图构建、融合、gold、硬件及 seed 算法；未冻结前不运行 holdout。

| 预算项 | 候选实验上限 |
|---|---:|
| retrieval candidates | 64 |
| graph | 128 nodes / 512 edges |
| 输出 | 8 events，另加统一文本预算 |
| sampled restart | 每个 query 抽取一次 `K=8`，有放回，重复抽中计入次数（AR1 起步方案） |
| 传播 | `T=10` 有限步 |
| 随机重复 | 20 个预先公开固定 seed |

统一文本预算的具体 tokens/bytes、tokenizer、预算拒绝规则仍须在执行协议里冻结，不能临时选取。
B3-mean 用相同 `q`；B1 不做无意义空转来伪造等 FLOPs，分别报告实际 embedding、图构建、查询与存储成本。
20 个 seed 只估计随机方差，不增加 40 个 heldout 家族的独立样本量。

| 指标 | 记录方法 |
|---|---|
| Primary | Recall@8 与 full-support hit（所需支持证据是否全部进入输出） |
| Secondary | nDCG、source precision、无答案题 false-positive、latency、峰值 RAM |
| 不确定性 | 以独立家族为单位的 paired CI；seed 内重复不能当独立题目 |
| 成本 | 索引/metadata/冷副本、构建与查询耗时分别报告 |

可讨论的事前门槛示例：full-support 提升至少 3pp 且 95% CI 下界大于 0，source precision 下降不超过 1pp。
该示例尚未冻结；必须先定协议再看 holdout，不能看结果改门，也不追加 seed 寻找显著性。
若 sampled 不优于同分布 mean，删除随机机制；不要把 mean 的收益归因于采样。
任何越权、撤销复活、未来泄漏或预算超限直接 FAIL，平均检索收益不能抵消。
本阶段不生成答案，因此不报告“回答幻觉减少”或对话质量改善。

### AR2 及以后

通过检索门后才分别研究压缩、重建、元记忆、state 与 LoRA，先冻结各自质量和删除传播指标。
B4–B8 必须有单模块增加/移除及关键交互对照，不能只有累计堆叠后的总体结果。
果蝇、GRU、SSM 同等报告数据、状态容量、训练/推理预算与硬件，不以结构相似代替结果。
真实数据和模型训练按已有的具体授权、预算与准入规则执行；本页研究设想本身不新增数据访问或部署权限。

## 5. 权威与操作边界

agent ID 不等于 thread/device 可共享的全部权限；query scope、source scope 以及能力调用都需要明确绑定。
采集、保留、上传、用于训练是分别授权的用途，允许本地召回不自动允许云上传或训练。
graph walk 前过滤权限，使用与最终交付前复核当前 source/revision/TTL/epoch，缓存命中也不例外。
单权威提交负责来源与撤销；离线 inbox 保留原 epoch，入站幂等去重，撤销优先于晚到重放。
分区期间不同时承诺即时全局撤销与无限离线可用；明确失联时拒绝、待确认或降级的策略。
index、Schema、cache、latent、training artifact 与 output 都保留 lineage；不能只撤销正文而遗留可用派生物。
无法证明可局部去除污染的 opaque latent 应 reset，并仅从仍获许可的来源重建，不能声称精确减去某段经历。
audit 默认记录必要 metadata，不默认完整保存 query/answer；正文与冷原件都需精选、访问控制与保留策略。
工具与机器人执行由 server 强制门控制，包含限速、取消、看门狗与物理安全约束；VOI 分数不授予权限。
模型可以建议行动或整理候选，不能自行把上述权限与执行门降为文本提示。

## 6. 文献短核验与适用边界

R 编号沿用用户 RDD，本文不声称已核全部 G 项目的实现；下表不替代原论文、代码审计或实验复现。
日期/状态按可访问一手元数据、摘要或官方 README 核对；R11 仅保留已核的 early-accepted 状态。

| 来源 | 短评与界限 |
|---|---|
| R1 [Spens/Burgess 2026](https://www.nature.com/articles/s41467-026-74357-6)、[作者仓库](https://github.com/ellie-as/hippocampal-neocortical-RAG) | *Hippocampo-neocortical interaction as compressive retrieval-augmented generation*，25 Jun / VoR 7 Aug；narrative、Mistral7B/LoRA、Hopfield 与关系推断是作者模型，README 的 A100/Python3.11.5 是作者 full-run 环境，非我方测试。 |
| R4 [作者全文](https://cocosci.princeton.edu/papers/callaway2023optimal.pdf) | 2023 online / 2024 卷期的最优记忆研究可启发成本目标，不能把其理想化任务和假设直接当作本系统最优性证明。 |
| R6 [Modern Hopfield](https://arxiv.org/abs/2008.02217) | 存在全局/子集混合 fixed point；不能由吸引子收敛推得事件原样还原或来源正确。 |
| R8 [HippoRAG 2 / ICML 2025](https://proceedings.mlr.press/v267/gutierrez25a.html)、[仓库](https://github.com/OSU-NLP-Group/HippoRAG) | PPR 与 passage 集成为图检索对照来源；作者 benchmark 改善不是 Core 的权限、撤销或当前检索结果。 |
| R9 [Mihály 等 2026](https://link.springer.com/chapter/10.1007/978-3-032-28826-4_8) | 7 Jul 书章比较 Hopfield/SDM 的二值 MNIST 噪声补全；可参考精度/鲁棒性权衡，不是语言情景记忆或长期伴侣验证。 |
| R10 [Entropy 26(5):381](https://www.mdpi.com/1099-4300/26/5/381)、[arXiv](https://arxiv.org/abs/2309.17290) | 理论建模的假设与推导须保留，不把它标为已实现的人脑机制。 |
| R11 [Nature early article](https://www.nature.com/articles/s41467-026-78727-y) | 已核 25 Oct 2026 accepted early article、尚待 VoR；不写成已完整读到定稿或已复现。 |
| R12 [FlyWire wiring diagram](https://www.nature.com/articles/s41586-024-07558-y) | chemical synapses 的结构连接组，不含完整生理动力学，也不证明在线学习、能耗或意识。 |
| R13 [LongMemEval-V2](https://arxiv.org/abs/2605.12493)、[官方仓库](https://github.com/xiaowu0162/LongMemEval-V2) | 12 May 2026 v1/Work in Progress；五类为 static/dynamic/workflow/gotchas/premise，与旧 LongMemEval 类别不同，本项目未跑该 benchmark。 |
| R14 [S-EMBER](https://arxiv.org/abs/2607.02689)、[Meta 仓库](https://github.com/facebookresearch/S-EMBER)、[数据卡](https://huggingface.co/datasets/facebook/S-EMBER) | 2 Jul 首稿 / 26 Aug v2；最新摘要强调 grounded recall gap，不能机械沿旧摘要结论；数据 CC-BY-NC-4.0/gated，未下载或取得训练用途批准。 |
| R15 [Ranganath/Ritchey 2026](https://www.annualreviews.org/content/journals/10.1146/annurev-psych-042126-090849) | *Episodic Memory: Dynamic Modes for Constructing Episodes*，21 Oct advance online，vol78 in press/版权2027；生成与情境模式是综述框架，非可直接部署算法。 |
| [Graphiti 官方 README](https://github.com/getzep/graphiti) | 应用方仍负责 ingestion、tenancy、access control 与运维；图存储/检索能力不能替代 Core 权威或自动解决多端权限。 |

AR0 当前读取/局部重建已有合成合同验收；后续先收敛 AR0b ADR 与 AR1 可审协议，再决定执行质量实验。本页所有新实验仍为 EXPERIMENT_NOT_RUN。

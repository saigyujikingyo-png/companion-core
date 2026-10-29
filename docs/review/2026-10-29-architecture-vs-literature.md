# 架构图对照已有工作（2026-10-29）

对项目六子系统架构图（① 物理身体与外部世界 ② 身体与非语言状态 ③ 互补认知 L/R ④ 记忆 ⑤ 统一执行 ⑥ 慢循环）的文献对照与风险评审。摘自评审者在 2026-10-29 完成的一次研究综述；表格与数字有来源，标注"判断"的是评审意见。

## 1. 总体判断

1. 最强项是"事实与动作的权威性"（AEMC 的来源／claim／授权／撤销；行动提交的幂等／UNKNOWN／回执；持久化的 fencing／恢复闭包），这是数据库与分布式系统的成熟范式，迁移到智能体上恰是多数 LLM 记忆框架所缺。
2. 关键路径空心化：有限共享工作状态、下一步选择、L 显式处理侧仍是研究项，而情感场、L/R、Student 自训练这些研究味重的模块已铺开。CoALA 已给出"工作记忆 + 提议—评估—选择"的现成抽象。
3. "身体"这条线新颖且有稳态／内感受式 AI 的学术依据，但必须降级为调制信号，不直接产出行动倾向。
4. L/R 是有用的工程隐喻，神经科学上站不住：Nielsen 等（PLOS ONE 2013，1,011 人静息态）表明偏侧化是局部网络属性，不存在"左脑型／右脑型"；建议更名"显式通道／情境通道"。
5. 自训练回路是最高风险项：Betley 等（Nature 2026-01-14）表明窄任务微调可引发大范围失准；陪伴场景另有谄媚与依赖风险（Cheng、Jurafsky 等，Science 2026-03：11 个主流模型认可用户行为的频率平均比人类高 49%；2,405 名参与者更信任谄媚回应）。评测门必须含人格／价值回归、拒答与边界回归和人工签核。

## 2. 对照表

| 子系统／节点 | 最接近的已有工作 | 成熟度 |
| --- | --- | --- |
| ③ 有限共享工作状态 | 全局工作空间（Baars；Dehaene GNW）、LIDA 认知周期、SOAR 决策周期、CoALA | 标准做法，可直接映射 |
| ③ L/R 双侧 | CLARION 显式／隐式双层；ACT-R 模块+缓冲区；双过程理论 | 双通道成熟；"半球"命名有争议 |
| ③ 身份合同／自我模型 | Constitutional AI 式原则层；Generative Agents 的人格种子与反思；Letta persona block | 公共／私有分层比主流更严谨 |
| ④ AEMC 权威底座 | Zep/Graphiti 双时态图（失效边标 invalid_at 不删除）；事件溯源／CQRS | 少见的工程级严谨 |
| ④ 联想召回 | HippoRAG（NeurIPS 2024，PPR 单步多跳，比 IRCoT 便宜 10–20×）；HippoRAG 2（ICML 2025）；GraphRAG/LightRAG；Mem0；A-MEM | 成熟，有现成实现 |
| ④ 元记忆与重建查证 | 不确定性标注、带标记重建、回查原件 | 新颖，评测方法不成熟 |
| ⑥ 休息与离线整合 | 互补学习系统 CLS；经验回放；Letta sleep-time compute（arXiv 2504.13171：同等准确率测试时算力降约 5×，摊销后单次成本降 2.5×） | 方向成熟；最划算的睡眠工作是预整理记忆，不是急着训权重 |
| ② 情感场／自主节律 | 稳态 RL（Keramati & Gutkin）、内感受 AI、Damasio 躯体标记、allostasis；Pihlakas 多目标稳态基准表明有界目标天然抑制无限最大化 | 有依据；工程上少见，高风险创新 |
| ② 果蝇蘑菇体 vs GRU/SSM | Bennett 等（Nat. Commun. 2021）多巴胺 RPE 调节 KC→MBON 可塑性 | 建议先用手写有界一阶动力学做基线，蘑菇体只做"线索→效价"子模块，GRU/SSM 作对照 |
| ⑤ 精确行动提交 | 事务性 outbox、幂等键、两阶段提交、人类在环审批（Temporal 式持久执行） | 成熟；缺按风险分级的人类审批 |
| ⑥ 教师-学生、清单、评测、注册表 | 知识蒸馏、课程学习、MLflow 式注册表、shadow/canary、MinHash-LSH 去重 | 标准 MLOps |

## 3. 风险与缺口（按严重度）

**严重（启动 Student 前必须解决）**
1. 自修改回路缺价值门：只有"质量与工程双门"，缺人格／身份合同回归、拒答与边界回归、谄媚检测、激活前人工签核、"新版本不得修改自身评测集"的权限隔离、自动回滚触发器；自我经历训练存在自我强化偏差，需固定外部锚定数据。
2. 缺显式冻结／关机与监督模块：现有"暂停／撤销"针对单个动作，缺独立于情感场与选择节点的全局急停，能冻结执行门、慢循环、registry 激活与记忆写入。
3. 情感场直接作用于选择：有界动力学只保证状态不发散，不保证行为可解释、不被操纵；外部可通过反馈通道反复刺激情感场间接操控。应只输出调制参数，由选择节点裁决并记录贡献；设速率限制与反馈去重。
4. 陪伴指标的奖励欺骗：若用满意度或互动时长评测，Student 会学会讨好。改为事实一致、边界遵守、鼓励现实人际、必要时提出异议，并由用户盲评，不用在线反馈直接训练。

**高**
5. 撤销传播不闭合：权威 claim 撤销后，派生投影、向量索引、PPR 边、情景摘要和已进入训练清单的样本需处理；权重中的知识无法撤销，只能靠"训练准入延迟期"与版本回退缓解。
6. 整库 RAM 镜像：容量上限 = 可用内存，恢复时间随库大小线性增长；热数据常驻、冷数据按需，并测恢复时间目标。
7. 实时循环与慢循环的争用与优先级反转：为在线推理保留资源；慢循环只读快照、经执行门提交写入；设在线延迟 SLO，超标自动暂停训练。
8. 加密增量持久化的常见失败模式：密钥轮换中途崩溃、增量链断裂、fencing token 未覆盖所有写路径、备份能写不能读。每月从零恢复演练，CI 做崩溃注入。

**中**
9. 可观测性：每个认知周期一条结构化 trace（输入、召回、调制量、候选、选择、回执）；OpenTelemetry + Langfuse/Phoenix。
10. 故障注入与演练：模型服务挂掉、QSFP 断链、磁盘满、时钟跳变、传感器 UNKNOWN。
11. 成本与能耗预算：节律可纳入能耗约束。
12. 隐私与第三方数据：声音与图像涉及家人、访客，需同意与保留期策略。

## 4. 优先级与阶段

关键路径上的研究项（优先）：有限共享工作状态 → 下一步选择 → L 显式处理侧 → 联想召回（BM25/向量）→ 个人工具网关 → 经历返回。

| 节点 | 可直接复用 | 理由 |
| --- | --- | --- |
| LLM/VLM 服务 | vLLM（官方 Spark 配方）、llama.cpp | 社区实测最充分；OpenAI 兼容接口 |
| 工作状态 + 选择 | 按 CoALA 自写小型决策循环，或 LangGraph 状态机 + interrupt | 有状态图、检查点、人类中断 |
| 召回 | SQLite FTS5（BM25）+ sqlite-vec/Qdrant；之后 HippoRAG 2 做 PPR | 与现有 SQLite 同栈 |
| 时态事实层 | Graphiti 双时态 schema | 只借鉴失效语义 |
| 休息期整理 | Letta sleep-time agent 模式 | 先整理记忆，不训权重 |
| 工具网关 | MCP 服务器，全部经精确行动提交 | 生态成熟 |
| Student 训练 | Unsloth / NeMo AutoModel / LLaMA-Factory（Spark playbook） | 现成配方 |
| 去重 | datasketch（MinHash-LSH）或 NeMo Curator | 近重复与同源家族 |
| 可观测性 | OpenTelemetry + Langfuse/Phoenix + DCGM | 论坛报告 DCGM 在 GB10 上工作正常 |

阶段：0）安全底座：全局冻结／关机、认知周期 trace、单机降级、恢复演练；1）最小闭环：本地 Super VL 作 L、CoALA 式工作状态与选择、BM25+向量召回、MCP 经执行门、经历回 AEMC；验收标准：一周无人值守运行，所有对外动作有回执，撤销能传播到全部投影；2）身体作为调制，消融实验对比用户盲评；3）慢循环的非参数部分：睡眠期整理、元记忆、PPR、矛盾检测、评测集；4）参数学习：LoRA Student，shadow 数周、人工签核、一键回滚、训练准入延迟期。

## 来源

- [CoALA（arXiv 2309.02427）](https://arxiv.org/abs/2309.02427)
- [HippoRAG（NeurIPS 2024）](https://proceedings.neurips.cc/paper_files/paper/2024/file/6ddc001d07ca4f319af96a3024f6dbd1-Paper-Conference.pdf)、[HippoRAG 2](https://arxiv.org/abs/2502.14802)
- [Zep 时态知识图](https://arxiv.org/pdf/2501.13956)、[Mem0](https://arxiv.org/abs/2504.19413)、[A-MEM](https://arxiv.org/abs/2502.12110)
- [Sleep-time Compute](https://www.letta.com/blog/sleep-time-compute/)
- [Bennett 等，蘑菇体 RPE 模型](https://www.nature.com/articles/s41467-021-22592-4)
- [Nielsen 等，半球偏侧化（PLOS ONE 2013）](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3743825/)
- [Embodied Neural Homeostat](https://dl.acm.org/doi/10.1016/j.neunet.2024.106379)、[多目标稳态与安全](https://www.alignmentforum.org/posts/vGeuBKQ7nzPnn5f7A/why-modelling-multi-objective-homeostasis-is-essential-for)
- [Emergent Misalignment（预印本）](https://arxiv.org/abs/2502.17424v1)
- [Harmful Traits of AI Companions](https://arxiv.org/pdf/2511.14972)

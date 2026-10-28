# 实施与持续开发路线

**独立追加 QA（开发/合成验证中）：** [CorpusQualityAudit/0.1](CORPUS-QUALITY-AUDIT.md)以新 selection/read grant 和新 once 账本审阅已选 eligible 文本，DS 制定 rubric、Together GPT-OSS 盲审，追加筛选清单和 scoped 跨 job 指纹索引；旧接受记录不改。新增[QA 目标基线](AUDIT-TARGET-BASELINE.md)与历史生成基线分开绑定。实际 QA、宿主/CI 与训练仍分别验收。

**后续里程碑：无外部输入的自主唤醒与休息（待实现/验收，首训覆盖待做）。** 首次上电即使用户尚未输入第一条消息，也应可由内部状态、记忆和目标演化获得唤醒机会，自选思考、探索、行动、发声或安静，并能休息后再醒。验收必须在没有外部输入的条件下记录这些选择及真实执行结果；固定开场白或机械定时输出不算通过，内部唤醒机会不等于必须输出。本里程碑不阻塞当前生产/QA，不授予常驻、无限推理或额外工具权限，当前宿主不因此改动。

**当前新生产切片（开发/合成验证中）：** [CorpusProduction/0.1](CORPUS-PRODUCTION.md)实现128候选校准所需持久双队列、逐项隔离、job内跨批去重、分能力池/分split不可变产物和官方batch tokenizer。真实生产、新head CI和Student训练分别待验收。规范目标入口为[出厂人格与目标连续性](FACTORY-BASELINE.md)；旧CP0Q原件及证据不重跑、不改写。

**当前 CP0Q：** [六单元双队列与独立分词计量](CORPUS-TEACHER-PILOT.md)已完成真实小批：13 次模型调用产生 5 条模型评审通过候选，1 条局部隔离；新进程重算 1,600 full tokens 一致，自动撤销与重复执行拒绝通过。单元级 JSON、长度、重复或模型评审失败独立隔离；来源、权限、未知提交及用量失控停止新增调用。新语料使用官方 Nemotron 3.5 Super VL NVFP4 身份和独立计量回执，旧 CP0 数学语料及失败原件保留。后续推进跨批语义去重/CP1 导入与 Student 后端；模型评审通过不等于事实验证或训练许可。本批的实际运行、独立审查与跨平台结果以切片证据为准，不复用旧运行的 PASS。

**CP0 第一片：** [独立合格候选采收](CORPUS-PIPELINE.md)已实际交付1条复用合格候选及新的加密清单，train1/dev0，新进程核验通过；固定 Student tokenizer 的94 input /18 loss /112 full tokens经另一进程重算一致。本次新增模型调用0，原失败不改写，训练未启动。下一片是独立生成/review双队列与逐项失败隔离，再做CP1现成语料导入和256GB训练池；单行数学产物仅证明采收链，不代表陪伴模型训练质量或规模产能。

**本批 WF2：** [失败诊断](WF2-FAILURE-DIAGNOSTICS.md)已定位旧 medium 的 `WF1_PAIR_BINDING`；[跨模型四单元 canary](WF2-UNIT-PILOT.md)已完成真实运行及冷验。4 seal/4 plan通过，T11/DS1后因第二候选未过精确验算停止，记录1条合格、1条隔离，原协议的四行 manifest 未完成。旧实验保持原结果，CP0采收另外记账；本 canary 不代表256GB首训数据池、Student训练或规模生产已交付。

**当前 IF7：** 原 `06fc8b2` 冻结候选完成独立893/893与typecheck后，已整合包含WF2的 `main`（`87eab00`）；新组合实际单worker984/984与typecheck通过，形成独立PR候选。精确head的跨平台CI与合并状态以PR实际记录为准，不复用IF0–IF6的 [PR #1](https://github.com/saigyujikingyo-png/companion-core/pull/1) CI。[当前证据](AEMC-INFRA-EVIDENCE-IF7.md)区分各层；[架构进度](AEMC-DEVELOPMENT-STATUS.md)仍按18项目标记账。IF7只观察generation、Store image、Safety与authority receipts，不引入GC、rollover或可写次数预测；本轮未部署或启动训练。

后续依赖顺序为容量运维协议（保留幂等、UNKNOWN与已消费额度）→ 生产authority/custody与恢复准入 → AR1冻结质量/总成本实验。已有compaction只重建新generation，不释放Store ingress或authority receipts；AR1、生产接线和训练准入仍开放。以下 IF0–IF6 与更早切片保留各自历史验证范围。

[历史 IF3/IF4 组合验收](AEMC-INFRA-EVIDENCE-IF4.md)：822/822、typecheck、两位独立终审与最终成本测量闭合；该记录仅对应IF4冻结源码，不替代当前IF5/IF6证据。

**AEMC基础设施 IF3/IF4：** [完整前置矩阵](AEMC-INFRASTRUCTURE.md)、[研究ADR](AEMC-INFRA-RESEARCH.md)和[版本化合同](AEMC-INFRA-CONTRACTS.md)保留全部训练前范围。在外锚/密钥与schema2持久消费者基础上，已实现 [v3增量存储、链备份和新目标压实](INCREMENTAL-STORAGE.md)，以及 [旧M2冻结包导入、全局来源登记与实际准入门](LEGACY-M2-IMPORT.md)。[IF0](AEMC-INFRA-EVIDENCE-IF0.md)、[IF1](AEMC-INFRA-EVIDENCE-IF1.md)、[IF2](AEMC-INFRA-EVIDENCE-IF2.md)证据保留其原快照。生产custody、十年规模、历史GC、真实检索/多模态质量及其余前置仍开放；不授予训练准入，下方旧切片保留历史范围。

**本批 WF1：** [独立私有教师校准 worker](WF1-CAMPAIGN.md)实现有限 campaign、host/CAS fencing、密封 custody、同源排除与形式验证、train/dev 模型评审及私有 manifest；实际 API/用量按单独冻结运行回执验收，不以合成完整链替代。Student 推理/训练 `NOT_RUN`，密封评测反馈不参与调参，64-family 扩批及公开发布未准入。

**本批 WF0：** [教学 metadata 合同](WF0-TEACHING-CONTRACT.md)实现独立有界声明 validator、完整已提供家族/已知指纹分组、私有继承、sealed split 隔离与公开 metadata 导出。仅 `DECLARATION_VALID_ONLY`，执行 `NOT_AUTHORIZED`、权限真实性 `NOT_AUTHENTICATED`、语义/质量 `NOT_EVALUATED`；不生成材料、不接 API/训练/Store，实际教学及完整来源认证仍待独立准入。[Together gpt-oss 教师研究](GPT-OSS-TEACHER-RESEARCH.md)为调用前 **DESIGN_ONLY** 快照，不改变既有 WF0 或消耗旧请求额度。

**本批 J0：** [GrowthJournal](GROWTH-JOURNAL.md)实现有界 RAM 计划/尝试/实际 curation 检查回执与固定模拟训练四维，当前权限复核、旧写入runtime fence、新当前历史视图及 JSON/安全 Markdown 声明导出。实际训练/模型调用0；不新增executor、DB migration或受信恢复。训练runner、持久可信回执与跨同意代际重新授权保持后续独立协议；本批作者/独立/whole/CI分层验收，不把lint完成或零admitted写成语义质量PASS。

**本批 SP0A / AR0b0：** [真实Store来源绑定与有界RAM消费者](SCENE-AUTHORITY.md)已实现显式Scene logical v2、metadata-only来源快照、reset/全量替换/独立ACK、暂停与源撤销失效，以及M2源恢复后的显式新绑定。仅合成数据，claim质量NOT_EVALUATED，持久schema与outbox未改；[编号迁移/immutable journal/per-consumer checkpoint设计](ADR-AR0B-DURABLE.md)仍DESIGN_ONLY。最终验收按本批专项、独立审查、whole和对应提交CI分层记录；这不完成AR0b durablefanout或AR1质量实验。

**本批 AR0：** [有界当前召回与同版 RAM 投影](AR0-RETRIEVAL.md)已通过作者139/139、独立最终6/6、本机一次whole413/413与strict TS/三个零模型调用demo；原12项L1差量仅保留TOOL_OUTPUT_ONLY历史证据、未重跑，分层不相加。CI以发布后对应提交Actions为准，当前不预报通过。只读当前memory与学习许可分离，局部全量重建不消费全局outbox ACK；生产未部署、质量NOT_EVALUATED。下一步按 **AR0b 持久 dispatcher/per-consumer 迁移与崩溃/重复/删除次序/重建基线 → AR1 真实 embedding/BM25/PPR/mean-vs-sampled 冻结实验** 推进；持久fanout未实现。

[AEMC v0.6 对象中心表征路线](AEMC-V06-REPRESENTATION.md)的 [SP0/SF0](SCENE-PACKET.md) 已实现独立 RAM 声明validator、精确概念/profile引用与可读 JSON 完整性交换；作者专项33/33与独立最终返验通过，whole/CI以本批回执及对应提交Actions为准，当前不预报通过。它不认证现实来源/权限、不接持久schema或感知；SP1/SF1质量与总成本、SP2映射迁移、SF2资产/撤销/崩溃及AR0b持久迁移仍是后续独立门，不替代AR1检索协议。

**本批进度：** [L1.a](LEARNING-DESIGN.md#l1a-已实现的窄接口)已实现同步 RAM 声明 lint、权威有界只读 snapshot 与候选 manifest；只用合成数据验证，同源分组/时间切分/声明矛盾与旧能力失效可检查，语义/翻译质量和 training/eval quality 均 `NOT_EVALUATED`。其余通用学习阶段仍为 DESIGN_ONLY；独立 TJ1 小 canary 的实际训练另列，不代表通用训练或部署。此前 source `05cbeea`已实现独立通信permission窗口，strict TS+300项+七步回放和独立63项通过；[原生零真实API接线](evidence/NATIVE-ACCEPTANCE.md#window-control)验证window60与原observed lease分离、重复不延期、off/pause/resume及clean退出。它不是自然主动送达PASS；先前NO_TRIGGER封存，不追加调用。


2026-10-26。用户已认可总体架构。每个里程碑形成可运行证据，不因更大模型或更多硬件跳过正确性门槛；M0已交付，M1已完成JSON/绑定/取消/薄映射及真实DeepSeek、完整Codex单回合验收。此前主动交接源码`4e3f246`的主动ready队列、原生ACK/SDK空闲发布门及前台实际settlement交接已通过strict TS+272项+七步合成回放、独立39项定向检查；[实际SDK零真实API投递](evidence/NATIVE-ACCEPTANCE.md#proactive-zero)机制PASS。唯一自然时间试验中fresh M2单次boot下5次真实合成输入全部native ACK，但主动投递0，结果NO_TRIGGER；新源码跨重启未重测、未部署，既有生产proactive配置false，当前生产calls未重读。此前`25cb0f8`的[M2a加密同机跨重启记忆](M2-DURABLE.md)两次原生恢复/撤销排除及部署回执保留，详见[当前验证](VALIDATION.md)。M2–M6未整体完成；M3/M4的[有限在线耦合](COUPLED-RUNTIME.md)也不是自然交流质量、人类情感或永久记忆资格。

| 里程碑 | 工作包 | 接受标准 |
|---|---|---|
| M0 核心正确性 | 独立 TS/SQLite repo、合成 provider、scope/租约/撤销、产物代际、维护文档 | 本机类型检查+对抗测试+合成回放；独立只读审查；无真实数据 |
| M1 宿主与模型 | JSON Schema 与 capability 协商；DSH 和第二宿主薄适配；云端独立 API 与本地 mock/本地 HTTP 推理走同合同 | 同一黄金事件集跨两宿主；取消/超时/断网/无结构化输出；每项兼容性标实测版本 |
| M2 生产数据基础 | 旧 JSON 只读导入演练；真实数据目录；加密；一致性快照与独立撤销账本；条件/纠正/时间模型；调度索引 | 故障恢复不复活已删内容；旧格式样本往返；10k/100k/365k事件与深DAG性能；迁移失败不改原库 |
| M3 自然交互 | 多尺度情绪归约器、回忆影响状态、显式证据撤销后状态重算；语音/3D统一时序与打断 | 状态不会跨用户污染；暂停/权限变化即时收敛；真实用户连续语音视觉验收，前端/美术实际 Opus |
| M4 神经实验 | Python NeuralAdapter、mushroom-body 小回路、结构化 LLM appraisal、回路注意与行动先验回流 | baseline/随机重连/GRU同预算对照；消退/反转；回路manifest可追溯；无优势也保留结果 |
| M5 多端与学习 | 手机/穿戴/桌面代理；离线outbox；按需训练codec/readout/LoRA；可信产物激活与回滚 | 设备失联/重连/撤销代际、继承检查点污染、跨进程晚到输出、训练不抢前台 |
| M6 具身 | ActionProvider、模拟器、ROS2/轮式平台 | 本地限速/避障/断联制动/急停；物理平台另行验收 |

[三项目标决策与资产矩阵](TARGET-DECISIONS.md)作为后续切片准则：果蝇候选按净收益可弃用；Student v1 的自然中文、共情情境、关系一致、主动交流合宜和长期状态连续优先，科学/工具/事实来源/执行真实性保持独立硬回归；通用公开底座与私有实例层分离。均为 **DESIGN_ONLY**，不改既有 PASS；TJ0 离线实现与独立 TJ1 Windows 小 canary 的实际验收分别记录，通用学习路线仍未交付。

[按需条件扩散/去噪重建](RECONSTRUCTION-SERVICE-DESIGN.md)仅为 **DESIGN_ONLY** 外部可替换服务候选，不蒸馏进主 LLM；与图扩散检索、常驻情绪层分开，不扩 TJ0。

[导师—教师—Student 最小路线](MENTOR-TEACHER-STUDENT-WORKFLOW.md)仅 **DESIGN_ONLY**：下一切片 WF0 为离线合同/原创合成数据准入，导师职责隔离不自动构成用途许可；不把 TJ1 小数值任务或 provider 连通回执升级为 Student/LLM 训练或质量验收。

## 下一批可开工任务

**成长日记优先级：** 用户目标是以私有硬盘冷存储记录真实微调/持续学习训练履历，固定版本化格式供专属压缩/解压研究，RAM 仅缓存。[TJ0](TJ0-DISK-FORMAT.md)已实现有界合成声明 schema/reducer、identity/Zstd 分块读写、跨进程回读与索引重建，始终 NOT_AUTHENTICATED；作者 39 项/TS/demo 与独立检查分层留证，最终 whole/跨平台以本批回执为准，不预报通过。它不认证真实训练。[TJ1 Windows 小 canary](TJ1-CANARY.md)已在冻结原创新合成数据上完成一次 CPU64步、参数 delta/export/新进程 reload/独立 eval；作者17项/TS/AST、独立6组与实际单次运行分层留证，whole/CI以本批回执为准，不预报通过。真实本地数值计算不称“模型调用0”；其 externalProvider/paidAPI/network 路径为0，不代表全系统监控。Nemotron/cloud 按具体资源、许可、额度另行验收，不要求所有小训练使用 Nemotron 120B。当前 J0 不回填训练历史；此优先级不跳过既有安全/宿主/数据门。

[AEMC v0.5 研究评审与接入路线](AEMC-V05-REVIEW.md)保留四域对接、数学修订与候选实验的 DESIGN_ONLY / EXPERIMENT_NOT_RUN 状态；后续 AR0 窄实现以上述独立合同及实际验收为准，不代表 AR1 已执行。

M2a 当前新增[加密跨重启切片](M2-DURABLE.md)：只实现同机恢复、独立撤销安全边界、额度与入站/输出终态；最新账本完整是前提，`authority.sqlite`有效前缀回滚仍为`KNOWN_UNPROTECTED_LEDGER_ROLLBACK`。整库图像16MiB、检查点历史256MiB、4096次commit是当前容量上限；旧库导入、备份恢复产品、性能规模、compaction及长期运维未完成，不把此切片视为整个 M2 完成。

1. DSH输入挂载、Codex完整回合/入站/幂等与独立原生中断已有局部实测。下一步将pipeline取消与native interrupt绑定，再测试断连、宿主重启和晚到终态；当前hostCancellation仍为not_integrated，不搬迁真实记录。
2. M1已实现deadline/取消、失败终结、持久精选事件幂等、JSON/受信绑定与有限资源队列，真实DeepSeek提取已通过单例验收。继续补部署层会话认证、额度、崩溃pending显式恢复控制面和多提供方语义评测；参见 [M1合同](M1-ADAPTERS.md)。
3. 构建离线 JSON 导入演练器，只输出新库与差异报告，保留所有旧文件。先选择固定合成旧格式样本，再向作者提小 PR。
4. 统一反例回放：purge + 延迟模型、过期情绪 + 解绑、QQ 重复入站 + 未知投递结果、TTS 跨标签 + 迟到播放回执。
5. 用户已授权有限个人试用常驻，实际部署单独验收。面向长期生产运维仍需补齐 M2 的备份恢复、迁移与规模验证；当前有限容量原型不提供十年保证。
6. [本地回路能力策略](NEURAL-LOCAL-POLICY.md)与[连接组CLI](M4-NEURAL-LAB.md)已实现，真实3136节点子图四种GPU操作与三种子24条件已完成研究验收；真实图未优于无回路基线。本批另完成事件驱动CPU在线worker、reset/carry、baseline/no-state切换与无回路对照。下一步补更强时序/GRU及质量评测，个人数据接入仍先完成M2。本机物理NPU缺席，其他NPU/ROCm/Metal后端仍需各自设备实测。
7. L1.a 已有原文/派生表达分离、zh/en/ja/mixed/unknown 声明标签与同源传递分组的合成回放；actor、来源和时间只能来自 Store，标注仍需人工或未来模型另行生成。下一步单独设计语义curation质量、标注生成与完整训练manifest，再接向量检索与训练。当前没有通用多语言理解、翻译质量验收、历史过期来源训练、持久curation DAG或真实数据接入，见[实际边界与后续设计](LEARNING-DESIGN.md)。
8. [背景状态切片](BACKGROUND-STATE.md)的影子意图现可由[耦合器](COUPLED-RUNTIME.md)单次消费为有限provider任务；回忆重排、明确反馈、来源撤销和一次性调度已验证，真实DSH有限链路见当前验证。最新主动调度交接修复先经独立原生准入，不复用此前`enableProactive:false`的M2原生记录；不得降低冷状态阈值或延长30秒原生presence租约制造PASS。其后比较ODE/SSM/小GRU/CfC/真实图及自然交流质量；不因连接组较小而预设其低功耗或优于简单基线。同源派生记忆不能重复奖励，传感器反馈须补可信来源合同。M2a恢复的是记忆与安全状态，背景/神经状态和待消费反馈会重置；跨重启情绪连续性尚未实现。功耗实验仍是独立证据，不代表完整常驻系统能耗。
9. 显式陪伴window已实现且官方SDK控制接线PASS；后续设计可信PresenceProvider及自然时序/质量基准，继续检验状态60秒时常与原生30秒observed租约、独立window的交互。条件估算和控制接线不替代真实自然触发/送达；旧NO_TRIGGER的5/6试验保持封存，不追加第六次、不换cohort重跑或据此开启生产主动性。

后续学习（[L1.a 以外仍为 DESIGN_ONLY](LEARNING-DESIGN.md)）：经历先成为精选证据，再形成带source revision、语言标注、curation许可、删除代际和父checkpoint的完整训练 dataset manifest；当前 RAM 候选不是该完整接口或训练许可。小codec、readout、LoRA等分离训练，经过跨语言、旧能力、纠正与漂移评测和shadow观察后，才进入activate/rollback。易变事实、身份和撤销继续由权威库管理；自摘要/RAG不是独立真值，metadata撤销不等于权重遗忘。两台DGX Spark候选仅预留training backend/model registry接口，资源方案待实际模型、精度和分布式验证后确定；本轮不采购、训练或迁移。

## 与六插件贡献的关系

现有独立 bug PR 继续维护，按上游实际 review/合并状态逐一推进；此仓不自动合并原有 PR。优先处理 memory 写回/持久化、mood 旧任务、QQ 跨实例/进程退出、TTS 播放归属，均保留窄补丁。公用合同先通过适配器验证，再讨论上游是否愿意依赖独立包。

发布共同底座时先给维护者可读的合同、兼容层和单插件演示；不在单一 bug PR 内塞数据库、神经框架、训练和平台重构。用户此前授权贡献 PR 仍适用于合适的上游小修；本仓已按用户选择采用[Apache-2.0](../LICENSE)，开源仓库地址为[companion-core](https://github.com/saigyujikingyo-png/companion-core)；第三方、数据与原生验收范围见[边界说明](THIRD-PARTY.md)。公开源码不代表运行产品、训练许可或上游合并已通过。

## 研究验收边界

情感分理解/共情、自然表达、连续内部状态三个维度。神经回路的输入与输出必须能消融，否则无法知道回路有无贡献。FlyWire、MaleCNS、FlyVis、flybody 是不同数据/系统；接入前固定版本、许可及基线，不把连接组本身当可直接推理的语言模型。M4 初期不需要采购大集群。

十年目标依靠持续可恢复运维、数据与模型可迁移、真实长期评测；加速测试不是经历十年的证据。意识/主观感受不作为通过软件测试可宣布的结果。

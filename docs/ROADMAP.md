# 实施与持续开发路线

**本批 J0：** [GrowthJournal](GROWTH-JOURNAL.md)实现有界 RAM 计划/尝试/实际 curation 检查回执与固定模拟训练四维，当前权限复核、旧写入runtime fence、新当前历史视图及 JSON/安全 Markdown 声明导出。实际训练/模型调用0；不新增executor、DB migration或受信恢复。训练runner、持久可信回执与跨同意代际重新授权保持后续独立协议；本批作者/独立/whole/CI分层验收，不把lint完成或零admitted写成语义质量PASS。

**本批 SP0A / AR0b0：** [真实Store来源绑定与有界RAM消费者](SCENE-AUTHORITY.md)已实现显式Scene logical v2、metadata-only来源快照、reset/全量替换/独立ACK、暂停与源撤销失效，以及M2源恢复后的显式新绑定。仅合成数据，claim质量NOT_EVALUATED，持久schema与outbox未改；[编号迁移/immutable journal/per-consumer checkpoint设计](ADR-AR0B-DURABLE.md)仍DESIGN_ONLY。最终验收按本批专项、独立审查、whole和对应提交CI分层记录；这不完成AR0b durablefanout或AR1质量实验。

**本批 AR0：** [有界当前召回与同版 RAM 投影](AR0-RETRIEVAL.md)已通过作者139/139、独立最终6/6、本机一次whole413/413与strict TS/三个零模型调用demo；原12项L1差量仅保留TOOL_OUTPUT_ONLY历史证据、未重跑，分层不相加。CI以发布后对应提交Actions为准，当前不预报通过。只读当前memory与学习许可分离，局部全量重建不消费全局outbox ACK；生产未部署、质量NOT_EVALUATED。下一步按 **AR0b 持久 dispatcher/per-consumer 迁移与崩溃/重复/删除次序/重建基线 → AR1 真实 embedding/BM25/PPR/mean-vs-sampled 冻结实验** 推进；持久fanout未实现。

[AEMC v0.6 对象中心表征路线](AEMC-V06-REPRESENTATION.md)的 [SP0/SF0](SCENE-PACKET.md) 已实现独立 RAM 声明validator、精确概念/profile引用与可读 JSON 完整性交换；作者专项33/33与独立最终返验通过，whole/CI以本批回执及对应提交Actions为准，当前不预报通过。它不认证现实来源/权限、不接持久schema或感知；SP1/SF1质量与总成本、SP2映射迁移、SF2资产/撤销/崩溃及AR0b持久迁移仍是后续独立门，不替代AR1检索协议。

**本批进度：** [L1.a](LEARNING-DESIGN.md#l1a-已实现的窄接口)已实现同步 RAM 声明 lint、权威有界只读 snapshot 与候选 manifest；只用合成数据验证，同源分组/时间切分/声明矛盾与旧能力失效可检查，语义/翻译质量和 training/eval quality 均 `NOT_EVALUATED`。其余学习阶段仍为 DESIGN_ONLY，不启动训练或部署。此前 source `05cbeea`已实现独立通信permission窗口，strict TS+300项+七步回放和独立63项通过；[原生零真实API接线](evidence/NATIVE-ACCEPTANCE.md#window-control)验证window60与原observed lease分离、重复不延期、off/pause/resume及clean退出。它不是自然主动送达PASS；先前NO_TRIGGER封存，不追加调用。


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

[三项目标决策与资产矩阵](TARGET-DECISIONS.md)作为后续切片准则：果蝇候选按净收益可弃用；Student v1 的自然中文、共情情境、关系一致、主动交流合宜和长期状态连续优先，科学/工具/事实来源/执行真实性保持独立硬回归；通用公开底座与私有实例层分离。均为 **DESIGN_ONLY**，不改既有 PASS 或 TJ0/TJ1 未实施状态。

## 下一批可开工任务

**成长日记优先级：** 用户目标是以私有硬盘冷存储记录真实微调/持续学习训练履历，固定版本化格式供专属压缩/解压研究，RAM 仅缓存。下一最小切片 [TJ0](TRAINING-RUN-JOURNAL.md)拟做记录 schema/reducer、私有盘分块无损读写、跨重启回读与索引重建的离线合成验收；仍为 **DESIGN_ONLY / NOT_IMPLEMENTED**，不是另一个 RAM 原型或真实训练交付。TJ1 才核对受控本地小 trainer 回执、参数 delta/export/新进程 reload/独立 eval。Nemotron/cloud 按具体资源、许可、额度另行验收，不要求所有小训练使用 Nemotron 120B。当前 J0 不回填训练历史；此优先级不跳过既有安全/宿主/数据门。

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

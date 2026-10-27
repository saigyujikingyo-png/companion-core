# AEMC infrastructure contracts / 0.1

日期：2026-10-27。**目标合同仍以 DESIGN_ONLY 为默认；已实现子集见明确链接的 M2、AnchoredVault 和 schema2 模块。**
这里固定跨组件语义和验收边界，具体子集不等于整组合同或跨平台互操作完成。
变更需新minor/major并列兼容表，不能悄悄改既有Scene v1/v2、schema1、TJ0或WF0/WF1。

## 通用约定

- 每份文档有 `contract`、`version`、`id`、`createdAtMs`、`producerRevision`。ID是标识，不是身份认证。
- 时间使用UTC Unix毫秒安全整数；持续时间带单位且非负。跨boot不能重用monotonic绝对值。单位/坐标系/缺失值显式，unknown不是0或空字符串。
- 精确资产引用为 `{id,revision,sha256,formatVersion}`，hash针对明确定义的字节，不暗称现有JSON canonical函数符合JCS。跨语言canonical profile仍须黄金字节验证。
- 未知主版本、缺必填字段、超限、重复ID、矛盾引用/代际均拒绝，不截断后返回完整PASS。可扩展字段只放已定义的extensions namespace。
- 所有size/count/depth/decoded output有hard bounds；实际数值由对应实现合同冻结，不把既有RAM上限默默放大。
- 接收声明、认证权利、执行、质量、外部效果分列。不能把声明有效升级成authenticated/authorized/evaluated。
- 内部来源/usage/digest也可能敏感；公开摘要默认仅固定计数/状态/版本，不放正文、密钥、个人路径或可跨域关联的私有指纹。
- 下面的所有句柄都须在使用/交付时重新校验当前权威；长期保存的JSON不是当前capability。

## C01 AuthorityContext/0.1 与 SourceUseDecision/0.1

`AuthorityContext` 必填：tenant/subject/persona/relationship、scopeId、sourceAuthorityId、scopeGeneration、consentRevision、runtimeEpoch、deletionHighWater、policyRevision、asOfMs、validUntilMs或明确无期限策略；source refs包含精确revision和完整祖先域引用。缺祖先不视为公共。

`SourceUseDecision` 必填：authenticated principal、resource digest/version、purpose（recall/curate/reconstruct/train/publish/deliver等分别决定）、allow/deny/unknown、decision issuer及可核验receipt引用、有效期、地域/产品/保留/派生限制。权限从可信宿主或权威服务解析，不从模型自报或角色分类器获取。

当前Store普通召回与learning consent分开；新合同不能让train许可扩大recall，亦不能把inference许可推为train/upload许可。主控custodian负责真实权利接线，导师只见架构运营metadata。

## C02 M2恢复合同/1

首片真实API、磁盘字段、错误码、界限及测试以 [M2-BACKUP.md](M2-BACKUP.md) 与 `src/durable-codec.ts` / `src/durable-backup.ts` 为准；不得把本文其余设计状态投射为该模块已实现的能力。

必守语义：head绑定format/identity/sequence/authority密文hash；pin来自包外可信方；合法后缀可以包含pin，短前缀/分叉拒绝。结果只证明不早于所提供pin，freshness未证明。完整chain与精确最新checkpoint组成当前状态恢复包，历史checkpoint不必全部包含。

备份验证无磁盘副作用，解密image只在RAM验证；stage仅新目录，其basename必须以 `M2.restore-quarantine.v1-` 开头；boot在初始化前检查canonical basename与隔离marker，mkdir后立即退出留下的空目录也拒绝启动。此旧 M2.v1 路径仍无自动外锚、独占激活或 key 轮换；新 AnchoredVault 是不同格式，不提供隔离绕过或自动导入。物理断电资格仍未取得。

## C03 KeyCustody/0.1 与 RecoveryActivation/0.1

IF6 [authority容量合同](AUTHORITY-CAPACITY.md)补本机执行前置：64MiB读硬界保持，新写默认22369621B；单global PREPARED期间拒绝其他增长写，prepare必须预演完成预算。旧无预算pending保留为unresolved；停止旧writer后才能使用新预留保证。schema/receipt/key格式未变，不将软件预留称为OS空间预分配。

| 合同 | 必填字段与约束 |
|---|---|
| KeyCustody | vault identity/generation；DEK ID/算法/用途、KEK/包装版本/托管provider、稳定idempotency key ID；旧备份解密期限；恢复owner/授权receipt；不得承载原始key或DPAPI blob |
| KeyMigrationPlan | source/target custody、迁移模式rewrap或rekey、输入head、备份/回滚依赖、幂等键兼容规则、测试receipt；丢失key不得生成新key假装恢复原库 |
| RecoveryActivation | verified package hash、外部fresh anchor、source writer fence/epoch、target identity/owner、quota/revocation水位、cutover/rollback步骤及receipt |
| 激活状态 | prepared → verified_quarantined → source_fenced → activated；任何阶段unknown停在unknown；没有source_fenced证明不得开第二个同身份writer |

仅schema验过或拥有key不授权生产激活。当前M2的每目录writer lock不能提供跨目录/跨机fencing。真实key rekey不能更改既有输入幂等指纹；需要版本化兼容或独立稳定HMAC键。

已实施子集：[AnchoredVault/v2](ANCHORED-VAULT.md)及[v3](INCREMENTAL-STORAGE.md)强制独立 `LocalSqliteAuthority`，整个同步访问guard与exact head CAS拒旧anchored源；PREPARED持久fence，固定密文发布后ACTIVE。DEK、稳定ingress与Store ledger key保持幂等，rewrap与current-state真rekey分开；恢复/迁移/维护/压实均使用新目标和owner epoch。[显式M2导入](LEGACY-M2-IMPORT.md)另有同authority来源唯一槽和实际准入门，不把旧M2副本冒称已fence。外锚独立防回滚仍是前提；硬件/远程托管、真实跨机钥匙恢复及历史密钥销毁未完成。

### C03a IncrementalStorage/3 与 LegacyM2Import/1 实施兼容表

| 组件 | 当前行为与兼容边界 |
|---|---|
| M2.v1 | 原wire/schema1和quarantine保持；只从完整export包显式导入，不激活隔离目录 |
| AnchoredVault/v2 | 既有默认profile与AAD/receipt保持；显式新目标storage-upgrade到v3，不能普通write偷偷换格式 |
| AnchoredVault/v3 | 认证blocks-br4-v1或full-br4-v1；base+最多15delta，完整Safety与image由同head绑定；blob一次写，stage只引用 |
| Current-state backup/compaction | 保exact base→head密文链；物化新base时使用新owner/instance与parenthead；旧源保留，不称已回收总空间 |
| Authority schema2→3 | 显式维护独占事务加legacy_imports，旧三表行/JSON保留；open不补表，新handle pin schema epoch |
| LegacyM2Import/1 | 可信下界与声明tip/packageDigest分离；verified genesis+identity全局唯一lineage；新DEK/稳定旧HMAC，原Safety先验后UNKNOWN |
| Legacy admission/1 | claim/reserve在guard内默认拒绝；exact current head CAS记录操作者停用声明，历史receipt保持false最新性/fencing声明，额度不重授 |

只覆盖本机有界当前态协议。authority-only唯一性不跨其他authority/旧副本；永久lineage登记不随压实删除。所有入口统一拒M2保留命名空间祖先，普通v2路径兼容。

## C04 FanoutJournal/0.1（目标合同）与 schema2 实施子集

IF5 [ConsumerRetrievalSnapshot/1与bindConsumer](DURABLE-RETRIEVAL.md)已把完整current projection接入真实检索：同guard持久TTL屏障后，同一冻结时间读取metadata/body/祖先；consumer stamp含完整applied/head、代际与authority，query/resolve均复核。新路径保原AR0界、全拒绝超预算且不自动apply/reset；手工refs接口与排序保持。stamp是当前本地读回执，不是可移植能力或语义正确性证明。需持久TTL写而被容量/pending拒绝时，交付失败并废旧能力。

目标表保留，不按首版结果下调要求。[S2 实现](DURABLE-FANOUT.md)采用**失效目标 ID + 当前授权全量元数据重建**：journal item 不保存历史精确 revision/epoch，精确引用与当前 authority 在投影中产生；固定的两个 versioned profile 代替任意配置插件。它不暴露任意 offset/独立 ACK，直接原子追平完整当前前缀。适用于本机有界 metadata fanout；历史逐 revision 通知、外部索引协议及完整目标合同仍未关闭。

已实现投影/checkpoint 同事务、独立消费者、完整 baseline、TTL 持久屏障、boot/scope/consent/runtime 句柄失效、retention reset 及满日志静态维护。满库维护从 exact current head 读取无 boot 副本，required reset 必须显式列名；原件保留后新目标 fencing。两消费者可分别前进或合并一次提交，不承诺每批增量索引效率。

| 对象 | 必需语义 |
|---|---|
| JournalBatch | authority/epoch、单调不复用sequence、transactionId、schemaVersion、count、digest；源mutation与该batch在一个事务提交 |
| JournalItem | batchSequence/ordinal、scope、sourceRef精确revision、invalidate/reset/delete操作、barrier generation；metadata也受保留策略约束；不承诺保存历史正文 |
| Consumer | 稳定consumerId、profile/config hash、consumer generation、required/optional策略、active/paused/rebuilding、applied complete prefix、reset barrier、baselineWatermark |
| ApplyReceipt | consumer generation、batch/digest、完成前缀；首版每consumer至多一个完整batch在途，投影和checkpoint同事务 |
| Baseline | 完整snapshot+watermark+authority+asOf+nextValidityBoundary；一致读内采集，无可回入写库的外部callback；超限拒绝，不能局部激活 |
| IndexRead | hit授权有效性与index completeness分列；包含完整到何sequence/何时间，fresh读仍逐个复核来源 |

重复相同ACK幂等，冲突digest拒绝；不能取乱序最大offset跳过未见批次。scope过滤造成的序号空洞合法。删除/纠正与barrier同事务，旧upsert/下载不得重新激活。暂停持久化并废旧句柄，body-free cleanup继续；resume重建而不恢复旧能力。

到达TTL/未来有效边界，即使head不变也不能宣称index仍当前。失效被观察后若要求跨崩溃不可复活，需落盘wall/visibility fence；RAM clock记录不够。retention不得只看最快consumer；落后被裁剪前缀必须reset/baseline。外部向量库采用显式幂等恢复，API ACK不算持久应用或exactly-once。

## C05 ConceptRevision/0.1 与 FeatureBinding/0.1

`ConceptRevision`：namespace、stableId、definitionRevision、定义与语言label、来源/权利、active/retired、alias/merge/split/close/exact/broader关系及其证据revision。ID退役不复用，旧定义不就地覆盖，现实实体追踪假设与概念类别分开。

`FeatureBinding`：concept精确revision；model/checkpoint、所有实际参与的tokenizer与encoder、layer/featureSpace/latentSpace、activationKind、pooling、normalization、basis/feature index、prototypeDictionaryRef/hash、saeDictionaryRef/hash、preprocess/adapter/quantizer/decoder/calibration各版本/hash；来源家族/split；input/output dtype/shape/单位；validity、quality receipt和撤销依赖。确实不适用的项显式null，不省略成未知默认；旧残差必须匹配完整profile及实际prototype revision，不能用新原型加旧残差。

迁移结果枚举：`OLD_PROFILE_DECODED | REENCODED | ADAPTER_APPROXIMATION | UNMAPPABLE`。新profile不能默认读旧latent；维度相同也不表示语义等价。旧decoder缺失返回不可重建，不静默生成替代事实。公共模型来源与私有事件来源分别建模，私有校准边界传播到派生映射。

## C06 AssetManifest/0.1、SceneEvolution/0.1 与 Reconstruction/0.1

原件、派生感知、统计图式、重建各有独立type。AssetManifest包含content hash/字节、MIME或固定format、来源/当前用途权、chunk/片段选择器、帧/样本时间基准、单位/坐标/校准、提取器/codec/profile、parent refs、retention、owner、rebuildability、加密key ID（无key）。

音频增加sample rate/channels/sample count、padding/delay、片段边界、转录/说话人候选/韵律与置信来源；说话人embedding不认证身份。视觉区分pixel2D、mask、pose/track假设和经校准3D，未观测的值保留unknown。

blob先准备，源/journal只引用完成且hash验证资产；源回滚的孤儿通过有界GC处理，GC不得删已提交引用。资产缺失/部分写入/错误hash拒绝整个activation；新generation回收需所有required依赖/保留门满足。

ReconstructionRequest带purpose、当前capability、预算、精确profile、known/missing mask、seed、deadline、取消token。Result永久标 `RECONSTRUCTED`、条件/已知锚点/缺失/不确定性、模型receipt，不能自动写回Evidence。cache绑定authority/asset/profile/用途/代际；撤销失效不等于外部副本或权重被擦除。

## C07 CostQualityTrial/0.1 与 RetrievalEvaluation/0.1

协议必填：question/hypothesis、原始来源family、开发/holdout/时间切分、独立custodian、rights receipt、确切算法/代码/decoder/dictionary/模型版本、随机seed、基线、质量/coverage/非劣门、完整成本/资源门、停止条件、一次性运行身份和执行许可receipt。缺任一冻结项为 `PROTOCOL_NOT_FROZEN`，不启动正式试验。

RetrievalEvaluation比较BM25、真实embedding、融合、确定性PPR、mean/sampled seeds；query及完整support答案先冻结。指标含Recall@k/nDCG、跨事件多跳support、假边/假记忆、置信校准、稀有细节、语言组别和来源正确性；source权限hard failures不得被均值抵消。

Codec/表示比较包括无损独立reader等价、task fidelity、感知/重建质量分账。空间包含全部索引/元数据/字典/decoder/冷原件/备份与迁移峰值；cold/warm时延和RAM单列。family是统计单位，衍生帧/译文/seed不是额外独立样本；缺失/拒答留分母。公开Q0只作回归，不再作为新盲测。

## C08 PersistentState/0.1 与 RelationshipRecord/0.1

快照绑定：reducer/backend/profile版本、scope/authority、source refs完整revision、event/journal watermark、已消费feedback/奖励ledger、recordedAt与时钟可信度、state数值域、hash。状态不能同时被两个writer激活。

observation、appraisal、outcome三个通道必须持久保存或精确重建 `channel × original event id/revision` 的消费身份、失败/取消终态与各自水位；新派生memory、新请求ID不能让旧根再消费。已消费记录不能静默淘汰后重新受理。验收包含恢复后同根不同leaf/ID重放、取消appraisal后重启，保持既有独立通道语义，单一feedback ledger或journal最大值不能替代它们。

重启复核权限/TTL/撤销后才能恢复数据状态；源失效重算或明确降级。不得恢复旧RunTicket、presence、通信window、shadow token、任务lease或未确认外部效果。跨boot时间换算必须有策略，时钟不可信时不偷偷补发。

RelationshipRecord独立保存有来源的偏好、边界、承诺及生效/失效时间、更正链、可见范围；tone/valence数值不等于关系事实。ODE/no-state/有限事件历史作为基线，GRU/SSM/CfC/果蝇分别对照；行为质量、正确性、资源和能耗分账。

## C09 SleepCandidate/0.1、FamilyRegistry/0.2 与 ReplayPurpose/0.1

SleepCandidate：purpose、authority、完整source revisions/roots、familyRegistryRevision、训练价值假说（非事实权威）、policy、rights receipts、expiresAt、proposed/validated/quarantined/revoked状态、私有digest。候选成立不授予train或dispatch许可；空候选也验当前权限。

FamilyRegistry：跨批完整祖先、已discarded/quarantined bridge、私有fingerprint算法/域/key代际、canonical grouping、registry revision；先传递分组和split冲突，再去重，换ID不洗掉来源。缺祖先/未知语义重复保持隔离与漏检声明。

ConflictRecord：actor、claim、mode/basis/引语、条件、适用期、原文引用、不确定性、reason、新resolution来源/revision。不同actor、未知条件、非重叠有效期不误判；未独立证实不能自动“纠正”为真。

ReplayPurpose分别为 `memory-rehearsal / public-reproduction / synthetic-study / transport-retry`，每类独立准入。consumed/UNKNOWN/STOPPED不可因换目录/cohort/新ID重放。重建/模型答案不能洗成新独立证据。同源feedback不重复奖励，恢复候选须新当前授权。

## C10 SleepPlan/0.1 与 GrowthJournalLink/0.1

SleepPlan：stable agent_id、候选集revision、可解释收益/不可用/算力/遗忘风险/承诺代价、计划起止/最长离线、资源lease、禁止窗口、未完成承诺、优先级、授权唤醒主体、checkpoint和回滚策略、通知接收方scope（不自动群发）。

状态：`awake → wind_down → snapshot_ready → maintenance → waking → awake`；每步持久receipt，取消/故障进入显式unknown/recovery_required。Guardian独立处理队列/关键请求并执行授权；停止训练请求与worker停止/释放资源分别确认。没有数据/权利/质量时只整理非参数记忆，不更新权重。

GrowthJournalLink绑定本次计划/实际动作/拒绝原因/资源、candidate/dataset/artifact/eval refs与实际receipt。沿用J0/TJ0/TJ1事实层，不填补不存在的训练；跨重开声明仍不得冒充可信执行。固定时刻、随机闲时、可解释策略的冲突率/收益/小时/中断次数另设冻结评测。

## C11 GenerationMigration/0.1

身份/权限、情景事实、技能行为、神经运行态分别列source/target和兼容策略。保留stable agent_id与证据，不承诺KV/隐藏激活/权重同一。迁移包pin base/tokenizer/encoder/adapter/工具/提示协议/索引/关系状态及其权利、完整谱系和评测版本。

流程：prepare → decode/reencode/map → shadow → independent_evaluation → root_acceptance → fenced_activation；任一步可reject/quarantine。旧模型回答需外部独立验证，不能自动成为教师真值；私有实例层不流入公开底座。旧能力/中文/陪伴/边界/工具/科学/证据/执行真实性分别回归。

训练/发布/激活receipt仍由主控独立准入，现有TJ1数值canary不覆盖Student或LLM迁移。回滚也须重验当前撤销/许可，不能恢复已失权parent。

## C12 BackendProfile/0.1 与 ProbeReceipt/0.1

必填：设备稳定ID、vendor/model/SKU、CPU/ISA/OS/kernel、GPU/GCD/NPU拓扑、driver/firmware/framework/compiler/EP容器hash、model/checkpoint、dtype/layout/shape/batch/unroll、mode（inference/update/backward/optimizer）、算子与CPU fallback、memory/latency/energy预算、source provenance、probe时间和过期条件。

selected不等于execution authorized。cold编译/热加载、设备内计算/传输/同步、分布式collective及峰值逐rank计量；Spark共享系统内存和MI250X双GCD不可误报为一个自动统一大显存。NPU推理不推导训练能力。硬件研究不授予租赁/采购或新API额度。

ProbeReceipt只针对该精确profile，记录numerical tolerance与实际资源/错误/未支持算子；环境改变重新准入，不拿历史 PASS 覆盖新kernel或模型。

## C13 语言、宿主与外部效果

| 合同 | 必填语义与硬门 |
|---|---|
| LanguageEnvelope/0.1 | BCP47与片段mixed/unknown策略、原文引用、派生翻译关系、translator版本、质量/不确定性；原文不覆写，译文同family，同语言标签不等于理解正确 |
| HostSession/0.2 | tenant/subject/persona/relationship、host instance/session、已认证主体/资源audience、能力协商/版本、稳定入站ID、authority epoch、deadline、quota/cancel；宿主自报字段不是认证 |
| DeliveryEffect/0.1 | 平台native ID、稳定effect key、权限版本、accepted/delivered/unknown/failed、原生receipt；ACK不等于阅读/完成，UNKNOWN不自动重发 |
| ProviderUsage/0.1 | reserve-before-dispatch、消费ledger、具体provider/model/revision、known/unknown usage和账单证据；取消/超时不退款，推理条款与训练用途分开 |
| EmbodiedAction/0.1 | 设备/skill/actionID、实时scene来源、单位/坐标、速度/力/区域限额、权限与截止、watchdog；stop_requested/acknowledged/observed_stopped分开 |
| TerminalCoverageDecision/0.1 | 完整设备/平台清单、protocol/simulated/native/physical/production逐层证据、required/optional及主控决定依据；当前UNDECIDED_ROOT_DECISION |

移动、穿戴、桌面Windows/Linux/macOS、社交/商业平台、Agent API/A2A/MCP、LAN机器人各保留候选profile；不能在主控决定前把未部署的端移出训练前范围。物理安全由本地控制器强制，断联制动/急停必须实测，模型意见不是执行许可。

## C14 HistoryAccessPolicy/0.1

scope、purpose、retrievalEnabled、consent/deletion/runtime generation、cache namespace/profile、retention/TTL、lastBarrier、provider-history mode与可观察receipt分列。

关闭检索后，新请求不得带旧历史引用/正文；关/撤销废弃在途旧能力和受控cache，打开不恢复旧句柄。cache命中仍须当前来源验证。可以测本地准备的request hash/refs和内存cache状态，不能把它声称云端KV已清空或权重已遗忘；远端不可观测保持UNKNOWN。已有专项授权不允许读取新的私密历史或重放已消费调用。

## C15 MetamemoryAssessment/0.1 与 VerificationDecision/0.1

MetamemoryAssessment逐claim记录：具体事实粒度、evidence/trace/schema/reconstruction类别、来源精确revision、保留/缺失细节、支持与矛盾引用、当前可访问原件与核验路径、校准profile及适用域、已知不确定性。模型自信与引用存在均不是事实已核实。

VerificationDecision记录用途/风险类别、错误损失、查证成本/预计有效性、主控冻结的强制核验规则、当前权限/预算、决定及理由。VOI只辅助可选查证，不覆盖确定性规则、权限、不可逆动作或当前实时场景要求。高风险要求原件/受信工具核验而无权或不可用时，返回不可核验并降级/拒答，不猜测填充。

状态为 assessed → verification_required或optional → verifying → supported/conflicted/unverifiable；核验结果保留实际证据/工具receipt和时间，不能仅用计划或ACK进入supported。需要外部工具时另验当前动作权限，取消/UNKNOWN不自动重试。owner为主控定义风险/接受标准、基础设施实现、独立评估者冻结任务。验收分别测应查未查率、无谓查证率、实际查证收益/成本、选择性回答校准和不可核验处理；只有分数校准不足以完成此目标。

## 实施门

以上设计合同需逐项落为bounded parser/state machine、负例与跨进程/故障证据；只写接口文件不是实现接受。任何拟合/codec训练、provider调用或真实设备动作由对应具体许可与资源门控制。完整状态和下一步见 [总矩阵](AEMC-INFRASTRUCTURE.md)。

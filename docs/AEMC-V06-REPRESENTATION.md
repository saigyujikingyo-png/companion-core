# AEMC v0.6：对象中心表征、稳定概念地址与残差路线

基于本轮粘贴补充，未获得所述完整稿；**DESIGN_ONLY / EXPERIMENT_NOT_RUN**。日期：2026-10-26。
本文不是所述1090行原稿，也未修改用户原稿；没有实现或运行新感知、压缩、映射、SAE或训练算法。
它补充 [v0.5 研究评审](AEMC-V05-REVIEW.md)，不改变已验 [AR0 当前读取](AR0-RETRIEVAL.md)的运行代码与权限合同。
Root/max 确定设计边界，Sol 整理；文献核对、typed schema 与合成 fixture 设想不等于感知或事实质量验收。

[数据库、交换格式与压缩计划](AEMC-STORAGE-FORMAT.md)另行区分逻辑协议、权威事务、标准容器与codec；仍为DESIGN_ONLY / EXPERIMENT_NOT_RUN，不改本页已审表征合同。

## 1. 采用外部权威与可替换映射

ScenePacket 与稳定概念 registry 由外部权威维护，perception latent、embedding、SAE 映射只是可换、可重建的表示。
不把神经元位置、权重地址、slot ordinal、SAE feature index 或 MoE expert index 固定为长期概念地址。
模型变了，旧语义地址仍可保留；旧空间的数值表示是否还能用，是另一项带版本的兼容问题。

| 标识 | 表达什么 | 不自动表达什么 |
|---|---|---|
| concept_id | 某 namespace 下的概念类型及其版本定义 | 现实中某只杯子的身份或世界真相 |
| trackRef | 设备/流内跨观察关联的追踪假设 | 已核实的跨设备对象同一性 |
| entity_id | 经指定证据/程序认可的现实实体身份 | 分类标签、slot或外观相似的自动等号 |

trackRef 拟包含 `device + streamEpoch + localTrackId + rev`；重启不能复用同一局部索引冒充原对象。
跨设备关联只产生候选及其依据/不确定性，不静默合并为同一 entity。
同样包含“红、蓝、杯、盘”的概念集合，不能区分红杯/蓝盘与蓝杯/红盘；必须保留 object/role 与属性的绑定。
registry 只管理 ID 定义与演进，不裁定观察事实；区分公共与私人 namespace，retired ID 不再复用。
多语言 labels 按 lang/version 单独管理，不能把名字相同当作概念相同，也不能因改名改写旧事件。
merge/split/alias/supersedes 都有版本、依据与来源；旧 packet 继续引用当时的概念定义。

## 2. 原型与残差的数学范围

固定完整 profile `p`，至少包括 encoder checkpoint、latent space/dim/normalization、prototype dictionary/version、decoder/version 与 quantizer。
以下仅提出同一空间中的待验近似，不宣称已实现压缩或可从任意文字还原多模态原件：

```text
z_i^p       = E_p(x_i)
mu_(c,k)^p  = F_p(concept_id, context)
delta_i^p   = z_i^p - mu_(c,k)^p
hat_z_i^p   = mu_(c,k)^p + Q_b(delta_i^p)
```

`k` 表示 profile 内的原型选择，不是稳定 concept ID；`Q_b` 的预算/码本与解码语义都要冻结。
若把旧残差直接加到新原型：`mu_new + delta_old = z_old + (mu_new - mu_old)`，会引入原型位移。
不同 checkpoint、坐标基、维度或归一化下的向量不能直接相加，也不能按同一 index 重用。
原补充中的 `D_phi` 若未定义输入/输出、训练目标与适用模态，就不能宣称跨模态分量可加或必可解码。
即使定义 `D_p(hat_z)`，低重建 MSE 也不保证关键属性、动作次序或来源事实保真。

升级时只能选择明确路线：

| 路线 | 条件与失败处理 |
|---|---|
| 保留旧完整 profile | 所需 encoder/dictionary/decoder/quantizer 资产及用途仍可用，按旧空间解释 |
| 从原件重编码 | 原件存在且当前用途授权允许，记录新 revision/profile 与新派生 lineage |
| 适配旧表示 | adapter 在执行前冻结，使用独立固定 anchor 集检查对齐与事实保真，不能只匹配维度 |
| 无法迁移 | 降级到允许的 symbolic/gist，标记 perception/reconstruction unavailable，不假装恢复 |

残差少不意味着总存储小：共享 dictionary、decoder、版本 metadata、索引与冷原件都计入总成本。
个人化原型也可能含个人信息，不能因为它叫“平均值”或“公共概念”就丢掉来源与撤销关系。

## 3. 拟议接口与紧凑伪 schema

下列不是现行 Core API、数据库 schema 或生产认证格式，字段名称与边界仍须在 SP0 开工前冻结。

| 对象 | 目的 | 必须保留的边界 |
|---|---|---|
| ConceptRegistry | 稳定 namespaced ID、定义与语言 label 演进 | 版本不可变、私人权限、retired ID 不复用 |
| MappingProfile | 将某概念/原型映射到指定模型空间 | 完整数值空间与训练/校准 lineage，不按 feature index 猜兼容 |
| ScenePacket | 事件中的对象、角色、属性、关系与动作声明 | scope/epoch/source refs、时间、geometry、不确定性及派生来源 |

```text
ConceptRegistry {
  namespace, concept_id, version, labels[{lang, version, text}],
  supersedes, merge_split_alias_refs, provenance, retired
}
MappingProfile {
  profile_id, version, model_ref, checkpoint_hash, layer, activation_kind,
  preprocess, tokenizer, pooling, dtype, normalization,
  encoder_ref, sae_dictionary_ref?, prototype_dictionary_ref,
  decoder_ref?, quantizer_ref, latent_space, dim, alignment_ref?,
  training_lineage, calibration_lineage
}
ScenePacket {
  packet_id, revision, scope_ref, epoch, event_ref, source_refs,
  occurredAt?, recordedAt, applicability{from?, to?},
  claims[], tracks[], objects[], relations[], actions[],
  geometry{kind: unknown | pixel2D | calibrated3D, frame_ref?,
    units?, axes?, handedness?, rotation_convention?, transform_ref?,
    uncertainty?, covariance{variables[], units[], matrix?}?},
  concept_refs[], perception_refs?[], residuals[{profile_ref, prototype_ref, code}]?
}
```

所有 optional/未知值须显式允许 null/unknown；不能用0补坐标、颜色、剂量、时间或未测协方差。
2D 必须声明图像尺寸、像素单位、原点/轴方向；不能把图像坐标直接当米制3D位置。
calibrated3D 只有在校准依据可用时成立，声明米制坐标、轴、左右手、旋转约定与 transformRef。
covariance 必须列变量顺序与单位（位置与角度不可混作同单位）；未知 covariance 不是全零确定性。
transform 校正产生新 rev，旧 packet 保留原 frame/transform 引用，不原地覆盖过去的位置解释。
slot index 不等于对象同一性；同一位置的新物体、遮挡后的重现与相似物体交换须保留不确定关联。
模型检测/关系抽取记录 extractor/model/profile 版本与不确定性，不能因结构合法自动标 verified。
来源、gist 与 reconstruction 分域；源结构不能塞 JSON 到现有 self_report 绕过 Core 的来源/身份合同。
云 API 没有提供 activation 时，只能使用外部 encoder/text mapping；不假设可读取其 SAE、神经元或隐藏状态。

## 4. 特殊信息必须有 hard anchors

裂纹、颜色标签、剂量字段、动作先后等，存成“对象×属性/角色×时间”的带来源 claim，而非只留概念集合。
每条 anchor 带 source ref/revision、适用时间、不确定性及观察/转述/推断区别；数值和单位不能由原型补出。
prototype 可作召回先验，但“典型杯子是什么颜色”不能变成“这次看到的杯子是什么颜色”。
动作次序允许偏序或未知；没有足够时钟/观测依据时，不把文本排列当成确定发生顺序。
verified 必须绑定独立证据或程序；另一帧的同一错误检测、翻译、摘要和重建不能互相自证。
Affect/果蝇状态可调显著性和检索偏置，不改写事实、权限或 verifier 的通过条件。
重复帧、track 数量、模型猜测或被反复激活的摘要不能直接变成新的 reward/独立支持证据。

## 5. 生命周期与多端权威

raw bytes 保留期、事实适用期与来源使用授权是不同维度，未来分别定义；当前 Core TTL 规则保持不变。
原件过保留期可以令核验 unavailable，并仅保留仍被允许的 trace；不是自动保留所有衍生内容的许可。
撤回来源授权则使相关结构、残差、映射缓存和训练候选失效；不能只删原文而保留可继续使用的派生表示。
这项未来区分需要明确 migration；不能用本文绕过现有 Core 的完整祖先有效性/撤销规则。
personal prototypes 保留 lineage；若不能精确撤除污染的 opaque latent，应 reset/rebuild，而非声称精确做向量减法遗忘。
权重训练遵循具体用途授权、评测与 rollback 门；删除数据库行不等于删除模型已学信息。
同场景帧、ROI、翻译、gist、重建、残差在 dev/heldout 分组时归同来源家族，不能以派生形式跨 split。
多端传同一权威 refs/epoch；离线 projection 不自造身份或权限，晚到旧 refs 仍受当前授权复核。
持久接入需要 AR0b 的 baseline/checkpoint/seq/删除/崩溃重放合同，不能用一个 RAM validator 代替。

## 6. 分阶段接入

| 阶段 | 建议内容 | 当前 |
|---|---|---|
| SP0 | 纯 RAM typed validator + projection 契约、不可变合成 registry/profile fixture 与 demo | 未开工；建议下一独立代码 slice |
| SP1 | 对象属性保留、原型/残差压缩的质量与总成本对照 | EXPERIMENT_NOT_RUN |
| SP2 | 跨 encoder/profile 升级、adapter 与无原件降级 | EXPERIMENT_NOT_RUN |

SP0 可与 AR0b ADR 并行；不接感知模型、媒体采集、持久 schema、宿主路由、外部 API 或生产数据。
候选 SP0 输入上限为32 objects、64 relations、32 anchors、64KiB受限JSON；尚未开工冻结，不是现行容量。
先冻结闭合字段、深度/长度/数量、版本/引用/单位与失效规则；synthetic registry/profile 不接受自行变更后冒充旧版。
未来 demo 机制目标可叫 SCENE_CONTRACT_PASS，并同时保留 PERCEPTION_NOT_RUN；现在没有该实现或 PASS 结果。
结构 validator 只能检查合同，不能认证现实身份、物体检测真值、感知质量或生产安全。
AR1 的真实 embedding/BM25/PPR 检索协议不被 ScenePacket 替代；语义检索与对象表征有各自对照和准入。
durable ScenePacket 接入受 AR0b migration 门约束，不提前修改 Core 数据格式或现有 AR0/L1 读取用途。

## 7. 待冻结的实验与删减条件

以下是同预算比较建议，尚未冻结协议、准备数据或运行；候选60家族/20dev/40heldout不是科学 power 结论。
按对象场景来源家族分组，冻结 profiles、量化/截断、总字节预算、gold、硬件与评测程序后再看 heldout。
共享字典/decoder 按明确规则计总成本或摊销，并单列 metadata、索引、冷原件，不以“每条残差很小”比较。

| 组 | 候选表示 | 主要可识别对照 |
|---|---|---|
| G0 | plain gist | 文本压缩基线 |
| G1 | typed structure，无 anchors | 结构本身 |
| G1+A | typed structure + anchors | 与G1比较，直接识别 anchor 收益 |
| G2 | typed + prototype，无 anchors | 与G1比较原型先验 |
| G2+A | typed + prototype + anchors | 与G1+A比较原型，与G2比较 anchors |
| G3 | typed + prototype + residual + anchors | 与G2+A比较残差 |
| G3−A | typed + prototype + residual，无 anchors | 与G3比较 remove-anchor 消融 |

各组同总成本上限并报告实际成本；不能让 anchors 组暗中多存原件，或让 gist 组无意义空转。

| 优先 fixture | 检查重点 |
|---|---|
| 特殊信息与原型冲突 | 裂纹/颜色/单位字段等关键属性不得被典型原型覆盖 |
| 两个相似杯子与属性交换 | object/role 绑定、track 候选与 entity 身份不混淆 |
| 动作先后、未知/遮挡 | 时间偏序、缺失与置信度，不能补0或补成确定事实 |
| 2D误当3D | frame kind、单位、轴/旋转/covariance、transform rev不匹配拒绝 |
| 跨语言 label | 定义版本稳定，翻译/别名不改旧事件或 split |
| 模型升级与无原件 | profile mismatch拒绝、旧空间正确解释、授权重编码或 unavailable 降级 |
| 撤销与多端旧refs | 结构/残差/个人原型 lineage 失效，离线副本不恢复权限 |

指标分别记录对象属性绑定、时序、稀有关键属性保留、证据支持、原型诱导错误、迁移变形、bytes/latency/RAM。
残差重建 MSE 不能替代事实正确、原件核验或上述关键属性指标；结构字段存在也不等于填写正确。
越权、撤销复活、跨版本误解码直接 FAIL，不得用平均压缩率抵消；不根据 holdout 改门或追加样本找显著。
若没有稳定收益，删除残差或映射层，保留更简单的 typed+anchors/gist 路线；生物或模型解释性不免除该对照。

## 8. Primary 参考与许可边界

只核对资料中相关机制/边界，没有复现论文实验、下载权重或引入第三方实现。

| 来源 | 可借鉴与不能推出的结论 |
|---|---|
| [Slot Attention，NeurIPS2020](https://proceedings.neurips.cc/paper/2020/file/8511df98c02ab60aea1b2356c013bc0f-Paper.pdf) | slots 可交换、可绑定不同对象，不是长期ID或稳定概念地址。 |
| [ConceptGraphs，2023 preprint / ICRA2024](https://concept-graphs.github.io/assets/pdf/2023-ConceptGraphs.pdf) | 依赖RGB-D/pose及多视图关联，漏检/描述错仍可能发生；原文将temporal dynamics列为未来工作，非完整事件记忆。 |
| [Hydra，RSS2022](https://arxiv.org/html/2201.13360v2) | 在线3D场景图与loop-closure优化不等于多年个人记忆、授权或跨模型概念稳定性。 |
| [Anthropic，2023](https://www.transformer-circuits.pub/2023/monosemantic-features/index.html) | dictionary feature是activation space方向，不是可固定寻址的模型weight；其代码许可本轮未核。 |
| [OpenAI，2024](https://arxiv.org/html/2406.04093v1) | SAE重建/稀疏性与行为质量不同，非零误差可能遗漏关键特征，不能把低MSE当语义事实保真。 |

本轮代码许可核对记录：[google-research/slot_attention](https://github.com/google-research/google-research/tree/master/slot_attention) Apache-2.0；[concept-graphs](https://github.com/concept-graphs/concept-graphs) MIT；[MIT-SPARK/Hydra](https://github.com/MIT-SPARK/Hydra) BSD-2-Clause；[openai/sparse_autoencoder](https://github.com/openai/sparse_autoencoder) MIT。
这些只限所核代码范围，不自动覆盖模型权重、数据、媒体或其他依赖；本文无需引入这些代码。
下一步先由 Root/max 审阅本设计，再决定是否冻结 SP0 独立实现；AR0本批机制验收不能转记为SP0/SP1/SP2或感知PASS。

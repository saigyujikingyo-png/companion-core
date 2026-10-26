# AEMC：数据库结构、交换格式与压缩研究计划

状态：**DESIGN_ONLY / EXPERIMENT_NOT_RUN**。日期：2026-10-26。
本文回应本轮数据库/整体架构/专属文件格式与压缩增量，不是已实施的数据库迁移、新格式或 codec PASS。
它承接 [v0.6 表征设计](AEMC-V06-REPRESENTATION.md)与 [v0.5 研究路线](AEMC-V05-REVIEW.md)，不改变已验 [AR0](AR0-RETRIEVAL.md)运行代码。
本轮只做官方格式资料核对和设计评审；没有安装整套格式栈、下载媒体/权重、迁移数据或运行压缩基准。

## 1. 决策：先公开逻辑协议，再选容器与 codec

优先自研公开、版本化的逻辑 schema/profile；先采用标准 manifest、容器与无损 codec，不先创造二进制格式或堆依赖。
权威事实应能由独立 reader 读取，不能必须绑定某版 LLM、encoder 或 decoder 才能理解基本 claim。

| 决策层 | 当前选择 | 研究进入条件 |
|---|---|---|
| ScenePacket / ConceptRegistry / MappingProfile 逻辑协议 | 应做公开规范、版本、类型、来源和权限合同；尚未实现 | SF0 可先纯 RAM schema/fixture/可读导出设计 |
| 标准 manifest+blob 目录 / 标准容器 profile | 优先，以资产用途选最少组件 | 固定逻辑 payload 后做独立合成 bench |
| 专属二进制容器 | 延后，不因名称专属就有价值 | 标准方案不足的实测证据、独立 reader、测试向量、迁移/降级策略 |

专属语义 codec 可作为另一研究分支，但不能把 PQ/RVQ/delta/Zstd 改名宣称发明。
AEMC 的贡献应来自有证据的新组合、任务收益或运维/权限保证，不由算法命名决定。
逻辑概念/事实 schema → 权威事务与外部 object → 交换容器 → codec 是不同层；JSON Schema、Parquet、Zstd 不做同类排名。

## 2. 拟议数据库职责（不是现行 schema）

延用现有 event/source authority，不建立第二份可自行授予权限或改写来源的真相。
下面是迁移前的职责草图，不代表本批已创建表或允许把结构 JSON 塞进 self_report 绕过 Core。

| 拟议表/记录 | 主要字段与职责 | 权威约束 |
|---|---|---|
| scene_packets | revision、scope、generation、payload_version、时间、status | 绑定既有 event/source，保存结构记录版本 |
| scene_objects | packet/object ref、track/entity/concept refs | 类型、追踪假设与现实身份分开 |
| scene_assertions | object×predicate×typed value×time、epistemic、source refs | 数值/单位/角色/来源绑定，不由原型补事实 |
| concept_definitions | namespace/id/definition revision、labels、status | 公共/私人命名空间、retired ID 不复用 |
| mapping_profiles | profile/version、完整资产及 decoder/quantizer/calibration refs | 跨版本不可按 index 猜兼容 |
| artifact_refs | scope、URI、digest、bytes、codec profile、retention | 位置/完整性不等于访问授权 |
| lineage_links / derived_projections | source refs、profile、checkpoint/watermark | 可重建索引与撤销关系；具体持久迁移归 AR0b |

私有事实/source 的主键与外键绑定所属 scope/version，避免跨 scope 借同名 ID 混用。
公共 concept registry/profile 可经明确可见性授权引用，不粗暴要求所有引用同 owner；公共 ID 不授予私有 source 读取权。
claim 表持有事实值并声明唯一 owner；ScenePacket 固定引用 claim revision，不能让 JSON 与 claim 表成为两份可独立修改的事实。
JSON 交换 payload 是该提交版本的序列化；payload/引用与可查询 claim 列在同一事务更新，不接受无协调编辑。
库引用事务还包含相应 lineage/outbox/receipt；vector/scene graph 只是可重建 view，不反过来决定来源是否有效。
对象关系/时序图可有环或偏序，provenance 撤销依赖仍是单独 DAG，不能混为同一张图。
当前 AR0 只有 query-local RAM pair，不写上述持久表、不消费现有 outbox ACK。
SQLite 先保留；只有多 writer、规模、恢复或运维实测需求成立时，再比较 Postgres 等后端，不先迁库。

## 3. 物理布局与跨资源提交

以下是布局候选，不是当前源目录的数据布局或性能保证：

```text
权威热层：SQLite manifest / claims / source references
本机 SSD：可重建 lexical/vector/scene-graph 索引与热点资产
外部对象：按授权域、asset ID、profile/version 组织的 SSD/HDD/NAS blobs
标准导出：独立 snapshot/manifest + 选定标准容器，不反向覆盖权威
```

外部 blob 不属于一次 SQLite 事务自动覆盖的资源；先明确每类 backend 的持久性/rename/flush 假设。
候选流程：stage → 验证 hash/length/profile → 原子 publish → DB ref commit，所有步骤都要有幂等与失败状态。
“原子 publish”只在同一支持的文件系统及已验证持久 flush 假设下成立；跨盘/NAS/云端不能假设 rename 原子。
每种 backend 需单独崩溃验收；数据库事务成功不证明媒体已持久，文件出现也不证明 DB 已提交引用。
blob 损坏或缺失明确返回 unavailable，不拿旧文件、生成图或推测内容替代所引用资产。

| crash 点 | 必须验证的恢复状态 |
|---|---|
| stage/校验前后 | 半写/长度不符资产不可见，不产生可用 DB ref |
| publish 后、DB commit 前 | 可能有未引用 orphan；不冒充已提交事实 |
| DB commit 后 | 引用资产完整可用或明确失败封锁，不回报虚假成功 |
| 重试/GC 中断 | 重复幂等，旧操作不能删除新活跃资产；有界恢复且不无限重试 |

orphan GC 延后设计；先证明引用、epoch、保留与并发规则，再回收，不能先删除活跃 dictionary/profile/asset。
blob 去重不等于独立证据去重；scope 内 object identity/去重隔离即可，不为本研究设计自创加密。
namespace/ACL 不能被全局 hash 去重绕过；digest 是完整性标识，不是读取 capability，也不是世界事实真值。
hash 仅标识所需资产，不证明当前还能获得该资产；reader 必须核实全部 decoder 依赖可用。
个人 dictionary/prototype、索引与映射 cache 均保留 lineage；删除派生物后应能从仍授权来源重建。
旧快照恢复必须对 fresh tombstone/authority 复核；校验和或 AEAD 不证明撤销水位新鲜。
现 M2 的 `KNOWN_UNPROTECTED_LEDGER_ROLLBACK` 仍保留；格式/加密不能修复有效前缀账本回滚缺口。
备份、导出与冷副本都受保留/权限治理，不能从“主库已删”推导所有介质物理擦除。

## 4. 六类 primary 对照

只选择与资产用途相符的 profile；不同时强制引入下表全部栈。

| 类别与官方来源 | 合适用途 | 不提供的保证 |
|---|---|---|
| [SQLite transaction](https://www.sqlite.org/transactional.html) / [WAL](https://www.sqlite.org/wal.html) | 单库权威事务、热 manifest/claim 与一致读取 | 不自动包住外部 blob；WAL 的同机共享约束不能忽略 |
| [JSON Schema](https://json-schema.org/learn/getting-started-step-by-step) | 逻辑结构、类型和字段验证，可读 manifest | `$schema` 是验证 dialect，不是业务 `schema_version` 或认证 |
| [Arrow IPC](https://arrow.apache.org/docs/format/Columnar.html) / [Parquet](https://parquet.apache.org/docs/file-format/) | Arrow 批次交换；Parquet 列式快照/分析导出 | Arrow stream 固定 schema、file 有 footer；Parquet 不是实时事务日志 |
| [Zarr v3](https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html) | 分块 N维 typed tensor 与大数组 | 上层仍需原子发布、权限、完整性与删除治理 |
| [MCAP](https://mcap.dev/spec) | 按时间/通道组织多模态消息，schema/profile 与可选索引 | 容器不解决撤销、身份或跨资源事务 |
| [Zstd frame](https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md) / [seekable profile](https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md) | 标准无损压缩；独立 frames + seek table 可支持定位 | 普通单 frame 不提供任意 seek；索引与 decoder 依赖仍计成本 |

SQLite DELETE 不等于物理擦除；[secure_delete](https://www.sqlite.org/pragma.html#pragma_secure_delete)/VACUUM 也须结合 WAL、FTS影子内容、备份与 export 治理，不能承诺所有历史介质消失。
本轮核对的是规范相关定义，不是各平台 reader、吞吐、断电、十年保留或产品安全实测。

manifest 分列 logicalSchemaVersion、containerProfile、codecProfile、encoded/decoded sizes，以及 canonicalization、数值/单位约定和全部 decoder 资产。
manifest/profile 只是数据，不执行其中 URI 或 decoder 代码；仅调用预先允许的 decoder 实现，不动态拉取远端程序。
独立 reader 验证相对路径/链接，实测编码与实际解码 bytes、深度/数量上限，不能只信 manifest 声明；防路径逃逸与解压超限。
未知 codec/version 拒绝或明确降级；旧 reader 遇新 major 可以明确拒绝，不要求逆向猜读。

## 5. 无损与语义压缩分别研究

先固定逻辑记录的标准序列化和 Zstd 无损 baseline，记录输入/解码字节等价与版本依赖。
无损恢复的是送入 codec 的记录；此前感知抽取、裁剪、量化已丢的信息不会因无损压缩重新出现。

| 重建域 | 可以测什么 | 禁止混称 |
|---|---|---|
| 原始 bytes/media | 输入字节精确恢复，或另明示媒体有损指标 | 不能用结构记录恢复当成原始视频无损 |
| typed structure/claims | 类型、角色、数值/单位、身份、顺序与来源是否保留 | 字段存在不等于事实正确 |
| latent vectors | 固定 profile 内数值/任务误差、alignment 与 decoder 输出 | 低 MSE 不等于关键属性/行为保真 |

语义研究候选依次比较：typed+anchors、结构/时序 delta、共享 prototype+quantized residual、task-weighted allocation。
delta 依赖链必须有最大深度与 checkpoints；随机读取不能无限追溯，更新/删除引起的重写量计入成本。
scalar quantization、PQ、RVQ 都只是候选成熟 baseline，尚未选择或实现；先做消融，不改名作创新结论。
所有 decoder 所需 dictionary/profile/calibration/quantizer 版本都保存、校验并计成本，不能从评测账本里隐去共享资产。
学习码本、adapter 与质量调参只用开发组，不能读取 holdout 来训练或挑选版本。
hard anchors 单独保护并验证数值/单位/身份/动作次序错误；新颖/惊奇用于价值估计，不等于事实可靠度。
预算分配应基于明确任务损失和风险，不把所有低频信息压掉，也不靠平均 MSE 掩盖稀有关键属性损失。
personal learned compression 遵循具体训练用途授权与撤销传播；不自动向 L1 提供训练数据或把候选 manifest 当许可。
无法局部去除污染的 opaque 表示按 v0.6 设计 reset/rebuild；数据库删行不等于已训权重遗忘。
压缩 payload、索引/registry 与事实读取权限仍分开；成功解码也须在使用/交付前检查当前 authority。

## 6. 评测矩阵与 go/no-go

先固定同一有效逻辑 payload、各组同总 bytes 上限、语义质量门与硬件，再比较 codec 或容器。
计 headers/index/metadata/WAL/cache/replica/dictionary/decoder 依赖与冷原件，分别报告共享资产成本和摊销假设。
cold 与 warm 各测；不能用一方热缓存对比另一方首次加载，也不做无意义计算伪造等成本。

| 维度 | 必测内容 |
|---|---|
| 访问 | 逐条、时间范围、随机查询的读放大；有效输出之外实际读取 bytes |
| 时延/资源 | p50/p95、CPU/RAM、build/encode/decode 吞吐、峰值暂存空间 |
| 变更 | 增量更新与删除的重写量、delta 最大链深度/checkpoint 间隔、个人字典失效 |
| 可移植 | 跨 OS 独立 reader、已声明 schema 双向兼容/迁移、旧版 fallback 与 profile 缺失拒绝 |
| 容错 | truncate/corrupt/bitflip、断电点、坏 chunk、缺 dictionary/profile、半发布与重复恢复 |
| 权限 | tombstone stale restore、撤销水位落后、scope 越界、派生索引/冷副本残留 |
| 语义 | 稀有属性、身份/时序、来源支持、校准拒识、原型诱导错误与权限残留 |
| 长期 | 版本 fixture、备份恢复演练、时间模拟；不写成真实运行十年验证 |

schema“兼容”要指明新增/删除字段、必需 feature、单位与语义变化；不认识必需 profile 不能静默按旧版解码。
parser/解压器设输入、解压后、分块、嵌套、字典和恢复次数上限；压缩比好不能豁免解压炸弹 bounds。
迁移先写新库、验证再切换，保留旧库与旧 reader；迁移和降级保存失败证据，不为 benchmark 覆盖用户数据库。
介质擦除另按 backend/备份策略验证，不由逻辑迁移承诺。
任何越权、撤销复活、profile 误读、无限恢复或 bounds 失败立即停止；压缩 gain 不能抵消事实错误。
新 codec 只有在事前冻结的质量/成本门下有明确收益才继续；未达标就采用标准方案，不反复改门寻找胜出。
基准规模、family split、seed、置信区间与具体数值门另冻，不借“十年目标”或理论推导宣布产品可靠。

## 7. 可执行研究顺序（均未实施）

| 阶段 | 建议内容 | 门槛 |
|---|---|---|
| SF0 | 逻辑 schema + 标准 manifest、合成 fixture、可读导出计划 | 可随 SP0 纯 RAM 探索；不改 durable schema |
| SF1 | 标准容器/codec baseline 的独立合成 bench | 固定同 payload 与总成本、独立 reader 和全部版本依赖 |
| SF2 | 故障恢复、撤销与迁移验收 | 先冻结崩溃/损坏/旧快照矩阵，验证新库切换与旧库降级 |
| SF3 | 压缩对照与消融 | 新 binary 仅在标准容器不足时研究；语义压缩按预先冻结的任务收益问题，与标准基线独立比较；质量门与成本门事前冻结 |
| SF4 | 跨 OS / 旧 reader 演练 | 公开规范、测试向量、major 拒绝与迁移/降级策略可独立验证 |

最小原型建议仅 manifest JSON + typed blob refs；之后按需选择 Zarr/MCAP/Parquet，不为研究直接引入新服务器或全部依赖。
SF0 的 JSON Schema 版本、业务 schema_version 与容器/codec profile 分别固定，测试不能只通过某一库的默认参数。
新格式须有不依赖专属 LLM 的独立 reader、可审测试向量和 bounded 失败模式，权威事实不能锁死在 latent 中。
durable 接入仍须通过 AR0b migration/consumer baseline/删除/崩溃恢复门，不因交换文件能读写就跳过。
已有具体授权、预算与准入规则继续适用；本文研究设想不新增真实数据访问、上传、训练或部署权限。
下一步由 Root/max 审阅本设计再选择最小 slice；当前没有数据库迁移、专属格式、压缩算法或存储基准 PASS。

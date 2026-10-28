# IF10 长期精确账本容量路线

2026-10-27。**DESIGN_ONLY / NOT_IMPLEMENTED / NOT_BENCHMARKED**。Root整合两位独立Astra max的方案及反证；[IF9](CAPACITY-REPACK.md)仍是当前实现边界。设计对象是精确运行控制记录，与[允许有损的内在痕迹](ADR-MEMORY-TOOL-BOUNDARY.md)分开，不通过删除幂等、UNKNOWN、撤销或提高现有上限取得容量收益。

## 取舍和先后

| 路线 | 决定与原因 |
| --- | --- |
| Safety不可变终态单冷段 | 下一实施候选；查找与终态边界集中，能减少每次提交重复携带的已终结历史 |
| Store tombstone/整图冷迁 | 后续独立合同；ingress返回节点当前revision/status，job/result、依赖、outbox和consumer仍引用节点，不能只搬一个表 |
| authority跨代永久索引路由 | 后续可信根协议；receipts及legacy唯一索引跨vault，复制一个新库并不缩小精确索引，须完整查询、切换和故障闭包 |

有限空间的精确映射不能无限记住任意新ID；Bloom过滤器、TTL遗忘或仅查询热区均不能替代永久重复/冲突判定。IF8复用回执页，IF9减少镜像碎片与Safety编码成本，都未解决无限历史。

## 单冷段的拟定合同

拟议 `archiveTerminalSafety` 显式维护只读exact current，不boot/sweep，使用新目标、新instance、ownerEpoch+1及现有PREPARED/publish/finalize。仅 `failed`、`unknown`、`acknowledged && feedbackConsumed` 可冷迁；pending/ready/taken和未消费反馈的acknowledged保持热区。UNKNOWN归档不等于已解决。

保留每条完整entry JSON、原ordinal、request key/fingerprint/state/deliveryId/reserved/feedback，以及所有全局reserved/lastSourceRef/lastWall/lastAcknowledgedDeliveryId。固定STRICT SQLite段在RAM构造，request key精确主键、非null delivery唯一、ordinal完整；候选使用WITHOUT ROWID，实际收益须测。首片总条目仍≤8192，冷SQLite明文≤8MiB；AEAD密文另设由nonce/tag/framing精确推导的界，不能把明密文界混用。maxCalls≤32、image16MiB、目录256MiB、回放64MiB保持。

一个不可变加密 `safety-<cipherDigest>.bin`，后续维护合并旧冷段与新终态成一个新generation冷段，保留旧文件。以不循环的vault/generation/keyEpoch/用途绑定AAD，再由generation head身份固定描述，并由加密record/frame的认证链绑定最终cipherDigest、字节数、格式、计数和逻辑摘要；head身份字段本身不是加密载荷。**冷段根必须固定在generation identity及authority普通write身份比较中**，普通write或提前base不能改根。

归档转换的前后快照必须按原序重建为完全相同的Safety。后续查询验证当前head对应的热冷并集，允许合法热区新写及状态变化，冷段自身内容保持不变：key与非null delivery全局唯一；ordinal无缺失或重复；索引列与JSON一致。缺文件、索引缺行、重复或不符均为corruption，不得当作不存在；缓存不能代替提交前必需文件闭包核查。

所有claim/reserve/terminal/feedback/delivery唯一性/status经统一SafetyLedger双读接口；不做双写。计数与8192门使用hot+cold总数。保持现有错误优先序：claim先判重复/冲突再判满；reserve先判额度；冷terminal同状态同delivery无写返回、不升温或创建替代entry；冷已消费反馈仍拒绝重复消费。

新profile最多**含base共15帧**，即14delta；一个冷段只读取和累计计费一次。备份manifest最多 `2×15+1=31` 个数据文件，两个备份说明文件另列；须同步改白名单及精确闭包校验。冷库只在RAM按严格已知layout打开/查询，不产生明文临时文件；若仍整体解密冷段，不声称按需RAM收益。展开前验证各descriptor与剩余总预算，包含SQLite冷段、image patch和热Safety。

持久化冷段与full base后才PREPARED；reconcile仅验证并发布冻结输出，不重新选择条目。PREPARED缺必需文件保持未决；finalize失回应时同operationId返回原receipt。backup必须自包含冷段；rekey验证后用新DEK重加密，新目标不能依赖旧DEK。legacy admission、来源唯一槽、旧源fencing和跨vault pending门均保持。

## 实施前需冻结的接受出口

公开API生成三类可迁终态与不可迁未消费反馈；满8192下旧ID同载荷/异载荷、UNKNOWN重试、delivery冲突与反馈错误均保持。注入冷段缺失、替换、错vault/epoch、索引缺行及热冷重复，必须拒绝。真实子进程在PREPARED、发布中、finalize失回应死亡；双进程竞争、旧源fencing、完整backup/rekey/restore/legacy链都纳入。

相同合法合成历史与IF9比较**完整base、之后固定次数写入、完整备份、恢复时间和峰值内存**，不只报热数组变小；小冷段可能因SQLite索引与额外文件更贵，结果如实保留。至少一个纵向测试贯通归档→冷键冲突/终态重试→热反馈完成→backup→rekey→restore。不得用结构注入8192替代完整业务历史，也不将该首片称为突破8192或十年容量验收。

[SQLite WITHOUT ROWID](https://www.sqlite.org/withoutrowid.html)可减少非整数主键的重复B-tree；[deserialize](https://www.sqlite.org/c3ref/deserialize.html)与[Node24.16 SQLite](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html)提供RAM载体基础。[URI immutable](https://www.sqlite.org/uri.html)是文件不变假设，不能替代认证根或fencing。这些资料支持组件选择，不证明以上协议已实现或通过测试。

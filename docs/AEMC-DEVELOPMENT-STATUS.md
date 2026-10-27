# AEMC 开发状态、架构取舍与合并候选

2026-10-27。本轮范围是基础设施独立工作树，基线 `d23921f5abc5be10f15883a1a5289af842299b3f`。完整目标仍 **IN_PROGRESS / TRAINING_NOT_ADMITTED**。本页区分实际代码、验证层和目标缺口，不计算一个混合完成率。

## 已落地的能力链

```mermaid
flowchart LR
  A[当前来源 同意 撤销与祖先闭包] --> B[外锚提交 恢复 fencing 密钥迁移]
  B --> C[v3 块增量 链备份 新目标压实]
  C --> D[schema2 持久消费者与完整进度]
  D --> E[IF5 当前授权检索与交付复核]
  B --> F[IF6 写入容量准入与完成预算]
  E --> G[后续 AR1 质量实验 尚未启动]
```

| 层 | 实际实现 | 仍不能推导的结论 |
|---|---|---|
| 来源与当前权限 | Store scope/consent/runtime、精确来源与完整祖先、撤销/过期复核 | 跨设备身份认证、真实素材使用权、事实语义为真 |
| IF0–IF2 存储与消费者 | M2隔离恢复、独立本机外锚、PREPARED/reconcile、旧anchored源fencing、KEK rewrap/DEK rekey、schema2双metadata消费者 | 生产custody、硬件防共同回滚、全局外部索引、十年容量 |
| IF3–IF4 热存储与导入 | 4096字节块replacement/XOR+Brotli4/raw、单blob、有界恢复链、保原密文备份、新目标compaction；M2冻结包导入、lineage防重和实际准入门 | 物理磁盘写次数、历史GC、旧M2副本fencing、真实私有库迁移 |
| IF5 / AR0b1 检索接线 | 完整durable projection在同一guard/冻结时间内与正文及祖先匹配；bind/refresh/query/resolve均复核消费者进度；过预算全拒绝 | 新排名算法、真实embedding/BM25/PPR、多跳或语言质量提升、宿主已接线 |
| IF6 容量失败处理 | 新PREPARED前预演最终化与日志预算；单pending全局新写门；捕获mutation异常也不能提交部分状态 | OS磁盘空间预分配、无限容量、全部旧异常pending可恢复、混跑旧writer安全 |

IF5选择先接完整性边界：持久消费者已有实际进度，旧RetrievalService却仍依赖手工refs。新增 [durable retrieval](DURABLE-RETRIEVAL.md)使两者形成真实调用链，原AR0字面/共享来源排序保持不变；先解决选集的完整性与当前权限，再做排名质量实验。

IF6来自新审查发现的容量P2，而非原计划中的扩容工程。只将TEMP源码的64MiB读界缩到64KiB，就能通过真实API重现提交后越界以及PREPARED无法重开。修补保持64MiB读硬界，默认新增写准入为22369621B；预演同一最终化SQL，给数据库与回滚日志留界。一项未完成意图会阻挡同外锚的新写入；真正不写的读取与有预算的reconcile保持可用。boot及跨TTL查询需要持久写，仍可能拒绝。具体证明、旧版本兼容和失败记录见 [容量合同](AUTHORITY-CAPACITY.md)。

## 总目标进度

[完整矩阵](AEMC-INFRASTRUCTURE.md)的18项按当前缺口互斥分类如下。IF5仅补I05接线，IF6仅补I01/I02故障处理；没有把质量、生产或完整训练前项自动转为已接受。

| 当前类别 | 数量 | 条目 |
|---|---:|---|
| 本机实现子集，完整目标开放 | 4 | I01存储、I02密钥/恢复、I03存储协议/成本、I05多消费者 |
| 已有局部基础，独立接受开放 | 4 | I00权威、I09背景/关系、I14语言/宿主、I16历史/cache |
| DESIGN_ONLY | 6 | I04概念、I07多模态、I10sleep候选、I12跨代、I13后端、I17元记忆 |
| NOT_STARTED | 3 | I06质量实验、I11自主sleep、I15具身 |
| UNDECIDED | 1 | I08候选机制取舍 |

完整训练前接受仍为0项；这不否定已通过的本机子集，也不将局部通过外推到整项目。物理终端覆盖D01与生产信任域D02等决策继续开放。

## 验证层与后续顺序

[IF4证据](AEMC-INFRA-EVIDENCE-IF4.md)保留原822/822、类型检查和三组成本测量；相对同codec完整快照，hot逻辑新增字节减少47.38%–49.58%，不是设备物理写入量。IF5作者关联159/159与独立静态审查完成。IF6作者分项含真实进程恢复、hot journal、legacy登记回滚、吞异常和TTL跨vault接缝，失败/环境拒绝与返验分别保留。[最终IF5/IF6组合证据](AEMC-INFRA-EVIDENCE-IF6.md)已闭合：独立874/874、typecheck与成本测量通过，134源码文件逐项一致，两位独立终审无剩余可操作P1/P2。相对完整br4，三种工作负载的hot逻辑新增字节分别减少47.40%/49.08%/49.64%；不把各轮专项数量相加。

下一步按依赖推进：

1. 把最终组合候选送独立PR/精确提交CI，核Windows/macOS/Ubuntu固定Node及Ubuntu24.x；本机通过不替代这些结果。
2. 容量运维：区分generation占用、Store image/ingress额度和authority receipts的长期增长。compaction不释放后两类；先设计保持幂等/消费账本的运维协议，再讨论冷历史/GC，不能丢掉已消费ID或UNKNOWN。
3. 生产信任域：冻结authority/custody owner、独立备份/共同回滚威胁、实际恢复RPO/RTO与旧writer停用方案，再做真实环境准入；目录名字本身不提供信任。
4. AR1质量：先固定来源权利、query/support答案、家族/时间切分、算法版本、质量与总成本门，再比较BM25、embedding、PPR及seed策略。检索引用有效不等于答案正确；本轮不调用模型或训练。
5. 按矩阵推进概念registry、资产生命周期、可撤销状态持续、逐claim查证、sleep和跨代迁移；保留各自接受出口，不以存储压缩收益替代表征质量。

## 合并范围与建议

建议只处理 `codex/aemc-infrastructure-20261027` 的基础设施候选，目标为**公开**GitHub仓库 `saigyujikingyo-png/companion-core` 的 `main`。2026-10-27T09:12:46.707412Z只读核查仍在上述基线，开放PR为0；精确新提交CI尚未执行。Core/WF2与storage lab的dirty成果留在各自树中，不在本次候选里拼接。初次审计三树HEAD相同，分支间已提交diff为零，直接merge会是空操作；必须先把指定文件形成可审查提交，才有实际合并对象。

已保留IF4历史38文件原生TEMP候选，含按旧132源码manifest验证的恢复文件；早期沙箱TEMP副本未跨调用保留，已明确作废。最终IF5/IF6候选另存完整文件清单、字节快照与hash，精确原生TEMP位置记在排除入库的交接中；不能冒称等于旧候选。公开文档使用 `%LOCALAPPDATA%\Temp` / `<INFRA_WORKTREE>` 路径占位符，原始日志及本地交接保留精确路径。

建议授权链为：审阅最终文件清单/差量与本机证据 → 用户确认提交及PR范围 → 精确新提交CI → 用户所确认的条件满足后合并。若目标main改变或出现冲突，重新检查整合源码并做对应验证，不沿用旧组合PASS。用户本轮说“考虑合并”；项目AGENTS明确要求的是合并前确认。Root本轮先准备本地可审阅的公开候选，尚未commit/push/创建PR；这是本轮执行范围选择，不把AGENTS解释为逐项要求这些操作另行审批。实际merge仍等待用户确认，不修改其他聊天的工作树。

合并不构成部署、真实私有迁移、provider调用或训练准入；这些接受层始终单独记录。

# IF3 增量存储、压实与旧 M2 导入计划

2026-10-27。用户要求继续自主实现：先确定增量/compaction路线并解决整库快照写放大，再完善旧M2导入。当前为实施前冻结合同，不是结果；IF2 的778 PASS只覆盖其原快照。

## 路线定案

采用完整 SQLite RAM COMMIT/serialize 后的4096-byte固定块 replacement/XOR变换，再用标准 Brotli quality4；不是新熵编码算法。保留Store/FTS业务事务，不使用业务命令重放；SQLite session不捕获虚表，因此本轮不采用其作为完整持久化层。[Session限制](https://sqlite.org/sessionintro.html)、[SQLite页布局](https://www.sqlite.org/fileformat.html)。serialize与扫描仍是O(image)，本轮解决落盘重复写，不冒称RAM/CPU也已增量化。

- 新强制 anchored-v3/storage profile，旧v2/M2路径保持兼容。新profile不能无声降级；密钥/owner/schema/profile绑定至认证上下文。
- 首帧完整base，每最多16帧一个base（最多15个delta）；同codec下delta不小于full则选择full，压缩不划算选raw。高熵输入允许无收益。
- 帧绑定父head、基底和目标image SHA256、目标长度、固定blockSize、严格升序唯一补丁与末块长度；count、累计read/decoded bytes、输入/输出都有硬界。Safety/额度/终态/反馈/撤销独立完整认证，不弱化为可跳过的增量。
- immutable ciphertext blob仅写一次；staging记录ref/digest和小record，避免base64大密文重复落盘。冻结、fsync之后才能外锚PREPARED；发布固定引用/record后ACTIVE。只有finalize成功后更新RAM durable baseline。
- 异常poison；pending reconcile从oldHead验证基底，仅完成原固定字节，不运行boot/业务/provider。缺片/冲突保持UNRESOLVED，不回旧head。
- backup携带最近base到exact current head所需原密文链，覆盖current-state；不扁平化后冒用原record digest。恢复/rekey/schema迁移/维护都先物化验证，再新目标base切换。

## compaction

第一步static exact-current读取且无Store boot，在新目录写完整base，提高ownerEpoch、更换instance、保留schema/keyepoch/业务状态，parentHead绑定切换时current head；沿用PREPARED/fencing/reconcile。原目录保留，不能把active缩小描述为总磁盘已回收。

冷端若未来有明确历史保留需求，优先标准分段容器＋成熟codec；本轮不新增冷归档产品，热增量、新目标base压实及current-state备份闭合后直接做旧M2导入。禁止删原件时，另造cold副本只增加总占用。侧边SL0/SL1实验在独立worktree `aemc-storage-lab-20261027`，Root只读引用，不合并其未提交分支。独立max复核报告/源码hash与尺寸计算，未推翻其尺寸结论；发现restoreAt把未读取的后续帧也计为validated bytes的P2，故不采用该指标作为整档认证证明。应用image-history收益不能外推为整vault收益。

## 实施前测量门

同一冻结合成输入/操作序列/保留范围比较旧v2 full raw、v3 forced-full Brotli4、v3 incremental Brotli4。逐帧精确恢复，schema/FTS/Safety/撤销/消费者一致为硬门。稀疏发布、修订撤销、双消费者三组：增量相对forced-full压缩控制的新增本地字节目标至少减少15%，相对旧raw至少50%；高熵control报告真实膨胀/fallback，不声称普适收益。参数和门不按结果暗改。

统计实际blob、record、stage、外锚/receipt变化、backup/cold archive、保留原件与峰值空间，不以纯image payload替代完整写入成本。报告decode/replay count、startup、commit/compaction latency与内存；有限样本不作SLA或十年外推。运行只新TEMP合成，fresh资源检查、低并发。

## 旧M2导入边界

热存储/压实稳定后实现：[旧M2实施合同](LEGACY-M2-IMPORT-PLAN.md)。从完整已验证M2 export包导入新目标，原件不改；可信head下界和声明exact tip分别绑定。旧格式无法证明latest或fence未接外锚旧副本，receipt必须明示。新claim/reserve在独立authority准入前实际拒绝，不能仅写manualResumeRequired字段。

同一外锚内按已验证genesis authority hash+identity派生lineage并全局唯一登记，换vault/operation/prefix不能再次获得导入额度；登记/tombstone不随compaction删除。新DEK独立生成，稳定ingress HMAC必须保留旧key，Store ledger_key/已用额度/反馈/撤销保持；旧key仍可读旧密文，不称泄露补救或crypto-erasure。pending/ready/taken最终变UNKNOWN，不自动恢复外部调用。实际私有库导入、旧运行停用、真实密钥托管仍非本轮合成执行。

## 所有权与闭环

独立manual worktree/branch保持，Root定案与整合；Astra xhigh单写者，两个Astra max只读研究/审查，Sol独立最终验证。每段作者专项→审查修补→最终冻结whole/typecheck，证据分层保留。未merge/push/训练；侧聊天成果只读接受，不主动回信。

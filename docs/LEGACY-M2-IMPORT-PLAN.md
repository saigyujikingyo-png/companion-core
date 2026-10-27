# IF4 旧 M2 导入实施合同

2026-10-27，Root依据两位研究/审查代理与实际代码定案。先完成IF3热增量/压实，再实现本入口；本文不是执行结果。只在新TEMP生成合成M2数据，不读取真实旧库、DPAPI或密钥文件。

## 输入和信任

增加inspect/import独立API，接受完整M2 export包（三文件）、RAM内legacyKey、identity和expectedMaxCalls。复用限长/无链接/一致捕获验证，import只使用一次捕获的内存字节，不构造DurableMemory、不打开源live DB。原verifyDurableBackup与quarantine语义保持。

sourceFreeze分别绑定declaredHead（必须等于此次包tip）、packageDigest（三文件确切字节/长度/名称摘要）与trust。trust显式选择trusted-lower-bound＋minimumHead，或declared-snapshot-only；不能从manifest自动制造可信pin。inspect返回安全元数据，import重新捕获并匹配freeze；来源改变则拒绝。

完整验证链后，以SHA256(canonical([M2_FORMAT, identity, firstSealedAuthorityDigest]))派生lineageId，以m2-import-加lineage派生固定migrationId。所有前缀、后继、分叉共享同一槽。只在同一独立authority内保证唯一；不是所有旧副本或其他authority之间的全局额度证明。

## Authority schema与原子唯一性

显式LocalSqliteAuthority.upgradeSchema，旧v2三表严格验证后在同一数据库独占事务追加legacy_imports，更新编号并校验精确新layout。保留原metadata/vaults/receipts行及JSON字节，支持ACTIVE和PREPARED；缺表/额外对象/未知版本拒绝，open不修补、不自动升级。重复完整升级幂等。要求维护停机；不能声称可兼容未实现schema检查的旧二进制。

新对象保存打开时user_version和schema_version，每次取事务锁及prepare/finalize重取锁后检查，变化则要求重开。新事务能力仍受一次性capability保护。

登记至少包含lineage主键、migrationId唯一、destinationVaultId唯一、requestDigest、冻结来源证明、PREPARED/ACTIVE、原importReceipt及admission状态。没有独立claim/release槽API：legacy-m2-import prepare在同一事务登记lineage与vault PREPARED；finalize同事务激活两者并写receipt。失败后不释放槽、不重授额度；reconcile核registry/pending/认证record一致，完成固定字节，不重读来源包。

完全相同请求ACTIVE返回历史receipt；PREPARED要求reconcile；同lineage换vault/target/operation或别的前缀均冲突。普通write/compaction/restore/rekey/schema维护不得删登记。import lineage进入认证identity并跨切换保留；缺registry不能降格普通vault。

## 激活和密钥

目的地必须独占新目录，与authority/来源包分离；目标及祖先不得为M2 claimed/quarantine命名空间。仅创建anchored-v3完整genesis，不先空库create再补状态。storageProfile明确，schema1保留或显式RAM迁移到schema2；超界拒绝，不截断/降级。

新storageDEK为调用方保管的不同32-byte值；stable ingressKey保留legacyKey确切字节，Store ledger_key保持。旧HMAC没有原native ID，不能通过换key或HKDF重新生成。maxCalls、reserved、逐项reserved、反馈消费、终态、撤销/高水位原样验证，pending/ready/taken转UNKNOWN，lastAcknowledgedDeliveryId清空。先校验原Safety符合新严格合同，不兼容报错，禁止靠终态化掩盖原非法delivery/重复或额度不符。

默认admission=required；claim/reserve在同一authority guard内拒绝，零新增预算/账本写入。显式admitLegacyImport以migrationId/current exact head/expected required状态CAS，保存独立准入receipt及operator-attested-stopped声明。准入不增加maxCalls、不减少reserved、不重开UNKNOWN；跨compaction等保留。普通非导入vault行为不变。

原importReceipt固定记录trustEvidence、latestProven:false、legacyCopiesFenced:false、quotaScope:this-authority-only、sourceRetirement:not-established、admissionAtImport:required。准入仅增加操作者声明，不把latest/fenced改true。旧key仍解旧历史，未实现crypto-erasure或旧ingress key轮换；新DEK分工不能冒称历史泄露补救。

## 必要验证

完整包/错误key/Unicode与冒号identity、错误tip/lower pin/fork/捕获变更、安全账本不兼容、同包重复/换vault/不同前缀/两进程唯一性；升级逐行保持/故障/未知布局拒绝/旧handle与过期capability拒绝；stage/prepare/publish/finalize故障和缺stage未决；未准入claim/reserve零副作用、准入CAS与耗尽预算、旧native去重/已消费反馈/撤销/ledger保持；schema1不改与显式schema2；压实/rekey/restore后lineage和准入保持；所有来源文件hash不变；合成旧副本仍能独立启动并据实保留fenced=false。

作者专项/typecheck→独立max审查修补→最终冻结Sol whole及IF3三arm测量。仍单worktree单写者，不merge、不训练、不接真实provider。IF3已有作者测量不是最后组合快照的独立证据。

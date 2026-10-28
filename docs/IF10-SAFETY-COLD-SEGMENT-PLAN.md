# IF10 Safety 单冷段实施合同 v1.0

2026-10-28，Root 整合候选 v1.0。状态 **PENDING_FINAL_REVIEW / NOT_IMPLEMENTED / NOT_TESTED**；精确 hash 的外部接受回执签发后冻结，文件本身不再倒写。源草案由 if10_contract_review 编写，SHA256 `773b436275eb2181a7982fb1c07108d60d003b74ddd0793088085fc58cc4096b`，原件保留。本合同不授予训练、合并、原始/历史数据删除、真实数据迁移或生产执行权限。

## 0. 范围、基线与当前交接

源基线为独立 IF9 工作树 `codex/aemc-capacity-repack-20261027`，HEAD `ffa596eb403fd54f128b776d9d966c49dfa0da33` 加既有 18 文件冻结候选。参考最终候选 manifest SHA256 `15a7e98c0749188c49d441ab56c4a5ef9ad0939f3eab530f0a1a8b9783f636ce`；其是否仍匹配由 Root/Sol 的鲜活核验另记，本作者不借历史回执宣称本文件已测试。

本片只将 Safety 的不可变终态移入一个加密 SQLite 冷段，减少以后每次 frame 重复写入相同历史。总 ingress 仍最多 8192，maxCalls 仍最多 32，Store 镜像 16 MiB、每代目录 256 MiB、4096 commits、恢复链总读取及累计展开各 64 MiB 不变。UNKNOWN 仍 UNKNOWN，消费额度不退回，旧 key/delivery/反馈/撤销完整保留。没有 GC、旧文件删除、Store 整图冷迁、authority 永久索引扩容或有损认知操作。

ARCH-1.0 确认后才进入实际工程。IF9 原冻结树保持不动；实现由 Root 在独立 IF10 工作树指定唯一作者。草案作者已交回写权；本整合候选由 Root 唯一写入，独立审查者只读。实现开始前另交实际 Astra xhigh 唯一源码作者，Sol 6.1 负责机械验证。

## 1. 明确选择

| 项目 | 本草案决定 |
| --- | --- |
| 新 profile | `blocks-br4-safety-cold-v1`；沿用 anchored v3 文件家族，不解释成旧 profile |
| Store | 继续 4 KiB block + br4 的已有 image 路线；没有 Store 语义变换 |
| 热 Safety | 新、独立类型的有序 hot envelope，raw/br4 carrier 二选一；不能调用旧完整 Safety validator 后把热区当全量 |
| 冷段 | 最多一个 STRICT/WITHOUT ROWID SQLite 文件，只在私有 RAM 中构建/打开，整段 AES-256-GCM 加密；首片无额外冷段压缩 codec |
| 冷迁资格 | 完整保留所有已有冷条目，加当前热区 `failed`、`unknown`、`acknowledged && feedbackConsumed`；其他状态留热 |
| 选择方式 | exact current 内确定性选全部当前合格热条目，不接受任意调用者名单/回调 |
| 首次使用 | 显式 `upgradeStorage` 到新 profile，root=null、所有记录留热；随后独立 `archiveTerminalSafety` |
| 空操作 | 没有新合格热条目，报 `SAFETY_ARCHIVE_NO_TERMINALS`；创建目标目录及成功 receipt 前拒绝 |
| 小批无收益 | 有合格条目即允许受预算约束的显式归档；不承诺单次 base/总磁盘严格变小。收益由完整序列成本比较决定，不用 IF9 repack 的 strict-shrink 门代替 |
| 自动行为 | boot、普通 write、满额、提前 base 不自动归档、不自动升级、不删除旧段 |
| 普通写 | 冷根与冷条目不变；只变更 hot/globals，新的请求追加 ordinal |
| 新 generation | 所有带冷段的换代都重新绑定 context 并重封冷段，不借旧 generation 文件继续服务 |
| 新 authority kind | 不新增。archive 用既有 `compaction`，以独立 request-digest action 区分 |
| 回执 | 仍 `AnchorReceipt`；成功仅证明状态提交，不证明成本节省或 UNKNOWN 已解决 |

第一片不创建多段合并器、Bloom 负查询或跨世代路由。若单段/全量恢复已满，拒绝；不放宽上限。

## 2. 数据与认证格式

### 2.1 完整逻辑状态与热 envelope

现有 `Safety.version=1` 仍代表逻辑完整状态。旧 M2、v2 与旧 v3 profile 的字节/validator 路径保持兼容。

新 profile 内部使用：

```ts
type HotSafetyEnvelope = {
  version: 1;
  globals: Omit<Safety, 'ingress'>;
  ingress: Array<{ ordinal: number; entry: Safety['ingress'][number] }>;
};
type HotSafetyCarrier = {
  version: 1; codec: 'raw' | 'br4';
  decodedBytes: number; digest: string;
  data: HotSafetyEnvelope | string;
};
```

每条 entry 保留完整 JSON 语义，不仅保留索引字段。global 字段包含原 version/identity/maxCalls/reserved/lastSourceRef/lastAcknowledgedDeliveryId/lastWall，并保留已验证输入的其他 JSON 字段；不得静默丢字段。规范化 JSON 只排序对象键，不改变数组顺序和值；拒绝不可无损表示的值。逻辑摘要比较完整规范化 Safety，非原 JSON 排版字节承诺。

旧 array 位置即 ordinal。热冷并集的 ordinal 必须恰为 `0..totalCount-1`；分区后不能重编号；新 claim 的 ordinal 等于此前 totalCount。热 envelope 按 ordinal 升序保存，冷段查询顺序同样显式 ORDER BY ordinal。进入新 profile 或每次构造完整视图都运行旧 Safety 的所有原校验，再做上述并集/ordinal/冷资格校验。

HotSafetyCarrier 的封闭字段、UTF-8/BOM/尾随/截断/拼接/展开量检查与 IF9 carrier 同级，解码器必须依据 profile 选择，不能把同名字段 duck-type 成旧 SafetyCarrier。raw/br4 按完整 carrier JSON UTF-8 字节比较，平局选 raw。读写必须复核 digest、实际 raw 字节数与限制。

### 2.2 SQLite 冷段

固定应用 ID `0x41454D53`（AEMS）、user_version=1、page_size=4096。固定唯一业务表：

```sql
CREATE TABLE entries (
  request_key TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE,
  delivery_id TEXT UNIQUE,
  entry_json TEXT NOT NULL
) STRICT, WITHOUT ROWID;
```

除了上述表及它的预期自动索引，不允许任意表、视图、触发器或扩展。schema/layout 必须对固定声明校验，不执行从文件提取的 SQL。逐行校验：

- key、delivery_id 与完整 entry_json 里的值相等；ordinal 安全整数、0≤ordinal<8192；
- entry_json 使用 fatal UTF-8，规范化重编码一致；保留所有字段；
- cold 中仅允许规定的三类终态；entryCount、reservedCount、unknownCount 与描述符一致；
- key/非 null delivery/ordinal 全局唯一；冷段内部和热冷并集分别核对；
- integrity、固定 layout 与所有行均通过后才提供查找接口；缺行/多行/错索引列不能作为查无记录。

构建和打开均用 owned unnamed `:memory:` DatabaseSync，allowExtension=false；在任何排序/DDL/导入/检查前确认可用的私有 RAM 临时配置。使用现有 IF9 `configureRepackRuntime` 的已冻结 runtime gate 或等价窄复用，执行并读回 temp_store=MEMORY、journal_mode=MEMORY、cache_spill=OFF、database_list 仅 main 且空文件名。不得创建具名明文 DB、使用 VACUUM INTO 或落盘 TEMP。只读冷段构建完成后用 query_only 防止业务误写；关闭时释放 RAM 连接与明文 buffer。SQLite API 自有内存的零化不在本片声称范围内。

### 2.3 冷根描述符与 AAD

新 profile 的 VaultIdentity **必须**有 `safetyCold`，值为 null 或以下封闭描述符。旧 profile **禁止**出现该字段。

```ts
type SafetyColdDescriptor = {
  version: 1;
  format: 'aemc-safety-sqlite-v1';
  file: string; // exactly safety-<cipherDigest>.bin
  cipherDigest: string; cipherBytes: number;
  plainDigest: string; plainBytes: number;
  entryDigest: string;
  entryCount: number; reservedCount: number; unknownCount: number;
};
```

所有 digest 为小写 SHA256 hex。descriptor 非 null 时 entryCount 为 1..8192；count 与实际完整解码一致，不能把 count 当作缺文件时可用的假账。null 必须对应零冷条目且备份中无冷文件。

冷段明文就是完整 SQLite image。密文格式固定 `IV(12) || GCM tag(16) || ciphertext`，无额外压缩或隐式 framing，所以 `cipherBytes = plainBytes + 28`。文件名完全由 cipherDigest 推导，不能包含任意路径。

AAD 固定为 UTF-8 JSON：

```text
[
  "companion-anchored-vault-v3",
  "safety-cold-v1",
  {
    authorityId, vaultId, identity, instanceId, ownerEpoch, keyEpoch,
    directory, storageDomain,
    schemaVersion: schemaVersion ?? 1,
    storageProfile: "blocks-br4-safety-cold-v1",
    legacyImport: legacyImport ?? null
  }
]
```

对象字段次序按上述定义固定；值来源为正在构造的新 identity。**AAD 不包含 safetyCold、自身 cipherDigest、head digest 或 sequence**，避免循环与普通写时重封。步骤为：固定新 generation context → 构建明文 → cold seal → 计算描述符 → 填完整 identity → seal frame/record → 得到 head digest。frame/record 的既有 AAD 继续绑定完整 identity，包括 safetyCold。

entryDigest 为规范化的 `[{ordinal,entry}, ...]`（ordinal 升序）的 SHA256；plainDigest 为 SQLite image bytes 的 SHA256。cipherDigest 验证实际密文，AEAD 验证 context，解密后再核明文长度/hash、layout、全部条目和 entryDigest。三者不能互替。

## 3. 最小公开 API 与幂等

```ts
AnchoredVault.archiveTerminalSafety(request: CompactRequest): AnchorReceipt;
```

请求复用 authority/vaultId/keys/maxCalls/targetDirectory/storageDomain/operationId/fault。只接受新 profile；不隐式升级。kind 固定 `compaction`。独立请求摘要格式：

```text
SHA256(JSON.stringify({
  kind: "compaction",
  action: "archive-terminal-safety-v1",
  oldHead,
  target, storageDomain,
  profile: "blocks-br4-safety-cold-v1",
  selectionPolicy: "all-terminal-v1",
  maxCalls, keyEpoch, storageKeyDigest, ingressKeyDigest
}))
```

字段顺序固定，旧 compact/repack 摘要不变。重复 operationId 先查原 receipt，以其 oldHead 重算摘要；相同请求返回原 receipt，不重新归档，不因当前 head 已变而改写结果；字段不同拒绝 ANCHOR_OPERATION_CONFLICT。与 compact/repack/fanout/upgrade 同 ID 必须冲突。PREPARED 情况先按既有 pending 规则拒绝，调用者显式 reconcile 原操作；不创建第二次效果。

维护读取 exact CURRENT，不构造 MemoryStore、不 boot、不 sweep、不调用 wall clock。归档转换前后完整 Safety、Store image、撤销 high-water、keys、legacy 绑定完全相等；只有分区、物理载体、generation identity 改变。target 必须新建且与 source/authority/backup 分离。ownerEpoch+1、新 instance、sequence=1，旧源保留并受外锚 fence。

无可迁热条目、格式/编码/校验失败及 RAM 中可确定的文件字节超界，在创建 target 或消费成功 receipt 前拒绝。authority 的 PREPARED/finalize 最坏完成空间预演沿用现有 prepare：必须在 target 和 stage 已写且校验后执行，不承诺所有容量拒绝均发生在建目录前；不引入新 preflight API，也不把 capacity() 统计当预留。已有冷条目而没有新合格热条目也属于无可迁，不为同一冷集合反复归档。若写冻结文件后 authority 容量拒绝，或 PREPARED 前已创建目录后遇真实 I/O 失败，保留 orphan 和诊断；没有成功 receipt，不清理或隐式复用目标，receipt 未消费不等于目标可安全重用。

## 4. 统一 SafetyLedger 语义

内部所有 Safety 方法通过统一 ledger，不能某些方法只查热区：

- `lookupRequest(key)`、`lookupDelivery(id)`：热冷并集唯一查询；
- `completeSafety()`：按 ordinal 合并完整视图，用于兼容校验、全局统计及逻辑等价；
- `hotEnvelope()`：只序列化 hot+globals；cold descriptor 与本 generation 固定；
- `claim/reserve/terminal/consumeFeedback/source/boot/status`：统一语义入口；
- `assertColdClosure()`：在当前 head guard 内验证所需冷文件是普通非链接文件、精确大小与 cipherDigest。

先恢复并验证完整冷段，再允许查找。后续 Safety API 查询/状态读取和提交前均验证当前必需冷文件闭包；可以复用相同 root 的已验证 RAM SQLite，但不能用缓存掩盖缺文件/替换。普通 Store 写、提前 base、发布/finalize 前也必须验证冷文件闭包。当前 trusted guard/文件读保证与现有实现同级，不声称防止外部管理员在任意最后一次检查后删除磁盘文件；之后重开或操作必须诚实报损坏。

有效闭包成立后，保持既有操作级拒绝次序：

| 操作 | 必须保持 |
| --- | --- |
| claim | legacy/current admission → 参数 → 查全局旧 key → 同指纹 INTERACTION_TERMINATED / 异指纹 CONFLICT → 再判总 8192 → 只追加热条目 |
| reserve | 当前 admission → 全局 reserved/maxCalls → requestId → 仅未 reserved 的 pending 热条目；冷条目不复活、不退款 |
| terminal | 查询全局 key；reserved+failed 映射 unknown；沿用原 delivery 冲突与全局唯一校验；同状态同 delivery 无写返回；冷终态不可变 |
| consumeFeedback | 全局 delivery 查询 → acknowledged 检查 → 已消费拒绝；只有尚未消费的热 acknowledged 可以改变 |
| source/lastWall | 更新 globals；当前权限/时间规则保持；cold 条目不变 |
| open/boot | 只把 pending/ready/taken 热条目变 UNKNOWN，按原规则清 lastAcknowledgedDeliveryId；这是显式 boot 行为，不冒充归档发生的变换 |
| status/inspectCapacity | ingress/unknown/reserved 为并集值；不只报 hot。增加可选 hot/cold 计数/字节与 descriptor 元数据，原 aggregate 语义不变 |
| 冷终态 no-op | 不调用 save、不增加 sequence/消费/lastWall，不“升温”成热副本 |

旧错误优先序在文件闭包正常时保持。损坏/缺失必需文件是完整性失败，不能继续执行或据此生成负查找。保留所有全部事务 guard、poisoned、跨 vault pending 与 authority completion reserve 行为。

## 5. profile 与所有换代矩阵

旧 profile 简称 P1=blocks-br4-v1，P2=full-br4-v1，P3=blocks-br4-safety-br4-v1，新 P4=blocks-br4-safety-cold-v1。

现有 v2→P1/P2/P3、P1/P2→P3 行为不变。新增仅 P3→P4 的显式 upgrade；P1/P2 想用 P4 须先按已有 API 升到 P3。P4 同 profile upgrade 和所有 downgrade 拒绝。新建 P4、legacy import 到 P4 均 root=null/all-hot；不自动归档。

| 操作 | P4 分区与冷根 | 其他必须条件 |
| --- | --- | --- |
| create | null/all-hot | 新 identity；原创建/预算合同 |
| P3→P4 upgrade | null/all-hot；完整 Safety 相等 | 显式新目标/新 generation；不归档 |
| archiveTerminalSafety | cold = old cold + 全部新合格 hot；新 root | 精确前后逻辑相等，无 boot；独立 action 摘要 |
| ordinary write | root、冷段 bytes 均不变 | hot/globals 合法变更；所有 frame 同 root |
| 自动提前 base | root 与冷段不变；depth 重置 1 | 仍计冷段读/展开预算；不自动归档 |
| compact | 保留分区；新 context 重封冷段 | 不顺带把新终态冷迁 |
| repackStore | 保留分区；新 context 重封冷段 | Store 原无损/strict-shrink 门独立保持 |
| maintainFanout | 保留分区；新 context 重封冷段 | Store fanout 规则独立；Safety 完整逻辑不变 |
| migrateBackup/schema migration | 保留分区；新 context 重封冷段 | Store schema 1→2 合同、当前 head 门保持 |
| restoreBackup | 保留备份分区；新 context 重封冷段 | 备份 head 仍须 exact current；不能复活旧控制状态 |
| rekeyBackup | 保留分区；新 DEK+keyEpoch 的 context 重封全部 | ingressKey 不变；新目标自包含，不依赖旧 DEK |
| export/verifyBackup | 原 current cold ciphertext 原样列入闭包 | 不改变 generation；精确必需文件集合 |
| legacy import | P4 null/all-hot | 原来源唯一槽/实际 admission 与 legacyCopiesFenced=false 保持 |
| reconcile | 读取冻结的新 cold/frame/record，不重选、不重封 | 验原 pending/head/operationId/parent/marker/根/文件闭包；缺失保持 UNRESOLVED |

所有“新 context 重封”应走一个共用 generation builder，避免恢复或 fanout 维护遗漏。新 generation 目录不能引用旧目录的 cold path，即使两者使用同 DEK。旧文件/备份一律保留；重封成本进入维护与峰值。

authority 的普通 write 比较须包含完整 identity 的 safetyCold；非 write 只接受上述显式换代及 profile 矩阵。capacityHead 当前手工挑字段的代码必须包含 safetyCold，不能返回丢根的“exact head”。无需更改 authority SQL schema，但旧 reader 必须因未知 profile 拒绝，而非忽略冷根。

## 6. 字节、帧、文件与资源预算

| 对象 | P4 硬界 |
| --- | --- |
| 总 ingress / maxCalls | 8192 / 32，不只按热区计 |
| 完整逻辑 Safety JSON | 4 MiB，保留 IF9 packed Safety 的完整状态界 |
| HotSafetyEnvelope 解码 JSON / carrier JSON / frame header | 各不超过 4 MiB；新增 ordinal 开销也计入，不挪用原限额 |
| 冷 SQLite 明文 | ≤8 MiB，page-size 整数倍，解密前先按 descriptor 准入 |
| 冷密文 | = plainBytes + 28，故 ≤8 MiB+28 |
| Store image / patch | 原 16 MiB / MAX_PATCH 公式保持 |
| 恢复链 | 含 base 最多 15 frame；旧 profiles 仍 16 |
| encoded 总读取 | cold ciphertext 一次 + 所有必要 frame/blob/record ≤64 MiB |
| decoded 累计 | cold SQLite 一次 + 各 frame 的 image patch rawLength + hot envelope decodedBytes ≤64 MiB |
| 数据文件闭包 | 有冷段 2×15+1=31；null root 最多 30；两个备份说明文件另列 |
| record / stage manifest / marker | 原 32768 / 65536 / 8192 bytes，不放宽 |
| generation disk / commits | 原 256 MiB / 4096，包含保留的 stage/orphan/旧 frame 等现有目录计账对象 |

writer Baseline 必须显式保存冷段的 encoded/decoded 常数，普通 delta 的累计只加入一次；提前 base 重新从 cold 常数起算，不能归零而漏账。reconstruct 在展开任何 descriptor 前检查剩余预算；同一根在当前恢复链最多读取/解密一次。预算不足提前 base 仍不足则拒绝，不写超界成功结果。exportBackup 的文件白名单新增严格 safety-hex.bin，并按 profile 应用精确文件数与闭包；旧 32 数据文件的备份仍可读。

第一片仍会整体解密冷 SQLite、可能重建完整逻辑 Safety，并执行文件 hash 读取。只能声称减少重复写入的候选机制，不能声称按需 RAM、CPU 或总 I/O 已下降。报告同时包含密文 buffer、明文 SQLite buffer、DatabaseSync 自有内存、完整 Safety/热 JSON、image、旧/new generation 与 staging 峰值。

## 7. 持久化、重试与故障顺序

1. 在 authority guard 内取得 exact current，检查与新路径分离、来源 registry、当前必需文件及全局 pending。
2. RAM 中解码完整状态、选条目、构建冷 SQLite/热 envelope，验证前后逻辑相等；固定新 context、封冷段、seal full base/record，计算全部上界。
3. RAM 中先通过 marker/stage/目录的可确定文件字节上界后，新建 target，依次写 marker、cold（如有）、full-base blob、stage；各按现有 writeNew/fsync 完成。随后 tx.prepare 验证已存在的 target/stage，并执行 PREPARED/finalize SQL 最坏完成空间预演与准入；capacity() 不是该操作的预留。authority 拒绝时保留 orphan/诊断且无成功 receipt，不隐式重用目标。
4. cold 和 base 的冻结字节已存在才 PREPARED。新增可选 fault 点 `safety-cold-written`；保留原 stage-written/prepared/checkpoint-published/record-published/finalized 语义。
5. publish 在写/接受 record 前再次校 cold 与 blob；finalize 为原 operationId 保存 receipt、切换 head。旧 live handle 从下一次 guard 起 fenced。
6. PREPARED 后缺失/损坏任一必需 cold/frame/stage/marker，reconcile 保持 UNRESOLVED；不降级到热区或重算替代冷段。
7. finalize 成功但响应丢失，相同 operationId 返回原 receipt。尚未确认结果不创建第二个归档效果；保留全部历史材料。

No-op/拒绝不创造业务成功 receipt。authority 容量的 admission/completion 预留与当前限制不变；不能以削减 UNKNOWN 或 receipt 解决满额。

## 8. 最小变更面与可检查 API 接缝

建议新增 `safety-ledger.ts`、`safety-segment.ts`，并在 `safety-carrier.ts` 中新增独立 hot carrier 校验/编码入口；保留旧导出的完整 Safety 行为。可以抽取纯压缩辅助，但必须以旧 wire 黄金字节/回归证明旧 profile 无漂移。

关联修改：anchored-codec（profile/descriptor/identity）、incremental-codec（profile允许表/15帧函数）、incremental-storage（hot wire/cold reader/budgets/闭包）、anchored-vault（统一ledger/new-generation builder/API/backup/reconcile/inspect）、local-sqlite-authority（profile转换与固定根）、capacity-types（可选冷段统计）。旧 M2 durable-memory/durable-codec 的 wire 及 Store schema/逻辑不改。

新的本地合成测试以 safety-cold-segment 和 anchored cold lifecycle 分工。已有测试只因新公开行为确有相关性时扩充；不为机械重复而整套重跑。

## 9. 冻结验收清单

### A. 格式与纯逻辑

- 三类可冷迁状态及 pending/ready/taken/未消费反馈的 acknowledged，混合 ordinal；空 cold、全 cold、零新 eligible、8192/8193、maxCalls 0/32。
- 完整 entry/globals/原序列恢复相等；未知额外 JSON 字段不静默丢弃；key/delivery/ordinal 索引列与 JSON mismatch、冷资格非法、count/摘要不符拒绝。
- 严格 layout、额外 table/trigger/view、坏 UTF-8、截断/尾随、profile混淆、descriptor和明密文字节超界、错误 key/context/epoch/vault/instance。
- SQL RAM gate 不通过即拒绝；没有具名明文输出，不以一个配置声明代替读回检查。

### B. 公开运行语义

- 正常 API 生成历史后 archive；归档前后全逻辑相等，维护不 boot/不读时钟/不清 lastAck；随后 normal open 的 UNKNOWN 转换单列。
- 冷 key 同载荷/异载荷、冷 UNKNOWN 重试、冷已消费 feedback、冷热 delivery 冲突；拒绝次序与原状态一致。
- 总 8192 满额下旧 key 仍先得到重复/冲突，真正新 key 拒绝；额度只增不减，不因分区重置。
- cold terminal 同状态同 delivery 无写、head/sequence/lastWall 不变；不升温。
- 打开后删除/替换冷文件的查询与新写拒绝；缓存不能掩盖损坏。用隔离临时合成副本执行故障，原成功副本保留。

### C. 持久与跨代

- 各换代矩阵路径至少一个带非空 cold 的真实重开；新 generation self-contained，旧源 fencing。
- compact/repack/fanout/migrate/restore/rekey 都重新封冷并保持分区；普通 write/提前 base 不改 root。
- 备份 31 文件上界、缺/多文件、错误白名单、冷文件替换；旧 profile 32 文件备份兼容。
- 真实子进程在 cold-written、PREPARED、record-published、finalized 断点；原 operationId reconcile/重试；缺文件不清 pending；跨 vault pending 不旁路。
- 两个真实进程争相维护/旧writer写入：只有当前 authority winner 成功；失败者不改变成功head/记录。
- 至少一条纵向链：archive → 冷键冲突/终态重试 → 热反馈完成 → export backup A → rekey → 完成所需真实重开/boot后，从新 current export backup B → restore B → 冷键与额度复查。另验证 restore A 必须因旧 head/keyEpoch 拒绝；不得放宽 exact-current 门，任何重开导致的 head 更新均须反映在随后导出的备份中。
- legacy import(P4 all-hot) → admission前维护不产生执行许可 → 原实际 admission → archive → rekey/restore；唯一来源与幂等不变。旧 M2 副本仍不能称被新 fence。

### D. 证据与发布边界

作者专项与 TS → 独立只读审查 → 受影响回归/必要 whole → 精确提交的跨平台 CI，按 Root 当前发布授权分别执行。固定源码/测试/配置 hashes、保留所有失败尝试；不同层/不同历史 counts 不相加。候选不能借 IF9 1028/1028 或旧 CI 标 PASS。

## 10. 成本实验与分母

采用同一合法 synthetic API 历史、相同 Store 内容和同一后续变更序列。比较 P3 保留所有 Safety 的 IF9 基线，与 P4 升级/归档后的路线。固定并公布：

- 起始 base、升级与归档一次性成本；
- N 次随后合法写入的完整 frame/stage/record/authority 增量；
- 完整当前备份字节、保留旧 generations 后总占用、恢复耗时和进程峰值；
- 至少小批、混合状态和高终态比例三种历史；8192 结构夹具只做结构上界，不冒充 8192 次公开持久操作。

分别报告累计应用层实际 write 字节、fsync 次数/耗时、真实已接受请求/状态变更数量及其规范化新增逻辑字节。归档没有新业务载荷，单列维护字节，不能强造写放大分母；fsync 不再计为第二次写入字节。后续状态变更无新增内容时也报告绝对维护字节，不以文件大小差冒充 OS/设备 I/O。若观察设备 I/O 才另报，否则 NOT_MEASURED。

全成本包含冷文件、descriptor、索引页、base、stage、record、authority、备份、重封及原件保留。不只报热数组变小。小批可能更贵；给出实际 N 下净变化，不从平均压缩比外推十年规模。收益门为同序列累计成本的可复核比较，安全接受不依赖结果必须正向。

## 11. Root 取舍与冻结条件

Root 已接受以下两项首片取舍，实施者不得临时改变协议：

1. 采用“P3→P4 显式 upgrade，再单独 archive”的两步 API，不临时合并为新复合效果。
2. 每次 Safety 查询及提交前校验冷文件闭包，接受其读取成本，不宣称 RAM/读放大收益。以后优化缓存必须另有可证明的文件/代际有效性合同。

独立审查通过后由 Root 以外部回执接受本文件精确 SHA，再原字节复制到独立 IF10 工作树。作者草案保持原 DRAFT 与原 hash；合同接受不等于实现、测试、CI或产品 PASS。任何协议改动先产生新版本并重新核对受影响条件。

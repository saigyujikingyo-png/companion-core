# TJ0：有界合成训练履历磁盘协议 v1

2026-10-26。TJ0 实现独立的、可跨进程回读的 **SYNTHETIC_FIXTURE** 声明档案。真实训练次数、模型调用次数均为 0；所有解析、投影和导出仍为 **NOT_AUTHENTICATED**。它不实现 TJ1 的受信 trainer、执行证明、完整 checkpoint 续训、权限恢复或生产激活。原 J0、Store/schema 1、M2 和冻结 Q0 未修改。

产品目标与后续真实训练边界见 [TrainingRun 设计](TRAINING-RUN-JOURNAL.md)，资产分类见[目标决策](TARGET-DECISIONS.md)。本格式及原创合成测试可公开；实例记录、索引、关联 hash、原因和导出正文默认私有。格式校验与 SHA-256 一致性不能认证 runner、事实、权限或质量。

## 接口与当前权限

`src/training-journal.ts` 的 `TrainingJournal.create(options)` 只创建新档案，已有文件不覆盖；`open(options)` 只重开已有档案。`options` 包括绝对且经过 `realpathSync` 规范化的既有 `directory`、`journalId`、同步受信 `authority()` 回调和可选 `readOnly`。回调来自宿主当前权威，不能从 archive/JSON 标签生成。

回调返回封闭普通对象：`scopeId`、十进制字符串 `generation`/`consentRevision`、`runtimeId`、安全整数毫秒 `now`/`expiresAt`、布尔 `read`/`write`/`export`。身份与同意代际必须由宿主持久维护，任何 revoke/off→on 都须推进代际；回调须核全部关联来源、当前授权、撤销与保留条件。TJ0 不能发现宿主未报告的授权变化，也不替代 Store 接线。Promise、getter、Proxy、异常、过期和时钟倒退拒绝；错误只给固定代码。回调不能重入、关闭或重开正在执行的实例。

每次 `append`（包括重复返回）、`readEvent`、`readAttempt`、`status`、`exportCanonical`，以及创建/重开交付，都先后核当前权限。读权限独立于写权限；export 还需 export 权限。观察到否决、身份/同意/runtime 变化或重入后，旧实例永久失效；`close()` 也不可逆。新进程必须获取新回调与新实例，盘上没有可恢复的旧票据。重开允许新的 runtime，但须匹配当前 scope/同意身份；旧 scope/同意档案不自动重新授权。

- `append(rawJson, {codec?})` 返回 `{duplicate, sequence}`，sequence 为物理序号。输入仅接受封闭 v1 合成事件；编码默认 `identity`。
- `readEvent(sequence)` 用已重建的有界 offset 随机读取、复验该 frame 并返回私有声明；`readAttempt(runId, attemptId)` 返回重建的合成状态副本。
- `status()` 只含固定标记、counts/bytes、恢复分类；`archiveAppendable` **仅表示物理档案完整性**，仍须当前写许可且非 readOnly 才能追加。
- `exportCanonical()` 只在整个已扫描档案完整时返回私有 canonical JSONL；坏尾前缀不静默导出为完整档案。导出不是公开发布，也不授予恢复或执行能力。

`status`/`readAttempt` 使用本次打开时完整验证并重建的 RAM 索引，不是每次全量 scrub。每操作检查文件身份、大小、mtime/ctime；随机读另核选中 frame。进程持有实例期间不允许别的合作读写者打开同一目录，索引不会跨进程共享。返回的私有副本已交付后不能物理召回。

## 逻辑 schema 与严格 reducer

每事件固定字段顺序为 `version, executionMode, datasetOrigin, runId, attemptId, runnerId, jobId, eventId, sequence, kind, data`。v1 只允许 `executionMode=SYNTHETIC_FIXTURE` 和 `datasetOrigin=SYNTHETIC`。真实合成数据训练属于未来 TJ1，不能用 TJ0 fake 条目冒充；caller 自报 actual、runner-observed/reconciled 或额外 assurance 字段均拒绝。

synthetic-only 是本切片的执行与准入合同：受信调用方必须只提供合成 purpose/NOTE/身份与引用。标签和 checksum 不验证文本来源，不能检测把真实私密内容谎称 synthetic 的调用方。

UTF-8 无 BOM、无 Unicode 归一化；固定字段次序和 JSON 转义。重复 key、非法 UTF-8、孤立 surrogate、未知字段、非规范盘上字节拒绝。写入口可接受合法 JSON 的空白/字段次序差异后规范化；从盘解码必须逐字节等于规范结果。原 receipt 字节不被本格式认证或保存。

ID 是 1–64 个受限 ASCII 字符。计数为最多 78 位、无前导零的非负十进制字符串；物理 frame 序号另有 1–256 的小整数上限。浮点 metric 不经过 JavaScript Number：`value` 为 unknown 的 `null`，或 `{dtype: f32|f64, shape, bits}`；bits 是按元素排列的 **大端 IEEE-754 小写十六进制原始位**，保留负零、NaN payload、正负 infinity 和 subnormal。shape 至多 4 维，正整数维度，积至多 128，空 shape 为标量；必须匹配准确位数。`name` 唯一、单位保留；unknown 不变成零。

| 事件 | 独立效果 |
|---|---|
| INTENT | 第一条且 sequence=1；记录 purpose、request/dataset/model digest、可选 parentAttemptId、seed、plannedSteps。计划不成为已观察 steps |
| STARTED | 仅 NOT_STARTED→RUNNING；只是 fixture 声明，不启动 job |
| STEP | 仅 RUNNING；optimizerSteps 严格增加，已知 batch 下界不倒退，保留精确 metrics；batch 不冒充 optimizer step |
| TERMINAL | COMPLETED/FAILED/ABORTED/UNKNOWN/REFUSED；终态不能再 STARTED/STEP/TERMINAL。失败不擦去已有下界与产物 |
| ARTIFACT / RELOAD / EVALUATION | 分别记录产物关联、reload 声明和 policy/metric/result；可在允许的终态后追加，不能改训练终态 |
| ACTIVATION | ACTIVE 要求训练 COMPLETED、同产物 reload 和 eval 均 PASS；ACTIVE/UNKNOWN 不能直接再激活。ROLLED_BACK/UNKNOWN 必须绑定当前 ACTIVE 的精确产物；everActivated 历史保留 |
| NOTE | 关联同 attempt 既有 eventId 的纠正/晚到声明；不重开 attempt，不静默覆盖原观察 |

同一 `(runId, attemptId)` 的 runner/job 不得改变，事件 sequence 必须严格加一。新重试使用新 attemptId，`parentAttemptId` 只是声明链接，不证明完整 checkpoint/RNG/dataloader 恢复。全档案最多 64 个 run/attempt 组合，不是每个 run 各有 64 个。

持久去重键为 `(runId, attemptId, runnerId, jobId, eventId)`，内容由规范字节 SHA-256 绑定：同键同内容在当前授权后返回原物理序号，不增加 frame；同键异内容拒绝。重开从权威档案重建去重索引。完整盘上出现第二个重复 frame 视为损坏。模型文字、退出码、loss 降低均不自动变成训练/质量 PASS。

## 容量与 codec

| 对象 | 硬上限 |
|---|---:|
| 全档案物理字节 / 累计解码字节 | 8 MiB / 4 MiB |
| 事件数 / run-attempt 组合数 | 256 / 64 |
| 单事件规范字节 / 单 frame 压缩 payload | 16 KiB / 64 KiB |
| JSON 深度 /普通文本字段 | 8 / 1024 UTF-8 bytes |
| 每事件 metrics / 每 metric 元素 | 16 / 128 |
| metric shape / counter digits | 4 维 / 78 位 |

逻辑 schema v1 与 container/codec 独立。codec 0/version 1 为 identity，保证可靠无压缩 fallback；codec 1/version 1 使用 Node 24 标准 Zstd（压缩级别 3，windowLog 16）。Node v24.16.0 的 [Zstd API](https://nodejs.org/download/release/v24.16.0/docs/api/zlib.html)仍为 experimental；不宣称自研压缩、压缩率收益或不同 Node/libzstd 版本输出同样压缩字节。无损门针对 canonical logical bytes，固定 identity golden 覆盖确定性容器字节。

先查全文件大小，再以固定小 header 查 encoded/raw 长度与累计预算，随后才分配 frame/解码。Zstd 同时设置 `maxOutputLength=declaredRawBytes` 与 `ZSTD_d_windowLogMax=16`，实际输出长度/逐字节 SHA 必须匹配。坏数据不能靠小声明长度展开大结果；未知版本不尝试猜解或回退。没有词典、模型权重或样本正文自动导入。

## Container v1 与提交边界

所有多字节整数为 big-endian，hash 为 32 原字节。

| Archive header（128 bytes） | offset / 长度 |
|---|---|
| `TJ0AR001` / containerVersion=1 / schemaVersion=1 / headerBytes=128 | 0/8、8/2、10/2、12/4 |
| SHA256(journalId UTF-8) / SHA256(JSON [scopeId,generation,consentRevision]) | 16/32、48/32 |
| 必须为零 / SHA256(header[0:96]) | 80/16、96/32 |

| Event frame | offset / 长度 |
|---|---|
| `TJ0CH001` / schemaVersion=1 / codecId / codecVersion=1 / zero | 0/8、8/2、10/2、12/2、14/2 |
| 连续物理 sequence / encodedBytes / rawBytes / zero | 16/4、20/4、24/4、28/4 |
| previousDigest / SHA256(raw canonical bytes) / zero | 32/32、64/32、96/32 |
| encoded payload | 128/encodedBytes |
| `TJ0DONE1` + SHA256(frameHeader + encoded payload) | 紧随 payload，40 bytes |

首 frame 的 previousDigest 是整个 archive header 的 SHA；以后为前 frame 的 footer digest。每次追加完整 frame+trailer 后调用 `fsyncSync`，成功并通过最终权限检查才 ACK；没有自动重试。写入/fsync 任何不确定失败返回 `TJ_COMMIT_UNKNOWN` 并封死实例。fsync 后权限失效可已有物理效果而没有成功返回；新受权上下文须重新扫描去重，不能把无 ACK 等同于未写入。

读取只承认连续验证过的完整提交前缀：序号、链、reserved zeros、长度、codec、canonical bytes 和 reducer 均须通过。第一处半写/损坏/不支持版本分别记 INCOMPLETE/CORRUPT/UNSUPPORTED，后续不跳过，原文件原样保留，禁止追加与导出。合法前缀仍可受权读取；投影带 `history=INCOMPLETE`，完整后缀/完成结论未知。没有 truncate、修复或更老档案 fallback。档案完整性 COMPLETE 不表示 run COMPLETED，更不表示训练执行成功。

`training.tj0` 是唯一记录权威。offset、attempt、dedup 都只是有界 RAM 索引，每次新进程打开重新扫描构建；不存在可授予 head 的持久 index。外部 `index.json` 不被读取。重开不执行任何已记录或未完成 job，`continuation=NOT_EXECUTED`。

## 写锁、目录与未证明项

每个打开实例（包括 readOnly 恢复）持有独立 `writer.sqlite` 的 `BEGIN IMMEDIATE`，使扫描/追加都只有一个合作 owner；进程正常退出或被终止后由 OS 释放锁，没有 PID/超时破锁。这仅使用 [SQLite 文件锁](https://www.sqlite.org/lockingv3.html)，不把 SQLite 的 [atomic commit 保证](https://www.sqlite.org/atomiccommit.html)嫁接给外部 archive。sidecar 不是旧 Store/M2 数据库，不保存 head、权限或 event。实例须保持可达直到 close；不可达服务的 native 资源可被 GC 释放。

`readOnly` 表示不可追加 archive；仍需可写的锁 sidecar，缺少时会创建空锁文件，因此不支持整个目录或卷的 OS 纯只读挂载。

当前锁协议不执行 SQL 写入：main 文件必须为 0 bytes；只允许至多 512 bytes 的 rollback journal，WAL/SHM 拒绝。所有这些文件在 SQLite 打开/恢复前检查类型、单 hard link 和大小；关闭 trusted_schema。损坏或外来 sidecar 不被删除/重置。权限拒绝发生在读取档案前；错误不返回路径、原始异常、event/来源身份或正文。

只在受信单机本地磁盘、已有私有目录使用。路径须先 realpath 规范化（macOS `/var` 的系统别名也应如此）；源码目录和名为 OneDrive 的路径组件拒绝，文件 symlink/multiple hardlink 拒绝。调用方仍负责私有目录、Windows ACL、卷类型与当前权限服务，路径筛查不是完整 OS 沙箱。新文件 POSIX mode 0600 不证明 Windows ACL；此实现没有加密、介质擦除、跨设备共享、备份保留或长期耐久承诺。

**KNOWN_UNPROTECTED**：无外部可信 watermark，合法完整前缀/整个目录回滚无法检测；同用户恶意改写并重算 hash、替换锁路径、祖先目录竞态与 OS ACL 攻击不在证明范围。目录项断电持久性、真实硬件 flush 故障、网络/同步盘语义与电源失效未验收。崩溃 probe 证明进程退出后合作锁释放和已持久 frame 回读，不能替代这些边界。

## 可复现验证

作者专项使用 fresh OS TEMP、原创合成事件和固定预算；保留错误工件，不读凭据、真实聊天、旧数据库或 OneDrive 运行数据。

```powershell
node --test test/training-journal-format.test.ts test/training-journal.test.ts test/training-journal-restart.test.ts
node src/training-journal-demo.ts
```

format/disk 检查包含 exact number bits、identity golden、Zstd 双预算、损坏/半写/未知版本、持续去重、终态、权限代际/时钟/重入、部分 write/fsync 失败；fresh-process probe 实际启动持锁 child、拒绝另一个进程、终止 owner，随后由新进程重建索引/重复核对/追加。child heap 64 MiB、启动/调用各 10 秒、cleanup 5 秒、测试外层 60 秒。demo 的重开在同一进程内，不能替代该 child probe。

作者专项、独立审查、一次 whole 与四项平台 CI 分层报告，不将 Windows 的结果预报为 Linux/macOS 已通过。TJ1 与真实训练/评测/部署均 **NOT_IMPLEMENTED**。

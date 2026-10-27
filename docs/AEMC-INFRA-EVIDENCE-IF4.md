# IF3/IF4 最终组合验证：增量存储、压实与旧M2导入

历史快照提示：本页822与成本只覆盖IF4。后续IF5接通持久检索，IF6在新审计中发现并修补外锚容量边界；当前状态及合并范围见 [开发状态](AEMC-DEVELOPMENT-STATUS.md)。本页原通过结果和当时审查结论保留，不代替新组合验证。

2026-10-27。**本机合成实现、测试与独立审查闭合；完整AEMC仍IN_PROGRESS / TRAINING_NOT_ADMITTED。** 独立manual worktree为`aemc-infrastructure-20261027`，branch `codex/aemc-infrastructure-20261027`，HEAD仍`d23921f5abc5be10f15883a1a5289af842299b3f`。本批改动未commit/push/merge，未运行训练或真实provider。

## 交付与路线

- [v3增量存储](INCREMENTAL-STORAGE.md)：保留完整RAM SQLite事务及FTS提交，再做4096-byte块replacement/XOR与标准Brotli4。full与delta按同codec比较，无收益回full/raw；最多16帧恢复链，完整Safety每帧认证。blob一次写入/fsync，stage只存引用和小record，PREPARED/finalize成功后才更新RAM基底。
- 链备份保原密文与exact head，不flatten后冒用旧head。恢复/rekey/schema/fanout维护先验证物化，再新目标base切换；reconcile只完成固定字节，不boot或重放业务。静态compaction保schema/key/profile、换instance/owner并fence旧anchored源；旧源文件保留，没有GC或总盘回收承诺。
- [旧M2导入](LEGACY-M2-IMPORT.md)：一次捕获完整三文件，可信pin下界与声明tip/packageDigest分开；schema3全局lineage槽与vault PREPARED/ACTIVE原子登记。新DEK不同，旧key保留作稳定HMAC，Store ledger/额度/反馈/撤销保持；先严格校验原Safety，再把未完成项转UNKNOWN。
- 默认claim/reserve在authority guard内实际拒绝；显式current-head准入只记录操作者停用声明，不能证明旧副本已被fence。receipt固定`latestProven:false`、`legacyCopiesFenced:false`、authority-only quota。lineage/准入跨后续切换保持，缺失或不一致登记拒绝。
- [冻结计划](INCREMENTAL-STORAGE-PLAN.md)及[导入合同](LEGACY-M2-IMPORT-PLAN.md)在实现前固定。侧边lab只读参考，未复制/合并其dirty源码；独立复核其尺寸结果，同时保留validated-bytes计量错误，不将纯image-history收益当整vault。冷历史归档不扩入本轮。

## 作者证据与失败历史

| 阶段 | 实际结果及边界 |
|---|---|
| IF3初次专项 | 11/14；三项Buffer/Uint8Array容器类型断言改为字节比较，未改变codec |
| IF3计量首跑 | EXIT0但checker过度规范化数组、clock/source oracle不足，且没有前后源码manifest；只保留历史，不作为最终门证据 |
| IF3关联与作者计量 | 174/174、typecheck0；修正checker后稀疏门通过，15源hash一致，但该测量早于最后长度边界修补 |
| IF3长度界修补 | fixture首次58/59、typecheck2；修正实际超界样例与literal类型后59/59、typecheck0；无降门 |
| IF4专项 | 16/16→19/19→21/21；包含真实进程竞争和PREPARED exit42；未发生runtime test failure |
| IF4关联 | 196/196；同轮typecheck2为fixture显式undefined违反exactOptional，省略字段后最后21/21、typecheck0 |

作者历史日志和详细限制见两份API文档。最后IF4专项目录：`%LOCALAPPDATA%\Temp\aemc-if4-final-20261027T040954Z`；focused.log SHA256 `6364ef5206bbd074d05392739605175dd8c5cdfc844db32f33d2385b20e9036e`。作者129文件manifest与后续独立132文件manifest口径不同，不混称同一清单。

## 独立最终执行

实际`gpt-6.1-sol/high`验证代理对最后冻结源顺序运行，Root与审查者只读源码；仅Root整理文档。全部使用新native TEMP、单测试worker，无失败或重跑：

```text
npm run typecheck
node --test --test-concurrency=1 test/*.test.ts test/*.test.mjs
node scripts/incremental-storage-measure.ts
```

- fresh检查：`2026-10-27T04:13:54.698Z`，Windows空闲RAM 3,782,057,984 B（3.522 GiB），TEMP所在C盘空闲345,673,981,952 B（321.934 GiB）；Node v24.16.0/npm11.13.0。
- typecheck EXIT0，2.408秒。
- whole EXIT0：**822 tests / 822 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**；测试时长45.177秒。
- measurement EXIT0，78.602秒；最大进程RSS 239,876 KiB。源码/测试/scripts/package等132文件前后hash零差异；报告18个runtime源hash也与当前文件一致。
- source-hashes-before.txt / after.txt共同SHA256：`6bc7236be833df9e86feaffb425fa42b1bcb815c6e1a196be3f633dede263c94`。driver SHA256：`4e29869780bd8e2e0dac558c171e5517be12a69c4c48d0abf33e9baa41d27909`。
- schema1 SQL未改，SHA256仍`5997a4524c01c771784cb1771630f25be140562e74e8253f1bb1024315a65fb7`。没有运行npm check、Q0/TJ1/WF1 campaign、真实宿主/provider或训练。

## 独立完整成本结果

固定12-event业务、clock、codec与保留范围；各提交从真实文件重建并逐字节比对自身image，独立source/FTS/高水位/HMAC/Safety oracle与跨arm语义/提交序列相等。主指标是hot vault全部文件和独立authority/现存sidecar的end-minus-setup**逻辑文件字节**，包含stage/record/blob，receipt不重复计费；不称设备物理写入量。

| 工作负载 | commits/arm | v2 raw新增B | v3 full br4新增B | v3 delta新增B | 相对full / raw节省 |
|---|---:|---:|---:|---:|---:|
| append/publish | 69 | 38,203,421 | 981,515 | 516,451 | 47.38% / 98.65% |
| revision/revoke | 77 | 42,616,532 | 1,142,814 | 581,201 | 49.14% / 98.64% |
| 双消费者 | 95 | 54,719,826 | 1,428,684 | 720,339 | 49.58% / 98.68% |

三项分别通过实施前冻结的**相对full至少15%、相对raw至少50%**门，没有跨workload取平均掩盖失败。真正的增量对照是v3 delta与v3 full；对v2 raw的总体改进也包括压缩和去重复stage封装。

高熵文本SQLite仍包含未变化页面，不能当整库不可压缩控制；其delta/full/raw为909,694 / 4,505,324 / 65,518,235 B，不设节省必过门。另一个固定seed的256KiB随机块控制明确选择base/raw，encoded=input=262,144 B且精确恢复；input SHA256 `cc196cda01cfbff8e7dcd90d9343be692b54337d717066d5297d12ac2195fdb9`。无变化poll均0提交，delta最大replay为16。

| delta扩展（不混入hot主门） | append | revision/revoke | 双消费者 |
|---|---:|---:|---:|
| current-state backup B | 33,274 | 65,201 | 76,786 |
| 保留原source B | 417,813 | 474,419 | 588,968 |
| 新active目录（压实+boot）B | 25,400 | 28,699 | 27,039 |
| 含authority/backup/旧源/新目标总保留B | 607,047 | 711,167 | 860,217 |
| compaction / startup ms | 22.16 / 19.71 | 33.87 / 20.39 | 35.99 / 20.46 |

新active缩小，但总保留空间增加；没有删原件。峰值仅按API步骤后及扩展完成采样，是observed lower bound，不覆盖瞬态SQLite journal。延迟/RSS为本机有限样本，不作SLA或十年外推。RAM serialize与比较仍扫描整image，完整Safety写入成本也仍存在。

## 独立审查闭环

实际两位`gpt-6-astra/max`只读研究/审查，唯一`gpt-6-astra/xhigh`实现者修补；Root整合。最后两位均无剩余可操作P1/P2，审查不冒称独立执行测试。

- hot资源两项P2：v3 manifest先界定再读取/parse；writer marker/record/stage不得超过reader界。strict UTF-8、Brotli尾部/拼接流拒绝、累计读取及展开界有实际负例。
- legacy两项P2：合法head字段换序通过规范化保兼容；authority升级在EXCLUSIVE内重验旧布局/身份/完整性、DDL后验新布局与旧行。
- registry一致性属于持久状态合同补强，未证明正常API/崩溃能绕过准入；补状态/receipt绑定和显式receipt字段构造，历史head不强制等于当前head，跨cutover正例保持。
- 文档P2已修并复审：缺失当前尚未发布record可从stage补写，不能与缺失stage/blob/前驱依赖混称不可恢复；已存在冲突record拒绝。canonical目录边界措辞与实际helper一致。

## 证据定位

独立日志根：`%LOCALAPPDATA%\Temp\aemc-if4-independent-20261027T041354279Z`。

| 文件 | SHA256 |
|---|---|
| whole.log | a9fc65e792e276b4378c0f4a881c61a0a56dc5be26f2134aeb7cb957910eb50d |
| typecheck.log | 3c60fa22bd04e0a2acd9cfaffcd8a3547c9e21e72735492f1152dcaac8732233 |
| measurement.log | 3438a10f8fd4b180a28278cd4b5f8d4084f2aef8221469645f6f1907092e76ba |
| preflight.log | 3ba21aafb650fd9389b98d6dd47563689394c537cdc93908bb3fd7e5fd75d01a |
| verification-summary.json | 26b066416a3e9a8a2e2044fdf7806073b08aae6a1106dd11db5ded41a00ce3fe |

完整measurement report：`%LOCALAPPDATA%\Temp\aemc-if3-measure-y7TXdB\report.json`，SHA256 `f8332a674affc61a010c2d1b70b02183e0912d8cda68ee21bfdfbb2496ec9f82`；protocolDigest `1ea52c00ee2e3114b20dc1cbda40e38aabec298d9fae212d24dec7c45cce22be`。Root已复核日志摘要、report及before/after manifest摘要，后续文档整合不修改冻结源码。

## 明确未接受范围

Root于`2026-10-27T04:33:01.701Z`完成文档整合后复核：独立manifest中132文件全部与测试时一致，13份入口/API文档的145条本地链接均存在，`git diff --check`通过；schema1及指定WF1路径无diff，branch/HEAD未变，handoff仍被Git排除。复核结果在同一独立日志目录的`root-final-verification.json`；未重复无变化的whole/measurement。

真实私有M2迁移、旧runtime停用、真实密钥托管/跨机恢复、remote/硬件反回滚、Linux/macOS新代码执行、精确新提交CI、物理断电与十年规模均未执行/未接受。cold历史archive、自动GC、取消16MiB/4096/256MiB和authority容量界未实现。保留旧密文及旧HMAC key不构成crypto-erasure。总矩阵其他前置仍开放，未签训练准入。

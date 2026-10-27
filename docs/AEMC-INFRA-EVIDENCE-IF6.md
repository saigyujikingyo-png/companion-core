# IF5–IF6 最终组合证据

2026-10-27；基线 `d23921f5abc5be10f15883a1a5289af842299b3f`，独立分支 `codex/aemc-infrastructure-20261027`。本轮将 IF0–IF4 的外锚、备份、持久消费者、增量存储和旧 M2 导入，与 IF5 当前授权检索桥、IF6 外锚容量准入一起验证。**本机合成实现及独立验证通过；完整目标仍 IN_PROGRESS / TRAINING_NOT_ADMITTED。**

本文路径中的 `%LOCALAPPDATA%\Temp` 指本机原生临时目录，`<INFRA_WORKTREE>` 指本基础设施工作树。公开文档省略个人目录；精确路径、历史失败和交接保留在被 Git 排除的 `.agents/handoff.md` 与原始本地工件中。

## 最终冻结源码与独立执行

实现者交回全树写权后，独立执行者使用 Node 24.16.0 / SQLite 3.53.0 / npm 11.13.0、原生 TEMP、新合成数据和单测试 worker 顺序执行以下检查。执行前可用 RAM 2.627 GiB、C 盘余量 319.358 GiB。Root 后续直接读回摘要和日志，并逐项复核源码及核心工件摘要。

| 独立命令 | 实际结果 | 墙钟时间 |
|---|---|---:|
| `npm run typecheck` | exit 0 | 2.357 s |
| `node --test --test-concurrency=1 test/*.test.ts test/*.test.mjs` | **874/874 PASS**，fail/cancel/skip/todo 均 0 | 49.470 s |
| `node scripts/incremental-storage-measure.ts` | exit 0，三项必需工作负载各自通过 | 74.974 s |

没有重跑 whole，没有运行 `npm run check`、真实 provider、模型推理、训练、旧 one-shot campaign 或部署。134 个 source/test/scripts/package 文件在作者冻结清单、独立 before/after 清单及 Root 最后读回之间逐项一致；测量另外记录的18个运行时源码摘要也无变化。之后只整合文档。before/after JSON 的 `phase` 等封装不同，文件摘要不同，不将它们误称为同一文件；其134个文件条目完全相同。

独立日志目录：`%LOCALAPPDATA%\Temp\aemc-if56-independent-20261027T090645935Z`。

| 工件 | SHA256 |
|---|---|
| `verification-summary.json` | `fd39b5c271e7ca23ece9863391eefeffeb0bb4794f8e45c113a4ff01b14787bb` |
| `whole.log` | `b65cbf11835345d28684a1d0ba491ad5fe3070fbdf32e0c06fbdf77e6eee2627` |
| `typecheck.log` | `3c60fa22bd04e0a2acd9cfaffcd8a3547c9e21e72735492f1152dcaac8732233` |
| `measurement.log` | `bcfc16e35b22e2aeaa867120f718663e203ddeebdad3deca053e8d7c8ae0db44` |
| `source-hashes-before.json` | `66bc23fd78afacb922c9115d23c33fbff0b69c094734052293094347db47d2e7` |
| `source-hashes-after.json` | `3e7183c1c565055b913e7e974d1b1d71f6aa23898a8a23d4acab064b8c44543c` |
| 作者 `aemc-if6-freeze-x36bK8/source-manifest.json` | `4464069917c7db4445dacd8755577218ea4f84b284fa3e4028317d6089ce8a69` |

原 schema1 摘要仍为 `5997a4524c01c771784cb1771630f25be140562e74e8253f1bb1024315a65fb7`。这些证据对应未提交候选；既有主分支 CI 不能代替本候选的精确提交 CI。

## 写入放大与 compaction

测量协议和驱动未变：协议摘要 `1ea52c00ee2e3114b20dc1cbda40e38aabec298d9fae212d24dec7c45cce22be`，驱动摘要 `4e29869780bd8e2e0dac558c171e5517be12a69c4c48d0abf33e9baa41d27909`。报告为 `%LOCALAPPDATA%\Temp\aemc-if3-measure-9ooRhq\report.json`，SHA256 `9388618f1490a13f39988ffb0fe292896b964588b7c06ba0636a28fb1e656903`。

主指标为固定12个业务事件执行后，相对于 setup 的 hot vault、authority 和现存 sidecar **逻辑文件字节增量**，包含 stage/record/blob；不是设备实际写入字节。各工作负载分别满足相对完整 Brotli4 快照至少15%、相对 v2 raw 至少50%的冻结门，不取平均抵消失败。

| 工作负载 | 提交数 | v2 raw 增量 B | 完整 br4 增量 B | 块增量 br4 增量 B | 相对完整 br4 减少 | 相对 raw 减少 |
|---|---:|---:|---:|---:|---:|---:|
| append | 69 | 38203421 | 981698 | 516339 | **47.40%** | 98.65% |
| revision-revoke | 77 | 42616532 | 1141510 | 581200 | **49.08%** | 98.64% |
| dual-consumer | 95 | 54707086 | 1430263 | 720265 | **49.64%** | 98.68% |

每帧本 arm 镜像字节一致、来源 oracle、HMAC/Safety 和跨 arm 语义均通过；块增量最大 replay 16，无变化 poll 提交0。随机整块不可压缩对照采用 raw，262144 B 输入等长输出且字节准确。高熵 SQLite 文本的附加负载不等于整库不可压缩对照，也不作为必需门。测量进程 maxRSS 262056 KiB。

| 块增量 arm 的延伸指标 | append | revision-revoke | dual-consumer |
|---|---:|---:|---:|
| 备份 B | 33191 | 65139 | 76723 |
| 保留旧源 B | 417702 | 474418 | 588895 |
| 压实并 boot 后新 active B | 25411 | 28663 | 27060 |
| 保留 authority/备份/旧源/新源总计 B | 606864 | 711068 | 860102 |
| compaction ms | 22.82 | 34.92 | 33.72 |
| startup ms | 20.75 | 21.47 | 20.95 |

压实缩小新 active generation，但保留总量仍增加；没有历史 GC。峰值仅为 API 步骤后的采样下界，不含全部瞬态 journal 峰值。RAM 全镜像序列化/比较及完整 Safety 验证成本仍存在；不把这些小型合成结果外推为 SLA、物理写放大或十年容量。

## 独立审查与故障闭环

两位独立 Astra max 审查者分别检查检索/表征边界及存储/容量边界，均在最终冻结源码上报告无剩余可操作 P1/P2。它们的只读审查与独立 Sol 的实际命令执行分账；审查结论不充当测试。Root 仅整合文档和复核证据。

审查发现的原容量 P2 已闭合：原实现允许 authority 提交越过读取硬界，导致已确认写入或 PREPARED 随后无法重开。独立缩尺反例只在 TEMP 源副本中将三个64 MiB读取常量缩为64 KiB，再通过真实 API 触发；未声称运行了实际64 MiB业务增长。修补保留67108864 B读硬界，新增默认22369621 B写软界、单 PREPARED 全局准入、同 SQL 的最终化 SAVEPOINT 预演与回滚日志余量检查。捕获 mutation 异常也不能提交部分登记/意图/receipt。

新测试实际覆盖 PREPARED 子进程退出/恢复、合法 hot journal 的真实 opener 恢复、legacy 登记及 future receipt 容量拒绝整事务回滚、吞掉 finalize 异常、另一个 vault pending 阻止 TTL 写屏障和过期正文交付。hot journal 由 raw SQLite spill 控制器生成，24/34 MiB高水位库是人工大小 fixture；二者不代表新 no-spill writer 的物理断电或真实业务规模验收。

作者红测、早期 fixture 未命中、一次 sandbox junction EPERM 及其单例原生命令返验均保留在 [容量记录](AUTHORITY-CAPACITY.md)；IF5作者关联159/159及早期测试类型问题见 [检索记录](DURABLE-RETRIEVAL.md)。最终874一次覆盖修补后的全部测试；不把作者各轮数字相加，也不改写历史失败。原 [IF4 822证据](AEMC-INFRA-EVIDENCE-IF4.md)仅属于旧源码。

容量保留条件：这不是 OS 磁盘空间预分配，ENOSPC仍可能发生；单个未完成意图可能阻止同外锚所有新写入。旧 ACTIVE 高水位可在硬界内纯读取，但 boot/TTL 是写操作；历史未预留 pending 只有在硬界和日志余量都足够时才能完成。升级须停用旧 writer；同 schema 的旧程序和原始 SQLite 不实施新准入。没有 rollover、receipt GC、旧副本任意恢复或远程/硬件防回滚承诺。

## 合并接受状态

2026-10-27T09:12:46.707412Z 的只读远程核查：仓库 `saigyujikingyo-png/companion-core` 为 **public**，默认 `main` 仍为基线 SHA，开放PR为0。已有 [main CI](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40425590234) 仅覆盖基线。一次本地 `gh --slurp` 与 `--jq` 参数冲突在请求发出前失败，保留原日志；更正为原始 JSON 分页查询后成功，与工程测试失败无关。

本候选范围仅本 infra 工作树的代码、合成测试、测量脚本和说明；不带入 Core/WF2 或 storage lab 的其他 dirty 成果。完整文件快照/清单在最终本地交接中记录。未 commit/push/创建PR/merge，未触发新 CI；[开发状态](AEMC-DEVELOPMENT-STATUS.md)列出后续条件。生产 custody、跨平台及物理断电、真实私有迁移、AR1质量、十年容量及训练仍未接受。

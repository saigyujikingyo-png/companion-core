# IF7 发布闭环与 IF8 容量治理证据

2026-10-27。IF7 已按用户条件完成 PR、跨平台 CI、独立审查和普通合并。IF8 是独立工作树上的同库回执 segment rollover，当前 **LOCAL_VERIFIED / UNCOMMITTED**：作者验证、两位独立代码审查、一次独立 **1004/1004 与 strict TS** 已闭合。IF8 尚未提交、推送、发布 PR 或合并；本轮无真实 provider、Harness、训练、部署或私有库迁移。

## IF7 精确发布结果

[PR #2](https://github.com/saigyujikingyo-png/companion-core/pull/2) 已于 `2026-10-27T13:37:07Z` 普通合并为 `4e0892c0e618304e8e0c84daa9e97b74edbb81ba`。两个父提交为 WF2 main `87eab00cd03867535cc8a32afcbbc3a4dd12546a` 与最终候选 `361d39c170de10cf766dba27131a87d559107363`；合并树 `c215260179c6e43afb1d9b1d645948cd7c85d9f3` 与被验证候选相同。

原 IF7 树保留恢复提交 `8d480ffbae863daf1c6a02d28d9c187422e87ff7`。独立整合树从新的 WF2 main 起步，只解决 README/ROADMAP 相邻段落冲突并随后校正文档发布时态；5 个 IF7 源码/测试文件与原冻结一致，其余 280 个 main 非候选文件的 Git blob/mode 保持一致。最终 2 提交、12 文件，704 行新增/22 行删除。原 [IF7 回执](AEMC-INFRA-EVIDENCE-IF7.md)保留当时的 PR 候选时态，不倒写历史。

新组合本机实际单 worker **984/984，0 fail/cancel/skip/todo；strict TypeScript exit 0**。Node 测试 79.312 s；162 个选定执行文件前后 manifest 一致（不是仓库全部执行文件）。独立精确 head 审查无剩余 P1/P2，核对最终 head/parent/tree、12 文件和 280 个非候选 blob。Codex bot 在同一 head 完成且未报问题；Sourcery 因 quota 跳过，不计为通过。

| 层 | 自然 Actions run | 实际结果 |
| --- | --- | --- |
| PR head `361d39c` core / native | [40512111740](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40512111740) / [40512111654](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40512111654) | 4 + 3 jobs PASS |
| push head `361d39c` core / native | [40512101570](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40512101570) / [40512101586](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40512101586) | 4 + 3 jobs PASS |
| merged main `4e0892c` core / native | [40513612016](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40513612016) / [40513611994](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40513611994) | 4 + 3 jobs PASS；最后 Windows job 于 13:41:01Z 完成 |

合并前 14/14、合并后 7/7。合并前再次核对 main 未变、无 material 阻断及未解决 review thread；未强推、重跑或取消 CI。机械整合、GitHub 发布与验证由实际 GPT-6.1 Sol high 执行；Root 核对原始 gate/merge/CI JSON，而非只采用代理摘要。发布不等于部署或训练准入。

原始回执均在 `%LOCALAPPDATA%\Temp\`：

| 工件 | SHA256 |
| --- | --- |
| `aemc-if7-publication-20261027T131302750Z/pre-merge-gate.json` | `c867cf5cc755f4f60140432d3dcee2de0ace5525b50738bab183776a39c666ca` |
| 同目录 `merge-response.json` | `ddf5fc52db5309d97eafb94f49450ec7cbce7d79189044ffbda19be4904dce57` |
| 同目录 `verified-merge.json` | `405b03fd825458d98605e5b6d7f54ad307bc24bc1f2c4099884a25dde5bc2425` |
| 同目录 `postmerge-ci-final.json` | `5a0e003a58395cce4164653da5c67cc099f61c6d625ea2e227c429cc44d4a85e` |
| `aemc-if7-integration-verify-20261027T131811612Z/summary.json` | `bdc963ed6b26a8d068a5eec641b0f872a194521db2f27e0268fa666a93b302a5` |
| 组合验证 test log | `d82ba6118a77698c8b074e915009d4c83eeddaec2f75927ef70f1b90e47f523e` |
| 组合验证 typecheck log | `3c60fa22bd04e0a2acd9cfaffcd8a3547c9e21e72735492f1152dcaac8732233` |

## IF8 技术裁决与实现

独立树 `codex/aemc-receipt-rollover-20261027` 以已合并 `4e0892c` 为基线。作者 Astra xhigh 单写者实现；完成冻结后交 Root 仅写文档，两位 Astra max 只读审查，实际 GPT-6.1 Sol high 做机械核验与独立测试。原 Core/WF2、lab、IF7 原树/整合树及旧基础设施树未覆盖。

[API 与限制](RECEIPT-ROLLOVER.md)、[原冻结计划](RECEIPT-ROLLOVER-PLAN.md)和[原子 repack 补充合同](RECEIPT-ROLLOVER-REPACK-ADDENDUM.md)共同定义本片。schema 3→4 显式升级，只增加 `receipt_segments`；原 receipts 表、业务 INSERT 和 `(vault_id, operation_id)` 永久键保持。已提交回执的完整原始 JSON 无损进入 Brotli4 frame，原 TEXT 变成严格绑定的 pointer，业务/compaction/旧 M2 查重统一解码。UNKNOWN、已消费额度、feedback、撤销、来源/镜像和 consumer 进度不删除。

最初 UPDATE-only 普通回执测试没有释放完整叶页，正确返回 NO_BENEFIT；这促成两位独立审查后的合同修订。最终在同一 guard/事务内先完全物化候选，再整批精确 CAS DELETE、同键 plain INSERT pointer、写 BLOB、验证键/原文闭包与总数，然后提交。缺键的临时阶段无 await、回调、释放或业务 lookup。最终 page_count 不增长且 allocated pages 必须严格减少。COMMIT 附近结果不确定时按相同维护 ID/请求查回，而不是假定回滚后换 ID。

此选择依赖 SQLite 的[事务原子性](https://sqlite.org/atomiccommit.html)与[普通独立连接隔离](https://sqlite.org/isolation.html)。语句 [ABORT](https://sqlite.org/lang_conflict.html) 不等于整个事务回滚，因此保留既有 poison/外层 rollback；[rowid](https://sqlite.org/rowidtable.html)仅供选择，不是业务身份。[freelist](https://sqlite.org/pragma.html#pragma_auto_vacuum)提供复用页，不代表文件已缩小。未把这些文档性质当作本机物理断电验收。

固定上限为 256 回执/段、完整解码 frame 1 MiB、压缩 BLOB 1 MiB、128 段；默认批次 128。可选参数只能降低限制。64 MiB 读/恢复边界、默认 22369621 B 新写软界与日志预算保持。没有 VACUUM、物理 DB generation 切换、GC、自动维护或无限容量承诺。已经超过软界的旧库、Store 16 MiB、Safety 8192、永久索引和 legacy 记录长期增长仍需后续治理。

## 验证与证据边界

作者最终 focused **20/20**（30.846 s）与七组 affected **180/180**（22.923 s），均无 fail/cancel/skip/todo；作者报告 strict TS exit 0。空 TS log 的 SHA 仅能证明日志无诊断，后续独立执行另有外层退出码。两组数量不相加为 whole。

作者普通容量案例使用真实 API 和短路径，131072 B 软界完全未改：61 个回执、63847 B 原始 JSON，完整 frame 77112 B、Brotli BLOB 7072 B。数据库 32×4096 B 保持，freelist 0→17；同 cap 下 fresh boot 和新业务 claim/reserve 成功，后续余 15 页。旧 payload 冲突、UNKNOWN、额度耗尽、feedback 已消费、撤销拒绝保持；rollover 前后来源/头/镜像/Safety/consumer 快照相同，boot 自身的既有写入另计。该合成案例证明页面复用路径，不是吞吐或剩余可写次数预测。

专项含完整排序 PK 集与未选中原文比对、实际 legacy 导入/准入与 compaction 旧 ID、真实 durable retrieval、两段查回、无收益回滚、全局 pending、codec 边界/损坏、跨进程 guard 竞争、DELETE 后/部分 INSERT 后/BLOB 前进程退出、COMMIT 前退出和实际 COMMIT 后响应丢失。128 段上限是明确标注的结构注入，不是 128 次合法历史 rollover；进程退出也不是物理掉电。

所有早期失败/环境拒绝及修复前后日志仍保留，具体索引见 [作者历史](RECEIPT-ROLLOVER.md#author-verification)。包括真实缺 API red、UPDATE-only 3/6、Windows 长路径拒绝、特殊 overflow fixture、错误的既有异常名，以及 18/19 揭露的缺 segment 维护 ID 被当成新请求缺陷。最终修补通过 pointer 反查拒绝缺 segment，不能用新请求悄悄掩盖。未重放旧 campaign、未降低容量门、未靠特殊大字段替代普通容量验收。

冻结与预核工件位于 `%LOCALAPPDATA%\Temp\`：

| 工件 | SHA256 / 核验范围 |
| --- | --- |
| `aemc-if8-author-freeze-20261027T141239833Z/execution-manifest.json` | `2f0be4e3ec9c5e66ca8095427b7892df7b5596658a9979d012f30e32bded1b7d`；219 文件，全部 tracked non-Markdown + 两个新增 source/test，含 integrations/research/CI/fixtures/configs。 |
| 同目录 `retained-evidence.json` | `541211c504fc57072915e27c25ff53192ff85a79a1aaa8bc616352fc53f486f5`；24 份原始证据 bytes/SHA 全匹配。 |
| `aemc-if8-independent-preflight-20261027T141808821Z/FINAL-RECEIPT.json` | `678f403f4099057f4fbe578123453316b20624fdeb9f644b804a6f65d0f2051a`；219 文件覆盖/逐项 hash、baseline blob/mode、合同和作者文档均匹配；未运行测试。 |
| 原 PLAN / repack ADDENDUM | `61a0ccad4bbcab35dff22629dfea69ae335843a5deb890033a2eab8c12651d78` / `de6cb920182ffde82c62be77190e19385e1efceb57871826715810d9bea811ee`；字节保持冻结原件。 |
| final focused log | `c59c0ab2be72a2a153292c682eb65ffb3838bd141fdd8dfb080133a57364a46f` |
| final affected log | `cd829bfe27ae395fb626e70a7dbe5bcb9ea9af1af17676df4a18cae9b086ab61` |

### 独立闭环

两位独立 Astra max 分别审查事务/repack/fencing/崩溃接缝与 codec/指针绑定/记录保留/容量口径；均直接读源码、测试、合同、manifest 与原日志，未发现剩余可操作 P1/P2。审查者没有重跑产品测试，其审查结论不等于独立执行结果。

实际 GPT-6.1 Sol high 在新原生 TEMP 中先核219文件，再顺序执行 `npm run typecheck` 和**一次** `npm test`（脚本固定单 worker）。类型检查外层 exit 0，2.848 s；whole 实际 **1004/1004、0 fail/cancel/skip/todo、外层 exit 0**，Node 98.621 s/npm 98.990 s。执行前新鲜资源为可用 RAM 4,647,056 KiB（约4.432 GiB）、C:可用335,018,053,632 B，Node24.16.0/npm11.13.0。未运行额外 demo/check/benchmark，未重跑 whole。Root直接核对 summary、跨调用回读回执和原日志终态。

独立 whole 内普通容量案例的原始观测为 **60 回执 / 68505 B 原文 / 82029 B 完整 frame / 7039 B BLOB**。同一131072 B软界、32页文件、freelist **0→17→15**，fresh boot与新业务写入实际通过。它与作者61回执的观察分列；两次通过不意味着随机合成回执的数量/字节数是固定性能常数。

219执行文件在独立测试前、后及跨调用回读均0漂移；全部原日志 bytes/SHA 一致。`aemc-if8-independent-20261027T142332Z` 下：

| 工件 | SHA256 |
| --- | --- |
| `summary.json` | `87cc399260b66dea41dd0dbe1a5558cfb1d892473ab74925292abf822a22318f` |
| `cross-call-verification.json` | `6e434291b6bdc7e4f81c3dd1a70b03920d95029d35044635e7566be745c59f82` |
| `before-manifest.json` 与 `after-manifest.json` | `78b1f9fa9cbc60172bbe01445bf1c6ec003563f82771bbf9cae39ade99451ba4`（归一化的独立清单，不与作者清单的容器JSON hash混同） |
| `test.log` | `74d7762004d0e4e81e66f1ec848d1112f21d5dce1cf2ec9e499f000000d056ee` |
| `typecheck.log` | `3c60fa22bd04e0a2acd9cfaffcd8a3547c9e21e72735492f1152dcaac8732233` |

IF8 尚无精确提交 CI，也无生产资格；不借用IF7的跨平台结果。文档补充与候选快照不改变执行文件冻结。后续任何代码修补都须重新绑定证据，不能继续沿用本次219文件的通过声明。

侧边研究已并入 [I17 贝叶斯重构设计](BAYESIAN-RECONSTRUCTION-DESIGN.md)，仍 DESIGN_ONLY / EXPERIMENT_NOT_RUN。它不会把无损回执协议改成有损记忆重构，也不授予训练许可。

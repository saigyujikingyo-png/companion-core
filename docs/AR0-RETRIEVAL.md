# AR0：有界当前召回与同版 RAM 投影

后续 [SP0A / AR0b0](SCENE-AUTHORITY.md)实现独立 Scene 来源桥和 RAM consumer reset/full-replacement 协议，复用同一 bounded source collector。它不改变本页 RetrievalService、全局 outbox 或持久格式；[durable fanout ADR](ADR-AR0B-DURABLE.md)仍为 DESIGN_ONLY，AR0b持久迁移未实施。

状态：**SOURCE_CONTRACT_PASS / LOCAL_WHOLE_PASS**，2026-10-26。本合同先以 IN_PROGRESS 写入，作者139/139、独立最终6/6与本机一次whole413/413均通过；原12项L1差量仅保留TOOL_OUTPUT_ONLY历史证据、未重跑，分层不相加。源码发布与CI以对应提交记录及Actions为准，本地检查不预报CI通过。
[AEMC 研究路线](AEMC-V05-REVIEW.md)的 AR1 质量实验仍为 **EXPERIMENT_NOT_RUN**；[L1.a 学习声明 lint](LEARNING-DESIGN.md)继续使用独立学习许可。

## 合同

`MemoryStore.retrievalSnapshot(epoch, publishedRefs)` 仅接受受信本地控制面已有的 scope 和明确的已发布 memory refs。
一次只读事务取一个当前 `asOf`，检查健康、generation、consent revision、来源 revision、完整祖先闭包和当前有效期。
不创建 scope、不修改许可、不接受历史 `asOf`。`learningAllowed=false` 允许普通读取；该事实不授予学习、上传或训练许可。
未来 `validFrom` 和已到 `validTo` 拒绝；事件 `occurredAt` 是内容中的事件时间，未知值保留，未来约定不因未来事件时间被误拒。
返回只有 version、authority（含 runtime epoch）、asOf、selected memory 与 root refs、counts；绝不返回祖先 event 原文或 body。
闭包独立上限：32 selected、128 nodes、512 edges、262144 charged UTF-8 bytes。正文读取前查长度，整次失败不返回部分结果。
成本包括读入 metadata、正文、依赖与完整返回表示；它是保守的序列化成本，不是 JavaScript heap 或 tokenizer 预算。

`RetrievalService` 是受信本地同步入口，不提供 host/stdio/network route：

| API | 结果与约束 |
|---|---|
| `bind({epoch,publishedRefs})` | opaque binding，复制冻结输入；只保存当前 runtime authority，不自动建 projection |
| `refresh(binding)` | 先丢弃旧 pair/candidate；完整复核并构建两个同版 RAM view 后才一次发布；返回 revision/counts |
| `query(binding,{text,limit?})` | 默认 8，上限 32；先复核整个 pair 后排名；返回 opaque candidate 与无正文 report |
| `resolve(binding,candidate)` | 再开当前只读事务复核整个 pair、权限、来源和 TTL，返回深冻结 memory-only 结果 |
| `unbind(binding)` | 清除 pair、candidate 与 binding；旧 handle 不能复活 |

输入字段闭合，不允许请求自报 scope/runtime/sources/权限。入口拒绝 Proxy，并从普通对象/稠密数组的自身数据描述符复制字段；拒绝 getter、自定义 iterator、额外字段和 symbol，数组长度先于完整描述符读取限额检查。
query 在 authority gate 前完成全部标量复制与规范化，之后不再读取调用方输入。每 binding 最多一个 active pair 和一个 current candidate；新 query 废弃旧 candidate。
复制、外 service、外 binding 的 handle 均拒绝；known old candidate 立即从 WeakMap 删除，不由其保留旧 snapshot。
每次成功 authority 读取后的 `lastAsOf` 单调不降；检测到时钟倒退即使该 binding 失效。旧 generation/consent/runtime 拒绝，包括空 scope purge 和 unrelated revoke。
learning consent off→on 后，仅新 epoch 的新 trusted bind 可读。所有操作同步完成，无 timer、worker、异步回调或嵌套事务。

## 同版投影与排序

两个封闭 reference RAM view 都来自同一个 snapshot：字面/词项 view 与 memory↔root 共享来源 view。
字面规范化固定为 NFKC 后 JavaScript `toLowerCase()`；词项是 Unicode 字母或数字的最大连续片段。
直接命中为非空规范化 query 的字面子串，或 query 全部不同词项均存在于 memory 的词项集合。
无字母数字的 query 仍可字面命中。中文日文连续片段不是语言分词，本规则不是 semantic、embedding、BM25 或相关性质量模型。
直接命中优先，然后只补与直接命中共享至少一个 root 的 selected memory；同层按绑定 refs 的稳定 ordinal 排序，最后统一 limit。
无直接命中时返回空；不做全库 fallback，不做多跳传播。标注 `direct_lexical` / `shared_root`，root 去重不增加独立证据数。
只有绑定 selected 能被输出，祖先与其他 scope 不能参与排名。

派生 view 另有独立上限：memory + unique root nodes ≤128、memory-root edges ≤512、charged UTF-8 bytes ≤262144。
闭包边数合格不保证派生边数合格；共享中间 memory 可让 root 映射膨胀，必须单独拒绝。
两个 view 构建后一起可用或不可用；refresh 失败没有旧版 fallback。投影预算失败保留 binding，可在新的成功 refresh 后使用。
任何 snapshot/来源/authority/TTL 复核失败则终结整个 binding，必须由受信控制面重新 bind；已观测过期不能被随后时钟倒退复活。
snapshot 或返回副本不是继续访问许可。跨 `await`、发送 provider 或其他外部使用前须重新 `resolve`；已经交出的副本不能物理召回。

## 验收矩阵

| 类别 | 必须验证 | 当前 |
|---|---|---|
| 权限与时间 | learning off 可读而 curation 拒绝；旧 consent/runtime；空/非空 purge；revoke/revise；TTL/future validFrom；未知/未来 occurredAt | AUTHOR_PASS |
| 来源闭包 | 跨 scope、raw event、pending、缺父、cycle、revision conflict、no root 拒绝；diamond 去重 | AUTHOR_PASS |
| 预算 | 32/33 selected、128/129 nodes、512/513 edges、snapshot 与 projection 各自 UTF-8 cap/+1、派生边膨胀 | AUTHOR_PASS |
| capabilities | 复制/外 service/外 binding、输入后改、新 query/refresh 旧 candidate、失败 refresh、clock rollback | AUTHOR_PASS |
| 空与持久边界 | empty 仍复核；poison；合成 M2 恢复拒旧 handle、新 bind 可读；已 ACK outbox 可重建 | AUTHOR_PASS |
| 无副作用 | read/query/失败前后 DB image、outbox、persist 计数不变 | AUTHOR_PASS |
| 回归 | strict TypeScript、L1 原专项、store 回归、三个 synthetic demo | AUTHOR_PASS；本机 whole413/413 PASS；CI待发布后对应提交 |

## 明确后续

AR0 是绑定 refs 的局部全量重建，完全不调用 `projectionBatch` / `acknowledgeProjection`，不碰现有全局 outbox ACK。
无 durable cursor、schema migration、历史召回、全 scope 索引或持久多索引同步。重启丢弃全部 RAM 能力，受信宿主重新 bind/refresh。
本批不改 M2 格式/依赖/模型/真实数据/生产部署，也不实现 PPR。

开发顺序：本批 AR0 → **AR0b** 持久 dispatcher/per-consumer 迁移，冻结崩溃重放、重复幂等、删除次序与重建基线 → **AR1** 真实 embedding/BM25/PPR/mean-vs-sampled 的冻结质量实验。
[SQLite isolation](https://www.sqlite.org/isolation.html)说明读事务提供一致视图，但事务结束后的使用仍需新复核。
[AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)强调重复、顺序与事务回滚边界；引用它不代表当前全局 ACK 已具备多消费者 fanout。

## 实际校验记录

实现入口：[Store](../src/store.ts)、[RetrievalService](../src/retrieval.ts)、[独立类型与预算](../src/retrieval-types.ts)。
新增[闭包合同测试](../test/retrieval-snapshot.test.ts)与[服务生命周期测试](../test/retrieval.test.ts)共 52 项；与原 L1 snapshot/curation/store 87 项合跑 **139/139 PASS，0 fail / 0 skip**。
运行命令为 `node --test test/retrieval-snapshot.test.ts test/retrieval.test.ts test/curation-snapshot.test.ts test/curation.test.ts test/store.test.ts`；`npm run typecheck` 通过。
原 L1 的权限检查次序、错误码、输出及精确 262144-byte 边界保持通过。首次三个 snapshot 合同在实现前失败，完成后通过；已观测 TTL 失败再回拨时钟的旧 binding 复活、Proxy/自定义 refs 数组、描述符读取晚于限额检查的反例均经历 RED→GREEN。

`npm run demo:retrieval` 使用全新 RAM 数据库，输出 `AR0_CONTRACT_PASS`、2 selected / 1 root / 1 direct / 1 shared / 2 hits 与撤销错误码。
演示不输出正文、身份或私有 hash；`realModelCalls=0`、`productionData=false`、`quality=NOT_EVALUATED`、`durableFanout=NOT_IMPLEMENTED`。
`check` 仅在原有序列末尾追加此演示；作者没有运行完整 whole，之后由 Sol 正常用户路线独立运行一次，实际413/413、0 fail/skip，strict TS和三个demo通过。
执行前后12个冻结文件与3个保护文件哈希、HEAD/branch均相同。独立max最终6/6、原12项L1差量TOOL_OUTPUT_ONLY与作者139分别记录，不相加；早期不完整日志不补造。
未改schema/M2/依赖，未调用真实模型或部署。CI、源码发布与真实部署仍各按后续确切证据记录；本页不把机制fixture当成召回质量或生产验收。

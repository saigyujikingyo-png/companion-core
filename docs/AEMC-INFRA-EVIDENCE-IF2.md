# IF2 / schema2 持久元数据消费者证据

2026-10-27。状态：实现与作者验证完成，独立 whole 778/778 PASS，两位独立冻结终审闭合。完整基础设施仍 **IN_PROGRESS / TRAINING_NOT_ADMITTED**。manual worktree `codex/aemc-infrastructure-20261027`，基线 HEAD 仍 `d23921f5abc5be10f15883a1a5289af842299b3f`；所有本批修改未 commit/push/merge。

## 结果与范围

- [S1](AEMC-INFRA-EVIDENCE-IF1.md) 的强制外锚、PREPARED/reconcile、源 fencing、recipient rewrap、真 DEK rekey 已先实现和审查闭合。
- [S2 API](DURABLE-FANOUT.md)：显式 schema2，原 schema1 SQL/hash 不变；无 boot 副作用的 RAM 副本迁移，通过新目标和外锚切换激活。源 mutation 与 metadata 失效 journal 同事务；retrieval-refs-v1、scene-source-refs-v1 各有独立持久投影与完整前缀游标，投影/游标同事务。
- 时间屏障先持久化，read 两阶段共享一个冻结 asOf；句柄绑定 boot、consumer generation 和当前 scope/consent/runtime。暂停、重启、撤销、来源更正、未来启用/过期均有专项反例。
- required consumer 阻止越过其进度裁剪；显式满库维护从 authority exact current image 读取，不 boot、不依赖旧备份，RAM 裁剪后切换新目标。required reset 必须列名，receipt 记录 floor/实际 reset IDs；源字节保留。
- 只交付本机有界 metadata fanout，日志保存失效目标而非历史精确 revision 内容。未接外部向量库、完整 scene 引擎、生产服务或旧 M2 私有库；不代表 C04 全部目标合同、长期增量存储或所有训练前项完成。

## 作者证据（各层不相加）

| 阶段 | 结果 |
|---|---|
| 初始 S2 专项 | 20/21；fixture 删除对象前未清 outbox 外键，修 fixture 顺序，未放宽 FK |
| 近预算 fixture 中间验证 | 下界断言不符实际 JSON 大小；修正 fixture 计量断言，原失败工具输出保留，未补造文件日志 |
| S2 + S1 + 原 M2/Store 关联 | 150/150 PASS，类型检查 EXIT0；16.027 秒、native TEMP 单并发、fresh RAM 2.816 GiB |
| 最后窄修补 | S2 30/30 PASS、类型检查 EXIT0；2.285 秒、fresh RAM 2.800 GiB；新增 schema1 restore/rekey receipt digest 兼容和 safety serialization failure poison 回归 |

关联日志：`%LOCALAPPDATA%\Temp\aemc-s2-associated-20261027T020446Z\associated.log`，SHA256 `0eed31b2dc57d610ea266ca7545b10f636c211458128536f73e8207d2405d498`。

最后专项：`%LOCALAPPDATA%\Temp\aemc-s2-freeze-20261027T020957Z\fanout.log`，SHA256 `f6e3177d060e9426b1bca1adf693c0d1903125c686162e9c5ed6824a5a2438bb`；同目录有 typecheck/resources。Root 已核实日志摘要和 hash。

## 独立 whole

实际 `gpt-6.1-sol / high` 测试代理，在冻结源码上只运行：

```text
npm run typecheck
node --test --test-concurrency=1 test/*.test.ts test/*.test.mjs
```

- Node v24.16.0 / npm 11.13.0，Windows native TEMP、单并发；执行前 `2026-10-27T02:14:12.686Z` 可用 RAM 2,745,364,480 bytes（2.557 GiB）。
- 类型检查 EXIT0，2.355 秒。whole EXIT0，**778 tests / 778 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**，37.226 秒。
- 124 个 src/test/scripts/package 白名单文件的摘要前后一致。未扫凭据、运行数据或 .env。manifest SHA256 `9e61c7f1871ca6c6b81bc0f40cae06856ca8bd0a7eb210796990ff99c9d6a66b`。
- 日志目录：`%LOCALAPPDATA%\Temp\aemc-s2-final-20261027T021412276Z`。
- `whole.log`（89,736 bytes）：`1a6bda9996bd3f48d066ce04b6638b4d6745dd0f9f09b531a8fa5bd5b6670245`。
- `typecheck.log`：`3c60fa22bd04e0a2acd9cfaffcd8a3547c9e21e72735492f1152dcaac8732233`。
- `preflight.log`：`27e9bcc33ebf942ca95493e5c10547912ce8fb5d1a187dca90ba7c8c9bf21528`；前后源码列表为 `source-hashes-before.txt` / `source-hashes-after.txt`。
- Root 已独立读 whole 摘要并核对 whole 与两个 manifest hash；源码冻结未变。没有跑 npm check、demo、正式 Q0/TJ1/WF1、真实 provider、训练或部署。

## 独立审查闭环

实际两位 `gpt-6-astra / max` 只读审查，唯一 `gpt-6-astra / xhigh` 写者实施修复；Root 在交回写权后整合文档。S1 六项问题的闭合保留在 IF1。

S2 重点问题及修复包括：旧 handle 跨 authority 代际、TTL 两事务时钟边界、未知 schema fallback、projection 字段/前缀/字节口径、65th scope 提交前限制、满日志无法 boot 的维护路径、required reset 显式选择、合法中文 consumer ID、必需 ledger_key、维护 image/highwater 一致及 boot 容量。全部有代码修补和相关反例，未通过放宽原 schema、外键或安全门消除失败。

两位冻结终审均已闭合，无剩余可操作 P1/P2。存储审查确认无 boot inspector、固定 layout、原件保持、maintenance fencing、receipt 幂等、reconcile、serialization poison 和 S1 digest 兼容；消费者审查确认权限代际、TTL、投影/checkpoint 原子性和验证边界，并核对 C04 与矩阵 I01/I02/I05 不冒称完整目标。审查者没有重跑 whole，测试结果引用各自执行者，不能互替。

Root 文档整合后再次逐一复核124个代码/test/package摘要，无差异；9份入口/交付文档共117个本地链接全部存在，`git diff --check`通过。schema1/WF1指定路径无diff，branch/HEAD未变化，原件与历史证据保持。

## 最终核心冻结

| 文件 | SHA256 |
|---|---|
| src/store.ts | 52bd64c302ec8765f6c90cab3015f9b01f82f2c2aa906a87aa781180bca2cb7e |
| src/anchored-codec.ts | 5c16831f0111ebde708a2d705272f6a6861a94a291e2d0c549a41e86ecdf8c34 |
| src/anchored-vault.ts | fa32c35c208d57faa96255ba2a54d76c8e62ff7386971de01840309bf6d6cc6d |
| src/local-sqlite-authority.ts | 50f70ea5e0f03e8cdbc3d50818fd582db609096e352c00ccd23d67e90d280950 |
| src/durable-fanout.ts | a5f2bca98061d65f78b6d746597e10f2674cf2e7407794d41bfb860ff25ad631 |
| src/fanout-types.ts | 8650aa1ed87d9c8ff0ce72f54986d0f91b1ab792304d8ed4d8a633d3e33ceba6 |
| src/schema-v2.ts | 075e1fe5b0fb259336b6b9f237b0d4f57a3ee4c9167aab84f4780d94b02b00c6 |
| src/memory-image.ts | cab38d612cced146c4ff4fdef35c8053e5f6cfecd493259031100951f253e6f7 |
| test/durable-fanout.test.ts | 2f4a8738efc78a35ef38a4c8476b0357779f3f7e47bb510845aaf488eb10917e |
| docs/DURABLE-FANOUT.md | 17bdb076e174ffc317d9823a31f09beb637a94c9cefb884095e01af3376e55c8 |
| src/schema.ts（未改） | 5997a4524c01c771784cb1771630f25be140562e74e8253f1bb1024315a65fb7 |

## 成本与未接受范围

独立 whole 重现八个合成事件、两个消费者：setup 4 / source 40 / grouped consumer 8 次持久提交、17 个 source batches，无变化 poll 0 次。新增 checkpoint/record 密文 11,123,934 bytes，含 staging 目录增长 25,980,225 bytes，峰值目录 28,085,398 bytes。source 五步流水线均值/最大 73.536/109.761 ms，双消费者 apply 13.439/15.824 ms；只是小型本机样本，不作 SLA 或十年推演。作者关联 run 的时间另保留于 API 文档，不混成同一次测量。

全image的16MiB/4096 commits/256MiB限制仍在；schema2 journal上限512 batches/16384 items，投影有独立容量门。production/remote custody、硬件单调性、跨机钥匙恢复、历史全量rekey、旧 M2 导入、Linux/macOS运行、物理断电、十年规模、真实检索/scene质量、新提交CI与训练均 **NOT_RUN 或 NOT_IMPLEMENTED（依项）**。冻结基线CI不能为这些未提交修改背书。未合并、未启动训练。

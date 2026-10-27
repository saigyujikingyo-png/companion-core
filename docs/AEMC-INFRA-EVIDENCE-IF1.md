# IF1 / S1 外锚、恢复 fencing 与密钥迁移证据

日期：2026-10-27。状态：作者专项通过，独立审查闭合；后续 S2 仍须实际实现。完整前置仍 IN_PROGRESS / TRAINING_NOT_ADMITTED。基线、manual worktree、无合并约束沿用 [总矩阵](AEMC-INFRASTRUCTURE.md)，IF0 证据保留不改。

## 实现范围

新增 mandatory anchored-v2 `AnchoredVault`、独立配置 `LocalSqliteAuthority`，整个同步 Store 访问持有外锚事务。固定 staging → 持久 PREPARED → 发布固定密文 → ACTIVE；失败显式 reconcile，不重做业务调用。实际恢复和真正 DEK rekey 创建新目标、递增 owner epoch 并 fence 旧源。KEK recipient rewrap 保留 DEK/稳定 ingress key；正确 DEK 配错 ingress key 拒绝。接口及完整信任边界见 [ANCHORED-VAULT](ANCHORED-VAULT.md)。

这是本机独立 custody 前提下的参考协议，不是 TPM、远程托管部署或抵抗管理员同时回滚外锚与库的实现。无旧 M2 导入，未迁移私有数据；旧 M2.v1、旧 schema SQL、原备份及密钥档案均保留。current-state rekey 不声称全部历史重加密或密钥销毁。未接生产 provider/训练。

## 作者验证分层

| 冻结阶段 | 结果 | 范围 |
|---|---|---|
| 首次新专项 | 24/24 PASS，类型检查 PASS | 首协议实现 |
| 中间关联 | 112/113 | 唯一失败是 Windows 打开的 SQLite 文件无法 rename，fixture 的跨平台假设不成立；原工具输出保留，未补造文件日志 |
| 修补后关联 | 121/121 PASS | S1 35 + 旧 M2/backup/Store 86；不是 whole |
| 最后 canonical 路径修补 | S1 36/36 PASS，typecheck EXIT0 | 4.577 秒、0 fail/cancel/skip/todo；单并发 native TEMP、Node 24.16.0、fresh RAM 3.507 GiB |

Windows fixture 明确断言打开数据库不能 rename；POSIX 分支存在但本机 NOT_RUN。覆盖真实子进程切换/锁竞争、三个真实 process.exit 故障点、五个注入故障点、未知提交无退款/无重放、源 fencing、quota/撤销/去重/反馈保持。各结果不相加。S1 没重跑 whole，后续 S2 冻结再独立执行。

日志（均 OS TEMP 合成数据）：

- `%LOCALAPPDATA%\Temp\aemc-s1-20261027T013204Z\focused.log`：SHA256 `af90d3e16949b56010320e70449437446342e5b68180dea309ba1edff49a7c2b`。
- `%LOCALAPPDATA%\Temp\aemc-s1-freeze-20261027T013501Z\anchored.log`：`c0828573c5c0c3d0d596c5a57c42904e7e3be80b14c8c88dc6d9357f627a3ac8`。
- 同目录 `typecheck.log`：`3c60fa22bd04e0a2acd9cfaffcd8a3547c9e21e72735492f1152dcaac8732233`。

Root 已独立核对日志摘要与上述 hash。新提交 CI、Linux/macOS 实跑、硬件掉电、远程/生产 custody、实际宿主与训练均 NOT_RUN。

## S1 源码冻结

后续 S2 允许按新阶段变更；下表只认证此 S1 快照。

| 文件 | SHA256 |
|---|---|
| src/anchored-codec.ts | 1aab4fa42c2d549d5e5df3b12f9a18d5d1de92941db56bb8dec56285709a65f4 |
| src/local-sqlite-authority.ts | 059d958ba0a71a3d2bcbd544c9f09efa1d612aef9e7025f9999f1f6c4923d4db |
| src/anchored-vault.ts | 37873e33c13a0ca060a2b789d2f58eeb25a064a8bb55fe7514e5cdebb1a6bcdc |
| src/store.ts | dbc55b7a8a0ba22cfd441495893c7dc23bdc169f1ad9cdf4730d5f82823fdbf9 |
| test/anchored-vault.test.ts | 4d93b2bb727594b4fd2e016e2b92c318cc1b8ec30773c7f29dd9001481a12c34 |
| docs/ANCHORED-VAULT.md | cee3a6d0ea116364f947f5c97aca48d674b40ba43c7aaa4da3d5564d4a78385c |
| src/schema.ts（保持原样） | 5997a4524c01c771784cb1771630f25be140562e74e8253f1bb1024315a65fb7 |

## 独立审查

实际 Astra max 只读预审发现并由唯一 Astra xhigh 写者修补：外锚跨 vault/非法代际转移、过期 transaction capability、recipient 字段顺序、DELETE+EXTRA 同步配置及读回、首次 SQLite open 前 sidecar 边界、低层 adapter 的 canonical 路径绕过。对应反例已进入专项。最终独立复审确认以上六项闭合，无剩余可操作 P1/P2，可启动 S2；guard、PREPARED、恢复 fencing、rekey、reconcile 与文档一致。审查者未写文件或重跑测试，36/36 与类型检查引用作者证据。

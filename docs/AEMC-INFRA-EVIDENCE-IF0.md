# IF0 开发与验证证据

日期：2026-10-27。状态：**本机合成首片验证通过 / 全范围仍 IN_PROGRESS / TRAINING_NOT_ADMITTED**。
基线为 `d23921f5abc5be10f15883a1a5289af842299b3f`；本批为独立manual worktree未提交修改，没有合并、推送或新提交CI。

## 分层记录

| 层 | 实际记录 |
|---|---|
| 冻结基线 | validation40425316221、main40425590234独立GH只读复核：同冻结SHA，各四项SUCCESS；只覆盖旧基线 |
| 作者新专项初轮 | Windows sandbox 3/33；manifest原子rename在sandbox TEMP被EPERM拒绝，保留失败，不降门 |
| 作者native中间轮 | 32/33；FTS损坏fixture未真正形成目标破坏，后在独立合成builder禁defensive并破坏实际FTS data block；生产defensive保持 |
| 作者定向 | 新backup38、原M2 21、restart1、Store26，单并发86/86 PASS；native TEMP，fresh约4.96GiB可用RAM |
| 作者后续close修复 | export回调通过store.close绕过保护，加入独立close guard后10/10相关定向PASS；不与86相加 |
| 类型/静态 | 作者与Sol最终strict TS PASS；Root整合后git diff --check PASS |
| 独立正确性审查 | Astra max最终只读复查关闭P1空目录crash窗口、P2 store.close重入；未发现其他新增可操作问题。未独立重跑，代码审查与作者运行证据分列 |
| 独立文档审查 | 另一Astra max发现并复查关闭四项P2：元记忆风险查证范围、状态各通道根事件消费去重、完整mapping profile、DirectML GPU分类；设计功能仍DESIGN_ONLY |
| whole | 独立Sol：712/712 PASS，0 fail/cancelled/skipped/todo，30.782秒，exit0；代码五文件摘要前后相同。不与专项相加 |
| 新提交CI/平台/部署 | NOT_RUN；没有新提交或Linux/macOS验证；未接真实宿主、数据或provider |

whole命令：`node --test --test-concurrency=1 test/*.test.ts test/*.test.mjs`；类型检查：`npm run typecheck`。运行时Node24.16.0/npm11.13.0，2026-10-27T00:49:03.503Z的fresh可用RAM为5199183872字节（4.842GiB）。没有运行npm check、正式Q0或实际TJ1 trainer。

原始日志仅在本机TEMP，主控可从排除入库的handoff取得路径；Root已核tail与hash。typecheck日志SHA256 `3c60fa22bd04e0a2acd9cfaffcd8a3547c9e21e72735492f1152dcaac8732233`；whole日志SHA256 `de3a2163be65a988da647fa2e42296b11642787ffc7aa60da965afdfb9572849`。本文件是安全摘要，不替代原始日志。

Root整合文档后再次确认五个源码/测试hash未变、diff格式检查通过、五份新文档的15个本地链接全部存在。18项范围矩阵、22项ADR、15组版本合同是设计与实施台账，不构成这些目标已经全部实现的声明。

## 本次被验证的源码冻结

| 文件 | SHA256 |
|---|---|
| src/durable-codec.ts | 664a0954774000e47f1d6a9466ce96c534c01d403a4d93fc6605253e9fb2fd53 |
| src/durable-backup.ts | 928848a529545192fc489fb55e7169627fe6a5ec6f4921cd01d5f3ce9188b1c9 |
| src/durable-memory.ts | f35a2ce1fe39e17096851167e9b70d92c189962492f33c35e3e7fbf651fe39ae |
| src/store.ts | f455986f7e4994ede20b679ecb53e03793cafbbabe42d6f9b908136d127d49a9 |
| test/durable-backup.test.ts | b35f6ea9ab38a7f1b9a94e3959f9fde78ccd9418796e9c131566fb76d39d6c49 |

## 核心修复与边界

1. head pin由包外提供，认证链必须包含同seq/hash；pin是下界，不是最新性证明。无pin的原有效前缀回滚负例保持。
2. authority通过受独占writer的同步serialize捕获，连同精确最新checkpoint验证后导出；没有热复制DB、导出密钥或任意历史完整性声明。
3. 验证使用query-only authority RAM副本与受限MemoryStore image，不把会追加checkpoint的DurableMemory构造当只读验证。
4. stage目标basename必须有 `M2.restore-quarantine.v1-` 前缀，boot在初始化前检查canonical basename；mkdir后直接子进程exit17留下空目录也拒绝boot，不产生writer文件。
5. 独立close guard禁止export期间直接关闭store，但允许正常/poisoned资源清理。源状态、配额、撤销、旧schema/格式不变。

首次CIM资源读取被sandbox拒绝，改用node:os只读fresh内存；依赖安装首次sandbox registry DNS失败，随后经受控native `npm ci --ignore-scripts --no-audit --no-fund`安装锁定三项开发依赖成功。未改用户配置。

测试数据仅新TEMP合成，未读取真实聊天、私有记忆、教学/密封原件、DPAPI或旧runtime；实际provider调用、训练、GPU任务和部署均未执行。测试中的合成key只在内存/stdin，不打印到本证据。

恢复激活/源fencing、外锚托管、key迁移、长期容量/冷热层/保留、断电可靠性、多消费者和其他目标仍开放，见[总矩阵](AEMC-INFRASTRUCTURE.md)。本片通过不签发训练资格。

# IF7 本机闭环与 IF0–IF6 发布证据

日期：2026-10-27。IF0–IF6为 **MERGED / CROSS_PLATFORM_CI_PASS**；IF7为 **LOCAL_VERIFIED / UNCOMMITTED / UNMERGED / CI_NOT_RUN**。完整架构仍 `IN_PROGRESS / TRAINING_NOT_ADMITTED`。本页补充实际发布与新切片证据，不改写 [IF6原回执](AEMC-INFRA-EVIDENCE-IF6.md)。源码、合成测试、生产接受和训练准入分账。

## PR #1 条件合并已完成

[PR #1](https://github.com/saigyujikingyo-png/companion-core/pull/1) 于 `2026-10-27T12:08:37Z` 普通合并。父提交为原main `d23921f5abc5be10f15883a1a5289af842299b3f` 与最终head `4871f165f8a42fe8eb243d713e88819225d77e71`；合并SHA为 `06fc8b2265aec5fcba8cb851ac55a14326a99e22`。合并树与head均为 `5b8e24d5826c9f08efe8d631c5802670a7b123a8`，未使用force、绕过失败门或手工重跑/取消CI。

| 精确提交与层 | 实际结果 |
|---|---|
| head `4871f16`，[PR run 40500911425](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40500911425) | Windows/macOS/Ubuntu Node24.16.0及Ubuntu24.x，4/4 SUCCESS |
| 同head，[push run 40500907013](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40500907013) | 同四个平台，4/4 SUCCESS |
| merge `06fc8b2`，[main run 40501461966](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40501461966) | 同四个平台，4/4 SUCCESS；最后job于12:12:37Z完成 |

Sol核验main仍为冻结base、可普通合并、无新增review阻断后执行用户已确认的合并。可选Sourcery因diff过大跳过；旧head的异步Codex bot当时仍运行，不记为PASS，也不是本次必需门。人工分派的独立Astra审查已另行完成。

发布包含50文件、四个提交：`d22d761`基础设施，`e34d8c3`跨平台测试路径，`43b760c`可移植容量夹具，`4871f16`单worker测试入口及子进程诊断。生产src在后三个提交中不变。原49文件候选扩大到50文件，是因为必要的 `package.json` 测试调度修补；显式多进程竞争测试仍运行。

### 保留的 CI 失败和修补

| 原阶段 | 实际失败 | 修补及边界 |
|---|---|---|
| `d22d761` | Linux两组873/874：纯RAM测试硬编码Windows路径；macOS72例失败：TEMP目录存在symlink别名；Windows通过 | 五个测试文件改用canonical realpath或平台绝对根，未改生产路径检查或放宽错误断言；128/128与TS通过 |
| `e34d8c3` | macOS873/874：24层路径先触发ENAMETOOLONG，未到产品容量门 | 合法128个CJK字符身份、24576B padding、65536B写界；实际prepared65536→future69632B，短目标路径68B；SQL成功后才记录registry/receipt INSERT，仍核原DB全字节/hash与登记回滚；1/1、38/38与TS通过 |
| `43b760c` | PR四平台通过，重复push的Windows873/874；故障子进程应exit47却status=null | 原timeout15000ms，失败用例20.935s，同head成功2.550s。原日志无error/signal，精确原因保持UNKNOWN，不能断言就是超时。npm test改单worker；诊断仅补error.message/code、signal/status/stderr，不输出stdin或key；超时/exit47断言不变 |
| `4871f16` | 无新失败 | 本机一次实际npm test874/874与TS0，两组精确head CI全部通过后合并；旧失败日志原样保留 |

发布日志位于 `%LOCALAPPDATA%\Temp\aemc-if56-publication-20261027T113241Z`。`pre-merge-gate.json` SHA256为 `8326d389db83430f743a244d68458399f4a807641fd5ead702f7f6bed6fbf287`；`merged-and-if7-setup.json` 为 `66fa1cfc0b0179595418c1a702ce9944b0aa14f0a44d6df3dc36de54977ef761`；`main-merge-ci-final.json` 为 `842525645be919c2092ba0d818d55cc7c7c84cd365bcd46d9e39213c5ee71678`。Root直接读取原回执及本地合并parents/tree，未只依赖代理总结。

## IF7 实现范围与路线

独立分支 `codex/aemc-capacity-inspection-20261027` 从合并SHA `06fc8b2` 创建。冻结 [实现合同](CAPACITY-INSPECTION-PLAN.md) SHA256 `1313c2225a0130c29b31f7d5982d67d6b3f429bfc265c801e91d8f531f76a3ea` 保持原件。唯一作者为实际Astra xhigh；代码冻结后Root只整合文档。

- `LocalSqliteAuthority.inspectCapacity()` / `AuthorityTransaction.capacity()`：同一现有guard中观察schema、page/freelist/sidecar、vault/pending、receipt UTF-8 JSON字节与legacy registry。
- `AnchoredVault.inspectCapacity()`：不构造live Store；ACTIVE复核exact head、marker、链、Safety、RAM image/FTS及fanout。PREPARED和UNREGISTERED只给metadata，不读stage、不自动reconcile或准入legacy。
- 新扫描器以bufferSize1流式读取，最多16384项且只可下调；未见EOF则精确总数/字节为null，只报观测下界。其他generation和backup显式unmeasured。现有authority guard仍有 `boundSqlite` 的 `readdirSync`，本片不声称整调用已消除全部无界目录枚举。
- 报告为递归冻结、脱离内部对象的JSON metadata，无正文/来源ID/ingress HMAC/receipt内容及可写能力。拒proxy/getter、head/path覆写和异常keys；复制keys与解码image最终清零，调用方原件保持。
- 不boot、不扫TTL、不变更epoch/lease/UNKNOWN/额度，不serialize写回；原schema、codec、shared guard及容量准入不变。已有SQLite打开时的hot-journal恢复仍可能发生，不冒称被API禁用。

结构计数含已保留、撤销和到期数据，不代表当前检索许可。receipt JSON字节不是物理表分配；freelist不是可回收磁盘；空blockers不等于READY或剩余可写次数。完整字段、限制和错误语义见 [API说明](CAPACITY-INSPECTION.md)。

## 作者、审查、独立验证

| 层 | 实际结果及范围 |
|---|---|
| 作者最终专项 | 19/19，1.437s；v2/v3、schema1/2、UTF-8/freelist、TTL/Safety保持、失效live handle、pending无payload、legacy未准入、compaction、partial scan、输入、capability、真实进程guard竞争与损坏拒绝 |
| 作者六组关联 | 161/161，19.891s；anchored-vault、authority-capacity、durable-fanout、durable-retrieval、incremental-storage、legacy-m2-import |
| 作者strict TS | exit0 |
| 两位独立Astra max终审 | 各自只读复核两项P2与compaction夹具修补，无剩余可操作P1/P2；各核136文件大小/hash一致，未执行测试 |
| 实际GPT-6.1 Sol独立执行 | 单次 `npm run typecheck` exit0，2.795s；随后实际 `npm test` 单worker，**893/893**，0fail/cancel/skip/todo，Node51.772s、npm墙钟52.148s |
| 冻结一致性 | 136文件与作者manifest全部匹配，运行前后manifest相同；跨调用复核源码和日志0漂移。文档整合不改源码冻结 |
| 新IF7精确提交CI、原生宿主、生产/质量/训练 | **NOT_RUN / NOT_ADMITTED**；合并点CI仅覆盖IF0–IF6 |

独立执行的fresh Windows可用RAM在preflight为3.408GiB、启动时3885656KiB约3.706GiB；C盘可用339016855552B，Node24.16.0/npm11.13.0。未杀其他进程。仅运行该次whole及TS，未额外执行benchmark、npm check或demo，未调用真实provider/API或启动训练；whole内部合成provider测试照常执行。Python文件只hash，未执行。

作者日志：`%LOCALAPPDATA%\Temp\aemc-if7-author-verified-20261027T123736527`。专项SHA `46cb74a711f9bd1f730cc4138bbf9c11ac2f2fc54c638318596180f9c192c6ab`；关联SHA `9b046c231ac242d9b4df7db6780a22ef8dd283e52a5c973c4e528a18ebf24402`。作者136文件manifest位于 `aemc-if7-author-freeze-20261027T123925024/source-manifest.json`，SHA `69226d926fd9132ec6b76a4ad321f8e0477a3d85058c30f9d605467674351cfa`，格式为phase+files。

独立日志：`%LOCALAPPDATA%\Temp\aemc-if7-independent-20261027T124146334Z`。

| 工件 | SHA256 |
|---|---|
| summary.json | `772fdbf49b05b9a33b9bb848387b03592aa090c9cbab9f0d13194a0a9c69484c` |
| test.log | `e6898e07233ca1dda88b37d7be7ad0f5d350bff3b4ca9c27da7aea1a69414686` |
| typecheck.log | `ee18eb7c72f9fd33f0ab0d1489d9662445932bb20ae39bdba2eef9faac35a019` |
| before-manifest.json / after-manifest.json | `006f19a5b5fdc334bf0cb5248f05b0b8caee2d3699d4774305ff98f2d75f182f` |
| cross-call-verification.json | `6a6b0f39225a2a2b653ea81304487573f400f2020ba3dad0bb69c714204d638e` |

Root直接读作者summary/日志尾、独立summary/日志尾与跨调用回执。各轮测试数量不相加；作者关联不当whole，静态审查不当执行，CI不当生产接受。旧IF6热路径逻辑新增字节下降47.40%/49.08%/49.64%只保留为历史成本证据，本片没有新性能测量，也不称物理磁盘写放大已实测解决。

### 失败与资源拒绝的闭环

1. `aemc-if7-red-20261027T121533107`：缺失API实际TypeError；初始六条TS narrowing错误修正后，`aemc-if7-first-green-20261027T121814959` 首片1/1及TS0。
2. `aemc-if7-expanded-20261027T122200726`：fresh RAM1.022GiB，低于作者本轮保守1.5GiB，测试与TS未启动；不是测试失败或永久项目门。随后低内存期间只做静态审查，用户释放内存后另开新验证目录。
3. 草稿冻结132文件，已含本片新增的2个源码/测试文件；最终补齐此前漏列的 `.node-version`、两个TJ1 Python文件和 `test/fixtures/hosts-v1.json` 后为136范围（即原IF6的134项加新增2项），不把旧132称作完整136。
4. 两项P2：keys先枚举索引再检查长度可能无界分配；失败事务stage basename不符合协议，尚未到预期SQL故障。修补为先intrinsic32字节/非SAB检查，再ownKeys；stage改为 `stage-synthetic.json`。新增33字节/SAB提前拒绝与合法offset view原件保持回归；失败capability和回滚断言保留。
5. `aemc-if7-reviewed-focused-20261027T123640689` 为18/19及TS0。唯一失败是compaction夹具在正常close前取文件基线，close移除writer journal。仅把基线移至close后，保留精确全文件保持断言；最终19/19与161/161后冻结并独立验证。旧18/19日志保留。

## 接续范围

下一步是保持幂等/已消费额度/UNKNOWN的容量运维与authority rollover协议、生产custody/共同回滚与恢复准入、AR1冻结质量和总成本实验。当前compaction不清Store ingress或authority receipts，IF7不赋予GC或自动维护能力。

原Core/WF2、storage lab、旧infra树和原数据均保留。新IF7未commit/push/merge；本轮未部署、迁移真实私有库、调用真实provider或启动训练。长期研究授权与此前PR合并授权不替代新切片合并或生产/训练准入。

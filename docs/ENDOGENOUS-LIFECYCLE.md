# E1：零外部输入的有界生命周期

`src/endogenous-lifecycle.ts` 提供独立的 `EndogenousOwner`。受信宿主创建一个 owner、绑定端口、显式 `start()` 后，第一次决策不需要人类输入、presence 或通信窗口。它不修改 `CoupledSession`、背景状态或原窗口／pause 语义，也不产生人类回合、Evidence、记忆 Proposal、奖励或表达投递。

这一切片是 **RAM 内有界调度机制**。端口可以返回 `REST` 或 `NOOP`，无需给理由；合成端口的固定返回值不能称为模型已经自主选择。内部运行许可、通信许可和用户在场仍是三件事。

## 宿主接口

```ts
const owner = new EndogenousOwner(); // 同一受控 lane 的整个宿主生命周期只创建一次
const session = owner.bind(async request => {
  // 示例固定合成返回值；不是模型、训练或人格实现。
  return '{"version":1,"choice":"REST","nextWakeInMs":1000}';
});
session.start(); // created -> 立即一次 boot 决策
// session.pause();  // 清除定时器、fence 当前结果并发出 AbortSignal
// session.resume(); // 仅 paused 可显式再次进入一次决策；旧 raw 未 settle 时拒绝
// session.close();  // 关闭该绑定；owner.bind(...) 可新建绑定但不重置资源
// owner.close();    // 永久关闭 owner
```

宿主必须持有 owner，保证同一受控 lane 的所有会话、close/rebind 都复用它；另建 owner 是新宿主权威，不是恢复同一会话的办法。本片没有进程级全局注册表或跨进程锁。绑定最多 1024 次；当前绑定未关闭时不能另绑，旧 handle 在重绑后失效。owner epoch 随 owner 创建生成，decision ID 由该 epoch 和单调 sequence 组成；同 owner 的已消费 ID 和条目永不删除／退款。

端口仅接受冻结的技术请求：owner epoch、decision ID、sequence、session 序号、`boot/resume/wake` 和 AbortSignal。结果必须是 **稳定普通原生 `Promise<string>`**；字符串为最多 256 UTF-8 bytes 的闭合 JSON，且只允许：

```json
{"version":1,"choice":"REST","nextWakeInMs":1000}
```

`choice` 只允许 `REST/NOOP`；`nextWakeInMs` 可省略，若提供必须是 10–300000 的安全整数。`reason`、正文、记忆或其他字段均不接受。端口须及时返回 Promise、不能同步阻塞事件循环，且其 abort handler 不得抛出未捕获异常。同步生命周期重入被拒绝；读快照可以观察已预留的调用与条目。

不接受 thenable、Promise 子类、自有 `then/constructor` 或跨 realm Promise；不调用对象的 `then` 来“尝试兼容”。不支持修改原生 Promise/timer/AbortController 内建对象。遇到不支持的返回对象，owner fault 并永久保留无法确认 settle 的 raw 槽；**不承诺可安全捕获恶意 constructor/species Promise 的晚拒绝**，这些不属于端口支持范围。普通原生 Promise 的晚成功／晚拒绝均有观察者，取消后仅丢弃，不产生新结果或新调用。

## 状态和资源边界

- `start` 仅接受 `created`，`resume` 仅接受 `paused`，重复或错误状态的调用拒绝。`pause` 清除全部调度、将当前 PENDING 变为 UNKNOWN 并 abort；暂停永不自动恢复。已经 closed/faulted/exhausted 的绑定不能被 pause 复活。
- `REST/NOOP` 结束当前决策。有下一次机会时进入 waiting，否则 resting；两者都不强制发送，也不隐含永久暂停。省略 nextWake 时没有新决策，保留 owner 到期 timer；宿主可以显式 pause 后 resume。
- 同时最多一个实际调用、一个 referenced timer。timer 在调用 deadline、下次机会、owner 到期之间切换。没有轮询、catch-up、忙循环、队列或自动重试。宿主的 pause/close 或固定预算停止会清理 timer；没有 `unref` 或 `process.exit()` 掩盖存活。
- 每次调用前不可退款地预留一个条目和完整 256-byte 响应额度。默认最多16次、4096 bytes；硬上限64次、16384 bytes。该字节预算限制本模块接受／保留的响应，不限制受信端口自己在进程中分配的内存。超大字符串在解析前拒绝，模块不保留任何响应正文。
- 默认 owner 总时长60000ms、单调用5000ms；硬上限分别300000ms、30000ms。总时长从第一次获准 start/resume 起算，包括暂停时间，close/rebind 不重置。预算耗尽结束运行；不能通过无理由 REST、异常、重绑或 UNKNOWN 退款。
- 默认使用 `performance.now()`。测试可注入受信单调时钟；观测到倒退、非有限或越界时钟会永久 fault，跳过到期时间直接停止，不补跑错过的机会。早于预约时刻的 timer 回调直接 fault，不重排轮询。同步阻塞的端口和任意篡改的时钟不属于实时保证范围。
- pause/timeout/close 只停止本地许可与结果接受；无法物理终止忽略 AbortSignal 的外部操作。其 raw 槽直到**实际**原生 Promise settle 才释放；UNKNOWN 不改回成功，settle 也不自动 resume。宿主仍须管理端口自身 I/O 及进程退出。

`read()` 只返回分离的固定技术 metadata 副本，不推进时钟、不调度、不输出私密思考。结果类别不是现实事件或行为完成证明。

## 验证入口与剩余范围

```powershell
node --max-old-space-size=256 --test --test-concurrency=1 --test-timeout=10000 test/endogenous-lifecycle.test.ts
node --max-old-space-size=512 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=128 scripts/endogenous-smoke.ts
```

smoke 是独立真实 Node 进程、真实 referenced timer 和固定合成端口：无外部输入 boot → REST → 自行 wake → NOOP → 预算停止 → `beforeExit` 校验 → 正常退出。只打印最小技术 metadata；不运行 Harness、真实模型、工具、声音、数据库、用户数据或训练。它证明调度与退出，不证明模型行为质量或表达送达。

E1b 的持久控制入口见下节；外部端口的 exactly-once、跨进程未决调用消解和真实宿主生命周期接线仍未提供。E2：真实模型决策、驱动／目标／反思、表达／工具执行、选择质量和隐私披露尚未提供；B Hybrid 的 memory-proposal、C 语音通道均没有在此接通。没有训练或意识／主观体验证明。作者专项、独立审查、whole 和提交 CI 分别验收；本文件不预报后续层通过。

E1a 历史本机验证（2026-10-28）：作者最终专项64/64、strict TypeScript exit0、独立实际 Astra max 审查无剩余可复现 P1/P2；上述零输入真实 Node/timer 合成 smoke 正常退出。冻结执行源码的最终完整测试1216/1216通过，失败／取消／跳过／todo均0，155064.4691ms；四文件绑定在 whole 前后未变。该历史本机回执记录时提交自然 CI 尚待结果。这些证据只覆盖有界进程内合成调度与退出，不代表真实模型自主选择、跨重启连续性或 Host 集成；不替代下方 E1b 候选的独立验收。

## E1b：AnchoredVault 内的持久生命周期控制

`src/endogenous-durable.ts` 复用上述 RAM owner，经 `AnchoredVault` 的显式管理入口创建和绑定：

```ts
// 受信管理代码，必须已经持有当前 AnchoredVault 和当前 scope。
vault.createEndogenousControl(scope, { maxCalls: 4, maxResultBytes: 1024 });
// create 仅执行一次；已有记录永远拒绝重建、重置或追加额度。
const session = vault.openEndogenousControl(async request => {
  return '{"version":1,"choice":"REST"}'; // 固定合成端口
});
session.resume(); // 新创建和恢复绑定都从 paused 开始；不使用 start()
session.pause();
// 原实际 Promise settle 后才能再次显式 resume；UNKNOWN 仍保留。
session.close();
vault.close();
// 后续进程：AnchoredVault.open(...) → openEndogenousControl(...) → 显式 resume()
```

这是一条 vault 内的受控 lane，不新增数据表、外锚数据库、调度框架或存储 profile。固定 `meta` 键 `endogenous_control_v1` 保存闭合版本1记录，总 UTF-8 大小最多16KiB、最多64消费条目；包括原 authority/vault/scope 身份、代际、consent revision、runtime epoch、controlId、固定 `rest-noop-v1` 决策 profile、不可增补 limits、固定 wall 到期、revision/run fence、停止状态、消费终态及独立 permitHeld。没有 goal、日记正文或私密思考。决策 ID 永远是 `controlId:sequence`，恢复、重新绑定和新 session 不重新编号或清账；每条仍预留完整256 bytes。

只有 `AnchoredVault` 装配受信持久 hooks。普通打开缺少记录时拒绝，不自动创建；原 `EndogenousOwner()` 默认 RAM 行为保持。每个 live vault 最多绑定一个 durable owner，关闭 session 后也不创建第二个 owner。整个 vault 持有原 `writer.sqlite` 排他锁；每次 dispatch、terminal、stop 和实际 settlement 同时检查原外锚 current head、控制记录 CAS/run fence 和 wall 时钟。scope 失效后不再接受结果。

预留在同步 authority guard 内完成：Store RAM COMMIT → 序列化 → 加密检查点 → authority finalize 实际提交。之后仍在 guard 中复核 head、时钟与所有权，再同步调用受信端口；端口返回普通 native Promise 后释放 guard，绝不持锁 await。终态持久提交返回之前，RAM owner 不接受 REST/NOOP，也不安排下一次机会。暂停／关闭先清 timer、fence、abort，再写停止状态；持久化不确定时 owner 停止、vault poison，不重新调用或退款。

控制许可从显式创建时固定 wall 到期，包含暂停和离线时间。恢复只用剩余 wall 时长建立新的进程内 monotonic 限制；旧 monotonic deadline、旧通信许可和错过的 tick 都不恢复。新绑定与正常 close/reopen 均默认暂停；只有未到期、未耗尽、未 fault、原绑定仍有效且没有 held permit 时，才可显式 resume。boot 和绑定都会推进有界 run fence，最多1024。

遗留 PENDING 在 boot 中变为 UNKNOWN，`permitHeld=true`，状态为 `RECONCILE_REQUIRED`。即使退出发生在预留已提交、端口尚未调用的窗口，也保守占用；新 owner 无权清除它。该切片没有跨进程清 held、退款或人工“已结束”声明入口。进程死亡不能证明外部操作终止。同进程只有原实际 Promise settle 的观察者可以清 held；UNKNOWN 不改回成功，也不自动恢复。同步 throw 没有 native settlement 证据，所以 durable 模式同样保留 held。若在 raw 未 settle 时关闭 vault，即使后来本进程观察到结果，也不能越过已关闭的权威去清记录。

purge、consent 改变、来源 revoke/revise 或其他 runtime 变化会在同一 Store 事务中保留消费、标为 FENCED，并立即取消本地 owner。原观察者仍可在同一 live vault 内清 held，但旧 scope 不重新绑定。boot 先核对控制记录与**递增前**的 scope：合法匹配记录随正常 boot 推进 epoch；失配、未知版本、错误身份或其他控制记录验证失败则保留原字节，固定本次 boot 的 E1 拒绝状态。普通 Store 仍按原规则递增 runtime，并可用新 scope 读写、备份及恢复；E1 create/open 不获得权限，不能靠旧 runtime 往返静默续权。本片不提供撤销后的控制重授权／重建。

正常运行时发现 E1 已到期，或预留提交已经耗尽本次调用期限，会在新的 exact-head guard 中持久化 EXHAUSTED 停止状态；本地 owner 停止，普通 Core 仍可读写和备份。预留前拒绝不会消费调用；已经提交的预留保留 UNKNOWN、完整额度和 held，不能换新 ID 重试。实际 Promise settlement 时才可由原观察者清 held，即使此时已到期也不能把 UNKNOWN 改成成功。若终态提交耗尽剩余时间，该结果在向 owner 返回接受之前改为 UNKNOWN 并持久化停止，不安排后续机会。

这种隔离只处理 E1 扩展记录的预期验证失败及上述正常期限拒绝，不吞掉 SQL、Store 完整性、AEAD、current authority、时钟回退或未决持久化错误；这些真实 Core 失败仍按原协议关闭整个能力。E1 预留／终态／停止写入的不确定失败仍 poison 整个 vault，因为无法证明这次持久提交状态；正常到期后的停止写入失败也遵守这一规则。

完整 meta 随现有 schema1/2 图像、备份／restore、rekey、迁移及 lossless repack 保留。旧 M2/raw Store 可以携带额外 meta，但携带本身不授予 E1 执行权；它们的独立 boot 会留下 runtime 不一致。来自另一 authority/vault 的记录拒绝 E1 执行，不能在导入时改写成新身份；合法准入的普通旧 M2 数据仍可读写和备份。原 authority/vault 的合法 generation cutover 可恢复当前控制；仍存活的旧 generation 在下次 guard 访问时被 exact-head fence。没有实现独立 authority 管理员回滚防护，也不承诺任意新 vault 之间的全局 backend 唯一 owner。

E1b 的作者验证入口是 `test/endogenous-durable.test.ts`，加原64项 RAM 回归和 strict TypeScript。新专项包括真实 Node 子进程的正常 close/reopen、预留后／dispatch 后／终态落定前退出，以及跨进程 writer 拒绝；还覆盖 live generation cutover、暂停／撤销后的晚 settle、固定到期、提交失败、旧 runtime、schema迁移、rekey、repack 与 legacy 携带。全是新临时目录和合成端口；日志保留实际退出码和 RSS。完整测试、独立审查和提交 CI 由冻结候选另行验收，未连接模型、通信、工具、声音、训练或生产宿主。

## E1b 本机工程验收（2026-10-28）

实际 Astra max 独立复核关闭正常期限拒绝误 poison 普通 Core 的唯一 P2，无剩余可复现 P1/P2。最终 strict TypeScript exit0，E1b26加原RAM64合计90/90专项通过；既有139项持久化闭包结果复用，未重复运行。冻结五个执行文件及本文件的最终完整测试1242/1242通过，失败／取消／跳过／todo均0，169826.5383ms，执行和文档绑定前后不变。提交自然 CI 尚待结果。

本验收仅是合成数据下的有界持久控制、停机恢复和普通 Core 隔离证据。已消费额度与 UNKNOWN/held 不退款、不因重开或新ID恢复许可；正常期限拒绝仅停止E1，真实或不确定的持久化失败仍使 vault fail closed。真实模型自主选择、Host接线、外部 exactly-once、训练及主观体验均不在本验收范围内。
E1b CI历史分层补充：上述完整1242/1242属于候选 `89ad9b7`。其首次自然CI在浮动Node24.21.0上因新测试无条件调用物理repack而触发既有 `REPACK_RUNTIME` 拒绝，暴露的是测试对实际能力的假定。随后仅测试增加实际runtime能力分支：supported保留原metadata检查，unsupported要求精确拒绝、零VACUUM且源字节不变，后半migration/rekey仍无条件执行；生产门和所有产品src字节均保持不变。独立原max仅审该test delta后无P1/P2；strictTS exit0和原生26/26专项通过，unsupported分支仍待新head自然CI。没有为test-only适配重复whole。首个sandbox TEMP路径失败仅保留TOOL_OUTPUT_ONLY事实，原沙箱日志不可恢复，不冒称已有原生日志；原CI失败及旧完整测试证据保留。
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

E1b 的持久控制入口见下节；外部端口的 exactly-once、跨进程未决调用消解仍未提供。下方 E2 文本切片增加显式文本 profile 与受信 Anchored Host 装配；真实模型选择质量、驱动／目标／反思、工具执行和生产部署仍未验收。B Hybrid 的 memory-proposal、C 语音通道没有混入决策端口。没有训练或意识／主观体验证明。作者专项、独立审查、whole 和提交 CI 分别验收；本文件不预报后续层通过。

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

后续浮动Node24.22.1自然CI已以实际 `UNSUPPORTED_REAL_REFUSAL` 分支通过原combined及后半migration/rekey。其后macOS正向legacy fixture因 `/var` 别名祖先被原路径门拒绝；仅两行测试修订以 `realpathSync.native` 规范新建fixture根，原symlink/path/runtime拒绝门和所有产品src不变。原max两行差量审查关闭，当前strictTS0／原生26通过；macOS通过与否只由此新head自然CI验收，旧失败保留，未重跑whole。

## E2：显式短文本选择与受信 Anchored Host

`createEndogenousTextControl(scope, limits)` 显式创建 `text-choice-v1`；`openEndogenousTextControl(port, acceptText, settled?)` 绑定同一 Vault 的单 owner。旧创建／打开方法仍只接受 `rest-noop-v1`，不会转换旧记录、换 ID 或清额度。新 profile 复用原控制键、版本、256-byte 每调用预扣、16KiB 总记录上界和最多64条消费；仅新增不含正文的 `TEXT` 终态。

新 profile 同时接受原 REST/NOOP，另允许唯一闭合文本形式：

```json
{"version":1,"choice":"TEXT","text":"一条短文本。"}
```

正文最多160 UTF-8 bytes，整个 JSON 仍最多256 bytes；TEXT 不接受 `nextWakeInMs`、Proposal、Evidence 或其他字段。正文仅保留在有界 RAM delivery 中。端口收到只读 `deadlineMonotonicMs` 和同步 `validateCurrent()`；期限在最初 dispatch 时算定，后续微任务与慢持久化均不能延长它。只有原 raw 实际 settle、严格解析、同步持久 terminal 成功并复核 wall／原 monotonic deadline 后，才调用一次受信同步 acceptance hook。仅 literal `true` 表示 hook 接受；普通 Promise 拒绝被消费，不等待、不把异步值视为许可。拒绝／异常不退款、不重试、不污染正常 Core。

`src/endogenous-text.ts` 构造独立 `endogenous-text-choice` 任务，通过共享 `RawTextPort.generate()` 获得覆盖 fetch、body 读取及 cancel cleanup 的 native Promise。它先退出 Vault 同步 guard，再检查当前权限并调用端口；发包前再次检查原期限。不能用 Hybrid `propose()`、HTTP interaction 或 DSH command 的提前超时 Promise 代替 raw settlement。普通 native Promise 无法证明远端已停止；违反 raw 合同的同步 throw／不可观察返回值保守保持 held。HybridProfile/digest 只是声明身份，`DECLARATION_ONLY / NOT_AUTHENTICATED`，不证明实际加载资产；文本不使用 memory-proposal wire，也不创建第二个 Hybrid 调度或账本。

`src/anchored-text-host.ts` 提供真实可调用的进程内装配：

```ts
vault.createEndogenousTextControl(scope, limits); // 单独的显式管理授权，仅首次
const host = new AnchoredTextHost({ vault, scope, raw, profile, resources, clock });
// clock 必须与这个 Vault 的 monotonic clock 相同；resources/raw 由宿主长期持有。
host.grantCommunicationWindow('fresh-permission-id', 10_000, 'trusted-stdio');
host.resume(); // 内部运行许可；不伪造人在场或人类输入
// onReady/read().lastReady 仅返回 delivery metadata。
const delivery = host.takeDelivery(deliveryId);
// 受信原生消费者实际完成后才调用：
host.acknowledgeNativeCompletion(deliveryId);
```

Host 在离开 dispatch guard 后用原 `decisionId` 调用既有 Safety `claim/reserve`，每次慢写后复核原期限。准备、take 和 ACK 继续写既有 `ready/taken/acknowledged`，并在写后重新核 scope/runtime、窗口和期限。REST/NOOP 或未投递 TEXT 的 Safety `failed` 在已预扣时保守归 `unknown`；这表示未完成投递，和 E1 已知 REST/NOOP/TEXT 选择是不同事实。已真实完成的 native ACK 若提交后才越期，持久 acknowledged 事实不可逆，接口仍拒绝、不续期、不重放。没有为清账制造 ready 或 ACK。

TEXT 通信窗口使用独立 RAM `CompanionWindowPolicy`，不修改旧 human-ACK grant 门、不修改 observed presence、不唤醒旧主动交流 scheduler。dispatch 捕获原 window id/generation、权限 epoch（或无窗口）及原到期；新 grant 不复活旧文本。没有窗口仍可决策，结果不投递。`clearCommunicationWindow()` 表示 off/quiet；pause/reset/close 撤销窗口与待投递文本，close 是明确断连。共享 CoupledSession 收到显式 `quiet:true` 时也总撤销 TEXT 窗口，包括旧 quiet 已为 true 的情况；仅 availability 变化会使旧请求／delivery 失效，但保留尚有效的独立窗口供未来请求使用。available=false 本身不是断连。

模型输出不经过 `submit()`，不创建人类 Event/Evidence、memory Proposal、appraisal、反馈或奖励。Coupled 新 prepare 入口只接收受信的已接受文本，take/ACK 使用独立的 durable TEXT 证明和原期限，不误用只适用于 deciding 的 dispatch validator。最后一次配额的成功 TEXT 可以在原许可内完成一次投递；显式 pause/close 仍撤销它。崩溃／重开不恢复正文、通信窗口或原 monotonic deadline，普通重开默认 paused；未决 UNKNOWN/held 不退款、不通过新 owner/ID 清除。仅原同进程实际 settle 观察者可清 held。

交付证明还必须通过本次接受的 RAM seal：同步 hook 活动期间可用于 prepare，只有 hook 返回 literal `true` 后才继续有效；false、throw、Promise/thenable 返回立即撤销。显式 pause/close、fault 和重绑定也撤销已保存证明，不能只凭历史 TEXT 条目恢复许可。自动 CAPACITY 停止保留已接受末次文本的原到期许可；之后显式 close 会关闭 RAM owner、停止 timer 并撤销证明，持久控制若已 EXHAUSTED 则保留该不可逆停止态，重开仍拒绝，不改变消费或 held。`onReady` 元数据通知在 E1 settlement 临界区退出后的微任务中发出，先复核同一 ready、原窗口／期限与交付证明；已撤销的排队通知直接丢弃。通知可以同步调用 Host pause/close，普通异步回调拒绝被消费，不等待、不续期，也不改变 raw settlement。

作者入口 `test/endogenous-text.test.ts` 使用 P4/schema2 的真实新建文件 Vault、固定合成时钟、受控故障和真实 localhost HTTP：无输入/无窗口、明确窗口、慢 claim/reserve/terminal/ready/taken/ACK、取消后 cleanup 挂起、purge/consent/runtime fencing、晚 settle、正常及未决重开、旧 profile 拒绝 TEXT。合成 native consumer 完成后 ACK 只验证接口组合，不是 DSH 部署或真实模型选择质量。当前 DSH stdio 仍使用旧 M2，本切片没有迁移该生产入口，也没有运行真实模型、音频、训练或正式质量实验。独立审查、whole 与跨平台 CI 仍需按新候选验收。

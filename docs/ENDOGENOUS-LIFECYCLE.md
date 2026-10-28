# E1a：零外部输入的进程内生命周期

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

E1b：跨重启连续性、持久消费／exactly-once、恢复权限和真实宿主生命周期接线尚未提供。E2：真实模型决策、驱动／目标／反思、表达／工具执行、选择质量和隐私披露尚未提供；B Hybrid 的 memory-proposal、C 语音通道均没有在此接通。没有训练或意识／主观体验证明。作者专项、独立审查、whole 和提交 CI 分别验收；本文件不预报后续层通过。

本机验证（2026-10-28）：作者最终专项64/64、strict TypeScript exit0、独立实际 Astra max 审查无剩余可复现 P1/P2；上述零输入真实 Node/timer 合成 smoke 正常退出。冻结执行源码的最终完整测试1216/1216通过，失败／取消／跳过／todo均0，155064.4691ms；四文件绑定在 whole 前后未变。提交自然 CI 尚待结果。这些证据只覆盖有界进程内合成调度与退出，不代表真实模型自主选择、跨重启连续性或 Host 集成；E1b/E2 缺口保持。
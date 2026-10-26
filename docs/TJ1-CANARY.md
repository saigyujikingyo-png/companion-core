# TJ1：本地真实训练 canary 与受控观察履历

当前状态，2026-10-26：作者离线17项/strict TypeScript/两文件 Python AST、独立6组与冻结源码审查均通过；其后 Windows 上一次 Node-only prepare 与一次真实 CPU 训练/独立新进程 eval 完成。各层证据分别保留，最终 whole/CI 以本批回执为准，本文不预报通过。TJ0 synthetic v1、黄金字节、J0/Store/M2/Q0 均保持不变。

## 单次实际运行与边界

- 原创新合成数据、从头初始化 `Linear6x2`，观察到64个 optimizer steps；训练终态 COMPLETED。首步解析、14参数 delta、导出、新进程 reload 与独立 eval 分别 PASS，不合并冒称通用训练质量。
- 固定128条 eval 的 MSE 为 `1.4615502344136207e-21`，全零 baseline `0.37451171875`，参数 delta L2 `1.5662455108655526`；这些只说明冻结数值任务，不是陪伴质量或持续学习收益。
- trainer/evaluator 均 exit0 且观察到 close，peak reported RSS 分别597045248/579739648 bytes；post-import 可用 RAM 分别4075708416/4088471552 bytes，均满足原门槛，未放宽 watchdog 或资源门。RSS 是受信 worker 报告的 OS peak，不是父进程独立测得的进程树 hard cap；进程耗时包含 startup。
- 另一个新 Node 进程冷读为 `RECORDED_CLAIMS_ONLY / RECONCILE_REQUIRED`，76记录、64步及 consumed/ended；重复 CLI 返回 `TJ1_CONSUMED`，在 Python 启动前拒绝，目录全字节未变，没有第二次训练。
- 只资格化该 Windows 解释器/冻结任务；不证明 Linux/macOS 真实训练、十年规模、加密、有效前缀回滚保护、外部执行认证、激活或 Nemotron/LLM 微调。原始运行数据、checkpoint、stderr 与权限文件保留在源码/OneDrive 外；公开文档只给允许公开的合成任务摘要。

本切片从一个自有、保存过的全零初始化训练 `nn.Linear(6,2)`，14 个 float64 参数。它是从头训练的数值 readout canary，不是预训练模型微调、LLM 训练、情感质量或持续学习收益证明。参见 [TrainingRun 目标](TRAINING-RUN-JOURNAL.md)及 [TJ0 磁盘格式](TJ0-DISK-FORMAT.md)。不接 provider、凭据、真实个人数据、GPU/NPU、模型下载、部署或激活；默认 `npm check` 不启动真实 runner。

## 固定实验与精确数据

全部配置是 `src/tj1-spec.ts` 的冻结常量，不接受调参或模型选择。实际本轮仅资格化 Windows + 操作者指定且冻结的已有 Python/PyTorch；离线 Node fixture 的跨平台 PASS 不表示跨平台训练。

| 项目 | 固定值 |
|---|---|
| 模型 | `torch.nn.Linear(6,2,bias=True)`；CPU float64，12 weights + 2 biases |
| 初始化 | `tj1-zero-state-v1` 自有 JSON checkpoint：固定 tensor names/shapes/f64 原始位、空 momentum、step 0、seed 103、完整批位置 0、config digest；不是 native `.pt` 或 pretrained checkpoint |
| 优化器 | SGD lr 0.1、momentum 0.5、dampening/weight_decay 0、nesterov/foreach/fused false |
| 训练 | 固定完整 64 条 batch，64 次 `optimizer.step()`；无 shuffle、accumulation、早停、调参或重跑 |
| 线程与 runtime | intra-op/inter-op 各 1、DataLoader workers 0；torch `2.11.0+cu128`，所有参数/梯度/输入为 CPU float64，不调用 CUDA 探测/初始化 |
| 标签 | W=`[[.75,-.5,.25,0,.5,-.25],[-.25,.5,0,.75,-.5,.25]]`，b=`[.125,-.25]`，y=Wx+b |
| Loss | 全 batch 的 64×2 标量平方误差均值；每 STEP 的 lossBits 是该次更新**之前**的 loss |

train-corners 为按 i=0..63 排列的六维 `{-1,+1}` 全超立方顶点，维 k 取 i 的第 k 位。eval-interior 按 n=0..4095、k=0..5 对 ASCII `TJ1_MINI_READOUT_V1|eval-interior|103|n|k` 做 SHA256，以首 byte `%8` 选 `[-7,-5,-3,-1,1,3,5,7]/8`，取前 128 个互异六元组。训练器只读取 train 文件；eval 数据留给新进程 evaluator。整 family 不跨 split，但这是已知线性函数的插值 canary，不是语义盲测或广义泛化证明。

数据行固定紧凑 JSON key 次序 `id,family,x,y`；每个元素是 16 位小写 big-endian IEEE-754 float64 hex，ASCII、无 BOM、每行及末行均 LF。Root 独立纯算术生成的冻结值：train 13,238 bytes，SHA256 `d24ee7488dd5204faabdd9e74ccbca09a67993e6071426df4e817eab5caaa73e`；eval 26,386 bytes，SHA256 `99853e550fa4b95346fd66f58183a409d0e15ff61c991582dcd526469c0f882e`；全零 baseline MSE `0.37451171875`。这些是数据/解析基准，**不是训练执行证据**。

首步独立解析梯度为 `-W/-b`，更新结果为 `0.1*W/0.1*b`；atol=rtol=1e-12。父观察者要求真实回执的梯度/参数有限并通过首步检查，最终 changed scalar count >0、delta L2 >1e-6。独立 eval 要求 MSE <=1e-6 **且** <=0.01×baseline；baseline 须正且有限。float64 原始 tensor 位与产物 identity 必须精确匹配，数值容差只用于独立算术/forward/metric，不代替无损身份。

## 观察来源与记录面

TJ1 是独立 `logical=tj1-local-canary-v1`、`container=sqlite-event-ledger-v1`、`codec=identity-json-v1`。它没有把 TJ0 SYNTHETIC_FIXTURE 升级为 real，也不声称统一训练 archive/codec 迁移已完成。输入数据为 ORIGINAL_SYNTHETIC；真实入口的执行方式为 ACTUAL_LOCAL；离线测试永久使用 OFFLINE_FIXTURE。

固定本地 trainer 是明确的受信代码边界。父进程先核 externally approved manifest digest、六个新源文件和两份现有解析依赖的 build hash、解释器 path/hash、数据/初始 checkpoint 实际字节，再通过固定脚本和固定参数创建独占子进程；没有 shell、任意命令、可注入 process factory、线上数据或模型选择。每次启动的父生成 launchId、manifestDigest、严格连续消息 sequence 与私有 stdin/stdout 管道关联回执。PID、nonce、hash、JSON 标签或 exit 0 单独都不证明训练。

| 事实 | 本切片证据来源 |
|---|---|
| Optimizer steps / 每步梯度、更新后 tensor、更新前 loss | PINNED_TRAINER_OBSERVED：固定受信 trainer 在真实 `backward()` / `optimizer.step()` 后发出的有序回执；不声称父进程独立重做全部 optimizer |
| 首步解析、参数 delta、产物 bytes/hash | PARENT_VERIFIED：Node 独立算术、位模式与文件读回；实际 STEP 先留存，首步核对失败也不抹掉已观察效果 |
| 新进程 reload | PINNED_EVALUATOR_OBSERVED：另一个固定 Python 进程用 `weights_only=True`/CPU 读取自生产的 native full checkpoint，并与独立 raw-bit 权重 export 逐位核对、加载模型 |
| Eval | evaluator 的 torch forward + 独立 Python 手算，再由 Node 独立前向/metric 复核；按冻结阈值分别 PASS/FAIL |
| 进程与清理 | 父进程持有的 ChildProcess、PID/创建观察时间/退出码/signal/closeObserved/elapsed、受信 worker 报告的实际 peak RSS、固定失败码 |

训练 terminal 在 trainer 退出后、eval 前独立落定。eval FAIL/UNKNOWN 不改训练 terminal；成功训练也不推出质量或激活 PASS。最终状态 `OBSERVATION_COMPLETED` 仅表示本次观察流程结束，stagebook 的训练、delta、export、reload、evaluation 分别解释。真实本地模型计算不写成笼统“模型调用 0”；只声明本实现 externalProviderCalls/paidApiCalls/networkCalls 为 0，这不是系统全局网络监控证明。

本次 live observer 可返回 `CURRENT_LOCAL_OBSERVER`。**所有**普通 ledger 读取/导出和跨重开均为 `RECORDED_CLAIMS_ONLY / RECONCILE_REQUIRED`；本切片没有外部 provenance anchor 服务，不把重新 hash 自己的记录当认证，也不恢复旧执行能力。`ledgerHead` 只是链末摘要，不叫最终观察回执签名。导入文件、合法 checksum 或 fixture label 不能构造 live observer 结果。

## 准备、一次性启动与权限

`prepareCanary` 是显式运行时入口，Node-only、0 torch import/0 optimizer step；真实准备也由执行者在 source freeze 后操作。它要求新建空的、realpath 规范化的 OS TEMP 私有目录，先保存 preparation intent，写并 flush 训练/eval/zero checkpoint，再冻结包含 run/attempt、scope/consent、config、来源/build、解释器与全部输入字节的 manifest，提交 PREPARED。原件不覆盖。

`runCanary` 必须得到**来自操作者/Root 的外部冻结 manifestDigest**和新的当前 authority。未 consumed 的 Node 准备记录可在新进程全字节核验后接收一次新的运行授权，这不是恢复旧能力。`LAUNCH_CONSUMED` 必须持久提交后才能 spawn；重复请求、丢 ACK、spawn/import/运行失败、权限失效、父进程崩溃均不自动重试或退款。运行后重新打开只能读/核对，不能自动执行记录中的命令。需要重试时另由 Root 审核新 attempt/新目录，不能删除 consumed 记录。

authority 是受信宿主提供的同步回调，包含 scopeId、十进制 generation/consentRevision、runtimeId、now/expiresAt 与 read/write/train/export。每次读取、写入、重复返回、spawn、STEP 交付、下一步许可与最终结果都复核；运行期间每 250ms 有界检查权限与可用 RAM。撤销/off→on 须由宿主持久推进代际；Promise/getter/Proxy、身份变化、倒退、过期或重入使旧 gate 永久失效。CLI 只读取操作者显式提供、位于 archive **之外**的 authority 文件，prepare 不创建 allow 文件，不从 ledger 自发现授权。

每 STEP 后 trainer 等待下一条父许可，64 后等待 EXPORT；权限失效停止后续交付并终止 owned child。在已经许可与实际更新之间不声称 OS 级原子撤销；已观察 lower bound 和原件保留，未观察效果 UNKNOWN。权限失效后无法继续写 observer 结尾时，保留不完整 consumed 历史，不绕过 gate 修补成完成。

## 持久性、工件与上限

`tj1-receipts.sqlite` 是本切片记录权威：固定 app/user/schema 版本、两张表、逐事件规范 JSON、连续 seq/previous/hash 及严格 reducer。每 append 是同步 FULL SQLite transaction；提交不确定即永久 fence。损坏、缺行、错链或内部矛盾拒绝，不跳行/repair。`tj1-owner.sqlite` 是独立 BEGIN IMMEDIATE 合作锁，扫描、准备提交与运行期间保持单 owner；进程退出释放，无 PID/超时破锁。索引/投影从事件重建，未改旧 Store/schema。

原 stdout 回执保存在 stage 私有 JSONL；stderr 保存至上限的原始私有 prefix，注明截断，不回显内容到公共错误。进程结果另保存为 `trainer-process.json` / `evaluator-process.json`，绑定 stage/launch/manifest/code/python、退出/清理/RSS/耗时及 stdout/stderr digest，并由 ledger 引用。在当前权限允许时失败也保存；若权限或写盘失效，则明确 evidence unavailable，不编造原件。

trainer 只用新路径 `xb` 写 `checkpoint.pt` 和 `weights.json`，flush/fsync 后报告 EXPORTED。**没有 temp→atomic rename 承诺**；父进程仅在 EXPORTED+clean exit 后读回/hash，部分或 orphan 文件不自动成为已核验工件。完整 native checkpoint 包含 model、SGD momentum、torch RNG、step 64、完整批位置、seed/config/data/code/runtime identity；另存 raw-bit 参数 export。保存和结构核验**不等于实际执行继续训练恢复**；本切片不尝试 resume。

| 限制 | 固定上限或门 |
|---|---|
| SQLite 文件 / events / 单事件 | 4 MiB / 256 / 8 KiB；开库前文件类型/大小，读 body 前计数/长度 |
| stdout / 单行 / stderr prefix | 512 KiB / 8 KiB / 32 KiB |
| 单模型工件 / 合计模型工件 | 1 MiB / 4 MiB；native writer 在写入前限制累计 bytes |
| startup / train / evaluator / cleanup | 各启动 30s / train 60s / eval 30s / cleanup 5s |
| host RAM | trainer/evaluator 启动前各 >=2 GiB；import 后与运行中 >=1 GiB |
| worker peak RSS | 从 OS 实测，受信 worker 报告；1.5 GiB 软件检查阈值。无有效采样为 null |

这些是小任务的超时、消息/文件边界和采样监测，**不是** Windows Job Object 内存硬 cap、完整进程树 RSS 监测或所有瞬时峰值的独立宿主证明。只关闭/终止自己创建的 child；cleanup 未观察 close 时为 UNKNOWN，禁止再启动其他 worker。实际资源数字必须等运行回执，不能从 14 参数估算。

目录须在源码/OneDrive 外的受信本机磁盘；数据文件/模型目录拒绝 symlink/junction 等不符合规范路径的对象，文件单 hard link，POSIX 0600 不等于 Windows ACL 验收。现阶段无加密、介质擦除、恶意同用户/管理员隔离、整个目录合法前缀回滚保护、网络盘或断电耐久证明。源文件和解释器 hash 是固定代码身份，不是完整 Python/native DLL supply-chain attestation。权威读取 metadata/派生 hash 仍是私有内容。

## 执行者入口与验收分层

以下是显式操作示意，不会由作者测试或 `npm check` 调用。所有路径由操作者给出；不要把真实机器部署路径放进公共仓库。

```powershell
node src/tj1-canary-cli.ts prepare --directory <fresh-private-run-dir> --authority-file <external-host-authority.json> --python-path <approved-existing-python.exe>
# Root 核对实际输入 bytes/build 和返回的 manifestDigest 后，恰一次：
node src/tj1-canary-cli.ts run --directory <same-run-dir> --authority-file <external-host-authority.json> --manifest-digest <externally-frozen-sha256>
node src/tj1-canary-cli.ts read --directory <same-run-dir> --authority-file <external-host-authority.json>
```

authority 文件仅保存 `scopeId,generation,consentRevision,runtimeId,expiresAt,read,write,train,export`；CLI 的 now 来自当前时钟。该文件属于受信宿主配置，不能由 archive 的声明替代；使用者负责维持当前权限和代际。

作者检查只运行 `node --test test/tj1-spec.test.ts test/tj1-ledger.test.ts test/tj1-restart.test.ts`、strict TS 和 `ast.parse` 两份 Python 源码。Node 子进程 fixture 明确 OFFLINE_FIXTURE，train=false，不启动 Python。作者、独立审查、一次真实 canary、whole 和对应提交 CI 分开验收；离线 PASS 不计入实际 optimizer 步数、reload 或 eval 结果。

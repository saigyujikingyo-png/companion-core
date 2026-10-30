# 代码评审：galatea main @ `7acba1d`（2026-10-29）

评审者：Claude（Anthropic）。方法：本地克隆；Node 24.16.0 下运行 `tsc --noEmit`（通过）和完整 `npm test`（1,897 项：1,892 通过、0 失败、5 跳过——跳过项需要官方 tokenizer 资产或固定 Python worker）；通读 README/AGENTS/MAINTENANCE/TARGET-DECISIONS/ROADMAP 等核心文档；三路独立只读扫描（④ 记忆层、⑥ 教学层、①②③⑤ 运行回路），所有关键结论在源码中二次核对。本文只记录已核实的事实和明确标注的判断，不复述文档自述。

2026-10-30 修订说明：事实对象仍是上述 main 快照，不覆盖 #33／#35 等未合并候选。主控采纳接线诊断；召回替换、教师／评审模型撤换和人格目标变更仍须各自证据或用户决定，不是本评审已经批准的动作。

## 0. 结论

1. 工程纪律是真的：零运行时依赖、`node:sqlite`、strict TS、三平台 CI、幂等／UNKNOWN／撤销／fencing 一律 fail-closed。
2. "跑着的系统"与"建出来的系统"是两套：在线路径 = DSH 会话一条文本 → 一次 DeepSeek 调用，持久化走 M2 `DurableMemory`；AnchoredVault、E1–E3、身体状态、语音、Hybrid 都没有 `src` 入口接线（见 [ACTUAL-WIRING.md](ACTUAL-WIRING.md)）。
3. ③ 认知核心几乎不存在：无共享工作状态、无选择节点、无 L/R、无对话历史；运行时系统提示是助手框架，人格合同不在其中。
4. ⑥ 没有 Student：无训练代码；语料由 DeepSeek 自产自评；dev 集未用；无人格／诚实／边界／谄媚回归集。
5. 一组终身上限与"长期运行"目标直接矛盾（§3）。
6. 过程重于产品：五天 103 次提交，19k 行源码、17.7k 行测试、约 9 万字文档；代码压成单行（264 行超过 400 字符，最长 2,161 字符）。

## 1. 规模与形态（事实）

| 项 | 值 |
| --- | --- |
| 提交 | 103（2026-10-25 ~ 10-29），单一作者，分支名 `codex/*` 共 40 条 |
| 源码 | `src/` 155 个文件，18,969 行；平均行宽 90.8，>200 字符 1,147 行，>400 字符 264 行，最长 2,161 字符 |
| 测试 | 116 个文件，17,711 行；全部合成数据，零真实模型调用 |
| 文档 | 110 个 Markdown，约 7,856 行／90,899 字；状态标记：`UNKNOWN` 178、`PASS` 162、`NOT_RUN` 58、`DESIGN_ONLY` 49 |
| 注释 | 约 653 行（3.4%） |
| 依赖 | 运行时 0；开发依赖 typescript 5.9.3、@types/node |
| 命名 | GitHub 仓库 `galatea`，package／README／SECURITY 仍写 `companion-core`，链接指向旧名 |

## 2. 逐子系统的核实结果

### ① 物理身体与外部世界
- 唯一输入是 DSH 会话里的纯文本：`dsh-coupled.ts:174-238` → `coupled-stdio.ts:222-236` → `coupled-runtime.ts:277-418`。
- 无任何硬件采集代码；`audio-input-contract.ts` 永远拒绝；无外部原件抓取。
- DSH = DeepSeek Harness SDK（`@deepseek-ai/dsh-llm` rc.3，`docs/THIRD-PARTY.md:15`），插件把自己注册为一个专用会话的 LLM provider（`dsh-coupled-host.ts:159-170`）。

### ② 身体与非语言状态
- 情感场 `background-state.ts`：6 个手调变量，指数松弛（快 20 s、慢 300 s、动机 60 s，`:47-49`）；目标值 `:235-243`；触发 0.60、回落 0.35、冷却 120 s、意图寿命 5 s（`:414-433`）。
- **在线回合给 `observe` 的输入全为 0**（`coupled-runtime.ts:309`：`novelty:0,socialRelevance:0,demand:0`），状态只随模型对用户消息的自评（`:399-401`）和 `/companion-feedback` 变化。
- `body-state.ts:139` 的 `BodyStateOwner` 只被自己的测试引用；`docs/BODY-STATE.md:63` 自述 B1／B2 未实现。无身体特征、无坐标场、无 GRU／SSM。
- 果蝇子图：`neural/connectome.py` 从 FlyWire v783 取 3,136 个蘑菇体神经元；`circuit.py` 是速率模型 + KC→MBON 门控弱化；离线结果 0.75 准确率输给线性基线 1.00（`docs/M4-NEURAL-LAB.md:64-71`）；在线 `prior_worker.py` 不学习，`jsonl-prior.ts` 只在显式 `switch flywire` 后以 0.25 权重调召回顺序（`coupled-runtime.ts:56`），不回灌情感场。

### ③ 互补认知
- 每回合一次模型调用；只有 DeepSeek 硬连（`coupled-stdio.ts:128,155-158`，`deepseek-flash`，thinking 关闭）。`raw-text-http.ts:110`／`http-interaction.ts:37` 接受 127.0.0.1 端点但无配置使用；无 Nemotron、vLLM、Spark、VLM 代码。
- 系统提示 `http-interaction.ts:52`："Return a brief helpful reply in the original language…"——助手框架；人格只在 `corpus-production-baseline.ts:4-7`，用于语料生成。
- 上下文 = 当前文本（取前 256 字符做查询，`dsh-coupled.ts:218`）+ ≤6 条记忆命中；无对话历史；消息在召回前先入库（`coupled-runtime.ts:307`），可能命中当前消息本身；模型的记忆建议在 `memoryCandidate` 中保留为未提交候选，不直接成为权威记忆（`:404-411`）。
- 唯一显式选择集 REST/NOOP/TEXT 在 `endogenous-lifecycle.ts:64-85`，只由 `anchored-*-host` 驱动，而这两个 host 没有 `src` 入口；其提示不含记忆、状态或人格（`endogenous-text.ts:7-23`）。

### ④ 记忆
- 数据模型 `schema.ts:4-54`：scopes（四元身份 + 代际 + 同意版本 + 运行 epoch）、nodes（event/memory，revision、status、validity）、dependencies（钉父 revision）、ingress（HMAC 幂等键）、jobs、artifacts、outbox、revocations、FTS5。"claim" 只是 `MemoryKind` 的一个枚举值（`contracts.ts:20-25`），没有独立实体。
- 强项：每次操作核代际与同意版本（`store.ts:195-201`）；每次读取用递归 CTE 走完整祖先（`:214-229`）；撤销／清空在单事务里级联并升 epoch（`:720-772`）；`reviseEvent` 先撤派生再升版本（`:755-765`）。
- 派生投影：FTS 与 schema-1 outbox 同事务更新；fanout 投影不打补丁，`read` 在消费者落后于日志头时拒绝（`durable-fanout.ts:256-260`），`apply` 整体重建（`:239-253`）；retrieval／scene 每次重取快照（`retrieval.ts:92-113`、`scene-authority.ts:107-118`）。已交出的副本无法召回。
- **运行时用的是 M2 `DurableMemory`，且构造时不带 `expectedHead`**（`coupled-stdio.ts:143-150`；`durable-memory.ts:19-23`），合法前缀回滚无法检测；M2 无压实。带外锚 fencing 的 `AnchoredVault` 只被 `anchored-text-host`、`anchored-message-host`、`endogenous-durable`、`safety-segment` 引用。
- **整库 RAM 镜像是字面的**：`:memory:` 库，每次有变更的提交 `serialize()` 整库（`store.ts:155`；`durable-memory.ts:98`；`anchored-vault.ts:339`）；一次交互约 10 次整库提交（`coupled-runtime.ts:148-149,292,305-308,412,433,441`）。
- 加密：AES-256-GCM，96 位随机 IV，AAD 绑定格式／用途／身份／epoch（`durable-codec.ts:61-77`；`anchored-codec.ts:66-81`）；密钥是 32 字节经 stdin base64 传入（`coupled-stdio.ts:143-148`）；DPAPI launcher 不在仓库（`dsh-coupled-backend.ts:32`），未核实。
- 召回：在线路径走 `store.search`——FTS 短语或子串匹配，`ORDER BY created_at` 升序取前 6 条，即**最旧优先**（`store.ts:668-681`），再按正则关键字重排（`coupled-runtime.ts:45-60`）。AR0（`retrieval.ts:22-24,148-168`）是字面匹配加一跳，无评分，未接在线路径；`src` 无 BM25／向量／PPR，BM25 只在 `research/retrieval-baseline/`。
- 持久消费者路径在一个 scope 超过 32 条可见记忆时直接失败（`store.ts:580`，`RETRIEVAL_LIMITS.selected`）。
- 撤销不擦除：旧 generation／检查点里的明文仍可用同一密钥解密，这些模块中没有 unlink；rekey 只重加密当前状态。目录从不 fsync；备份以 rename 发布（`durable-backup.ts:86-92`）。时钟倒退毒化句柄、持久的 last-seen 阻止时钟前跳后重开（`durable-memory.ts:131-135`；`anchored-vault.ts:387-391`）。外锚 `timeout: 0`，任何争用立即 `ANCHOR_BUSY`（`local-sqlite-authority.ts:105,229`）。

### ⑤ 统一执行
- 文本投递门很强：输入 ID + sha256 指纹幂等（`coupled-runtime.ts:282-290`）、HMAC 持久 ingress 键（`durable-memory.ts:171-176`）、预算先预留（`:202-208`）、失败即 UNKNOWN（`:181`）、重启后 pending 变 UNKNOWN（`:91`）、`writer.sqlite` 独占锁（`:49-57`）、暂停／撤销取消一切并强制重绑（`coupled-runtime.ts:116-123,169,188-190`）、ACK 等 DSH 原生提交 + 回合结束（`dsh-coupled.ts:145-165`）。
- 没有任何文本以外的动作：模型工具调用被拒绝（`http-interaction.ts:103-105`）；`ActionProvider`／`NeuralAdapter`／`HostAdapter` 仅接口（`contracts.ts:47-75`）。语音只有 PowerShell `SAPI.SpVoice` worker（`windows-sapi-speech.ts:47`），业务模式要求的权威"No such implementation ships here"（`speech-controller.ts:23,47`）。
- DSH 在场租约 30 s（`dsh-coupled.ts:209`），模型回复慢于此会错过 ACK 并暂停。

### ⑥ 慢循环
- 教师端点：DeepSeek `deepseek-flash` 与 Together `openai/gpt-oss-120b`（`wf1-types.ts:51-52`）。当前 CorpusProduction v1/v2 只接受 DeepSeek（`corpus-production-types.ts:37`），协调、生成、评审是同一模型的三次调用（`:74-75`）；QA 由 DeepSeek 写 rubric、gpt-oss 盲审（`corpus-qa-types.ts:39,64-65`）。
- 候选 = `{unitId, prompt≤2048B, response≤8192B}` 单轮文本对（`corpus-production-types.ts:28,78`）；通过评审即 `MODEL_REVIEWED, trainingReady:false`（`corpus-production-runner.ts:95`）。
- 去重：精确／NFKC／仅 prompt 指纹 + 64 位 SimHash（5-gram，Hamming≤8）+ Jaccard≥0.85（`corpus-production-quality.ts:4-15`）；跨 train/dev 的家族 HOLD（`runner.ts:74`）；"家族"是宿主登记的标签而非真实出处；跨批索引最多 8 个（`corpus-qa-index.ts:19-33`）；时间切分只在 L1.a 记忆 linter（`curation-rules.ts:78-83`）。
- 分词：Python `tokenizers` + 沙箱 Jinja 渲染 NVFP4 仓库的 tokenizer.json 与 chat template，均 SHA 钉住（`corpus-teacher-tokenizer.ts:13`）；`enable_thinking=False`，loss 只覆盖回复正文（`workers/corpus/tokenizer-batch.py:124-147`）。
- 存储：每个工件 AES-256-GCM，HKDF 按 job／bucket 派生密钥（`wf1-storage.ts:21-42`）；事件进入哈希链 SQLite 日志，头部以 CAS 锚在外部 authority JSON（`corpus-production-store.ts:87-93`）；训练根必须在批准根内、仓库外、非 OneDrive（`wf2-training-root.ts:6-14`）。
- README 数字含义：127 = 一次 128 条 DeepSeek 生产的合格行；116 PASS = 1 次 DeepSeek rubric + 32 次 gpt-oss 评审的判定；8,571／34,110／42,681 = 这 116 对在 Nemotron 模板下的 token 计数，约 294 个监督 token／行。
- **Student**：只有 `STUDENT_TARGET` 常量（`corpus-teacher-types.ts:6`：repo、revision、`trainingCapability:'NOT_VERIFIED'`、`trainingReady:false`）；`configDigest` 从未被核对；无权重加载、LoRA、NVFP4／QAD、dataloader 或 loss-mask 导出。TJ1（`scripts/tj1-trainer.py:97-142`）训练的是 float64 的 `nn.Linear(6,2)`，64 步 SGD，与语料无关。
- 评测与门控：只有 LLM 判 PASS/HOLD/REJECT/UNCERTAIN；`registerArtifact`/`activateArtifact` 只存 sha256 和计数器，无调用方（`store.ts:791-820`）；成长日记的"已评测／已激活／已回滚"是模拟回放（`growth-journal-synthetic.ts:11-40`）；WF0 的 `teaching-validation.ts` 没有其他源码模块引用；dev 集从未使用；无人格／诚实／谄媚回归集。
- 持久教学循环（`teaching-cycle-runner.ts`、`corpus-resource-scheduler.ts`）只跑过合成数据，计划类型硬编码 `'SYNTHETIC_PLAN'`（`teaching-cycle-types.ts:24`）。

## 3. 终身上限（与"长期运行"冲突）

| 上限 | 值 | 位置 |
| --- | --- | --- |
| 每个持久 vault 的模型调用（永不退还，改上限被拒 `DURABLE_BUDGET_MISMATCH`） | 32 | `durable-memory.ts:35`；`durable-codec.ts:32-35` |
| 每小时调用（重启后历史全算入当前小时） | ≤8 | `coupled-stdio.ts:151`；`interaction.ts:109` |
| 每会话交互（不淘汰，满则 fail-closed） | 128 | `coupled-runtime.ts:94,291`；`dsh-coupled.ts:77,95,129` |
| 整库镜像 | 16 MiB | `durable-codec.ts:8` |
| 每代提交／检查点历史 | 4096／256 MiB | `durable-codec.ts:8` |
| Safety 条目（热+冷，终身） | 8192 | `safety-ledger.ts:44-48` |
| fanout | 512 节点／scope，64 scope，16384 日志项 | `fanout-types.ts:1-2` |
| 内生控制（每 vault 一次） | 300 s／64 次 | `anchored-vault.ts:427`；`endogenous-durable.ts:58-63,135` |
| 持久召回可见记忆 | 32 | `store.ts:580` |

按每次交互约 10 次整库提交估算，M2 路径的寿命约为一百到几百次交互。这些原本是实验安全阀，但已写进格式与账本校验，成了产品约束。

## 4. 具体缺陷

1. `FACTORY_BASELINE.humanQuote` 末尾包含给编程代理的指令"我记得这些我之前写过，你找出来"，随每次 plan／generate／review 请求发给教师（`corpus-production-baseline.ts:5`）。修法：另发新版本号的 baseline，去掉尾句；旧原文、批次与 digest 保持不变。本 PR 不修改该常量，也不回放旧请求。
2. `wf2-together-pilot.ts:30` 把 Student 型号告诉教师。
3. `workers/corpus/tokenizer.py` 与 `tokenizer-batch.py` 近乎重复。
4. 三代教师管线（WF1/WF2 .3–.8、TeacherPilot、Production v1/v2）共用一条分发链（`wf1-provider.ts:19-30,53,88-109`）；`teaching-validation`、`corpus-qa-archive-assembly`、`training-journal`、`growth-journal` 只被测试或 demo 调用。
5. `retrieval-demo.ts:24` 仍报 `durableFanout:'NOT_IMPLEMENTED'`。
6. `docs/CORPUS-TEACHER-PILOT.md:84` 自述真实试点曾把 source／family／rights 元数据发给了 provider。
7. 安全扫描未发现密钥；CI 不用 secrets；`.gitignore` 覆盖 `.env*`、`*.dpapi`、`*.db`、`/runtime/`。`AGENTS.md:16` 含本机绝对路径。

## 5. 判断：什么该保留、什么该收

**保留**：store 的来源 DAG 与撤销级联、AEAD 用法、PREPARED/reconcile 协议、投递门的幂等与 UNKNOWN、合成测试的对抗性（Proxy/thenable/时钟倒退/子进程崩溃）。

**收**：IF6–IF11 的容量工程（回执段、冷槽→分片、按字节记账的工作区、legacy lineage 登记）在在线路径永远达不到的上限上调优；TJ0 自定义压缩档案格式服务于一本尚无真实记录的日记；为单条 240 字节语音做租约与 fencing；`neural-policy.ts` 为一个玩具回路准备 8 种后端。

## 6. 建议顺序

1. 冻结两周不加新层；把 [ACTUAL-WIRING.md](ACTUAL-WIRING.md) 放到 README 顶部并随每次合并更新。
2. 选一条持久化路径：接入 AnchoredVault 并把 M2 标为遗留，或给 M2 补 `expectedHead`；终身上限改为滚动窗口或配置项；停止逐变更整库序列化（按事务批合并）。
3. 审定最小认知环（见 [MINIMAL-COGNITIVE-LOOP.md](MINIMAL-COGNITIVE-LOOP.md)）：对话历史、显式工作状态、选择节点、人格进入系统提示、`observe` 接真实输入特征；缓存仍须当前来源／许可复核。本地端点与降级路线是后续候选，不代表本 PR 已部署。
4. 召回：先对照排序、时间偏好与当前输入排除方案。[既有固定合成对照](../../research/retrieval-baseline/README.md#fixed-cohort-result-and-decision)不支持用研究版 BM25 替换 AR0；在线 `store.search` 又是另一条路径，不能据算法名称直接替换或推定质量提升。
5. ⑥ 先建评测集再决定训练；修掉 humanQuote 尾句；不向教师暴露 Student 身份；能力池与教师资格见 [2026-10-29-training-route.md](2026-10-29-training-route.md)。
6. 代码减重：格式化（见格式化 PR）、错误码集中成表、删除三代管线中不再调用的代码；README 压成一页"现状／接线／下一步"，证据回执移入 `docs/evidence/`。
7. 平台：Windows 绑定（DPAPI、SAPI、`D:\…`）隔离为可替换 launcher 接口，目标宿主是 Spark 上的 Ubuntu ARM。

主控接续次序：恢复后先处理 #35 布局故障与容量验收，再审定认知环方案和 #37 格式化窗口，随后推进在线闭环。本次修订不恢复既有执行、不合并、不启动训练。

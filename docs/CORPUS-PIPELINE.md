# CorpusPipeline/0.1：CP0 选中候选采收

这是独立于 WF2 `.8` 的第一片数据交付实现：只读采收已合格候选，复核既有证据，写入新的加密证据、单行 JSONL 和不可变 manifest。2026-10-27经独立源码/载体审查与用户具体授权，专职Sol完成真实单行采收、冷进程核验、固定Student tokenizer计量及另一进程重算；结果见下方实际记录。Student训练与产品质量验收未执行。生成/review双队列、CP1语料导入、Parquet、语义去重和大池生产不属于此片。

原 `.8` 保持 `STOPPED`、T11/DS1、qualified1/quarantined1、无原 manifest。新合同允许一条 train、零条 dev，不改变旧四行完整 manifest 的门槛，不续跑、重评分或读取失败/sealed 正文。选中数学行的 `EXACT_VERIFIED` 仅指 `EXACT_RATIONAL_TYPED_TARGET_ONLY`，不能推导自然语言解释正确、教学质量优秀或已经适合训练。`MODEL_REVIEWED` 与形式证据是不同等级；此片仅接受精确数学资格，另存 modelReviewAccepted=true，不接受任意自然语言行。

## 可信 host 与最窄读取

1. 专职运行代理在新的 retain-only host authority 下调用原 `CampaignLedger.inspect`；原 HMAC 账本、旧 authority、旧 STOPPED 状态和所有原件保持不变。读取许可与执行许可不同，账本 `inspect` 不发请求。
2. `prepareWf2Harvest(ledger, trainReadPort, candidateId, expectedSource)` 要求 Root 冻结的 `campaignId/ledgerHead/buildDigest/profileDigest/archiveDigest`。这里 `archiveDigest` 是独立接受的 source snapshot JSON 的 SHA-256，不是整个运行目录摘要；运行代理负责核实该 snapshot/runtime closure。Core 比对认证 state 的前四项并把 snapshot commitment 纳入新 selection，不自行扫描 archive，也不把合法 hash 字符串当作授权。
3. 返回的 `reader` 仅允许七个具体 train refs：选中 plan unit、rubric、typed target、生成请求/最终响应、review 请求/最终响应。整个计划和其他三个 plan unit 只保留已认证 ref 元数据，不读取其正文。custody、其他候选、provider raw、reasoning、任意额外 ref、同 id 被篡改的 kind/hash 均拒绝。
4. 采收重建原 generation/review 请求字节；核对来源、family/unit/固定 schedule/provider/model/response、rubric、CLEAR review 原件、原 oracle evidence、exclusion commitment；对这条已有合格目标重新精确验算。完整计划/同源排除曾由冻结 WF2 source 检查的事实来自认证账本，不重读 sealed 正文；隐含语义同源仍 `NOT_PROVEN_BEYOND_SUPPLIED_ANCESTRY`。

`CorpusAdmission/0.1` 是可信 host 每次重新读取的窄 current-use 决定，绑定 run、selection、storage binding、authority revision/runtime、expiry、retain/harvest/verify 和 sourceUse=ALLOW。`AdmissionPort` 必须由 host 绑定独立当前文件/服务；模型或不可信 stdin 不能提供它。`TRUSTED_HOST_WF1_LEDGER` 与 `SYNTHETIC_FIXTURE` 分开。能力封装属于可信同用户 host 边界，不是 OS 隔离或可公开验证的签名；hash/readback 只证明完整性。

## 不可变产物与冷核验

`openCorpusRun` 复用原 WF1 bounded encrypted artifact broker、路径和 D-root binding，要求新目录、新 run id；旧 WF1 ledger 目录拒绝。部署 launcher 固定真实 `D:\兴趣开发\AI\Training_0`，Core 只接显式 approved root，测试只用 TEMP。authority/keys 留在语料树外：受信 Node host binder 经匿名 stdin 取得内存中的存储密钥并绑定能力；Core CorpusCommand 配置及 Python tokenizer 输入不含密钥。这是同用户受信 host 边界，不宣称 host 进程完全不接触密钥或已实现 OS 隔离。

单写 SQLite owner 锁保护一次 offline commit。成功前依次写新 `corpus-evidence`、`corpus-jsonl`、`corpus-manifest`，每个对象 readback；最后 `wx` 写 `corpus-commit.json`。对象不覆盖，重复调用校验原 commit/manifest 后返回相同 ref。中断留下的未提交对象保留为 orphan，不导出、不自动删；重新授权且输入相同才可重新离线采收，外部 API 从来不在此恢复路径里。receipt 已存在而损坏时拒绝，不能覆盖成成功。暂停、撤销、expiry、revision/runtime 改变、UNKNOWN/DENY 都停止当前读写。

`verifyCorpusManifest` 和 `inspect` 逐对象检查加密完整性、封闭 schema、逻辑行、qualification/source 请求绑定以及当前权限。冷进程只需要新 store 的只读能力，不需要原 source/custody key。原 `.8` 的 failed/sealed 内容完全不在 verifier 的能力集合里。

新 manifest 显式保存 source/derived refs、父候选、family/roots/split、原 STOPPED、模型 requested/returned ID 与未知 revision=null、协议/effort/finish/usage 来源。每行分别保存 generated、structurallyValid、modelReviewAccepted、exactVerified、dataGateAccepted、manualChecked=false、trainingReady=false。复用行计入 reusedQualified=1，generatedNew=0。

`dataGateAccepted=true` 与 `trainingJobPolicy=NOT_AUTHORIZED` 正交。初始 manifest 固定 `HARVESTED_TOKENIZATION_PENDING`，tokens 与 tokenizerProfileDigest 为 null，measurementStatus=`TOKENIZER_NOT_PINNED`，绝不写作零。它既不启动 trainer，也不声称完整 CP0 数据/训练门已过。

## Host-bound CLI

`runCorpusCommand(raw, ports)` 是给可信 launcher 的 CLI handler；Core 不提供读任意 key 路径的通用 CLI。stdin 封闭为：

```json
{"version":"CorpusCommand/0.1","command":"harvest","spec":{"version":"CorpusHarvest/0.1","runId":"new-run","profileDigest":"<frozen>","selectionDigest":"<selected>","storageBindingDigest":"<new-root>","authorityId":"fresh","authorityRevision":1,"runtimeId":"fresh-owner"}}
```

`harvest` 需要 selection/selected reader/current admission/new output/commit ports；`verify-manifest` 和 `inspect` 仅需要新产物与 current admission。`describe` 使用 spec=null。配置最多16 KiB；launcher 应有同等 stdin、time/output 限制。stdout 仅返回 `CorpusSummary/0.1` 固定状态和聚合计数，不包含正文、路径、family、私有 ref。`inspect` 绝不采收或启动任务。

## 本地精确 token 计量

`measureCorpusRow(row, profile, pythonPath)` 运行 `workers/corpus/tokenizer.py`，参数为 `-I -B`。profile 固定实际 tokenizer.json/template SHA-256、模型 revision、Python/tokenizers/Jinja2/MarkupSafe 版本；无 Node 第三方 runtime 依赖，无模型 weights、下载或 remote code。只接受本地普通文件、32 MiB tokenizer、64 KiB template、64 KiB 输入、65,536 token；host 限时30秒、输出16 KiB。输入有界和进程超时不是 Windows OS 内存 quota 的验收。

User 文本是 canonical `{tool,input}`，assistant 文本是 canonical typed target，不把 plan/review/metadata/teacher reasoning 当 loss。固定模板设置 enable_thinking=false、truncate_history_thinking=false、medium_effort=false、tools=[]、add_special_tokens=false；分别渲染 generation prompt 与完整两条消息。完整 IDs 必须精确以前者为前缀，否则拒绝。loss 是剩余 assistant suffix，包含模板 terminator；空 think 区块若在 prompt 内，不计入 loss。计数用十进制字符串，返回 input/full IDs 与 loss mask 摘要，不返回正文。

回执 `CorpusTokenMeasurement/0.1` 绑定完整 rowDigest/profileDigest，状态 `LOCAL_PINNED_EXACT`，始终 actualTrainerParity=NOT_RUN/trainingReady=false。`measureCorpusManifest` 把 manifestRef、profile 和计量回执写入新的加密 `corpus-token-measurement` artifact 并 readback；host 私有载体持久保存返回的 measurementRef。`verifyCorpusTokenMeasurement` 可在新 Node 进程逐对象核验并再次调用 Python 重算实际 IDs，不能只相信保存的 count。它不回填/覆盖初始 manifest；完整计量后新 manifest 的签发是下一独立准入。`officialPipelineParity=NOT_VALIDATED` 保守保留；专职 Sol 的特定 Transformers 版本、特定 public text fixtures 等价证据可另存，不推导多模态或真实 trainer parity。

## 2026-10-27 实际采收与计量

原始安全stdout回执SHA256为 `1396a2f4320277bbbe910b660b7d89a7a838fb3c0697143f5957f612ad124a07`，状态 `HARVESTED_VERIFIED_AND_MEASURED / COMPLETE / NONE`。新的加密清单实际为1条train、0条dev，reusedQualified=1、generatedNew=0；本次新增模型/API/DSH调用与Student训练均为0。仅harvest读取原选中的7个train refs；其后三个阶段只访问新store。host在采收前后核实原authority、ledger、owner文件字节不变，旧 `.8` 继续保持STOPPED及无原四行manifest。

固定文本计量profile `c2cf92861921ae1d797a93d35b0ab617b86386650e0938041a0ddca7a3eafc93` 采用官方Student仓库 `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16` revision `fb0ee0bc6b3f70342afd8d84cb80dbadbaa8a1fe` 的本地tokenizer/template；实测94 input、18 assistant suffix loss、112 full tokens。另一个新Node/Python进程重算全部计数、input/full IDs摘要和loss mask摘要一致。初始manifest仍保留原始PENDING字段，计量证据作为独立加密artifact保存；不是把未知字段原地改成训练许可，也不宣称真实trainer或多模态全流程等价。

四阶段实测时间为采收348ms、清单冷验186ms、计量845ms、独立重算781ms；这是单行本地操作，不是教师生成吞吐或每日产能。执行前可用Windows内存4,116,209,664B、D盘454,432,280,576B，CPU秒和worker峰值RSS未测，保持null。未读取或公开原失败样本、密封评测正文或教师reasoning，密钥不显示或明文落盘。最初的自动审批在CreateProcess前拒绝；用户随后明确授权同一冻结入口，再提交获准并完成，原拒绝记录保留，未重放任何已消费的模型请求。

执行后只读检查确认139项源码/公开运行文件无漂移，两项新授权均已撤销并过期；新D产物共7个文件、30,300B，计量指针对应的密文存在。原文件前后相等依据是已冻结host执行中的断言，后检查另记录当前hash，不冒称另有独立采集的外部before hash。该单行数学样本是实际采收链验收，不是语料规模、陪伴能力或模型训练收益的证明。

## 验证与后续

聚焦合成检查覆盖原 `.8` 真实代码路径的首行合格/次行失败、七-ref读取、篡改 review/请求/source/exclusion、UNKNOWN/撤销/epoch拒绝、重复幂等、单写争用、提交前崩溃/orphan、密文损坏、只读 mutation拒绝和新进程逐对象验证。可选 `CP0_TOKENIZER_PYTHON` 指向已 pin 的独立 Python，使用 TEMP 手工 WordLevel tokenizer 检查精确 ID/mask golden、资产hash/runtime/prefix拒绝；不下载真实资产。源码合成通过不等于真实采收已完成。

独立 `corpus-tokenizer-synthetic` CI 在 Windows x64、Ubuntu24.04 x64 和 macOS15 arm64 实跑同一 CPU fixture（包括持久计量回执与新进程重算），只装三项固定版本的开发库。CI Python 固定3.12.10；本机作者实测3.12.14，测试各自记录解释器真实版本，生产 profile 的 exact runtime 校验不放宽。[官方 python-versions 清单](https://github.com/actions/python-versions/blob/160ca1e232997f36def6bb6e857f628222bef58a/versions-manifest.json)的3.12.14缺少 Win/mac build，不能假称三平台同版；[setup-python v6.3.0](https://github.com/actions/setup-python/releases/tag/v6.3.0)固定到commit。原 Core job 未配置 Python 时该额外用例会明确skip；专用3-job CI设置绝对解释器路径以实际执行。三平台结果在发布后独立验收，当前尚未运行。

长期目标：部署前256GB训练池主要导入清洗后的优质现成语料，teachers 定向补人格/情感、长期 memory、多语言、探索、工具编排和校准；CP0不是全模型训练。未来实际部署及睡眠微调目标是尚未拥有/测量的双 DGX Spark 互联，维持同一持续主体和受控权威 memory，默认在线节点加学习节点，不当作统一256GB显存；首轮较大训练仍计划 Together 租赁。

未来外部 scoped privileged broker 保护两机 OS、身份、凭据、生产 weights、权威 memory、备份与版本 fencing；普通 memory 更正/删除经独立事务服务，candidate weights 经独立 eval/activation/rollback。当前不改变任何宿主权限、配置或服务，也不把协作式 guard 宣称为 OS enforcement。

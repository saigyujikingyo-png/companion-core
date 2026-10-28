# CorpusQualityAudit/0.1 验收分层（2026-10-28）

本切片对既有生产 job 中冻结选中的合格候选追加独立模型质量意见、私有 scoped index 和筛选 manifest。[协议与边界](../CORPUS-QUALITY-AUDIT.md)保留作者冻结时的实现说明；[原出厂基线](../FACTORY-BASELINE.md)与[当前 QA 目标增补](../AUDIT-TARGET-BASELINE.md)分别绑定生成目标与审查目标。本文记录后续实际验收，公开源码和安全总计，不公开样本或逐条意见。

## 源码与合成验证

冻结运行源码为 37 个文件，build digest 为 `f1b8d25398fc287bc665a2faea38ef00f69a236815057e799b3591fca6e0e9c9`；原公开改动冻结为 15 个文件。本文与 README 是后续公开文档 overlay，不改变该运行源码或重跑既有 whole。

- 作者专项 13/13、最终差量 2/2、基线差量 1/1 均通过，0 skip；共有 14 个独立 QA 用例，三层结果不相加为新的 whole。strict TypeScript 与 `git diff --check` 通过。
- 执行者的一次本机 whole：1,080 tests，1,080 pass，0 fail，0 skip，185,571.9468 ms。原日志 SHA-256 为 `1be0bbbdcf7f9cac9c44747aa9b06f1030fec8c2c9a1233557318085a7d801d7`；独立审查核对日志摘要与最终 Node reporter，未重跑 whole。
- final37 合成宿主链：127 条输入得到 124 PASS、1 HOLD、1 REJECT、1 UNCERTAIN；33 次 fake transport 调用，真实 API 调用 0。它验证宿主完整链和产物绑定；其中 public tokenizer 测量只针对合成 fixture，不是私有教材 token 总计，也不证明模型实际质量。

独立审查结论为 `QA_SYNTHETIC_AND_WHOLE_EVIDENCE_ACCEPT`，审查回执 SHA-256 为 `2c2c8ab35bd015988a41eeb6fe24d2564fb36b68ed7933945dfd19341292a829`。真实 QA 宿主仍有独立准入门，不由该结论授权。

## 合成候选选择与实际模型 QA

从真实 API 生成的合成候选中冻结选择 127 条，train 111 / dev 16，耗时 4,173.6675 ms，选择阶段新增 API 调用 0；旧来源保持不变，读取准入已撤销。来源是模型生成的合成教材，未把私人聊天或真实生活记录作为本批来源。选择步骤只冻结获准审查的来源，不产生 QA 结论，也不恢复旧 job 的发送权。

读取宿主准入审查为 `READ_SELECTION_HOST_ACCEPT`，审查回执 SHA-256 为 `10809c588f90d24102baee83f61d6b6363896884a34467b4dadcad36d4c164a4`；该审查发生在实际读取前。实际安全回执为 `READ_SELECTION_COMPLETE_REVOKED`，SHA-256 为 `37fcd05cb0c210a31a2767c82b9c03f1571cc5c02dea83221ea92938a8182a1b`，记录旧 authority 未恢复、旧 once 未触碰，未创建新 QA authority 或发送 once。事后的独立 `READ_SELECTION_SAFE_ACCEPT` 由 Root 交接的 Max 消息确认，不冒称为上述准入审查中的实际执行结果。

实际 dispatch 首次尝试在创建进程前被自动审批拒绝，要求明确的人类外发许可；当时没有新增 QA 执行或 API 请求。取得对这 127 条合成 prompt/response 外发至 Together 官方 GPT-OSS 服务的明确许可后，同一未消费 audit 首次启动。终态为 `QA_SETTLED_COLD_VERIFIED_REVOKED`，原固定到期时间未延长，dispatch/read 权限和新 QA authority 均已撤销。

127 条的模型结论为 **116 PASS、9 REJECT、2 UNCERTAIN、0 HOLD、0 PENDING**。最终私有 index 与 manifest 已提交；本次 scoped 比较后 eligible 为 116 条，其余 11 条未进入 eligible。导出汇总中的 heldRows 不等于模型结论 HOLD。以下教材 token 继承原来源固定的 exact token receipts，本次没有重新分词：

| 切分 | eligible 条数 | input tokens | loss tokens | full tokens |
|---|---:|---:|---:|---:|
| train | 101 | 7,492 | 29,972 | 37,464 |
| dev | 15 | 1,079 | 4,138 | 5,217 |
| 总计 | 116 | 8,571 | 34,110 | 42,681 |

packing 为 OFF，官方 trainer/pipeline parity 尚未验证。范围仅为本次选中的 127 条，使用 exact、normalized pair 与 normalized prompt 比较；不覆盖另一批 182 条，也不保证全局语义去重。此前两批共 309 条只是模型评审候选，不能写成 309 条通过本批 QA，或将本次 116 条称为跨批训练数据集已合格。

实际宿主记录 **33 次 native fetch**：DeepSeek coordinator 1 次、Together reviewer 32 次；provider 报告 usage 为 107,826 input / 124,136 completion tokens，known429、submitUnknown 与 usageUnknown 均为 0，retryCount 为 0。native fetch 次数不等于独立服务器收据计数，`actualProviderCalls=null`。未配置价格，reserve 上界和 usage 金额估价为 null，费用与 invoice 均为 `UNKNOWN`；记录中的 knownUsageEstimateMicroUsd=0 不代表零美元。API usage 与上表教材 token 分账。

宿主完整生命周期为 424,577.4711 ms，其中 Run 进程为 412,186.5532 ms；Core wall 为 3,839,266 ms，自 spec 创建起包含准备和审批等待；Core service 为 1,419,319 ms，是并发请求的累计服务时长。这些口径不互换，也不冒称单次网络 wall 或模型推理时长。

新进程冷验证的 counts、calls 和私有 index 摘要与运行结果一致，旧来源不变；独立撤销入口确认已撤销。最终 cleanup 无 provider 调用。真实重复 Run 在 worker、凭据或 custody 读取前以 `REFUSED_ALREADY_CONSUMED` 拒绝，新增 worker、凭据读取和 provider 调用均为 0，once 未改变，无新 nonce。没有重新发送或补样。

最终安全聚合回执 SHA-256 为 `930eed4037bfd5d40d58f711e44bcb645529025261485161d63caec63e829cf2`，controller 安全回执 SHA-256 为 `0620066d2802127d82051654981441c8eb0cd0672933d4a6f957894c2cd2f200`。公开材料不含 case ID、ref、内容指纹、账户、本机路径、样本、评语或原始 provider 输出。

## 发布与验收边界

跨平台结果以本切片提交的 PR 检查记录为准。沿用现有 Core 四组合、tokenizer 三组合与 DSH native 三组合的 PR 工作流；基础 PR 的结果不替代本批检查。源码审查、合成宿主链、本机 whole、合成候选选择、实际模型 QA、冷验证与 CI 各自保留范围。

QA 输出始终为 `MODEL_OPINION`，请求模型不同不证明统计独立，`independence=SAME_MODEL_OR_ROUTING_UNKNOWN`；`factualTruth` 与 `falseAcceptanceRate` 均为 `UNKNOWN`。所选来源绑定不是旧 provider 全流程重审，`providerReaudit=NOT_PERFORMED`。QA 意见不进入 loss，不授予训练许可；`trainingReady=false`，Student 训练 `NOT_RUN`。

# CorpusQualityAudit/0.1

这一独立切片为已结束的生产 job 追加模型质量意见和筛选清单。首个实际配置拟覆盖原 127 条 eligible 文本，代码支持冻结的 1–192 条 census。原接受记录、被拒内容、shard 与 token 回执不改写。作者验证只用独立 TEMP 合成数据；实际 QA、宿主完整链、新提交 CI 和训练分别验收。

## 新 job 显式 policy v2

`CorpusQualityAudit/0.2` 使用独立 `QA_V2_PROFILE_DIGEST` 并要求 `execution.concurrency`，保留单物理 job 的 192 行和 wire/token/storage/期限限制。金额与总调用数只计量，planned operation/case 仍只消费一次。rubric 与 verdict 都使用[生产 v2 的同 attempt raw 缺报证明](CORPUS-PRODUCTION.md#explicit-policy-v2-for-new-jobs)：仅完整可信输出且实际 usage absent/null 可作为 UNREPORTED 接受；坏 usage、矛盾标签和 raw/final 不一致不能冒充缺报。生成、冷验与 export 使用同一判断。HTTP/格式或可信 unknown 只 HOLD 相关行；rubric 失败影响依赖该 rubric 的全部行。身份、来源、权限及存储完整性仍 fence job。独占 resume 的 `RECOVER_UNKNOWN` 记录本地决定，serviceMs 为 null，原请求不重发，迟到结果不能升级接受。

v2 生产 qualified row/export 的 0.2 版本可以进入新的选择与 QA 链。归档描述符必须显式选择 `QA_POLICY_V2` 和新 `QA_INDEX_ARCHIVE_V2_PROFILE_DIGEST`；它绑定 exact spec/build/profile、terminal refs/head、冷验收据摘要与当前授权。包含该输入的 assembly 使用新的 `QA_ARCHIVE_ASSEMBLY_V2_POLICY_PROFILE_DIGEST`，沿用结构未变的 0.2 wire；冷 reader 重新计算并核对精确 profile，不接受冒名旧 F1/F2。旧 F1/F2 固定签名与 profile 未修改。

完整索引继续保留 PASS、REJECT、HOLD、UNCERTAIN 节点用于跨批连通去重，最终 eligible manifest 只是该完整索引的选择结果。归档 reader 的新 profile 仍只读 metadata/index/selection 与末端事件，不读 attempts/cases 表、provider raw/reasoning/rubric/verdict 正文或旧教材；它依赖受信宿主独立 pin 的 descriptor 和 cold receipt，摘要本身不是签名。缺 usage 的 raw 证明发生于原 production/QA 的当前 attempt 合法读取域，不扩张后续索引授权。新增测试全部为合成数据，不改变真实批次验收或 Student 训练状态。

### 新 v2 请求策略与旧批边界

`CorpusQualityAuditRequestPolicy/0.1` 将 coordinator 与 reviewer 的实际 system 文本摘要纳入 `QA_V2_PROFILE_DIGEST`。协调器明确收到既有封闭 JSON 合同：1–12 条唯一 ASCII ID 的 criteria、instructions 最多 2048 UTF-8 字节、每条 criterion 最多 512 字节，建议 6–8 条简短标准；本地限制不放宽，不截断、修复或重试输出。两方均按每条任务适用的标准评审，课程或数据集的六域覆盖不作为每行或每个 review batch 的要求，不强求未要求的多语言、工具、身份或私生活展示。题目明确要求翻译或跨语言保真时，缺少必需语言或保真失败仍须判该要求不合格。相关事实、来源、隐私、权限、执行真实性及不确定性检查仍必须满足，不因此自动 PASS。

此策略只供新 build、新 job。新 reader 明确拒绝旧 v2 profile；旧 v2 已消费批次继续使用其原冻结 build/source（本次旧 execution62 为 `070f0ba1…`），不迁移、重开或改写旧请求。新 QA index/assembly profile 随 QA profile 派生变化，宿主须重新绑定对应 build、模板和准入；不得将旧 v2 归档交给新 reader 混读。v1 的 profile、rubric/review 请求字节和旧 F1/F2 读取路径保持不变。

这次修复针对已观察的一次 16 行 canary：3 个 rubric 格式失败导致 12 行 HOLD，另 4 行被评审拒绝；技术冷验证通过与质量门失败分别保留。新 v2 在现有 `failureCodes` 中仅记录固定的 `CQA_RUBRIC_COUNT`、`TEXT`、`ID`、`DUPLICATE_ID`、`FIELDS` 类别及通用 `CQA_RUBRIC_FORMAT` 回退，不记录输出正文、异常 message 或 stack。类别不能证明样本质量，存储读取和 native 完整性失败仍 fence。后续真实模型质量须另行验收，Student 未获训练授权。

## 来源与读取边界

受信 launcher 在旧 authority 仍可合法 inspect 时，通过 `prepareQualitySelection` 读取快照、registry、export、所选合格 row/candidate 及对应 token 收据，冻结旧 job/spec/build/profile/head、ledger/authority 文件摘要、export 摘要和逐条精确 refs/digests。它不调用 `verifyProduction`，不读取旧 provider 请求、raw、reasoning、计划/旧评分正文、被排除候选或 sealed 材料。新独立 selection/read grant 明确当前 read/retain、派生 review/training 用途；新 `openQualityArchive` 只暴露所选 case ID 的读取，不暴露任意 ref 解密。

旧 authority 到期后，所选历史字节可由有效的新 archive grant 读取；旧发送权不恢复，不伪造时间，也不延长旧授权。每次 source read、发送与提交复核新授权及用途。新进程对冻结源 ledger/authority 全字节校验；运行中 regular-file 和 stamp 检查只作变化诊断，所选加密 artifact 每次核摘要和认证。原文件变化或当前 read/retain/source 撤销即停止。认证范围是所选字节与已冻结生产链的绑定，`providerReaudit=NOT_PERFORMED`；不是重新审核整个旧 provider 过程。

## 角色、用途与盲审

DeepSeek 官方 API `deepseek-flash` high 生成一次独立 rubric，输入是 host-approved existing objective、原出厂基线和[当前 QA 目标增补](AUDIT-TARGET-BASELINE.md)。Together serverless API `openai/gpt-oss-120b` high 审阅。每条只传 opaque caseId、输入摘要、prompt/response；不传原 teacher、接受状态、旧评分、pool/split/family 或旧 source ID。文本自身可能透露背景，元数据隐藏不是不可识别性或统计独立的证明。两个 provider/model 是请求身份，祖先与路由独立性仍为 `SAME_MODEL_OR_ROUTING_UNKNOWN`。

当前用途依据分别为 [DeepSeek Open Platform 条款](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)的训练/蒸馏许可，以及 [Together 官方 GPT-OSS API 发布说明](https://www.together.ai/blog/announcing-the-availability-of-openais-open-models-on-together-ai)所述蒸馏和合成训练数据用途。Together 仅用于本项目获准的自有伴侣/模型研究范围；这不是对竞争云平台、转售、再分发或其他账户合同的概括许可。host 提供精确 service/accountType/accountRef/purpose/termsEvidence 和派生祖先的版本化 ALLOW；UNKNOWN/DENY 或不匹配拒绝 dispatch/export。开放权重许可与托管服务用途分开。

ResearchMentor 只看聚合 metadata，不能读样本、逐条意见或写具体教材。模型输出封闭为 PASS/HOLD/REJECT/UNCERTAIN，永远只是 `MODEL_OPINION`；不能自封人工核验或确定性证据。事实真值与真实误收率均 UNKNOWN。评语不进入 loss，QA 不授权训练。

## 持久执行与产物

`openQualityAudit` 使用新 job、AES-GCM artifacts、SQLite event/projection、独立外锚及 owner 锁。消费落盘先于唯一发送；结果未知、未结算消费以及已结算未知结果的重启均 fence，不重发、不退款或补样。SQLite commit 后外锚失败仍严格拒绝冷开，不推进 head、截断账本或自动接受前缀。

rubric 一次先结束；review 同时至多 4 个请求，每个 1–4 条，按实际 64 KiB 编码预算封组。单条格式坏或无法装入一请求则 HOLD，其他冻结行继续。全局 fence 后在途仅可结算，不能新增 PASS。已知 429 消费一次，未知 usage 保留 reserve；保留完整服务端 Retry-After，超过 30 秒的当前等待上限或非法值 fence，不截短继续发。有限任务、单次时限、当前权利和资源门保留；金额仅记账，无 10 USD 项目准入上限。旧 Production/0.1 冻结金额配置不改。

终态追加私有不可变 scoped index 与 selection manifest。selection/index 按 32 条加密分片；manifest 引用 selectionRef 与合格 case/verdict refs，精确继承旧 row 和 token 测量。冷验证重建新请求、rubric、逐条 verdict、index 与 manifest。eligible 是原选中 eligible ∩ QA PASS ∩ 当前授权 ∩ scoped 去重允许；待审、失败、HOLD、REJECT、UNCERTAIN 不默认通过。

`buildScopedIndex` / `assembleScopedIndexes` 提供有界跨 job 的 exact、NFKC/大小写/空白归一 pair 及 normalized prompt 指纹。身份以 job+unit 命名空间区分，改 ID 不能改变内容指纹。重复边连接 source family；跨 split 的连通 family 全部 HOLD，保留选中节点中 QA 拒绝项的桥接关系。范围仅为显式选中的 eligible 以及调用者明确提供的最多 8 个版本索引，不读取旧 rejected 节点，不保证全库语义去重或 ANN 召回。下一 job 在 assemble 阶段组合新旧索引；最终训练混合仍需另行冻结。

## 宿主接口与验证

`runQualityAuditCommand({version:'CorpusQualityAuditCommand/0.1',command,spec}, ports)` 支持 describe/run/inspect/verify/export-index。可信 ports 提供 store、selected source、selection、objective、transport 和可选 signal；私钥和样本不放公共命令。`createQaTransport` 复用固定 native endpoints、禁止 redirect/SDK retry。`readQualityIndex` 只供可信本地 assemble；CLI 返回总数、pool×split 状态、有限失败码、耗时、已知 usage 与 UNKNOWN、reserve 和已知 usage 估价，不返回逐条意见、指纹或样本。金额 reserve 上界和 usage 估价分字段，invoice UNKNOWN。

合成测试覆盖正常 blind census/cold export、旧源过期与新 grant、source/权限撤销、逐项隔离、UNKNOWN once/restart、429、用途祖先、跨 job 指纹/split HOLD、错误 manifest、原件不变和金额超过 10 USD。合成 token 收据只测试读取绑定；真实官方 tokenizer 正确性沿独立已存在的 tokenizer suite 验收，不伪称本测试执行了模型或实际分词。

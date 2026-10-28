# CorpusQualityAudit/0.1

这一独立切片为已结束的生产 job 追加模型质量意见和筛选清单。首个实际配置拟覆盖原 127 条 eligible 文本，代码支持冻结的 1–192 条 census。原接受记录、被拒内容、shard 与 token 回执不改写。作者验证只用独立 TEMP 合成数据；实际 QA、宿主完整链、新提交 CI 和训练分别验收。

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

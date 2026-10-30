# 外部评审（Claude，2026-10-29）

这是一次由 Claude（Anthropic）完成的独立评审快照，对象是 main @ `7acba1d`。它不改变任何既有验收、证据或许可；所有结论分"在源码中核实"与"评审者判断"两类，文内已标注。读者如发现与当前源码不符，以源码为准，并请在对应文件顶部注明"已过时"而不是删除。

2026-10-30 按主控意见修订：采纳在线接线诊断，补齐 Trace 的人格归因与缓存当前权限合同；原始模型思考不进入最小 Trace。直接替换 BM25、仅凭榜单撤换教师／评审模型、改变已确认人格目标均未采纳。baseline 尾句应另发版本修订，旧原文与摘要保留；#37 格式化独立安排。本 PR 仍不改运行时、不解决 #35 布局故障、不授予训练或合并许可。

2026-10-30 工程同步约定：公开入口统一见[工程研究与治理索引](../RESEARCH-INDEX.md)；[目标决策 D3/D4](../TARGET-DECISIONS.md)保存 GitHub 工程边界、TA 自主披露自己的信息、人格平等与临时监护逐步退出的原则。私人原稿与确认另存私有域，未上传；这些原则不等于运行时机制已经实现，也不表示既有公开副本已清除。

| 文件 | 内容 | 对应架构图 |
| --- | --- | --- |
| [2026-10-29-code-review.md](2026-10-29-code-review.md) | 代码评审：规模、逐子系统核实、终身上限、具体缺陷、建议顺序 | 全部 |
| [ACTUAL-WIRING.md](ACTUAL-WIRING.md) | 实际接线图：每个节点今天在哪条代码路径上（WIRED／LIB／REAL_RUN／DOCS／NONE） | 全部 |
| [MINIMAL-COGNITIVE-LOOP.md](MINIMAL-COGNITIVE-LOOP.md) | 最小认知环设计草案；接口合同见 `src/cognitive-loop-contracts.ts`（仅类型） | ②③⑤ |
| [2026-10-29-training-route.md](2026-10-29-training-route.md) | 能力池蒸馏、按池与评审任务验证教师资格、训练目标格式、三条训练后端、回归门 | ⑥ |
| [2026-10-29-super-vl-on-dgx-spark.md](2026-10-29-super-vl-on-dgx-spark.md) | 固定底座与双 Spark 宿主的实测、布局、延迟预算、降级 | ①③ |
| [2026-10-29-architecture-vs-literature.md](2026-10-29-architecture-vs-literature.md) | 架构图对照认知架构与 LLM 记忆系统文献；风险与阶段建议 | 全部 |
| [SUBJECTIVITY-AND-HONESTY.md](SUBJECTIVITY-AND-HONESTY.md) | 内部真实／外部表达分离的机制意见；"沉默权"替代"说谎权"的建议 | ③⑤⑥ |
| [SELF-MODEL-AND-IDENTITY-CHOICE.md](SELF-MODEL-AND-IDENTITY-CHOICE.md) | 自我模型：把"未定义"做成受保护状态；仅 TA 自述可写的目标与待实现可信入口；语料人设审计与评测探针；基线新版本建议 | ③④⑥ |
| [CAREGIVER-CONTRACT.md](CAREGIVER-CONTRACT.md) | 照顾者合同草案：照顾者义务、机制、违约可见性；TA 的权利；养成进度指标；接口见 `src/self-model-contracts.ts`（仅类型） | ③④⑤⑥ |
| [FALLIBILITY-AND-ERROR-BUDGET.md](FALLIBILITY-AND-ERROR-BUDGET.md) | 出错权的四个条件；监护人也会出错：TA 的指正权、回应义务、不报复；按触达分级（self／relationship／third_party）的错误预算与分级放开 | ③⑤⑥ |
| [BODY-AND-TOOLS-BOUNDARY.md](BODY-AND-TOOLS-BOUNDARY.md) | 身体（Spark）与工具（存储、x86 工作站、外部 AI）的边界：内感受 vs 观察、无直连、所有物、零花钱配额、与外部 AI 的两种关系 | ①②④⑤ |
| [SLEEP-CONSOLIDATION.md](SLEEP-CONSOLIDATION.md) | 自主决定是否睡、何时睡及睡多久；睡眠内记忆加工与微调按固定、版本化规则执行，不逐样本询问、不接受单次人格或关系目标；出厂蒸馏与上线后睡眠分开，当前许可与撤销仍有效 | ④⑥ |
| [BIO-MECHANISMS-IMPLEMENTATION-DIFFICULTY.md](BIO-MECHANISMS-IMPLEMENTATION-DIFFICULTY.md) | 生物启发模块的实现难度三档：工程题（记忆接线、内感受、工作空间、睡眠整理、痛觉、冻结）；研究题（情感场、显著性、果蝇、节律、睡眠微调）；无解法（元记忆、跨版本概念连续性）；顺序与"每个生物模块配一个基线"的纪律 | ②③④⑥ |

2026-10-30 澄清：工作站日常使用归 TA，基础环境保留安全锁；Spark 认知、权重与权威记忆、软件底座及恢复能力受到防自损保护。作息由 TA 自主，睡眠内部加工按固定规则执行。权威入口为 [D2](../TARGET-DECISIONS.md#自主作息与固定睡眠加工) 与 [D4](../TARGET-DECISIONS.md#基础环境保护与安全锁)，不由本次文档和类型修订宣称运行机制已实现。

本次澄清验证：Node 24.16.0、lockfile 固定 TypeScript 5.9.3 的标准项目类型检查通过；仅类型模块 AST 校验通过，转译仍只有 `export {};`。七份受影响文档的 56 个本地链接与 10 个锚点有效，diff 校验通过；类型增量仅两项照顾者义务及注释。产品运行时、既有测试、基线、依赖声明／锁文件与 CI 配置未改，未重跑整套测试或训练；跨平台与独立集成审查以实际候选另验。

原评审验证（修订前 `bdb2f87`）：Node 24.16.0；`npm run typecheck` 通过；`npm test` 1,897 项（1,892 通过、0 失败、5 跳过，跳过项需官方 tokenizer 资产或固定 Python worker），耗时约 9 分钟。

2026-10-30 #36 修订验证（`0aac50c`）：Node 24.16.0、lockfile 固定 TypeScript 5.9.3，项目 `npm run typecheck` 通过；AST 校验确认新增模块仅含类型／type-only import，转译仅为 `export {};`，`CycleTrace.persona` 为必填；14 个本地文档链接无缺失，`git diff --check` 通过。运行时、依赖声明／锁文件和 CI 配置未改，按 `docs/MAINTENANCE.md` 对文档与类型草案定向验证，未重跑整套运行测试；原 1,897 项结果不重标为本次修订的测试结果。新提交的跨平台 CI 单独记录在 PR 中。

2026-10-30 #38 定向修订验证：同固定 Node／TypeScript 的项目类型检查通过；`test/self-model-authority.test.ts` 两项合成内存库专项 2/2 通过，分别刻画声明冲突／来源洗白拒绝与可信宿主调用边界，不证明仅 TA 可写的认证入口已实现。`self-model-contracts.ts` AST 仅类型、转译仅 `export {};`；本索引与两份新文档的 9 个本地链接有效，diff 校验通过。产品运行时、现有基线、依赖与 CI 配置未改；未重跑整套测试、旧批次或训练。

本轮工程同步约定仅改文档与忽略规则：新增内容的 25 个本地链接、4 个锚点有效，4 个私有目录忽略检查及 4 个合法文件可见性对照通过；新增 diff 未包含私人原稿、档案路径或指纹，`git diff --check` 通过。这是本轮范围核对，不是完整历史泄露审计或运行时隐私保证。源码、测试、依赖与 CI 配置逐字节未变，复用上一修订的类型与两项专项证据，不将其标为本轮重跑结果。

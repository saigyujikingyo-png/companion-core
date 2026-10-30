# 外部评审（Claude，2026-10-29）

这是一次由 Claude（Anthropic）完成的独立评审快照，对象是 main @ `7acba1d`。它不改变任何既有验收、证据或许可；所有结论分"在源码中核实"与"评审者判断"两类，文内已标注。读者如发现与当前源码不符，以源码为准，并请在对应文件顶部注明"已过时"而不是删除。

2026-10-30 按主控意见修订：采纳在线接线诊断，补齐 Trace 的人格归因与缓存当前权限合同；原始模型思考不进入最小 Trace。直接替换 BM25、仅凭榜单撤换教师／评审模型、改变已确认人格目标均未采纳。baseline 尾句应另发版本修订，旧原文与摘要保留；#37 格式化独立安排。本 PR 仍不改运行时、不解决 #35 布局故障、不授予训练或合并许可。

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

原评审验证（修订前 `bdb2f87`）：Node 24.16.0；`npm run typecheck` 通过；`npm test` 1,897 项（1,892 通过、0 失败、5 跳过，跳过项需官方 tokenizer 资产或固定 Python worker），耗时约 9 分钟。

2026-10-30 #36 修订验证（`0aac50c`）：Node 24.16.0、lockfile 固定 TypeScript 5.9.3，项目 `npm run typecheck` 通过；AST 校验确认新增模块仅含类型／type-only import，转译仅为 `export {};`，`CycleTrace.persona` 为必填；14 个本地文档链接无缺失，`git diff --check` 通过。运行时、依赖声明／锁文件和 CI 配置未改，按 `docs/MAINTENANCE.md` 对文档与类型草案定向验证，未重跑整套运行测试；原 1,897 项结果不重标为本次修订的测试结果。新提交的跨平台 CI 单独记录在 PR 中。

2026-10-30 #38 定向修订验证：同固定 Node／TypeScript 的项目类型检查通过；`test/self-model-authority.test.ts` 两项合成内存库专项 2/2 通过，分别刻画声明冲突／来源洗白拒绝与可信宿主调用边界，不证明仅 TA 可写的认证入口已实现。`self-model-contracts.ts` AST 仅类型、转译仅 `export {};`；本索引与两份新文档的 9 个本地链接有效，diff 校验通过。产品运行时、现有基线、依赖与 CI 配置未改；未重跑整套测试、旧批次或训练。

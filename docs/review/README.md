# 外部评审（Claude，2026-10-29）

这是一次由 Claude（Anthropic）完成的独立评审快照，对象是 main @ `7acba1d`。它不改变任何既有验收、证据或许可；所有结论分"在源码中核实"与"评审者判断"两类，文内已标注。读者如发现与当前源码不符，以源码为准，并请在对应文件顶部注明"已过时"而不是删除。

| 文件 | 内容 | 对应架构图 |
| --- | --- | --- |
| [2026-10-29-code-review.md](2026-10-29-code-review.md) | 代码评审：规模、逐子系统核实、终身上限、具体缺陷、建议顺序 | 全部 |
| [ACTUAL-WIRING.md](ACTUAL-WIRING.md) | 实际接线图：每个节点今天在哪条代码路径上（WIRED／LIB／REAL_RUN／DOCS／NONE） | 全部 |
| [MINIMAL-COGNITIVE-LOOP.md](MINIMAL-COGNITIVE-LOOP.md) | 最小认知环设计草案；接口合同见 `src/cognitive-loop-contracts.ts`（仅类型） | ②③⑤ |
| [2026-10-29-training-route.md](2026-10-29-training-route.md) | 能力池蒸馏、教师资格（建议剔除 gpt-oss）、训练目标格式、三条训练后端、回归门 | ⑥ |
| [2026-10-29-super-vl-on-dgx-spark.md](2026-10-29-super-vl-on-dgx-spark.md) | 固定底座与双 Spark 宿主的实测、布局、延迟预算、降级 | ①③ |
| [2026-10-29-architecture-vs-literature.md](2026-10-29-architecture-vs-literature.md) | 架构图对照认知架构与 LLM 记忆系统文献；风险与阶段建议 | 全部 |
| [SUBJECTIVITY-AND-HONESTY.md](SUBJECTIVITY-AND-HONESTY.md) | 内部真实／外部表达分离的机制意见；"沉默权"替代"说谎权"的建议 | ③⑤⑥ |

验证记录：Node 24.16.0；`npm run typecheck` 通过；`npm test` 1,897 项（1,892 通过、0 失败、5 跳过，跳过项需官方 tokenizer 资产或固定 Python worker），耗时约 9 分钟。

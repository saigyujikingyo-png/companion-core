# 补充：Together 上的 gpt-oss 教师

2026-10-26；DESIGN_ONLY / GPT_OSS_TEACHER_CALLS_NOT_RUN / QUALITY_NOT_EVALUATED。新增教师来源，学生仍为 Nemotron 3.5 Super VL 120B；不改既有冻结计划或 WF0 合同。ResearchMentor 仍仅做一般方法与运行 metadata，具体材料由独立获准 TeachingCoordinator 决定；闭源 GPT/Astra 顾问会话与本来源严格分账。

**型号与能力。** Together serverless 当前列出 `openai/gpt-oss-120b`、131072 context、MXFP4、function calling 和 structured outputs；这些是 documented 能力，未由本项目调用验收。[服务目录](https://docs.together.ai/docs/serverless/models)与[OpenAI 模型页](https://developers.openai.com/api/docs/models/gpt-oss-120b)分别记录部署与纯文本能力，不能把它当视觉教师。20b 已于2026-09-15移出 serverless，不默认替换可用；其 dedicated/fine-tuning 是另一准入。

**接口边界。** `reasoning_effort` 只允许 low/medium/high，默认 medium；本地拒绝其他值。原生 `reasoning` 与最终 `content` 分栏，流式分轨累计；completion cap及输出计费涵盖二者。usage-only chunk 即使无 choices 也保留用量。JSON只解析content；期望最终答案时，只有reasoning、空最终答案或 `finish_reason=length` 记 `INCOMPLETE_OUTPUT`，不得final PASS；tool_calls只表示待执行请求，需独立工具回执。[Together quickstart](https://docs.together.ai/docs/gpt-oss)

**记录与教学使用。** 在未来provider输出适配层另提版本化envelope：provider/endpoint、requested/returned model、版本证据、effort、reasoningRef、finalAnswerRef、finishReason、usage及其来源、sourceFamily、用途决定与验证回执；未知revision/usage不写成固定版本或零。WF0不因此临时加字段。开放模型原生reasoning是候选过程文本，不是实际内部计算测量或正确性证明。答案型与过程加答案型是否使用、如何独立核验及按同家族/等loss-token预算对照，交TeachingCoordinator决定；不得混入闭源受限推理、既有顾问产物或sealed材料。

**许可分层。** 权重[LICENSE正文](https://huggingface.co/openai/gpt-oss-120b/blob/main/LICENSE)为Apache-2.0。[OpenAI官方帮助页](https://help.openai.com/en/articles/11870455-openai-open-weight-models-gpt-oss)链接模型仓库的[USAGE_POLICY](https://huggingface.co/openai/gpt-oss-120b/blob/main/USAGE_POLICY)：本次可读201-byte正文要求遵守适用法律，文件最近变更标为 `ed282e6`（2025-08-05）；已核正文，不把闭源产品政策自动替代此文件，也不据此作项目所有用途的许可结论。

Together [服务条款](https://www.together.ai/terms-of-service)更新于2026-05-19：§2.4要求遵守第三方模型条件并约定冲突时模型条款优先；§7.2规定双方之间的输入/输出归属；§4.3(c)涉及竞争Together产品/服务及竞争分析或benchmarking。应结合拟议用途和实际适用约定判断，不能机械判定所有学生训练被禁，也不能以Apache或输出归属绕过托管限制。[Together发布说明](https://www.together.ai/blog/announcing-the-availability-of-openais-open-models-on-together-ai)明确提及Batch用于蒸馏和合成数据，这是产品能力依据，不能替代合同判断或当前batch资格实测。

**最小接入。** 保持DeepSeek-first与WF0推进；gpt-oss作为独立可选来源，在sealed先封、用途绑定后先做有界协议/成本校准，再按合格率与吞吐扩批。冻结每批calls、总completion tokens、wall time、并发和金额cap；reasoning不得绕过预算。Batch另验支持、usage、取消、失败重入及UNKNOWN提交核对，不能把账户存在推成可用。待核仅包括实际账号附加约定/输入权利、部署版本、权限与限额、接口实测和教师质量；本补充未读凭据、调用API、生成教学材料或启动训练。

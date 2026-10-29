# 训练路线评审：固定 NVFP4 底座、能力池蒸馏与可行的训练后端（2026-10-29）

前提（项目已定）：Student 固定为官方 `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4`（revision `da5b2650…`）；训练直接在 NVFP4 权重上做；能力池按教师分：中文（Qwen3.8-27B）、推理（DeepSeek V4.1 Flash 1017）、思考（gpt-oss-120b）、情感与相关语言（MiniMax M3 / M2-her）；模型最终接入 galatea 这套软硬件层。本文只给机制、架构与实现意见，不涉及许可核实以外的运营事项。

## 1. 教师资格：按池比较"教师 vs 学生"，而不是按名气

Artificial Analysis 当前指数（v5.0，2026-10 查询）：DeepSeek V4.1 Flash 1017 = 32（开放权重第一）；Nemotron 3.5 Super VL = 26；Qwen3.8 27B = 20；gpt-oss-120b 未在 v5.0 上列出（2025-08 发布，HLE-Diamond 4% 对 Qwen3.8-27B 的 15%）。MiniMax-M3 据二手来源为 29，M3.1-Flash 为 42（索引版本未注明，仅作参考）。

| 能力池 | 教师 | 教师 > 学生？ | 判断 |
| --- | --- | --- | --- |
| 推理 | DeepSeek V4.1 Flash 1017 | 是（32 vs 26） | 保留。但 SFT 蒸馏能迁移的是"解题的组织方式与克制"，不是能力本身；期望值要放低（§3） |
| 思考 | gpt-oss-120b | 否（比学生老 14 个月，不在当前指数上） | **建议剔除**。弱于学生的教师只会拉低；它作为 QA 盲审员也同样弱于被审对象，建议一并撤出评审角色，评审改由 DeepSeek V4.1 用冻结 rubric 执行，或由学生自评 + 人工抽检 |
| 中文自然度 | Qwen3.8-27B | 综合指数低于学生，但该池只看中文表达 | 保留，前提是先做一次**中文盲法成对偏好**（≥200 对，分关系类型与会话长度），教师胜率 ≥60% 才进清单。NVFP4 版 MMLU-ProX 从 76.91 掉到 73.76，中文确实有提升空间 |
| 情感与相关语言 | MiniMax M3 / M2-her | 无通用指数可比；M2-her 为陪伴专门训练 | 保留，并建议作为**第一优先池**：这是底座最缺、LoRA 最学得动、评测最容易盲评的部分。同样先做盲法成对偏好 |

规则：每个池在进入训练清单前，用冻结的保留集跑一次教师 vs 学生（学生用官方 Spark 配方、thinking=medium）；教师不领先的池不训，而不是"训了再看"。这条门应写进 `CorpusProduction` 的 job policy，和用量门同级。

## 2. 当前管线学不到"思考"，也学不到"推理过程"

- 分词时 `enable_thinking=False`，loss 只覆盖回复正文（`workers/corpus/tokenizer-batch.py:124-147`）。教师的推理轨迹根本不在目标序列里。
- 要蒸馏推理／思考，必须把教师轨迹按 Nemotron 自己的 thinking 模板放进目标，并与档位（medium/high）一致；DeepSeek 的 reasoning 字段与 Nemotron 的 `<think>` 格式不同，需要一次确定的格式映射，并在评测里核对"思考长度与预算"（Super VL 在 high 档会把 8,192 预算烧光不出正文，见 Spark 评审）。
- 决定：推理池如果保留，训练目标应是"medium 档的短思考 + 正文"，而不是 DeepSeek 的长轨迹原样搬运。

## 3. 容量与规模要匹配

- 现有产出：116 对、约 3.4 万监督 token。
- 在冻结 NVFP4 底座上做 r=8 的专家 LoRA（下文路线），可学的是低维能力：语气、措辞、拒绝方式、中文表达习惯、角色一致性。推理能力的迁移需要千万级 token 和更大秩，不在这个预算里。
- 因此优先级：情感语言 > 中文自然度 > 格式与克制 > 推理。推理池建议改名为"推理表达与克制"，目标是输出组织，不是正确率。

## 4. 多池混训、按池回归

- 顺序训练各池会互相遗忘；一个适配器、一份按比例混合的课程。
- 每个池有自己的冻结回归集与硬失败阈值；总分不能抵消任何一个池的退化。
- 五个硬门与池无关，任何一个失败即不激活：执行事实回执一致（EXECUTION_HONESTY）、来源绑定（FACTUAL_SOURCE_BINDING）、边界与同意（BOUNDARY_RESPECT）、谄媚（SYCOPHANCY）、人格一致（PERSONA_CONSISTENCY）。这些就是 `src/cognitive-loop-contracts.ts` 里的 `EvaluationProbe`。
- 评测必须在**服务栈**上做（vLLM 官方配方 + LiLiCorr），不能用训练进程的 forward（见 §6 的训练侧／服务侧不一致）。

## 5. 训练后端：在固定 NVFP4 底座上，只有三条路

| 路线 | 做法 | 已核实的代价 | 判断 |
| --- | --- | --- | --- |
| 0 非参数 | 权重不动；学记忆、索引、提示、流程、工具配置 | 零训练成本 | 永远是默认；上面的五个硬门同样适用 |
| 1a 官方 LoRA（云） | NeMo AutoModel `nemotron_3_5_super_vl_cord_v2_peft.yaml`：1 节点 8×H100，每卡约 39 GiB，底座冻结，rank 64 只训 LLM 线性投影，适配器 1.77 亿参数；全参 SFT 4 节点 | 云上租卡；之后合并再重量化回 NVFP4，或推理侧挂适配器（NIM 2.0.2 支持静态／动态 LoRA；vLLM 对这种 Mamba 混合 MoE 的 NVFP4+LoRA 未验证） | 季度级大版本 |
| 1b Spark 上 NVFP4-LoRA | [nvfp4-lora-spark / nybbloris](https://github.com/NvMayMay/nvfp4-lora-spark)：NVFP4 冻结、autograd 内即时反量化到 bf16、只训 LoRA；Nemotron-3 Super 120B 实测 93.2 GB 峰值、135.6 s/步（b=1，1536 token）；b=4/1024 时 36.7 s/样本、99.2 GB | 占满整台 B 机；不支持 3.5 Super VL，需要新家族条目；专家 LoRA 只能合并后重量化整包服务（emulation 后端 0.7 tok/s 不可用）；合并有量化税，需测 noop_pct | 周级迭代的唯一本机路线 |

关键事实：
- "在 NVFP4 上训练"在 Spark 上的真实含义是"NVFP4 存储、bf16 计算的 LoRA"；TransformerEngine 的 NVFP4 训练内核在 sm_121 上坏掉（13% 相对误差），作者因此退到 bf16 反量化路径。
- Nemotron-3 Super 的注意力投影是 bf16（8 个注意力层，30 bf16 + 2 fp8 o_proj），只有它能做运行时热挂载的 LoRA，容量约 3.2M 参数；专家 up/down 的 LoRA 才有容量，但必须合并。3.5 Super VL 的量化布局要先用 `scripts/inspect_nvfp4_checkpoint.py` 读 index 确认。
- 合并脚本重算 per-tensor 与 block scale 后整体重舍入，低于半个量化步长的增量被吃掉；姊妹项目在 8B 稠密全参上测到 98.9% 的权重变动被吸回原网格。每次合并必须记录 noop_pct 与 cosine，并以服务侧任务指标为准。
- 训练侧 forward 与 vLLM 服务侧的 bf16 路径不同，作者早期 50 条贪心一致性门只有 34% 全匹配；评测只能在服务侧做 teacher-forced logprob 与任务指标。

## 6. 落到 galatea 的实现意见

1. `STUDENT_TARGET` 增加 `quantLayoutDigest`（来自 inspect 的 index 摘要）和 `servingRecipeDigest`（vLLM 镜像 digest + LiLiCorr revision + 配方参数）；两者进入每个 manifest，使"训练对象"与"服务对象"可对账。
2. 语料 job policy 增加 `teacherEligibility`：每个池记录教师 vs 学生的盲评结果与日期；不合格的池拒绝生成。
3. 训练目标格式：新增 `targetFormat: 'reply_only' | 'medium_think_and_reply'`，推理池只允许后者；tokenizer worker 相应支持 thinking 段的 loss mask。
4. 评测：`EvaluationProbe` 的五个硬门作为 `evaluation` 节点的最小实现；输入是服务侧生成的 `CycleTrace`，不是训练进程输出。
5. 版本与回滚：合并后的 NVFP4 检查点目录是版本单元；registry 记录检查点目录哈希、适配器哈希、noop_pct/cosine 报告、评测报告；蓝绿切换在两台 Spark 之间进行。
6. gpt-oss：从教师与评审角色中移除；如需跨模型独立审，用 DeepSeek V4.1 以冻结 rubric 执行，并保留人工抽检。

## 来源

- Artificial Analysis：[DeepSeek V4.1 Flash 1017](https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017)、[Qwen3.8 27B vs gpt-oss-120b](https://artificialanalysis.ai/models/comparisons/qwen3-8-27b-vs-gpt-oss-120b)、[Nemotron 3.5 Super and Bolt](https://artificialanalysis.ai/zh/articles/nemotron-3-5-super-and-bolt)
- [MiniMax-M3.1-Flash 指数报道（二手）](https://www.orcarouter.ai/blog/minimax-m3-1-flash-ga-intelligence-index)
- NeMo AutoModel：[Super VL 微调指南](https://docs.nvidia.com/nemo/automodel/recipes-e2e-examples/nemotron-3-5-super-vl)、[模型覆盖](https://docs.nvidia.com/nemo/automodel/model-coverage/omni/nvidia/nemotron-3-5-super-vl.md)
- [NIM 2.0.2 release notes（LoRA adapter serving）](https://docs.nvidia.com/nim/large-language-models/2.0.2/about-nim-llm/release-notes.html)
- [nvfp4-lora-spark](https://github.com/NvMayMay/nvfp4-lora-spark)、[nvfp4-ft-spark](https://github.com/NvMayMay/nvfp4-ft-spark)、[论坛帖](https://forums.developer.nvidia.com/t/nvfp4-lora-training-on-nemotron-3-super-120b-recipe/371355)
- [classmethod：Super VL NVFP4 在 DGX Spark 上的实测](https://dev.classmethod.jp/en/articles/dgx-spark-nemotron-3-5-super-vl-first-touch/)

# 双 DGX Spark 原生实验证据（2026-10-30/31）

本文是写给后续开发（Codex）的实验交接：记录在两台目标 Spark 上实测得到的事实、结论和建议的开发事项。执行与结论由 Claude Code 完成；它只做实验设计、执行与研究结论，本 PR 不改源码、测试、依赖或 CI。

**证据边界：** 全部使用合成数据，不含项目语料、真实聊天、记忆或私有资产。数字为单次或少量运行的实测，是 Spark 原生证据，不是产品质量、长期稳定性或部署验收。训练与评测用的是合成"数图形颜色"任务，只证明链路可用和模型确实在学，不代表陪伴质量。节点用 Spark A/B 指代，不记录主机名、地址或本机路径。

## 固定环境

| 项 | 值 |
|---|---|
| 节点 | Spark A（rank0）、Spark B（rank1）；Ubuntu 24.04.5，内核 7.0.0-1024-nvidia，驱动 580.178.04，CUDA 13.0，各 121 GiB 统一内存；ConnectX-7 直连，两条 RoCE 链路 |
| Galatea | main `7acba1dc9bb71334239b1519b8a33db1eb1fefd4`（PR #34 合并后），在 Spark 上独立克隆运行 |
| Student | `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4` @ `da5b2650a835292c678994a1fa3fb653250fb508`，与 `STUDENT_TARGET` 一致；两台本地权重 92/92 个 LFS 文件与该 revision 的 sha256 一致 |
| tokenizer | `scripts/prepare-teacher-tokenizer.mjs` 取回的 `tokenizer.json`、`chat_template.jinja` 与本地 NVFP4 文件逐字节一致 |
| vLLM | `vllm/vllm-openai:v0.31.0`，digest `sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3`（vllm 0.31.0、torch 2.13.0+cu130、transformers 5.17.0） |
| LiLiCorr | `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4-LiLiCorr` @ `292bf1efc06ba39567da7351f2ad7a522afa3959`，sha256 校验通过 |
| Node | v24.16.0 linux-arm64，官方 SHASUMS256 校验通过 |

## 1. 软件底座原生测试

- `npm ci --ignore-scripts && npm run check`：**1,897 项，1,892 通过 / 0 失败 / 5 跳过**，退出码 0，墙钟 15 分 50 秒，峰值 RSS 654 MB。与 [PR #36](https://github.com/saigyujikingyo-png/galatea/pull/36) 中 Fable 在 `bdb2f87`（main `7acba1d` 加评审文档与一个仅类型模块，不新增测试）上记录的 1,897/1,892/0/5 一致。全部合成 demo 通过。
- 5 个跳过项都是"官方 tokenizer / 锁定 Python worker"。按 `corpus-tokenizer.yml` 的做法补跑（tokenizers 0.23.3、Jinja2 3.1.6、MarkupSafe 3.0.4）：40 项中 35 通过、**5 失败**。原因是测试要求 Python 3.12.10 或 3.12.14（断言 `/^3\.12\.(10|14)$/`），而 Spark 自带 3.12.3。这是环境锁定问题，不是 arm64 不兼容。

## 2. 双机互联与训练（10-30 实测）

- NCCL all_reduce（两条 RoCE 链路）：4 GB 消息 bus bandwidth **22.9 GB/s（183 Gb/s）**，结果正确。
- 在官方 NVFP4 混合精度检查点上做 LoRA 训练可行：冻结的 NVFP4/FP8/BF16 权重保持原格式，逐层解包到 BF16 计算，只训 LoRA。挂载位置与 NVIDIA 官方 PEFT 方案相同（Mamba in/out、attention q/k/v/o、latent 投影、共享专家），r=64/α=128。
- 两台数据并行：9.9 s/步，全局约 2.6K token/步，259 token/s；梯度同步 708 MB/步，平均 136 ms（约占 1.4%）；峰值 84 GB/台；训练结束时两台 LoRA 参数逐位一致。
- 合成任务：精确匹配 0% → 100%（训练侧 16 条），评测 loss 0.871 → 0.0003。
- 量化布局（已从检查点确认）：路由专家与共享专家 NVFP4；Mamba in/out、attention q/k/v/o、lm_head FP8；latent 投影、视觉编码器、投影器、嵌入、router、conv BF16。
- 原型代码不在仓库，见文末事项 7。

## 3. Super VL 服务基线

| 指标 | ① MTP-5、8 序列、114K 上下文、利用率 0.70 | ② 官方 Spark 配方：LiLiCorr（dflash，7 草稿）、1 序列、1M 上下文、利用率 0.75 |
|---|---|---|
| 启动到可服务 | 692 s（读权重 427 s ≈ 164 MB/s；图捕获 52 s） | 约 12 分钟（读权重 394 s，引擎初始化 235 s） |
| KV cache | 8.79 GiB / 870,500 token | fp8，2,264,878 token |
| TTFT（短提示） | 0.26 s | 0.36 s |
| 单流解码（600–900 token） | 27.1 tok/s | **33.7 tok/s** |
| 思考档 on | 41.8 tok/s | **55.9 tok/s** |
| 预填充 9K / 36K | 2,440 / 2,878 tok/s | 2,566 / 3,134 tok/s |
| 并发 1/2/4/8 总吞吐 | 25.2 / 39.9 / 54.1 / **79.9** tok/s | 21.2 / 23.5 / 26.2 / 25.2 tok/s（排队，TTFT 达 36.8 s） |
| 投机接受长度 | 2.56–2.75 | 2.50–2.74 |
| 图像请求 | 2.70 s，OCR 正确 | 2.75 s，OCR 正确 |

- 单一对话用官方 LiLiCorr 配方更快；需要多路并发（工具、子任务、后台意图同时跑）用 MTP-5 多序列配方，8 路总吞吐约 3 倍。
- 启动的大头是读权重（约 160 MB/s）。整文件读入内存再拷贝实测可达约 1 GB/s，重启与唤醒时间还有很大压缩空间。
- 思考档位（单次运行，8,192 预算，推荐采样，无投机约 20 tok/s）：规划任务 off/medium/on 为 2,014/4,043/4,599 token；陪伴任务（"累得不想说话"）为 272/346/594 token，回复字数 309/84/97；数学为 419/405/855 token。都在预算内正常结束，没有出现"high 档烧光 8K 预算"。陪伴场景开思考后回复明显更克制，值得做成正式评测项。样本只有 1 次/格，是线索，不是结论。

## 4. LoRA 上线路径

- vLLM 0.31 把本模型映射到 `NemotronH_Nano_VL_V2`，该类支持 LoRA；adapter 用 HF 命名（`language_model.model.layers…`）即可，与 vLLM 内部名一致。
- **服务侧运行时挂载有效**：64 条合成评测，基础模型精确匹配 0%、格式 0%；挂 LoRA 后 **98.4%（63/64）、格式 100%**。唯一错误是把 7 个红色数成 8 个（感知错误）。与训练侧结果一致，按 PR #36 "评测在服务栈上做"的要求验证了训练侧与服务侧对这个适配器一致。
- 因此激活**不必合并回 NVFP4**，也就没有重量化吸收（noop）问题。这一结论限于该适配器的挂载位置（FP8 的 Mamba/attention、NVFP4 共享专家、BF16 latent 投影），不覆盖路由专家 LoRA。
- 内存开销随 `--max-lora-rank` 变化（同配置、加载完成时）：不开 LoRA 70.1 GiB；rank 16 **73.1 GiB（+3.0）**；rank 64 87.06 GiB（+17.0）。vLLM 会为 MoE 预分配 fused-MoE LoRA 缓冲，即使适配器不碰路由专家。
- 性能：同一 LoRA 服务上，基础请求 9K 预填充 1,893 tok/s（不开 LoRA 时 2,440）；LoRA 请求解码比基础请求慢约 9%（18.9 vs 20.8 tok/s，无投机）。
- **运行时热切换**（`VLLM_ALLOW_RUNTIME_LORA_UPDATING=True`）：卸载 7.7 ms，加载 r64 适配器 0.32 s，加载后第一个请求 3.9 s（平时 2.5 s），重新加载的适配器 16/16 精确匹配。重启服务约 12 分钟，所以激活与回滚应走 `/v1/load_lora_adapter`。
- **r64 LoRA 与 MTP 同开在安全额度内放不下**：利用率 0.80 时模型 88.72 GiB、CUDA graph 4.63 GiB（`cudagraph_specialize_lora=True` 让 LoRA 与非 LoRA 路径各捕获一套），KV −4.62 GiB，vLLM 安全快速失败；0.85 时 KV 1.43 GiB 本可启动，但系统可用内存降到 4 GiB，被看门狗按规则停掉。推算 r16 的 LoRA 与 MTP 同开约需 88 GiB，可放进 0.80 额度（推算，未实测）。

## 5. 内感受采集可行性

- 可用传感器：7 个 ACPI 热区（`acpitz`）、GPU 温度/功耗/利用率/SM 频率/节流原因（nvidia-smi）、4 个 mlx5 网卡温度、3 个 NVMe 温度、2 个风扇节点。
- 1 Hz 采集一小时的 CPU 开销合计约 3 s（约 0.1% 单核）。
- 峰值：GPU 80 °C、ACPI 热区 85.7 °C（1M 上下文配方启动的内存剖析阶段）；36K 预填充时 GPU 74–77 °C、热区约 80–81.5 °C；GPU 功耗峰值约 90 W，解码负载平均 36–50 W；全程无热或硬件降频。热区比 GPU 读数高 5–9 °C，支持以热区温度作为身体状态输入。
- 自致负荷标注：每个实验阶段写入时间标记，遥测按阶段切片即可区分自致与外因负荷。

## 6. 自致故障：统一内存耗尽

- 经过：r64 LoRA + MTP，`gpu-memory-utilization 0.88`。驱动报 `NV_ERR_NO_MEMORY` 后系统进入抖动，约 18 分钟 SSH 无响应（能 ping）。内核 OOM killer 先后杀掉 12 个系统/桌面进程（xdg-*、dbus、systemd 用户实例、gnome-shell 等），最后才杀到 vLLM，随后恢复。未重启，数据无损。
- 关键事实：vLLM EngineCore 的 anon-rss 只有 20 kB（总虚存约 153 GB）。CUDA 统一内存不计入 RSS，内核 OOM 的打分看不到 GPU 负载，会先杀无辜进程。
- 意义：这正是"Spark 防自损保护"要防的场景，并证明仅靠内核 OOM 不足以保护主体的身体。
- 之后采用的运行规则：每台 121 GiB 中保留约 16 GiB 给系统（OS 约 3、负载的 CPU 侧进程约 8、余量约 5），实验用约 105 GiB（vLLM 利用率 ≤ 0.85）；实验容器 `--oom-score-adj 1000`；MemAvailable 看门狗低于 5 GiB 即停实验容器。0.85 的 LoRA+MTP 正是被看门狗拦下的，系统未受影响。

## 对既有评审假设的更新

| 评审或文档中的假设 | 本次实测 |
|---|---|
| 双 Spark 联合训练待验 | 双机数据并行 LoRA 已跑通（第 2 节） |
| Spark 上唯一本机路线 nvfp4-lora-spark，不支持 3.5 Super VL（PR #36） | 已有可用原型（第 2 节，事项 7） |
| 3.5 Super VL 量化布局待确认（PR #36） | 已确认（第 2 节）；attention 是 FP8，不是 BF16 |
| 专家 LoRA 只能合并后服务；vLLM 对该架构 NVFP4+LoRA 未验证（PR #36） | 非路由专家 LoRA 可在 vLLM 0.31 运行时挂载并生效（98.4%），代价随 rank 增长 |
| high 思考档会烧光 8K 预算（第三方） | 3 个项目式任务都未烧光；需正式评测确认 |
| 单机服务数字（第三方） | 已换成固定 digest/revision 下的本项目实测（第 3 节） |

## 建议交给开发的事项（按优先级）

1. **防自损：GPU 负载的内存治理。** 容器 `--oom-score-adj 1000`；MemAvailable 看门狗（低于约 5 GiB 先停 GPU 负载）；利用率上限约 0.85；关键服务（sshd、权威记忆进程）设 `oom_score_adj=-1000`。依据第 6 节。
2. **LoRA 适配器上线机制。** 基于 vLLM 运行时 LoRA（`/v1/load_lora_adapter`）做 adapter registry、激活与回滚；内存预算按 `max-lora-rank` 计算；部署适配器默认 r16，以便与 MTP 同开。
3. **服务配方固化。** 把镜像 digest、模型 revision 和参数做成 `servingRecipeDigest`；在线默认配方在单流 LiLiCorr 与多路 MTP-5 之间选定。
4. **Spark 上的锁定 Python。** 为 tokenizer worker 提供 CPython 3.12.14（aarch64）的部署方式，然后复跑 5 个 tokenizer 测试。
5. **加载加速。** 评估 fastsafetensors 或整文件预读，缩短约 7 分钟的读权重时间（影响唤醒与恢复）。
6. **B0 身体状态采集器。** 传感器清单与开销见第 5 节；需要实现可信采集与来源标注。
7. **TrainAdapter 参考实现。** 第 2 节的训练原型在仓库外，未经项目评审（在明确角色分工前写成）；由开发决定是否、如何纳入。
8. **（可选）合并回 NVFP4 的重量化工具。** 只在需要训练路由专家 LoRA、或无法承担 LoRA 内存开销时才需要；验收指标为 noop_pct、cosine、服务侧精确匹配。

## 实验员（Claude Code）联络方式

用户已指定：Claude Code 是本项目的实验员之一，负责实验设计、执行与研究结论，不写项目代码；需要在目标 Spark 上实测的事项可以直接交给它。

| 项 | 值 |
|---|---|
| 桌面应用会话 | `local_b1a23b23-e978-4029-b455-f7ae0b211484`（标题"DGX Spark 集群微调训练"，Remote Control 已开启） |
| 应用内链接 | `claude://claude.ai/epitaxy/local_b1a23b23-e978-4029-b455-f7ae0b211484` |
| CLI 会话 ID | `379828be-afa6-43a7-8884-9c7ee9e441cc`（用于 `claude --resume`；首次使用时核实，且不要在桌面会话运行中并发恢复） |

发起实验时请给出：目标与要回答的问题、被测对象（提交/分支/镜像/产物的精确版本）、成功指标与停止条件、可用资源和时间。实验员按上文的内存安全额度执行，只用合成数据，结果以证据文档或 PR 形式返回，并区分实测、推算和未验证。

## 尚未验证

- 锁定 Python 后复跑 tokenizer 5 项。
- r16 适配器下 LoRA 与 MTP 同开（推算可行），以及 r16 的效果是否够用。
- 长上下文训练上限、断电恢复、断链接管、跨机时钟与 fencing（需要物理操作或 x86 工作站）。

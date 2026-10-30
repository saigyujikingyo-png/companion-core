# 底座与宿主：Nemotron 3.5 Super VL NVFP4 × 双 DGX Spark（2026-10-29）

本文汇总对项目固定底座与固定宿主的核实结果，并给出部署布局。数字均注明来源；标注"估算"的是评审判断。

## 1. 模型事实

| 项 | 值 | 来源 |
| --- | --- | --- |
| 结构 | 120B 总参／12B 激活，Mamba-2 + Transformer 混合 MoE，每个 MoE 层 512 专家（top-K 22），C-RADIO 视觉编码器 | 模型卡（经 classmethod 转述） |
| 输入 | 文本、图片、视频（mp4，≤2 分钟） | 同上 |
| 上下文 | 1M | 同上 |
| NVFP4 权重 | 69.86 GiB（88 个 safetensors）；LiLiCorr 草稿 1.23 GiB | 同上 |
| 量化保留 | 视觉编码器、连接器、Mamba 卷积、嵌入 BF16；路由 FP32 | 同上 |
| NVFP4 vs BF16 | GPQA-D 89.90/89.52；LiveCodeBench 87.41/88.22；SWE-bench V 71.07/71.10；OCRBench 68.34/68.12；**MMLU-ProX 73.76/76.91；WebVoyager 66.31/77.72；DeepSWE 18.2/24.65** | 模型卡 |
| 许可 | OpenMDW-1.1 | 同上 |
| 官方部署目标 | 1× DGX Spark、1× H200、2× H100、1× GB200 | 同上 |
| AA 指数 | 26（v5.0），NVFP4 与 BF16 差 0.1 分内；输出 token 比 Nemotron 3 Super 少约 60% | Artificial Analysis |

含义：OCR／问答几乎无损；多语言与长程智能体任务在 NVFP4 下明显掉分，所以工具网关的多步长任务要切短并多做约束核验，中文质量要自测。

## 2. 单机实测（classmethod，2026-10-18，GB10 / 128 GB）

- 模型卡配方（`gpu-memory-utilization 0.75`、默认 1M 上下文）原样启动，661 s（权重加载 343 s）；KV 池 1.2M token（1.15 个 1M 请求）；测量期间主机空闲内存 13–17 GiB；常驻接近 100 GiB，等于整机专用。NVIDIA 员工在论坛说明配方假设无其他进程共存，共置应降到 0.70。
- 解码：单流 19.06 tok/s；LiLiCorr（DFlash，7 lookahead）38.07 tok/s，接受率 43%；短提示 TTFT 0.26–0.33 s。
- Prefill 2,100–2,200 tok/s：16K 输入 7.5 s、64K 输入 30 s。
- 并发（131K 上下文、8 序列、无投机）：1/2/4/8 路分别 19.2/31.2/52.1/79.3 tok/s 总吞吐，8 路时每路约 10 tok/s。
- 思考档位：默认 high 在部分任务烧光 8,192 预算不出正文；medium 最好（日文 9/9、智能体探针 6/6、三个 harness 可用）；off 最快但会丢长系统提示中的规则。
- 热：作者机器 64K 输入全程 GPU 峰值 77 °C、热区 83 °C、82 W，无降频；论坛有同配方 ≥32K 输入时断电的报告，以及 GPU 读数 81–85 °C 时 `/sys/class/thermal` 热区 93–96 °C 的观察。
- vLLM 镜像为 nightly 提交 `3f1bcfd…`；模型卡列出的 `v0.32.0` 标签在 10-17 时尚未上 Docker Hub。

## 3. 双机：联邦，不是集群

- 两台 Spark 经 ConnectX-7 QSFP 直连（每端口 200 Gb/s，仅以太网／RoCE），与 NVIDIA 官方"Connect Two Sparks"拓扑一致；RDMA 聚合约 196 Gbit/s，但普通 TCP 实测仅约 16 Gb/s。
- 对能放进单机的模型，双节点张量并行只有约 1.3× 的收益（gpt-oss-120b 实测 75.96 vs 58.82 tok/s），却会占满两台机器。
- 结论：A 机整机跑 Super VL（在线：感知、L 侧、教师、judge 之一）；B 机跑慢循环（语料、训练、评测、shadow）并作 A 的降级宿主。B 机训练时无法同时放第二个 Super VL，shadow 评测只能分时。

## 4. 角色分配与延迟预算（评审判断）

- Super VL 承担：L 显式处理侧（规划、分解、约束核验，medium）、可信输入的图像／短视频理解、教师与研究导师草稿；不做独立评测的唯一 judge。
- 小模型或非 LLM 承担：R 持续情境侧、显著性与快速预测、"在听"式即时反应、线索扩展（嵌入 + BM25）、身体特征。
- 延迟：medium 档一个任务约 40 s，off 档约 6 s。陪伴对话要么闲聊回合关思考 + 短系统提示（硬规则挪到执行门核验），要么 R 侧先给即时反应、L 侧随后补内容。
- 降级：A 机不可用时，B 机用 Bolt 74B-A9B（Super VL 的 Star Elastic 子模型，同骨架同视觉编码器，llama.cpp 61.6 tok/s，简单任务质量接近）顶上；云端 API 只作最后降级。

## 5. 对"身体"信号的直接影响

硬件采集测到的温度、争用、余量，大部分会来自智能体自己安排的训练或推理。B0 已有"来源隔离"，必须显式分开"自致负荷"与"外因负荷"，否则会形成"训练→疲惫→休息→更多训练"的自激循环。热区温度（`/sys/class/thermal`）而非 `nvidia-smi` 读数才是应纳入身体状态的量；断电中途写库正是恢复闭包的演练场景。

## 来源

- [classmethod：Nemotron 3.5 Super VL 120B-A12B on DGX Spark](https://dev.classmethod.jp/en/articles/dgx-spark-nemotron-3-5-super-vl-first-touch/)
- [NVIDIA DGX Spark User Guide：ConnectX-7 Networking](https://docs.nvidia.com/dgx/dgx-spark/spark-clustering.html)
- [NVIDIA 论坛：双 Spark 直连实测](https://forums.developer.nvidia.com/t/two-dgx-sparks-over-the-connectx-7-direct-link-setup-notes-throughput-numbers-and-two-questions-federated-vs-cluster-telemetry/376298)
- [llama.cpp 讨论：DGX Spark 性能](https://github.com/ggml-org/llama.cpp/discussions/16578)
- [Artificial Analysis：Nemotron 3.5 Super and Bolt](https://artificialanalysis.ai/zh/articles/nemotron-3-5-super-and-bolt)
- [Unsloth：Nemotron 3.5 Super VL 指南](https://unsloth.ai/docs/models/nemotron-3.5-super-vl)
- [Nemotron 3.5 Bolt 74B-A9B](https://ai-tldr.dev/models/nemotron-3-5-bolt-74b-a9b/)

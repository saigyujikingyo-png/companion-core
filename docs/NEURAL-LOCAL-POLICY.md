# 本地神经后端能力策略

2026-10-25。`src/neural-policy.ts` 是纯 TypeScript 能力证据选择器，**没有果蝇模拟、设备探测、实际模型执行或训练**。默认 `prefer-local`、`small-circuit`；全连接组必须显式请求 `fullConnectomeOptIn: true`。所有候选都为本地后端，不自动调用云端。

`selectNeuralBackend(request, candidates, authority)` 返回 `selected`、`needs_probe` 或 `blocked`，包含每个候选的全部拒绝原因。`selectedId` 只表示能力证据合格，不表示已经执行或获准访问数据。没有候选/没有实测证据时是 `needs_probe`；显存容量、设备枚举与 TOPS 均不能授予资格。

工作负载 manifest 包含 mode、回路规模、graph/model/checkpoint/parent checkpoint SHA256、dtype、布局、batch、展开步数和精确声明的 CPU 分区。`neuralWorkloadHash` 对这些字段生成稳定摘要；省略回路规模等价于显式 small-circuit。调用方须把神经时步、算子版本、动力学参数及其他影响执行的配置也纳入 graphHash；本模块不读取或重算图文件。无父 checkpoint 时必须明确传 null。改变 checkpoint 或父 checkpoint 均需新证据。

可信 runtime 逐候选提供 backend、稳定物理 deviceId、deviceArchitecture、runtimeVersion、providerVersion、driverVersion，以及匹配的 workload hash、检查时间/过期时间、原生 forward/residency/benchmark 结果和实测资源值。deviceId 不能仅为枚举 index（如 0）；runtimeVersion 标识框架构建，providerVersion 须覆盖实际 EP/SDK/编译器版本；多分区执行也须覆盖 CPU runtime 配置。原生实际设备 ID 必须匹配目标设备，不接受未来时间、已过期或非法时间区间。工作负载或环境不匹配返回重新探测需求。

后端名称包括 cpu、cuda、directml、qnn-htp、openvino-npu，以及为后续 MI250X/macOS 扩展预留的 rocm、metal、coreml-ane。名称定义不代表已实现 runtime、安装驱动或本机通过。

| mode | 独立必要证据 |
|---|---|
| inference | forward、residency、benchmark 均 passed |
| local-plasticity | 上述条件加 update passed |
| readout-training | 上述基础条件加 update、backward 均 passed |
| bptt | 上述基础条件加 update、backward 均 passed；unrollSteps 至少 1 |

update 表示该准确 workload 的完整参数更新步骤通过验收，包含 optimizer 步骤（若有），不能仅以反向梯度计算成功代替。optimizer 类型、超参数及更新规则须纳入 graphHash 所标识的配置。三种学习 mode 都必须 update passed；readout-training/bptt 还必须 backward passed。

mode 进入精确 hash，因此 NPU 的 inference PASS 不能授予其他 mode 资格。状态为 failed/unsupported 的证据不合格；not-run/缺失证据不能假定成功。推理后端和训练后端分别选择，不要求 NPU 承担训练。

CPU fallback 默认为空。允许混合分区时，request 必须预先明确声明精确节点/算子标识列表，probe 实际列表必须完全一致；节点标识应能区分同类型的不同节点。计划变化需要重测。runtime 提供的 host/device 峰值和 p95 必须包含所有分区、传输与同步的端到端成本；本模块只校验可信测量值，不自行证明计量完整。所有数值须有限且非负，峰值与 p95 均不得超预算。单独已验收的 CPU 候选可作为设备级回退；这和 GPU session 内的 CPU 分区是两回事。

合格本地候选按实测端到端 p95 选择，相同值保持候选输入顺序。该策略不根据硬件名称猜测加速收益；上层预算应预留前台语音/动画等资源，重新探测不得自动开始训练。探测与实际使用之间仍需检查当前资源预算，本模块不预留资源。

`authority.learningAllowed`、`authority.parentLineageValid` 由受信核心从当前许可和产物来源链得出，不能读取用户 JSON、模型回答或 probe 中的自报授权。学习三种 mode 都需 learningAllowed；来源链失效时 inference 也必须停止。这里不实现身份认证或反学习，亦不代替存储层的代际控制。

**实际执行前和输出交付前必须调用 `MemoryStore.validateRun`，使用当前 scope/consent/deletion/runtime 代际及 artifact；训练产物注册/激活仍走原有来源继承和许可复验。** 此选择器只评估受信 runtime 的能力证据，不加载 checkpoint，也不授予执行、数据访问或上线权限。外部不可信 JSON 不能直接接入这些类型。

后端依据：官方 [QNN](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)、[OpenVINO NPU](https://docs.openvino.ai/2026/openvino-workflow/running-inference/inference-devices-and-modes/npu-device.html)、[DirectML](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html) 是受设备、算子、shape 与精度限制的推理路径；[ORT 训练文档](https://onnxruntime.ai/docs/build/training.html) 明确提供 CPU/CUDA 构建路径。[PyTorch sparse](https://docs.pytorch.org/docs/stable/sparse.html) 的布局、反向与性能支持不能仅由稀疏矩阵存在推断。本模块不把这些官方能力声明当成本机实测 PASS。

验证仅使用 `test/neural-policy.test.ts` 中显式标记的合成证据；不会下载、安装或调用真实硬件/神经模型。

# AEMC 基础设施 ADR 与公开研究 / IF0

日期：2026-10-27。状态：**架构决策供实施，质量/生产/训练接受未授予**。
基线、完整范围、依赖及所有权见 [总矩阵](AEMC-INFRASTRUCTURE.md)。外部资料支持设计取舍，不是本项目的实验结果。未运行新的模型实验或重跑已消费试验。

## 存储、恢复与格式

| ADR | 决策、替代方案与理由 | 证据、代价与复核条件 |
|---|---|---|
| IF-01 权威存储 | **采用** SQLite事务权威和成熟AEAD；保持M2 schema1兼容。**不采用**无限整库checkpoint作为十年终态方案 | 当前16MiB/256MiB/4096 commit上限与全图像写放大。需另做增量/compaction/冷热层，不偷改schema1或明文回退；[SQLite格式](https://www.sqlite.org/fileformat.html) |
| IF-02 head与备份 | **采用**由包外提供的可信head下界、同head密文恢复包、无副作用验证、隔离stage。**不采用**包内自签checksum即新鲜权威 | 较旧pin不能证明不存在后续撤销；外锚更新/故障顺序、跨机器owner与激活 **尚未决**。完成export不等于恢复演练或激活；[SQLite backup](https://www.sqlite.org/backup.html)、[RFC9162一致性](https://www.rfc-editor.org/rfc/rfc9162#section-2.1.4) |
| IF-03 密钥迁移 | **采用**把包装密钥、存储加密键、稳定幂等键分别建模；首片保留原key。托管后端 **尚未决** | 当前AES key亦用于ingress HMAC；直接换key会改变已消费输入指纹。先研究同key重新包裹，再设计版本化rekey。DPAPI通常绑定账号/机器，复制文件不是跨机恢复；[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)、[NIST800-57](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final) |
| IF-04 压缩与独有格式 | **采用**项目逻辑schema与可读版本manifest；**替换**默认专属codec为完整结构+成熟压缩基线；新codec **尚未决** | Q0无方法同时满足15%archive节省和冻结质量门。prototype+delta历史节省为4.713% archive、0.0678% standalone；不是所有多模态压缩均无效。需新家族/任务/全部成本；[Q0结果](../research/q0/RESULTS.md)、[Zstd RFC8878](https://www.rfc-editor.org/rfc/rfc8878) |
| IF-05 durable fanout | **采用（待实现）**schema2 metadata-only invalidation journal+当前授权refetch；首版受信本地投影与checkpoint同事务 | 不永久保存历史私密正文；历史任意时点重建不在此选择的保证中。旧outbox不能充当immutable journal。编号离线迁移、新副本验证、旧reader拒绝新schema；[既有ADR](ADR-AR0B-DURABLE.md)、[transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) |

IF-01/02 的断电边界：SQLite DELETE+FULL 与单文件fsync不自动证明全部文件/目录在断电后可恢复；EXTRA增加rollback journal删除后的目录同步，也不能替代设备/文件系统验收。本批只接受实际运行的合成故障/进程边界证据。[SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)

IF-04 比较表必须固定相同保留策略和质量目标：

| 数据用途 | 成熟比较对象 | 禁止遗漏 |
|---|---|---|
| 结构化交换 | JSON+identity/Zstd、CBOR+Zstd | canonical profile、Unicode/数值/单位/unknown、schema、decoder |
| 热事务与检索 | SQLite含索引/journal，后续可比较其他事务库 | WAL/重建/权限/迁移代价；不能只压payload |
| 批次/列式分析 | Arrow IPC、Parquet | 列schema/metadata/依赖/随机小读放大；它们不是在线事务等价物 |
| 大数组/多模态时序 | Zarr、MCAP、标准媒体容器、独立Zstd frames/seek table | chunk/index/footer/codec模型、原件及缺损恢复 |

规范入口：[JCS RFC8785](https://www.rfc-editor.org/rfc/rfc8785)、[CBOR RFC8949](https://www.rfc-editor.org/rfc/rfc8949)、[Arrow](https://arrow.apache.org/docs/format/Columnar.html)、[Parquet](https://parquet.apache.org/docs/file-format/)、[Zarr](https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html)、[MCAP](https://mcap.dev/spec)、[Zstd seekable](https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md)。标准身份不免除实现测试。普通Zstd frame不等于随机访问容器，输出和解码窗口均须限额。

完整成本至少包含：

- 稳态字节：权威数据、journal/WAL、索引、manifest、元数据、字典/profile/decoder、冷原件、必要副本、备份、安装依赖。
- 峰值字节：稳态加迁移staging、旧generation和临时解码/重建空间；按逻辑字节与文件系统实际占用分列。
- 更新/删除重写量，cold/warm编码/解码/随机读取p50/p95、RAM/VRAM、恢复/迁移时间、版本维护和运维工时。
- 完整与摊销成本同时报告；不可把保留全部历史与只保留当前状态混比。新实验的收益/非劣/coverage/资源门须先冻结；Q0公开集仅作回归。

## 稳定地址、多模态与候选机制

| ADR | 决策与替代方案 | 证据、代价与复核条件 |
|---|---|---|
| IF-06 稳定概念地址 | **采用（待实现）**外部versioned registry、不可复用retired ID、带来源的merge/split/alias；**不采用**神经元/SAE index/向量坐标作为跨代地址 | 当前ConceptRef为namespace/id/revision，研究稿concept URI不能未经新版本直接导入。close/exact/broader mapping不同；[SKOS](https://www.w3.org/TR/skos-reference/#mapping) |
| IF-07 跨模型映射 | **采用**旧profile解码、获授权原件重编码、已评测adapter、不可映射降级四条显式路线；适配算法 **尚未决** | 重编码作基线，线性/正交/相对锚点另评测。高相似度/低MSE不保证属性/角色保真；[Relative Representations](https://arxiv.org/abs/2209.15430)、[Platonic hypothesis](https://phillipi.github.io/prh/) |
| IF-08 对象关系与残差 | **采用**对象-属性-角色-时间-来源联合绑定、hard anchors/unknown；**替换**只保存概念集合/gist；学习残差 **尚未决** | Slot可交换不是持久对象ID；3D须有校准/深度证据，不能由2D推成3D观测；[Slot Attention](https://proceedings.neurips.cc/paper/2020/hash/8511df98c02ab60aea1b2356c013bc0f-Abstract.html)、[ConceptGraphs](https://concept-graphs.github.io/) |
| IF-09 音频 | **采用**转录/事件语义、声学表示/codec、精选真实片段三层；神经codec **尚未决** | 比较PCM/FLAC、成熟有损与神经codec；人名/数字/否定/时序、说话人混淆、韵律/盲听分测。embedding不等于身份；[EnCodec](https://arxiv.org/abs/2210.13438)、[Mimi](https://github.com/kyutai-labs/moshi#model-architecture) |
| IF-10 Hopfield | **尚未决**有限候选集去噪/补全；**不采用**来源权威用途 | 对照最近邻、soft attention、直接读；吸引子可混合/平均，收敛不证明恢复真实事件。测负载、稀有细节和串扰；[论文](https://arxiv.org/abs/2008.02217) |
| IF-11 SDM | **尚未决**二值噪声线索实验；**不采用**主权威存储用途 | 先证地址距离保留任务语义；与Hamming近邻比较，计hard locations/计数器/饱和/删除重建成本；[NASA报告](https://ntrs.nasa.gov/citations/19890017031) |
| IF-12 HDC/VSA | **尚未决**可重建角色查询投影；**不采用**单bundle替代完整事件或稳定ID | 角色codebook/seed/version冻结，显式边保留；测方向关系碰撞与随对象/关系数增长的干扰；[TorchHD论文](https://www.jmlr.org/beta/papers/v24/23-0300.html)、[实现](https://github.com/hyperdimensional-computing/torchhd) |
| IF-13 SAE | **不采用**长期概念寻址；**尚未决**固定profile的可解释探针/压缩 | 需要实际activation访问、字典/层/预处理hash和任务评测；特征可随初始化变化，重建误差不替代行为保真；[稳定性](https://arxiv.org/abs/2501.16615)、[评估](https://arxiv.org/abs/2406.04093) |
| IF-14 小条件扩散 | **采用**外部按需重建服务边界；模型 **尚未决**；**不采用**重建结果自动写成原始观察 | 比较原件检索、结构+简单decoder、Hopfield，再考虑扩散；输出永久标reconstructed，带条件/缺失/seed/profile；[联想记忆理论](https://www.mdpi.com/1099-4300/26/5/381) |
| IF-15 持续情绪/关系 | **采用（待实现）**可恢复工程状态与独立关系记录；**替换**只有会话RAM作为连续性方案 | 快状态衰减不删除长期承诺/边界；隐状态只在精确backend/profile恢复，否则合法事件重算/降级。来源撤销重算；旧presence/权限/在途效果绝不恢复 |
| IF-16 果蝇 | **替换**默认必选为ODE工程基线；果蝇/GRU/SSM/CfC **尚未决** | 既有三seed真实图mean0.75、无回路1.00，尚未匹配完整预算/GRU；运行成功不证明收益。pCd特定雄蝇持续状态机制不等于当前女性FlyWire子图；[pCd](https://authors.library.caltech.edu/records/nrk7w-5yx18)、[FlyWire](https://www.nature.com/articles/s41586-024-07558-y)、[CfC](https://www.nature.com/articles/s42256-022-00556-7)、[本项目历史](M4-NEURAL-LAB.md) |

两项文献对迁移/重放的限制：
[Spens/Burgess 2026](https://www.nature.com/articles/s41467-026-74357-6) 的实现绑定特定Mistral/xRAG版本，且自重建再巩固存在进一步失真；不能证明跨底座latent通用互换。[Speech Codec Probing v2](https://arxiv.org/html/2603.10371v2) 主要英语代理任务显示codec更强地编码语音形态，不能因token被称semantic而免除词义/中文评测；也不据此宣称中文已失败。

所有候选采用单独增量消融，不只比较一条逐层堆叠。家族切分包含原件、帧、ROI、转录、译文、摘要、重建和残差；统计单位为来源家族，缺失/拒答留在分母。质量门涵盖事实/来源/角色/数值/时间和风险-coverage，感知自然度单独报告。训练decoder、字典或adapter需具体准入；本批未执行。

## sleep、迁移、后端与终端

| ADR | 决策、替代方案与边界 | 证据与复核 |
|---|---|---|
| IF-17 sleep候选与调度 | **采用（待实现）**当前有权、完整家族、去重前分组、可解释SleepPlan+Guardian；**不采用**重建/模型自评洗成独立证据 | curation/WF0现为声明合同。跨批registry、语义冲突和恢复重授权仍缺；固定/随机闲时/启发式比较，任务/最长离线/授权唤醒为硬约束；[PROV-DM](https://www.w3.org/TR/prov-dm/) |
| IF-18 跨代迁移 | **采用（待实现）**身份/事实/技能/运行态分层、旧新shadow与可回滚激活；具体Student/teacher和训练服务 **尚未决** | stable agent_id不能证明人格/能力完全同一；新模型、tokenizer、工具、索引、encoder、adapter分别pin；旧模型答案不等于独立真值 |
| IF-19 硬件后端 | **采用**按精确workload与模式验能力的可替换后端；**不采用**型号名/总显存/营销峰值作为可执行证明 | CPU/CUDA/ROCm/NPU训练与推理分开，任何fallback/CPU分区/传输/同步计入端到端成本；[本地策略](NEURAL-LOCAL-POLICY.md) |
| IF-20 多语言与终端 | **采用（待实现）**统一agent身份、来源与效果合同；**尚未决**完整物理端部署与准入阶段边界 | BCP47标签不等于翻译质量；HTTP ACK不等于模型完成或用户收到；cancel不等于物理停止；[BCP47](https://www.rfc-editor.org/rfc/rfc5646)、[OAuth安全](https://www.rfc-editor.org/rfc/rfc9700)、[ROS2 Action](https://design.ros2.org/articles/actions.html) |
| IF-21 无历史与cache | **采用（待实现/独立验收）**purpose+scope+generation缓存键、关检索后的新请求屏障、撤销后能力失效 | 本地cache清理与云端KV状态分开；无法观察远端则UNKNOWN。不重放既有STOPPED/UNKNOWN投递，不凭off称模型遗忘 |
| IF-22 元记忆与风险查证 | **采用（待实现）**逐claim证据/缺失/矛盾评估、可访问原件与查证状态机；**不采用**自信分数替代事实核验 | 用户研究稿§8与本项目来源权威分层；主控定义高风险必查门。VOI只选可选查证，应查未查率/无谓查证率/实际收益分别验收；见合同C15 |

硬件/模型公开资料快照（2026-10-27查询；实机仍NOT_STARTED）：

| 对象 | 本轮有依据的约束 | 尚需证明 |
|---|---|---|
| DGX Spark | 128GB profile为CPU/GPU共享LPDDR5x，273GB/s；双机200GbE连接仍是分布式，必须固定SKU与OS | Arm64镜像/框架/模型算子、collective、分片峰值、断链恢复；两机不自动成为一个256GB显存空间。[硬件](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)、[多机playbook](https://build.nvidia.com/spark/connect-multiple-sparks/overview) |
| MI250X | 双GCD各64GB，aggregate128GB不能当单rank128GB；按GCD/NUMA/xGMI登记 | gfx90a、dtype、kernel、ROCm/OS/driver/firmware、RCCL与分片恢复。查询时官方latest为10.1.0，实际部署必须pin，旧7.x表不当latest。[AMD验收](https://instinct.docs.amd.com/projects/system-acceptance/en/latest/gpus/mi250.html)、[兼容矩阵](https://rocm.docs.amd.com/en/latest/compatibility/compatibility-matrix.html) |
| Windows GPU / DirectML | 所引ORT EP是DirectX12 GPU加速路径，不能计为NPU覆盖 | 串行session、实际GPU adapter、算子/shape和端到端成本另probe；不推导反向训练支持。[DirectML](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html) |
| NPU / QNN HTP、OpenVINO NPU | 各自受设备/版本/算子/shape约束的推理路径；不能推导反向训练支持 | QNN实际CPU分区/fallback；OpenVINO2026有限设备/vision模型的实验性bounded dynamic shape需精确编译器/驱动probe。[QNN](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)、[OpenVINO2026](https://docs.openvino.ai/2026/openvino-workflow/running-inference/inference-devices-and-modes/npu-device.html) |
| Nemotron3.5 SuperVL | 官方model card列120B总/12B active、视觉输入，且模型权重许可和试用API条款分别存在 | 型号页面摘要与model card存在上下文/参数显示差异，必须pin实际revision与服务profile；Spark推理listing不能证明双Spark训练、Together托管微调或权重导出兼容。未调用API。[model card](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/modelcard)、[官方recipe入口](https://github.com/NVIDIA-NeMo/Nemotron/blob/main/docs/nemotron/super35/README.md) |

NVIDIA技能发现已查看实时[官方目录](https://github.com/NVIDIA/skills/tree/main/skills)，当前狭窄Spark基础设施研究无须安装新技能；CLI目录查询因沙箱DNS失败后使用公开catalog，不安装技能、不改用户配置。

任何ADR尚未决或不采用都不自动关闭矩阵项。若替换方案不能满足原目标，必须把等价证据与缺口交主控接受。本文可指导继续开发，不能签发训练资格。

## IF1/IF2 实施决策补录

- **IF-23：采用强制新格式与独立 authority 协议。** 不把旧 M2 的可选 head pin 升格为最新性证明。新 AnchoredVault/v2 的格式/AAD绑定authority、instance、owner/key epoch与schema；整个同步访问持锁，PREPARED后失败不回退，reconcile只发布固定字节。本机参考实现采用SQLite DELETE+EXTRA，并分开外锚和vault恢复域；同账户/管理员同时回滚两域仍是信任边界。与远程/硬件服务相比可先实际运行验证，但不能声明生产custody完成。[SQLite事务](https://www.sqlite.org/lang_transaction.html)、[同步模式](https://www.sqlite.org/pragma.html#pragma_synchronous)、[实现](ANCHORED-VAULT.md)。
- **IF-24：采用有界metadata target invalidation + 当前全量重建。** schema1 SQL保持不变，schema2离线副本迁移；两个消费者的projection/checkpoint同SQLite事务再经外锚确认。相比首版同时引入外部向量库/异步ACK，可直接验证完整前缀、TTL和删除屏障；代价是整库快照及投影重建成本，不闭合十年增量存储或完整历史通知合同。AUTOINCREMENT防已提交编号重用，但不保证连续，因此游标依实际batch而非整数连续性。[SQLite编号](https://www.sqlite.org/autoinc.html)、[实现与实测成本](DURABLE-FANOUT.md)。
- **IF-25：满日志使用显式新目标维护。** 不靠无限扩cap或静默重置required消费者。静态读取外锚current head的有效image，不启动旧Store；RAM裁剪、显式required reset名单、结果预留boot空间，再走同一fencing切换。原件保留，维护receipt含floor/实际reset IDs。它是有界恢复路径，不是长期compaction或自动运维资格。

## IF3/IF4 实施决策补录

- **IF-26：采用精确序列化字节的固定块差分和标准Brotli4。** SQLite Session不覆盖虚表且有主键/schema限制，不能把apply成功当完整FTS/DDL恢复；逻辑业务重放还会引入时间/随机值/外部效果语义。4096块replacement/XOR保原Store/FTS事务，在同codec下比较full和delta，无收益选full/raw，链最多16帧。RAM serialize/扫描仍是O(image)，Safety每帧完整认证。[SQLite Session](https://sqlite.org/sessionintro.html)、[Node24.16压缩API](https://nodejs.org/download/release/v24.16.0/docs/api/zlib.html)、[实现](INCREMENTAL-STORAGE.md)。
- **IF-27：采用单blob与新目标base压实；冷归档暂不扩入本轮。** blob/stage fsync后PREPARED，reconcile只补固定字节；current-state包保原认证链，不能flatten后冒用旧head。压实无Store boot、换owner/instance并保旧源，所以active缩小与总保留空间分账。侧研究SL0/SL1尺寸已独立复核，标准分段tar压缩值得后续显式历史保留研究；其restoreAt的validated-byte指标错误不作为全档认证证据，也不影响尺寸表。当前目标由hot增量与base切换满足，不为追求离线archive压缩率增造历史副本。[实施前门](INCREMENTAL-STORAGE-PLAN.md)。
- **IF-28：旧M2采用一次捕获、全局lineage与实准入门。** 包外pin仅下界，另固定exact tip和包字节；已验证genesis定义同源，schema3登记与vault PREPARED/ACTIVE原子。旧key必须保留作原HMAC，新DEK分工不能冒称历史擦除。默认claim/reserve拒绝，显式current-head准入只记录操作者声明；既不证明latest，也不fence未接外锚的旧副本。严格Safety先校验再终态化，不靠UNKNOWN转换掩盖非法账本。[实施合同](LEGACY-M2-IMPORT-PLAN.md)、[API与限制](LEGACY-M2-IMPORT.md)。

## IF5/IF6 实施决策补录

- **IF-29：先接durable完整性，再增加排名算法。** `consumerRetrievalSnapshot`把TTL持久屏障与冻结时间读取放在同一个外锚guard内，metadata/body/祖先在同一只读事务校验；不串联独立公开读取，也不截断512-node metadata成32条后声称完整。`bindConsumer`复用AR0排序，但消费者进度进入pair身份，query与resolve均重新读取当前权威。原子事务不赋予事务结束后的永久访问权。[SQLite隔离](https://www.sqlite.org/isolation.html)、[实施计划](DURABLE-RETRIEVAL-PLAN.md)。
- **IF-30：用保守单pending准入修复容量失败，不在本轮引入authority rollover。** 原实现仅在访问前检查文件界，缩小阈值实证表明commit可以把后续open/reconcile锁在界外。采用较低新写软界、同SQL完成预演、无cache spill及提交前数据库/最坏journal证明。多个pending按某一顺序预演不足以证明任意B-tree分配顺序，所以本机后端先拒其他增长写。代价是一项pending阻挡同authority新写，旧高水位纯读与有预算完成仍可用；这不是无限容量或物理空间预分配。[固定Node24.16 SQLite源码](https://raw.githubusercontent.com/nodejs/node/v24.16.0/deps/sqlite/sqlite3.c)、[journal格式](https://www.sqlite.org/fileformat.html#the_rollback_journal)、[容量证明与测试](AUTHORITY-CAPACITY.md)。

下一存储研究应区分image/ingress/authority receipt的长期增长；generation compaction不能清除这些语义责任。冷归档/GC须保持幂等、已消费/UNKNOWN身份和恢复信任，不能因hot字节节省就假定十年目标闭合。下一检索研究则按C07冻结家族/时间切分、query/support与质量/成本门，IF5控制面合成正确性不充作AR1质量结果。

# TrainingRun：真实训练履历与冷存储设计

状态：**DESIGN_ONLY / NOT_IMPLEMENTED**，2026-10-26。本次仅校准文档；没有新 schema、reducer、测试、存储/codec、runner、训练、模型调用或部署。原 f98eba6 的 J0、549 项 whole 与四平台 CI 历史保留，不作为本设计实现或真实训练验收。

资产公开/私有分类遵循[目标决策矩阵](TARGET-DECISIONS.md)：私人或可泄露的派生数据、个性 Adapter、训练履历正文继承私有；通用履历仅在全字段无私密且许可允许时可公开，指针/hash 也逐项分类。运行原件默认私有；经逐字段/许可审查的通用履历公开副本是独立产物与版本，不替代权威原件。逻辑格式可公开不代表实例记录可公开。

## 目标与独立记录面

成长日记记录真实 fine-tuning / continuous-learning 训练履历：为什么训练、实际做了什么、产物和质量如何、是否启用。权威记录放在源码/OneDrive 之外的私有硬盘运行目录，以固定版本化格式冷存储，便于后续专属压缩/解压研究；RAM 只缓存近期视图。它不是聊天日记或 curation 日志。

[J0](GROWTH-JOURNAL.md)只有有界 RAM 计划/尝试、真实 curation lint/revalidate 观察与固定 SYNTHETIC_REPLAY；实际训练/模型调用为 0，没有 trainer 或可信跨重启恢复。真实训练日记目标尚未交付，不回填不存在的历史。拟议 TrainingRun / attempt 是独立新记录面，不扩权原 J0。

只有受信 runner 直接观察，或经核对身份、job、请求与产物的 cloud-job receipt，才能产生真实训练条目。模型只能生成引用这些回执的人类可读总结，不能自报 optimizer step、成功或许可。证据等级逐事实判定，不能把整 run 一次升级。local/cloud receipt 均须绑定 run/attempt/purpose、source snapshot、runner build、冻结请求/配置 digest、dataset identity 与实际产物 identity（无产物时显式 unknown/未产生）；cloud 额外绑定 tenant/project/job/提交 ID。本地也不能把任意后来配置关联到旧回执。PID、URL、自报 JSON 和 Hash 均不自证执行；Hash 只证明一致性，不自动证明权限或质量。

## 拟记录字段与证据

以下是版本化合同设计清单，不是已有公开 API：

| 记录域 | 拟记录内容及边界 |
|---|---|
| 身份与目标 | schema version、runId、attemptId、目标、发起原因、请求/事件标识；重试新 attemptId 并链接前次 |
| 模型与 lineage | 精确 base model revision/hash、tokenizer、parent checkpoint/hash、全部继承训练来源与许可引用；缺项 unknown |
| 数据与 teacher | dataset manifest/hash、冻结 split/curation 版本、teacher/标注来源与许可、训练/上传授权回执；许可声明不等于认证 |
| 复现环境 | 训练代码 revision、配置/hash、seed、hardware/runtime/精度、资源与预算；未知环境项显式 unknown |
| 实际执行 | actual start、已观察 batch 与 optimizer step、gradient accumulation 配置、checkpoint/中断事实、终态；batch/microbatch 不冒充 optimizer step |
| 训练与质量 | loss 及来源；独立 eval 的 policy、冻结数据/split、配置/seed、指标与回执；退出 0 或 loss 下降不等于独立质量 PASS |
| 产物 | adapter/checkpoint hash、参数 delta 证据、export、独立新进程 reload 验证与兼容性结果；文件存在或 artifact registry 登记不等于 actual model loaded |
| 量化与部署 | 量化配置/产物 hash、量化独立 lineage/量化后 eval、部署尝试与结果；训练完成不推导量化或部署成功 |
| 成本 | usage/cost 观测来源与单位；未取得为 unknown，不用计划预算冒充实际消耗 |
| 激活与回退 | 当前授权、eval/shadow 门、activation/rollback 独立回执及合法目标；保留 ever-activated 历史 |

训练 actual、eval、artifact/export/reload、量化/部署与 activation/rollback 各自记录证据和状态，不合并为一个 success。区分 NOT_STARTED、部分已观察效果、失败、中断、unknown 与完成；已观察 steps/artifacts 不因失败消失，未知不能写成 0。权重、Adapter、checkpoint 和 dataset 作为独立对象保管，仅引用 content hash/受控定位符，不塞进 journal。

## 来源、次序与可信恢复

executionMode（真实/模拟/未知）与 datasetOrigin（合成/采集/许可公开等）是独立维度；合成数据上的真实 optimizer 更新可在受信回执支持下记为真实训练。下文永久 synthetic 命名空间只指模拟执行，不因 dataset synthetic 而降格或混淆真实训练。

拟议来源分类为 planned、runner-observed、reconciled、synthetic。planned 只表达意图；reconciled 必须保留所核对的受信执行回执及原观察来源，不把任意 JSON 升级为执行。fake runner/fixture 模拟执行与“合成数据上真实更新参数”的受信训练必须分开命名和验收；fake/fixture/synthetic 使用独立命名空间，永久不可晋升真实条目或计入真实训练统计。

严格 reducer 校验前置阶段、身份与因果次序。终态不可由晚到 success 复活；晚到/冲突证据隔离供核对，以关联 reconciliation 事件追加事实而不改原终态，不能重开 attempt。须先持久化 intent 再 submit；submit→ACK 之间 crash 为 UNKNOWN，核对前不自动重跑。old owner 必须 fence；重试或续训创建新 attemptId，续训绑定完整 checkpoint/optimizer/RNG/dataloader 位置，不自动重跑。追加纠正、后续 eval 等关联事件不抹历史，也不复活训练终态；投影展示纠正关系与当前有效结论。持久去重按 runner/job/attempt/event 身份及序列合同定义；重复不产生第二次效果，同身份异内容拒绝。RAM 生命周期去重不是跨重启幂等。

可信持久 append-only journal 仍需独立完整性、runner 身份、事务/检查点协议。跨重启先 reconcile 当前 authority/consent/revocation、job 与最后可信 watermark；缺失、断链、冲突或无法核对时保持 unknown/隔离，不按墙钟或退出码补成功。旧 lease/写票据/运行能力不能随历史恢复，权限 off→on 或重启不能复活已撤销任务/产物。有效前缀回滚等须冻结威胁模型并单独验收，append-only 名称不提供保证。

## 固定逻辑格式与冷存储候选

版本化逻辑 schema 与物理 container/codec 解耦；cold archive 是权威记录，可重建索引是派生物，索引损坏不得改写事件。候选 header 包括 magic、schemaVersion、codecId/codecVersion；按 run/阶段组织 chunk directory，声明解压长度、边界与完整性校验，提供有界随机读和损坏定位。截断/半写/不支持版本 fail closed，恢复只承认经验证的完整提交边界，只承认经验证连续已提交前缀；不能跳过缺块，后缀/完成状态保留 UNKNOWN/INCOMPLETE，不猜测缺失步骤或写 PASS。导入/解压即使 checksum/canonical bytes 正确也只得到声明记录；自报 runner-observed/reconciled 标签不能直接计入已认证真实训练，须核验来源/runner 身份与绑定回执才有对应事实的证据资格。reconciled 必须说明核验方法及覆盖事实，反复读取同一日志不是独立核验；证据资格仍不授予执行、训练或激活权限。

压缩输入、每 chunk/累计解压字节、event/字段/metric payload 体量须在实现前冻结硬上限；读取同时校 declared 与 actual，超限须在分配或继续展开前拒绝，小 header 不能引导无界分配。

JSONL + Zstd 无损 baseline、可选确定性 binary 都是待研究候选，不宣称新自有格式已经定案。先保可靠无损 fallback，再研究字典、模板差分、列式和指标 delta。叙事摘要是可重建派生视图，不能替代关键事实、step/loss 或产物身份。

拟议 roundtrip 门须同时定义逻辑值与规范字节：整数计数用十进制整数字符串，避免 JSON/JavaScript 大整数精度丢失；loss/指标保留 dtype、shape 与原始位模式或等价确定性十六进制编码，明确负零、NaN payload、正负 infinity，不以普通 JSON number 承载这些精确值，不能隐式转 null；metric 同时保留原精度/单位，unknown 为独立状态。普通文本按明确 UTF-8/字段顺序/转义规范生成 canonical bytes；不能静默 Unicode 归一化。无损只针对已定义 canonical logical bytes，不表示来源真实。codec 必须逐字节还原该 canonical event stream，并核精确数值位模式及引用身份；原 runner receipt 原字节另附受控 hash 引用，规范化不冒充原始字节。具体 schema/canonicalization 仍待 TJ0 实现前冻结；不接受仅“数值近似相同”的无损声明。

Q0 的场景表征阴性结论不能外推训练日记 codec 无收益；此对象需要自身合成训练事件语料与冻结基准。比较总 archive 成本，包含字典、索引、header、校验与 reader/版本依赖成本；另测随机读取、跨版本兼容、截断/损坏恢复、压缩/解压时间与峰值 RAM。不得用只计 payload 或平均压缩率替代可靠性与总成本门。本轮不运行压缩实验。

## 隐私、保留与撤销

持久训练 metadata、来源引用、hash、原因也可能敏感；存储、读取、投影、导出及保留期限受当前访问策略控制。冷持久记录不等于无条件永久留存；撤销/到期可限制读取或依法定保留策略清理，清理与完整性边界需另行定义。真实样本正文、聊天、标注全文、秘密和任意异常文本不复制进 journal。训练日志不是许可缓存，进入阶段及恢复时重新核授权。

撤销样本后停相关训练、阻止不合法产物激活并按 lineage 隔离后代。撤销 metadata/样本不等于权重 unlearning；受污染参数需禁用，回退只用当前仍合法 ancestor，必要时重训。已导出副本的撤回能力不得夸大。

## 下一最小切片与验收边界

| 切片 | 未来范围 | 必须独立验收 |
|---|---|---|
| TJ0：DESIGN_ONLY / NOT_IMPLEMENTED | 版本化记录 schema、严格 reducer、私有盘分块无损读写、离线 fake transport/fixture、安全投影；不是又一个 RAM 原型 | 跨重启回读/索引重建、规范字节与数值精确 roundtrip、有界解压/随机读、版本/损坏/半写反例；计划/实际和各阶段独立、重复/冲突/晚到终态、部分效果/unknown、synthetic 永不晋升、当前权限投影；不能称真实训练交付 |
| TJ1：DESIGN_ONLY / NOT_IMPLEMENTED | 可信 runner/durable append-only journal 身份与跨重启 reconcile，受控本地小 trainer receipt | 独立资源/许可准入；真实 optimizer step/参数 delta、export/hash、新进程 reload、独立 eval；成功/失败/中断/unknown、重试/持久去重、撤销/权限变化与跨重启不复活；每阶段分别结论 |
| 后续后端：DESIGN_ONLY / NOT_IMPLEMENTED | Nemotron 或 cloud target、规模/长任务 | 按具体模型、资源、训练/上传许可、额度与 provider receipt 独立验收；不要求每次真实小训练使用 Nemotron 120B |

TJ0 合成盘回读不是受信真实训练恢复；TJ1 结构/恢复通过及小训练完成，也不自动证明持续学习收益、长期质量或生产激活资格。质量/激活沿用[学习设计](LEARNING-DESIGN.md)的独立冻结评测与当前权威门。Root 在实现前冻结具体合同与预算；本设计不启动工作负载。

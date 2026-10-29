# IF10 Safety 终态冷段：实现、独立验证与当前发布边界

2026-10-28。**LOCAL_VERIFIED / UNCOMMITTED / IF10_CI_NOT_RUN**。IF10基于IF9提交 `beed926203879bf31e3c4c6aefff124724accfc0`，两位实际Astra max独立只读审查无剩余P1/P2；实际Sol 6.1执行一次独立本机whole **1098/1098** 和strict TypeScript，均exit0。IF10未提交、无PR/CI/合并；本轮未部署、迁移私有库、调用provider或启动训练。

[实现接口](SAFETY-COLD-SEGMENT.md)、[冻结合同](IF10-SAFETY-COLD-SEGMENT-PLAN.md)、[当前架构状态](AEMC-DEVELOPMENT-STATUS.md)和[长期容量路线](LONG-TERM-CAPACITY-DESIGN.md)分列代码、协议、完整目标和后续工作。此页更新当前状态；[IF9旧候选](AEMC-INFRA-EVIDENCE-IF9.md)及所有旧失败回执保持历史时态。

## 已实现的边界

- P4 `blocks-br4-safety-cold-v1`显式升级；`archiveTerminalSafety`是独立幂等维护操作。只冷迁failed、unknown和已消费反馈的acknowledged，保留完整JSON、原ordinal、精确request/delivery键及reserved合计。UNKNOWN没有变成已解决，额度没有退款。
- 一个不可变、加密、STRICT/WITHOUT ROWID SQLite冷段；所有查询及写入经热冷联合账本。当前冷文件闭包在live访问、commit、publish/finalize复核，RAM缓存不能掩盖缺失或替换。
- 新generation统一先固定context再重封冷段；普通写和提前base保持根。compact/repack/fanout/migrate/restore/rekey自包含，旧源保留且被fence。PREPARED只发布冻结输出，reconcile不重选条目；缺依赖保留未决。
- 冷明文8MiB、密文另加28B；完整Safety和其他载体原预算保持。P4含base最多15帧，有冷根31个数据文件、无冷根30个，备份两个说明文件另列；encoded与decoded分别64MiB，冷段各计一次。旧profile保持16帧/32数据文件。
- backup/restore仍要求exact CURRENT；rekey后先导出新B才能恢复B，旧A不能复活旧控制状态。旧profile备份的operator note兼容仍在，严格物理目录闭包限定P4。
- Safety总条目8192、maxCalls32、Store镜像16MiB、代际目录256MiB及authority容量门没有放宽。没有GC、永久索引跨库路由、Store整图冷迁、十年容量或生产托管接受。

普通冷段SQLite只要求实际RAM能力；它不需要物理repack的FTS5/sourceId许可。IF9的`src/memory-image.ts`精确运行时门保持原SHA256 `a8f78b5f0e3e5cba1737dd63e48caaf5bc8e177ac5f1f92adc21aacb32497034`。

## IF9 发布与运行时兼容性

[IF9 PR #5](https://github.com/saigyujikingyo-png/companion-core/pull/5)在head `beed926203879bf31e3c4c6aefff124724accfc0`自然触发的push和pull_request各7项检查全部通过，**14/14 SUCCESS**，仍OPEN / DRAFT，未合并。修复只涉及CI预期、repack测试及[兼容性说明](IF9-RUNTIME-COMPATIBILITY.md)，生产门不变。

| 验证路径 | 实际运行与结果 |
| --- | --- |
| Windows、Ubuntu、macOS固定Node24.16.0 | push与PR各1032/1032，required-supported；必须执行正向repack |
| Ubuntu浮动Node24.x | push为24.21.0，PR为24.22.1；SQLite3.53.4不在精确许可中，各1026/1026，验证REPACK_RUNTIME和无目标/回执/状态副作用 |
| native-synthetic | push与PR均成功；无真实provider或训练 |

浮动版本的正向VACUUM用例明确为NOT_EXECUTED_UNSUPPORTED，不声称该SQLite版本的物理repack被接受。原37af候选的12成功/2失败CI及浮动1028项中10项失败保留；没有重标为PASS或靠删除检查取得绿色。

push检出beed；PR虚拟合并 `9acafdef9636527e7d6841bd32b5d33d7a0cbb6e` 的树与beed同为 `370398fdb22d2ccdde61fba4665d763629165074`。公开运行：[push core](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40617548016)、[push native](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40617547977)、[PR core](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40617553308)、[PR native](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40617553320)。

## IF10 源码绑定与独立审查

作者为实际Astra xhigh，冻结候选16文件/264706B，完整执行源码228文件；初始基底37af。Sol只把已审查的IF9三个文件无损快进到beed，IF10的16文件逐字节不变，执行源码仅受到父提交两个非Markdown文件的已审查变化影响。此处的快进是工作树父线整合，不是PR或main合并。

两位实际Astra max分别只读审查不可变副本。第一路发现的旧profile备份兼容与分项预算证明缺口已修复并返验；最终生产10文件及三份测试与作者006相同。第一路进一步核验最终成本脚本、四组原始结果与封存；第二路独立检查热冷精确语义、AAD、generation更替、PREPARED、恢复闭包与容量边界，均无剩余可定位P1/P2。审查没有代替测试或执行新成本实验。

| 不可变证据 | SHA256 |
| --- | --- |
| 冻结IF10合同 | f9c2ee8d2853bec4cfea3621e65b8593ecdb694e2423153bc6f0d17e7b637de1 |
| 作者final receipt | 502a949ed1f1414ce5ca80ed4dbb4ed4bfce5c1282ed410577b8a54cc2e3ea9b |
| 作者candidate manifest | 8bcab0ab035e1f1ed19c226d85dfeb102dc34ddff3b57d30681689aaf6fbd74e |
| 作者execution manifest | e0c3613542aa13800ab87de7cfd4d248d31a5fc9dee2c79c4f40d10e1ac6c15e |
| beed整合后独立execution manifest | 556af91418526310930b1ad81f4bc0cd038de5c164c982de9a74a9e7a86414ad |
| 独立whole/TS最终回执 | 5bcd64a2329f94a700606065bedc79f527065414cd8a3184d99e9234feb24e50 |
| IF9最终CI回执 | e24b70b6f59413b424d6980b6f1b8f63e0bb1cabaa0a4b382adf5ec4f1634952 |

作者封存、父线整合和Root后续Markdown状态更新是不同封存层；不能将后续文档数量冒充作者原16文件。源码和测试没有因状态文档更新而改变。精确文件清单、完整副本、旧blob/mode、patch和原始日志保留在原生TEMP，位置见本地ignored handoff。

## 验证层

| 层 | 实际结果与范围 |
| --- | --- |
| 作者005 | Node24.16.0和24.21.0各66/66专项，TS0 |
| 作者006最终代码 | 两runtime各22/22生命周期；原生affected228/228，TS0；未重跑005的完整66项 |
| 独立whole | Node24.16.0/SQLite3.53.0，required-supported，一次1098/1098，fail/cancel/skip/todo均0，exit0 |
| 独立strict TS | 一次--noEmit，exit0，stdout/stderr均空 |
| 源绑定 | 整合后228执行文件在whole、TS前后及最终回读一致，16个作者候选文件无漂移 |
| IF10提交CI、真实宿主、生产与训练 | NOT_RUN |

独立whole于2026-10-28 02:08:45.861Z开始，02:10:47.529Z结束，子进程121.6223239秒；TAP报告121.569627秒。TS随后运行2.3543413秒。原工具session70372外层exit0已由发起Sol恢复读取；额度中断没有触发重跑。whole stdout SHA256为 `0e277b788ea3c9cc44179a51b309a4cec6e36e89dc4608d04c1ad9faf42e057f`。测试前分别重新确认可用RAM和磁盘不少于1GiB，原生独立TEMP、单worker、仅合成数据。

原受限沙箱affected226/228的两个junction EPERM失败、初始成本脚本解析失败及全部原始日志保留。24.21冷段路径有正向专项验证，但没有在该runtime再跑独立whole；物理repack按实际门明确拒绝。8192压力用结构注入，不冒称8192次成功持久业务请求。各层数量不相加。

## 完整成本观察

`scripts/safety-cold-measure.mjs`计量成功的Node writeFileSync应用字节，fsync次数/时间另列；SQLite authority内部写入/fsync和物理设备IO为NOT_MEASURED。完整authority文件/sidecar extent是占用，不当成流量。进程peak RSS含多个重叠分量，SQLite自有RAM和staging分项峰值未独立测量，不将快照相加构造峰值。

同vault公开source更新采用循环尾部，比较端点完整Safety和精确Store image相等。尾部与维护没有新增业务内容，不能用零分母制造写放大比例；新历史canonical ingress JSON字节单独归一记录。P4总量包含升级、归档、boot、尾部和完整当前备份。

| 固定公开历史 / tail | 新历史JSON B | P3 tail+backup B | P4 maintenance+tail+backup B | P4−P3 B |
| --- | ---: | ---: | ---: | ---: |
| 2请求 / 24次 | 465 | 162318 | 294211 | +131893 |
| 混合12请求 / 24次 | 2872 | 171216 | 307829 | +136613 |
| 64终态 / 24次 | 14911 | 256589 | 373025 | +116436 |
| 另行预先固定256终态 / 64次 | 59647 | 1138223 | 881730 | −256493 |

前三组都是负收益，64终态的tail本身也未减少应用写入。之后Root才预先固定一个256条合法未reserve的claim→failed历史/64次tail；作者仅运行一次，58.727秒、exit0，无参数搜索、重试、限额放宽或旧三组重跑。

额外案例tail由1090548降至512891B，P4一次维护188603B；当前backup由47675增至180236B，串行实际保留磁盘由7647368增至8803530B，peak RSS159592KiB。所有旧代际、比较历史和备份保留。它支持特定历史与后续写入次数下的应用写入取舍，不支持总IO、RAM、CPU或普遍空间节省结论。归档继续显式执行，不自动启用。

## 保存位置与后续

公共文档只使用路径占位符：

- `%LOCALAPPDATA%\Temp\aemc-if10-author-final-20261028T020253518Z`：完整作者候选、源、旧证据索引和四组成本。
- `%LOCALAPPDATA%\Temp\aemc-if10-independent-20261028T020727392Z`：整合后源码、原始whole/TS、admission、最终独立回执和写权交回。
- `%LOCALAPPDATA%\Temp\aemc-if9-runtime-publication-20261028T015139240Z`：IF9发布、14项原始job日志与最终CI回执。
- `<IF10_WORKTREE>\.agents\handoff.md`：排除入库的精确本机路径、所有权和最新Root文档封存。

完整18项目标仍按4/4/6/3/1分类，完整训练前接受0项。下一个容量合同分别处理Store ingress、图/撤销/consumer引用闭包和authority永久PK/legacy索引的可信路由/切换；不能用TTL、Bloom-only或仅热区查询替代旧键精确判定。ARCH-1.0图及代码已单独接受；其在侧边continuity树的文档整合和历史治理文档审查属于另一交付层，不据此扩大IF10接受范围。

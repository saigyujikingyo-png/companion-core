# 当前验证状态

**WF2 当前入口：** [教师控制与小批验证记录](WF2-VALIDATION.md)分列源码/专项、本机721/722失败与定点修复、Windows rc3原生、公开探针与真实教师阴性。过期 high 准备未运行；HIGH2 和最终 medium 均已停止、合格0，工程 `PARTIAL`。跨平台结论以对应提交的 Actions 为准，以下历史快照保持原范围。

**2026-10-26，本批源码冻结 `05cbeeac9411af87081282ca43223d767eca09f3`。** 一次normal-user `npm run check` exit0：strict TypeScript、300/300 tests（0fail/skip）、七步合成回放、realModelCalls0；独立Astra63项及七runtime hash一致。[可移植证据](evidence/NATIVE-ACCEPTANCE.md#source-and-ci)记录source/result/log内容标识；这里未宣称远端三平台CI已通过。

[实际窗口原生接线](evidence/NATIVE-ACCEPTANCE.md#window-control) **WINDOW_CONTROL_WIRING_PASS**：完整Git tree snapshot、官方SDK、真实synthetic Node child；1条合成anchor/1次synthetic provider/1个nativecommit/completed ACK，realAPI0/noDPAPI。beforehuman拒绝calls0；grant60实际remaining约59994ms，新的commandId重复grant拒绝且expiry/generation不变；原输入保守观测+31009ms时observed=false、显式window/主动资格仍true。off/pause/resume不恢复window且calls仍1；child和outer均clean/noForce/owned0，child residual0。它不是自然主动触发、UI体验、M2恢复或本批生产部署PASS。

下文4e3f246的NO_TRIGGER与25cb0f8的M2两次恢复/部署保持原范围。新window source跨重启和真实模型自然主动未测；本批未部署生产，不把历史0/32当作当前用量。[学习设计](LEARNING-DESIGN.md)仅DESIGN_ONLY，无训练/自动清洗执行。


**上一主动交接源码冻结 `4e3f246b5a7f0ce7ecbae9b8822d687096aa779b`（历史切片）。** 本轮源码、zero投递机制和真实自然试验分别记载；自然触发结论为NO_TRIGGER，未部署新源码。下表保留的`25cb0f8` M2两次恢复/部署证据不能替代新源码跨重启验收。其后各节保留历史快照，其中“最新”“未实现”“NOT_RUN”、测试数量和 RAM 限制只适用于各节当时的版本，不覆盖本表。[M2a 合同与限制](M2-DURABLE.md)和[协调证据](evidence/NATIVE-ACCEPTANCE.md#m2-repaired-three-call)分别记录源码机制与实际运行。

| 层级 | 当前接受范围 |
|---|---|
| 4e3f246源码与合成校验 | `4e3f246`作者`npm run check` PASS：strict TypeScript、272/272 tests（0 fail/skip）、七步合成回放；Node24.16.0 / SQLite3.53.0，真实模型调用0、生产数据false。独立Astra max 39项定向检查与五runtime哈希核对PASS。此前一次whole输出截断保留UNKNOWN；此处引用Root授权、完整留存的证据恢复重跑。272项仍含`KNOWN_UNPROTECTED_LEDGER_ROLLBACK`已知负例，不是回滚防护PASS。 |
| 主动投递/前台交接源码 | ready有界保留到原生commit/completed end及core ACK落定，再在原租约内等待SDK `whenIdle()`；新输入/暂停/撤销/过期使旧权限失效。最新鲜人类输入成功ACK后才启用调度，不新增presence；前台按原到期时间等待实际逻辑工作和raw permits清空，拒绝时不领取入站或额度，不轮询/重试。见[DSH合同](DSH-COUPLED.md)、[stdio合同](COUPLED-STDIO.md)。 |
| 实际SDK零真实API投递 | [SDK零API投递摘要](evidence/NATIVE-ACCEPTANCE.md#proactive-zero)为`ZERO_NATIVE_DELIVERY_PASS`：actual SDK native-user1/provider-request1/prepared-consume1，ready排队，首次ACK前重复同readyID仍只消费一次；assistant-commit2/delivery-ack2。realAPI0、synthetic responses2，fixture不构造真实core/memory/HTTP；disposed/closed，outer exit0/noForce/owned0。custom-source分支由实际prepared-consume支持，技术notice的UI可见性未验证。 |
| 真实自然时间试验 | [自然试验摘要](evidence/NATIVE-ACCEPTANCE.md#proactive-natural)：新源码fresh M2单次boot，约120秒内5次合成自述的真实API请求全部native commit/completed ACK，reserve5/6、ingress5、unknown0，prepared/proactive ACK0。暂停后同RPC重复保持calls5、0新native user/turn。install/inner/outer均exit0/noForce/owned0，output drained、raw permits全false。结果NO_TRIGGER为有效阴性，不是运输失败或自然主动闭环PASS；第6次封存、不重试/退款。 |
| 时序解释与未测范围 | [条件分析](evidence/NATIVE-ACCEPTANCE.md#proactive-natural)：末态affiliation约.37143、target约.74344；若target保持，按60秒时常推算约138.8秒达.60，而最后原生lease约110秒结束。仅为条件估算，未延长实测，也不证明届时必触发或内部没有shadow intent。新源码跨重启、自然主动送达、通知UI和真实用户体验未验收；生产未更新，既有proactive配置false，当前生产calls未重读。 |
| 历史M2源码校验 | `25cb0f8`当时`npm run check` PASS：strict TypeScript、241/241 tests（0 fail/skip）、七步合成回放；独立Astra max八项定向返验通过。以下M2原生与部署行保留该冻结阶段证据。 |
| FTS5 修复 | 独立合成完整多回合/恢复/撤销序列红绿复现了 RAM COMMIT 前序列化遗漏 FTS5 xSync 的缺陷；现为 RAM COMMIT→完整图像序列化→AEAD检查点fsync→独立安全账本FULL提交→对外成功。不确定失败封锁 store/vault；已知损坏检查点不会自动修复或接受。原native失败库封存未解密，原始固定错误码未留，不把独立复现当作原库直接诊断。 |
| 原 `newcap8` 真实有限链路 | A/B/C/D四次真实DeepSeek请求均native ACK；state prior和旧A召回分数1→1.5366496366、明确反馈由下一输入消费、暂停拒绝、首次恢复召回及SDK重复RPC抑制有局部证据。撤销后第二次恢复FAIL、E未发；原链保留PARTIAL，不补写完整PASS。 |
| 修复后零请求原生检查 | [修复后零请求摘要](evidence/NATIVE-ACCEPTANCE.md#m2-repaired-three-call)：独立新vault、0 API凭据/0模型调用，仍使用独立memory key；内外进程exit0、owned residual0、无强杀。不是旧vault恢复或真实模型链路PASS。 |
| 修复后真实cap3 | [修复后三请求摘要](evidence/NATIVE-ACCEPTANCE.md#m2-repaired-three-call)为 `PASS_REPAIRED_NATIVE_THREE_CALL_PROOF`：独立新vault的A/B/C三次真实请求均native ACK且appraisal applied；两次恢复默认暂停、保留calls1/2，三个binding不同。B召回A anchor分数1→1.1997564545；撤销后C的recalled/conditioning/background refs均排除A事件和anchor。三次inner/outer均clean exit0/noForce/owned0/drained；一次退出保留`lastErrorCode:UNCLASSIFIED`诊断，不宣称全程无错。原4+新3=7/aggregate8，不退款、不重试；`originalChainContinuity:false`。 |
| 此前有限个人试用部署 | [部署摘要](evidence/NATIVE-ACCEPTANCE.md#m2-desktop)：`PASS_M2_DESKTOP_RESIDENT_READY_UI_CONTROL_PENDING`。bootstrap真实create+flush后clean unload，最终同vault/identity以resume-only原生READY；回执当时0/32、baseline、paused/unavailable，无生产prompt，旧及bootstrap子进程全退出、DSH主进程未重启。direct inspect.restored字段未采集、完整desktop重启未测；该阶段新菜单点击/聊天输入框绑定待确认，旧OPEN/CONTROL_PASS不替代该UI验收。M2+flywire原生组合本轮未测；[用法与外部脚本依赖](evidence/NATIVE-ACCEPTANCE.md#m2-desktop)单列。 |

`requestAudit` 的 body hash、refs/ranks/scores 是本地实际请求准备证据，不是独立远端回执或交流质量评测；native ACK也不证明用户已读、自然互动质量或情感效果。此前M2原生批次使用合成文字通过真实模型/宿主，`enableProactive:false`；本批window接线另用synthetic child，不把它当自然主动投递。恢复会重置背景/神经状态和待消费反馈，不是永久情感或意识。16MiB整库图像、256MiB检查点历史及4096次commit等边界、无备份迁移和有效前缀账本回滚风险见M2a合同；十年可靠性和长期规模仍未验收。

# 历史：0.1 初始切片验证

**最新背景状态切片（2026-10-25）：** 完整 `npm run check` 退出0，strict typecheck、94/94测试（无跳过）和七步合成回放通过。包含原76项和新增18项；schema1、Node24.16.0/SQLite3.53.0，回放库为TEMP `companion-core-replay-aylJOL`。原生API/Codex没有新增调用，下文各阶段历史证据继续保留。新来源API只读，不改变既有存储入口行为。

独立Astra max对冻结版本复跑18/18，并执行185.5ms纯内存边界探针：根事件多次发布/再提炼/重叠引用不能重复刺激；15,000ms起拒绝appraisal，调用前过期不启动evaluator；非合作raw promise跨reset保留许可；context/consent ABA、purge和来源到期拒绝旧结果。分段与单次推进最大latent差1.11e-16、nextWake差1.46e-11ms；精确阈值无重复意图。两个P2（派生来源重放和无新事件时迟到解释）均关闭，无新P1/P2。

真实时钟的有限120秒对照已执行，使用独立临时合成库、两进程部分时间重叠：事件模式1次调度检查、1个影子意图，进程CPU 47ms；10Hz模式1,144次检查、1个影子意图，进程CPU 1,844ms。事件模式RSS64,114,688bytes，tick69,029,888bytes；这不是模型内存净增量或电能。原始结果TEMP `companion-background-state-UbhToA/result.json`（SHA256 68341f6da33904c03dc4b63339bba869be183ce7befc4e9f6eb6e335eec1baca）和 `companion-background-state-QfHFwX/result.json`（1e0769ad0ebbb495e45ec2d50c63b4f6f7cda1abac09a355ce5f0a13f4deebc1）均由Root重新读取并核对源hash。没有真实模型/发言/GPU调用，过程退出0。首次应用沙箱试跑也退出0，但沙箱临时产物之后不可访问，故不将其作为可重新核验的保存证据；随后相同源码在普通用户TEMP重跑并保留上述文件。

有限功耗实验另在同级维护研究目录 `2026-10-25-background-state`。10个条件在535.406秒内完成，4组CPU/CUDA调度状态parity通过；GPU能量有读数但全部差异INCONCLUSIVE，CPU计数在该次因元数据解析问题NOT_MEASURED。不能把本节的调度次数或CPU时间当作省电百分比。真实连接组算子仍是独立实验，未与此状态层在线连接；物理睡眠恢复、全天常驻、真实交互质量、跨重启状态和十年记忆仍未验收。

核心验收SHA256：background-state `141681d77b66418f54f0d779288a3f52bde2e57c9227d28d9df382c5fcf7089f`；store `bd76459ddb0b782f7b764e865c0be876225a1440877da3cfda4f952f3ad6740c`；probe `3831ed176d59b41caecd45d8e86092af0a000f8747942ffed45903d5f9569b80`。旧三份neural执行源码hash未变，未重复训练。

日期：2026-10-25。范围为 Windows 本机临时 SQLite / 合成身份与文字，不包含生产、真实模型或社交交付。

| 检查 | 实际结果 |
|---|---|
| 固定开发依赖安装 | TypeScript 5.9.3、@types/node 24.19.2；禁用安装脚本；npm报告0漏洞（仅该时点） |
| `npm run typecheck` | PASS，strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes |
| `npm test` | 24/24 PASS，无跳过；实际文件库、中文空格临时路径 |
| `npm run demo` | PASS_SYNTHETIC_REPLAY；7步事件→发布→召回→清空→旧工作拒绝 |
| 运行版本 | Node v24.16.0，SQLite 3.53.0，schema 1；integrity/foreign_key 检查通过 |
| Astra max 独立审查 | 3个发现均修复；纯内存独立返验3/3通过 |
| Sol 6.1 独立审查 | 四项发现已闭环；纯内存返验投影消费/晚到确认/激活重试/历史asOf通过，未知库和查询修复已核对 |
| CI | 已配置 Windows/Linux/macOS + Linux Node24更新哨兵；未创建远端、未执行 hosted CI |
| 真实宿主/云API/本地模型/神经回路 | NOT_RUN |
| 物理断电、文件系统故障、十年运行与大规模性能 | NOT_RUN |

## 关键反例

覆盖 scope 清空后旧租约与离线重放；到期相等边界；接管/重开库/时钟回拨；来源更正；助手和转述者归属；跨租户来源隔离；菱形依赖撤销；提交回执重试；outbox中途SQL失败回滚；510条较新事件不截断早期召回；异步模型迟到；取消不发布；许可ABA；父检查点来源继承；旧模型运行票据失效；未来/未知/被改动数据库拒绝；祖先有效时间；推断不能升级自述；100项投影消费；注册/激活幂等；FTS5影子表清除。

SQL触发器注入是事务失败测试，不是实际断电证明。24项通过也不代表自动提取语义准确、跨设备 exactly-once 或权重遗忘已经成立。

## 审查收敛

Sol 指出投影先限100后过滤会饿死后续项，且无消费确认；实现改为upsert/remove + ack，并覆盖101个过期项后的有效记录。激活同一产物不再反复增加runtimeEpoch；未知库识别先于WAL修改；查询改为逐项读取及只读事务。

Astra 指出观察basis的belief可被提升为事实、有效期跨界不重新投影、SQLite普通secure_delete无法清除FTS5旧segment。已加强kind/basis不变量、增加时间变化delta、开启FTS5自身secure-delete并直接测试影子块。Astra最终返验store.ts SHA-256：`be457e54defd8f095916270603bf264f0785c7188276cb1baed6c97f33d664c2`。

## 明确待补

M1 后续：部署层认证、完整宿主回合与原生中断确认、真实模型及实际交付前逐块校验；已完成的 M1 切片见下表。M2：生产加密与恢复、独立撤销账本、迁移、十年规模性能。当前学习注册表仅证明metadata fence，不证明外部worker诚实执行manifest或模型已卸载。

## M1 增量验证（2026-10-25）

| 检查 | 实际结果 |
|---|---|
| 完整 `npm run check` | PASS：strict typecheck、51/51 tests、7步 demo；包含原24项不变回归 |
| 独立审查后 HTTP 修复 | typecheck PASS；HTTP focused 13/13 PASS，含新增第52/53项非合作 response.cancel 与合法null占位反例；其余40项复用上行未改动证据 |
| JSON schema 文件 | 三份 JSON 解析、元数据与 NUL 文本正则检查 PASS；未安装第三方 JSON Schema compiler；运行时验证由对抗测试覆盖 |
| schema 1 兼容 | `src/schema.ts` 无修改；持久提取幂等与取消均复用 jobs 字段，无新增表/迁移 |
| DSH 原生输入挂载 | 主代理独立实测 PASS：0.2.1-rc.2，Node24.21.0/SQLite3.53.4；真实hook/append→发布召回、同消息不同日志位置幂等、卸载取消和移除订阅；真实模型调用0。最终记录为同级维护仓 evidence/core-m1-native/880e1039-bb09-4413-9806-10e2a4317f99.json；传输时间强制变化另由离线测试覆盖 |
| Codex app-server | 0.164.0-alpha.11.1 本地导出schema核对、initialize-only探针及黄金通知映射；完整真实回合 NOT_RUN |
| HTTP | 实际127.0.0.1随机端口：请求结构、显式合成key、错误status/content/size/JSON、截断/refusal、socket/body deadline、实际取消、拒绝redirect、DeepSeek JSON profile PASS |
| 真实云API/真实本地模型/神经worker | NOT_RUN；fixture、fetch注入和loopback不替代真实模型验收 |

新增边界包括：不合作provider立即取消和晚到结果丢弃；deadline定时器饥饿；falsy rejection与非法proposal终结；旧worker无权清理新lease；有界排队/活动槽保留；版本/字段/身份注入拒绝；旧绑定在purge或consent ABA后失效；持久operation并发/重启/失败幂等；同ID新传输time仍幂等；失败操作不被重新绑定或consent ABA复活；DeepSeek空final不采用reasoning_content替代。

独立 Astra max 审查复现的 HTTP response.cancel 永不结束问题已修复：坏状态、坏content-type、超限Content-Length以及读取中取消四路径均等待底层清理真实结束才释放运输槽；调用方仍由外层deadline/abort立即收敛。每条路径连续5次调用只启动2次fetch、保留2个未完成cancel。

另一项合法 OpenAI 文本响应含 function_call:null/audio:null 的兼容问题已修复，只对明确 OpenAI profile 接受这两个已知 null 占位；非 null 工具/音频与未知 metadata 仍拒绝。提供方协议差异不触发自动降级。

普通 Windows 沙箱的回环fetch返回 EACCES；已诊断最小createServer+fetch并通过单次权限审查运行合成loopback和完整check。没有公网监听、真实模型调用、环境凭据读取或用户配置修改。详见 [M1 合同](M1-ADAPTERS.md)。

## M1 与本地神经策略最终整合（2026-10-25）

最终 `npm run check` 退出 0：strict typecheck、**66/66 tests PASS，无跳过**、七步 `PASS_SYNTHETIC_REPLAY`；Node24.16.0 / SQLite3.53.0 / schema1，integrity 和 foreign-key 检查通过。包含原24项、M1新增29项、本地神经策略13项。临时数据库位于系统 TEMP，真实模型调用0；没有变更 schema、增加依赖或修改旧插件。

神经策略覆盖四种 mode 分离、精确工作负载及父检查点摘要、硬件/runtime/provider/驱动变化、证据期限、实际设备归属、显式CPU分区、资源预算、学习许可和来源失效。独立 Astra max 审查发现 backward 成功而 update 失败仍可选择训练的缺口；已要求三种学习 mode 均有完整参数更新 PASS，梯度训练还需 backward PASS，新增两个 mode × 四种未通过 update 状态的八个反例。

独立返验八个负例和三个正例全部通过；审查前后 policy SHA256 均为 `e7041be3e0dbd3fb8aecffbcb4163830a7db282ffc4b0f9e3d1330f219720d8d`。本轮发现的两个 HTTP P2 和一个神经策略 P2 均已修复并经独立返验关闭。

以上是能力策略的合成证据验收，**没有设备探测、NPU/GPU 原生执行、果蝇神经仿真或训练性能结果**。默认本地小回路；具体能力和预算须由后续受信 runtime 实测。硬件策略详见 [本地回路策略](NEURAL-LOCAL-POLICY.md)。DSH 原生输入局部证据复用上述最终 UUID 记录，九个被测源文件哈希均未变化；不因新增独立策略模块重复运行宿主。
# 2026-10-25 Codex native slice and language preservation

**Final update:** after the later audit fixes and explicit additional one-turn authorization, `companion-codex-native-AQT9vg` passed the reviewed completion-only native test, including actual completed/42, memory publication/recall, native duplicate replay and full-stream transport/zero-tool checks. Offline `companion-codex-verified-lhSQQr` independently passed fixed source snapshots and memory-backup verification with zero new calls. Total real native requests across the retained attempts: three (two completed, one interrupted). Root's final full `npm run check` passed strict typecheck, **76/76 tests**, no skips, and seven-step replay at TEMP `companion-core-replay-OidUZI`. No TypeScript code changed after this check. The paragraphs below preserve earlier stages and are superseded by this final update where they say the repaired completion path has not run.

**Neural lab final update:** frozen Python source at local commit1d93629 completed actual run20261025T164817Z-d3d04a6f with exit0, four CUDA modes,3seeds×2training modes×4conditions=24, and six exact workload probes. CPU8/8 tests and two independent read-only reviews passed. Root's offline bridge verified102 artifact hashes and all six Python/TS workload hashes, checkpoint bytes/parent identities and permission/lineage/expiry counterexamples. Astra max additionally checked48 training checkpoint files and recomputed all aggregate rows; no new P1/P2. Real graph mean accuracy0.75±0.25, no-circuit1.00; no biological or BPTT accuracy advantage established. Prior reload FAIL and resource-gate refusal are retained. Physical NPU absent. This is a research CLI on public graph/synthetic stimuli, not an online NeuralAdapter, LLM fine-tune, personal-data training or complete M4 delivery; see [M4 lab](M4-NEURAL-LAB.md).

See [Codex native acceptance](CODEX-NATIVE-ACCEPTANCE.md) for exact evidence paths and limits. One actual gpt-6.1-sol completed turn plus native user-item to synthetic memory publication/recall is verified by the retained original run and an independent read-only postflight. A separate interrupt-only run verifies a matching interrupted terminal and observed exit0. Exactly two real turn requests; no production data. The original reports lack complete stdout-drain evidence, so full-stream zero-tool/no-approval claims are NOT_ACCEPTED. The first combined runner remains FAIL due to its post-completion replay; native duplicate replay and the repaired combined runner were not rerun or accepted.

Added six offline Codex lifecycle/mount tests. Full npm run check passed strict TypeScript, 72/72 tests (no skips), and the seven-step synthetic replay on Node24.16.0/SQLite3.53.0/schema1. The restricted app sandbox blocks loopback fetch; the successful complete check used the established approved normal-user route. Subsequent runner-only changes also passed typecheck; final focused mount coverage checks extra native metadata projection without relaxing core wire validation.

The HTTP prompt now preserves the source language, entities and key terms following Root's real Chinese-to-English extraction finding. Root's second independent DeepSeek call passed Chinese recall, duplicate-no-second-call and purge/old-binding rejection on that exact HTTP source hash. No schema/store changes.

Read-only review found that the runner initially inferred zero tools from a 512-entry bounded trace. Whole-stream counters fixed that limit, but the old short traces could not prove stdout drainage, and the initial counter-based verifier failed to gate transport errors. The current runner emits versioned close/exit/buffer/fatal audit fields; the verifier pins source hashes plus source snapshots and requires a complete consistent audit before granting zero-tool/no-approval PASS. Legacy records retain only positive completed-turn/memory and observed-interrupted facts; the new postflight is PARTIAL with zeroToolStatus NOT_ACCEPTED. Ten focused tests now pass, including misleading zero counters with protocol failure or missing close, and completion-only's enforced one-turn/no-interrupt budget. Typecheck and diff checks pass. Original evidence remains unchanged; no new native call or real turn was issued for these fixes. Completion-only is prepared for Root's review and an additional explicit one-turn authorization.

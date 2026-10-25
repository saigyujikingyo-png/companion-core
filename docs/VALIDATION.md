# 0.1 初始切片验证

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

See [Codex native acceptance](CODEX-NATIVE-ACCEPTANCE.md) for exact evidence paths and limits. One actual gpt-6.1-sol completed turn plus native user-item to synthetic memory publication/recall is verified by the retained original run and an independent read-only postflight. A separate interrupt-only run verifies a matching interrupted terminal and observed exit0. Exactly two real turn requests; no production data. The original reports lack complete stdout-drain evidence, so full-stream zero-tool/no-approval claims are NOT_ACCEPTED. The first combined runner remains FAIL due to its post-completion replay; native duplicate replay and the repaired combined runner were not rerun or accepted.

Added six offline Codex lifecycle/mount tests. Full npm run check passed strict TypeScript, 72/72 tests (no skips), and the seven-step synthetic replay on Node24.16.0/SQLite3.53.0/schema1. The restricted app sandbox blocks loopback fetch; the successful complete check used the established approved normal-user route. Subsequent runner-only changes also passed typecheck; final focused mount coverage checks extra native metadata projection without relaxing core wire validation.

The HTTP prompt now preserves the source language, entities and key terms following Root's real Chinese-to-English extraction finding. Root's second independent DeepSeek call passed Chinese recall, duplicate-no-second-call and purge/old-binding rejection on that exact HTTP source hash. No schema/store changes.

Read-only review found that the runner initially inferred zero tools from a 512-entry bounded trace. Whole-stream counters fixed that limit, but the old short traces could not prove stdout drainage, and the initial counter-based verifier failed to gate transport errors. The current runner emits versioned close/exit/buffer/fatal audit fields; the verifier pins source hashes plus source snapshots and requires a complete consistent audit before granting zero-tool/no-approval PASS. Legacy records retain only positive completed-turn/memory and observed-interrupted facts; the new postflight is PARTIAL with zeroToolStatus NOT_ACCEPTED. Ten focused tests now pass, including misleading zero counters with protocol failure or missing close, and completion-only's enforced one-turn/no-interrupt budget. Typecheck and diff checks pass. Original evidence remains unchanged; no new native call or real turn was issued for these fixes. Completion-only is prepared for Root's review and an additional explicit one-turn authorization.

# M1：受信宿主与有界推理

2026-10-25。本切片实现跨宿主精选文字输入、持久提取幂等、快速本地取消和共用 HTTP 推理。它没有启动公网服务、读取环境凭据、调用付费模型或迁移真实记录。数据库仍为 schema 1，初始 `SCHEMA_SQL` 未更改。

## 身份和 JSON 边界

`HostMemoryService.bind` 是受信控制面：宿主完成会话认证、本人输入确认和证据选择授权后，提供 `identity`、`host`、稳定的 `hostInstanceId` 及 `sessionId`。返回的对象能力由服务内部 WeakMap 验证；JSON 克隆、猜测 ID 或另一服务的能力均不被接受。调用方不能把网络上的自报身份交给 bind。当前没有对外 HTTP/MCP 认证服务器。

绑定冻结 scope 的 generation/consentRevision，speaker 始终由绑定主体产生。消息不能传入 scope、speaker、epoch、provider endpoint 或 key。清空/许可改变后旧绑定报错；只有受信控制面可以重新认证和绑定。解绑立即取消该绑定未完成的工作。

外部消息必须是 UTF-8 上限 65536 字节的版本 1 JSON，根字段为 `version`、`operation: extract_memory`、`event`；未知字段和版本均拒绝。`schemas/` 保存 JSON Schema，`wire.ts` 为无依赖运行时验证器。除 schema 外，运行时还校验固定 session、拼接后的文本最多 4096 UTF-16 code units、safe integer、候选有效时间顺序和来源权限。`negotiate` 仅声明 selected_text、local_cancel、bounded_queue；不声明原生宿主中断已接通。

传输层必须把一个已经认证的连接绑定到一个能力对象。能力不能序列化后作为认证 token 使用。`MemoryStore` 与 `bind` 仍是进程内受信 API；本切片不是完整远程认证系统。

## 两个薄映射

| 输入 | 接受的精选文字子集 | 明确拒绝 |
|---|---|---|
| DSH `session/event` | `user/message`、`surfaceOp: append`、直接位于 data 的 `role: user` message、`source.kind: user`、原生 message.id | inbox 排队回执、替换副本、runtime-context、assistant、非文字块 |
| Codex app-server `item/completed` | 绑定 thread 的 `userMessage`，稳定 item.id，text content，空或缺省 text_elements | agentMessage、流式 delta、非空文本引用、非文字块 |

DSH `event.time` 和 Codex `completedAtMs` 是提交/完成时间，不等于本人话语发生时间。两个映射均填 `occurredAt: null`。重送相同 message/item ID 时，新的 seq 或传输时间不会造成正文冲突。source.kind/principal/userMessage 标签本身不证明真实人类身份，证据授权责任仍在受信 bridge。

`mountDshHost` 提供真实 `ctx.on('session/event', callback)` 的结构化挂载接口；只观察指定 session，卸载会移除回调并解绑。此模块不导入、启动 DSH 或模型。Codex 目前是通知 JSON 的薄映射，没有启动新 app-server 会话。黄金 fixture 位于 `test/fixtures/hosts-v1.json`，两者走相同 store、提取和发布流程。

原生中断必须另行验收：Codex `turn/interrupt` 请求需要 threadId + turnId；空 result 只说明请求被接受，`turn/completed` 的 interrupted 才是回合结束证据。DSH 也必须观察相应 aborted 终态。本地 AbortSignal 收敛不能充当这些确认。

## 幂等、失败和背压

稳定入站键来自可信 host-instance namespace、原生 session 和 message/item ID。`beginSelectedExtraction` 使用库内 HMAC 为固定 selected-v1 policy + 权威 source revision 产生持久 job ID，复用 schema 1 的 jobs 表。正文变更但复用同一个入站键仍报 IDEMPOTENCY_CONFLICT。

同一已发布事件的重复调用返回原回执；并发重复报 EXTRACTION_IN_PROGRESS；取消/失败后报 EXTRACTION_TERMINATED。显式重新绑定或许可 ABA 也不会重新执行同一失败来源。已发布记忆后来被单独撤销时，重复提取返回 revoked 回执。崩溃遗留 pending 不由普通重传自动接管；恢复控制面和人工确认流程属于后续工作。这一取舍确保不静默重放已消费操作。

`extractMemory` 默认 30 秒 deadline，允许显式 1–300000 ms。等待模型槽位包含在 deadline 中；提供方忽略 signal 时调用方仍立即收敛。失败 job 通过原 epoch + owner/token 条件更新为 revoked 并清 draft/lease，旧 worker 无权终止接管后的租约。晚到 resolve/reject 都被消费，不进入 propose/publish。

宿主默认最多 2 个活动推理、8 个等待项，可受信配置至 1–32 / 0–256。已取消而未真正结束的提供方仍占活动槽；排队取消移除等待项。耗尽时 BACKPRESSURE，不创建无限后台请求。HTTP 适配器还独立限制底层 fetch 为 2/8，防止注入的 fetch 忽略取消。响应体清理也占用运输槽，直到 cancel Promise 真正结束；坏响应头同样遵守此边界。永久挂起会保留占用，恢复需替换/关闭失效 provider；本切片没有终止外部进程或证明远端算力已释放。

## 云与本地 HTTP

`HttpInferenceAdapter` 共用三种显式协议：companion-json-v1（请求 version/model/selectedEvidence，响应 version/proposal）、openai-chat-completions（非流式 JSON Schema 输出）与 deepseek-chat-json（JSON object 模式）。模型名和完整端点仅由受信配置指定；没有端点发现、失败重试、降级、备用模型或自动下载。

DeepSeek profile 显式发送 response_format: json_object、thinking: disabled 和 max_tokens: 2048，并在提示词中给出 JSON schema 与格式范例；最终 content 仍需本地严格验证。可选 reasoning_content 仅接受 string/null 后忽略，不保存、日志或作为空 content 的替代。空内容与截断均失败，不自动重试。请求字段依据 2026-10-25 查阅的 [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 和 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)；只有回环 fixture 测试，真实 API 未调用。

本地模式只允许 `http://127.0.0.1` 或 `http://[::1]` 字面回环地址；云模式要求 HTTPS 和构造时显式注入的内存 key。拒绝 URL 内凭据、query、fragment；没有 `.env` 或用户凭据读取。请求拒绝重定向。测试里的 key 是固定合成字符串。

deadline 覆盖连接、响应头和响应体。只接受 HTTP 200 + application/json；Content-Length 与实际读取字节均受限，默认 64 KiB，配置上限 1 MiB。解析采用严格 UTF-8，不提取 Markdown 中 JSON、不容忍未知字段、不接受不完整 finish_reason、工具调用或 refusal。OpenAI profile 接受已知 function_call:null/audio:null 占位，非 null 功能输出仍拒绝。候选再次通过 kind/basis/TTL 和 store 的来源链验证。结构合规不证明提取语义正确。

公开错误必须使用 `publicError` 映射至固定类别，不能透传原始 SQLite/提供方异常。常规实现不记录请求正文、响应正文或 authorization header。

## 验收分层

M1 运行时边界/黄金 fixture 与真实回环 HTTP 有自动测试；原 M0 24 项回归保留。回环测试只绑定随机本地端口，不连接公网或真实模型。Windows 普通沙箱阻止回环 fetch 并返回 EACCES；已通过单次权限审查在沙箱外运行这些合成测试。

主代理对 DSH 0.2.1-rc.2 完成独立原生 hook/session.append 探针：Node 24.21.0 / SQLite 3.53.4，发布召回、同消息不同日志位置的重复幂等、卸载取消和移除订阅通过，真实模型调用 0。最终证据位于同级维护仓 `evidence/core-m1-native/880e1039-bb09-4413-9806-10e2a4317f99.json`，九个源码摘要与验收版本一致；强制改变传输时间另由离线回归覆盖。探针阻止 global fetch，不声称 OS 级断网。首轮失败与较早 PASS 的限制保留在该目录 README。

Codex 通知 shape 核对本机 codex-cli 0.164.0-alpha.11.1 导出 schema；同级维护仓 `evidence/host-protocol-probes/codex-probe-result.json` 保留 initialize-only 探针及 320 文件 manifest，`codex-schema/v2/ItemCompletedNotification.json` 是 item 形状入口。Codex 完整会话、真实云 API、真实本地模型、宿主中断确认、神经模块、流式 TTS/输出逐块 fence、生产加密和恢复均未由这些测试证明。生产数据门槛仍是 M2。

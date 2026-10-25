# v0.1 核心契约

状态：内部 TypeScript 合同、运行时验证及 M1 JSON Schema/受信绑定/薄映射已实现，详见 [M1 适配合同](M1-ADAPTERS.md)。协议版本为 1，当前不是面向公网的 SDK；网络会话认证仍由宿主负责。

## 权威和信任

每个数据库一个权威服务，worker 通过适配层领取任务，不能直接读写 SQLite。所有正式变更使用 `BEGIN IMMEDIATE`；查询使用一致性读事务。数据库只保存调用者选择的最小证据。scope 不等于认证凭据，服务端必须从已验证会话构造 scope 和 speaker，不能照抄外部消息的自报身份。

`ensureScope` 对四维身份幂等并保留删除代际。创建 scope 默认禁止学习。事件携带采集时已分配的 scope generation/consentRevision；离线重传不得重新盖当前代际。入站键是 `(source, stable source event key)`，不是重试包装生成的新 UUID。篡改键且重新标注当前代际的恶意宿主不是本层可辨认的事件。

## 写入顺序

1. `acceptEvent(epoch, input)`：规范化有限长度文字、来源与发生时间。未知发生时间为 null。重复键同正文返回既有回执，不同正文报 `IDEMPOTENCY_CONFLICT`。
2. `beginJob(epoch, refs)`：从权威库冻结依赖，在任何异步模型调用之前执行；其返回值不是允许 worker 随意刷新 revision 的凭据。
3. `claimLease` → `jobEvidence`：opaque token、单调时间截止。重领 token 改变且清掉旧 draft。新服务实例不能继承旧实例的 lease。
4. `propose`：验证候选类别、basis、说话者来源链、有效时间；同一次租约 draft 不允许被改写。推断只能是 belief，belief 必须有 TTL。
5. `publish`：事务中重新检查 scope、许可版本、全部来源 revision、有效期、租约 owner/token/deadline；写正式记录、依赖、FTS、outbox 和提交回执。

业务确认点为事务 commit。SQLite 异常直接传播；不返回虚假的“记住了”。同 token 在响应丢失后重试可取得同一回执；源已撤销则回执 `currentStatus=revoked`。旧 epoch 在清空后先返回 `STALE_SCOPE`，客户端刷新后只能查询历史失效回执，不可重新提交旧事实。

回执中的 active 表示该记录尚未撤销，不代表在当前时刻适用；有效期与祖先当前状态必须通过 `read` 检查后才能用于回应。注册回执 active 也不代表模型已经加载或激活。

`reviseEvent` 表示纠正源证据，失效全部旧派生；它不是“一律最新偏好覆盖”。条件并存、自然变化与历史误报的完整 schema/用户交互属于 M2；首版禁止以此接口伪称已经实现完整冲突解释。

## 查询与投影

`read/search` 在 scope 和 asOf 下检验来源 DAG；asOf 默认现在，显式过去时刻可读当时有效的状态。撤销不是普通到期：已撤销内容对过去查询也不重新开放。当前召回是 FTS phrase 与字面子串，按时间稳定排序，未实现语义排序。

`projectionBatch` 返回最多 100 个当前 upsert/remove，消费者执行后调用 `acknowledgeProjection`。重复交付必须幂等；消费者还应周期调用以处理未来生效/到期。每个命中在用于模型上下文前必须再经 `read`，不能直接信任外部索引。晚到 upsert 的确认被撤销挡住，但本层不能阻止不遵守协议的外部索引写入；下一条 remove 和读侧验证共同收敛。

当前时间变化刷新扫描当前 scope 的活动记忆。它是正确性基线，不是百万记录性能方案；M2 将改为有效期调度表并测试大规模 DAG、慢查询、磁盘不足。全文子串也可能扫描全 scope，不能把 `limit=20` 当十年规模延迟保证。

## 学习与运行代际

`setLearningConsent` 修改布尔值同时增加持久 consentRevision，true→false→true 不复活旧任务；已有显式记忆仍可检索。训练 job 使用同一来源冻结和租约合同。`beginJob(...,'training',parentArtifactId)` 将父产物来源合入 manifest，继承污染不能通过只报新增数据隐藏。

`registerArtifact` 记录内容哈希及实现标识，并不验证训练文件内容或自动加载；真实 worker 必须证明产物和 manifest 相符。随后 `activateArtifact` 检查来源与许可，同产物重试幂等。`beginRun` 颁发运行代际；源更正/撤销、清空、许可变化或切换产物使旧票据失效。

`validateRun` 是一次检查，**不是永久通行证**。未来媒体/流式桥必须在每块输出实际交付时检查，并在撤销时停止队列、等待取消确认；当前尚未实现声音队列和模型卸载。参考实验仅通过注册表测试，不能报告模型已完成遗忘。

## 稳定错误类别

| 类别 | 典型 code | 处理 |
|---|---|---|
| 旧工作 | STALE_SCOPE / STALE_CONSENT / STALE_SOURCE / STALE_RUN | 丢弃旧结果，重新取得已授权当前状态 |
| 租约 | LEASE_BUSY / LEASE_EXPIRED / LEASE_LOST | 不用旧 token 强行重试；必要时新领取并重算 |
| 幂等/候选 | IDEMPOTENCY_CONFLICT / DRAFT_IMMUTABLE / SPEAKER_MISMATCH | 隔离输入，不猜测原意 |
| 学习 | LEARNING_NOT_ALLOWED / ARTIFACT_REVOKED | 保持停用 |
| 数据库 | UNSUPPORTED_SCHEMA / UNKNOWN_DATABASE / SCHEMA_MISMATCH | 不自动重建、迁移或覆盖原库 |
| 基础设施 | 原始 SQLite/IO 错误 | 当前仅内部接口；服务化时转结构化错误，不回显用户正文 |

枚举值不含用户文本。M1 提供公开错误 schema、固定绑定与有界推理队列；部署层额度、远程会话认证仍待接入。代理的自然语言和媒体描述都是待验证数据，不能成为系统指令。

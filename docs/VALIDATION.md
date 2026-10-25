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

M1：认证/JSON边界、超时与取消即刻收敛、失败job终结、实际宿主/模型适配、实际交付前逐块校验。M2：生产加密与恢复、独立撤销账本、迁移、十年规模性能。当前学习注册表仅证明metadata fence，不证明外部worker诚实执行manifest或模型已卸载。

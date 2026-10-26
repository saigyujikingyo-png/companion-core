# 长期维护约定

## 分工和单一写入

主代理负责架构、拆解、整合与验收。常规任务用 GPT-6.1 Sol；高难代码用 GPT-6 Astra xhigh；深度长推理、复杂架构和关键审查用 GPT-6 Astra max；前端与美术用实际 Claude Opus。该用户规则已落在本仓和维护协调仓的 AGENTS.md。

单目录一个写入者。并行修改用独立 worktree 与分支，合并需用户确认。每项较大代码变更由另一代理只读审查；审查反例进入回归测试，修复后复核。日志只记录必要 ID/状态，不输出密钥、完整聊天或隐藏推理。交接使用排除入库的 `.agents/handoff.md`。

## 版本与依赖

- 核心协议、数据库 schema、提供方模型、媒体编码和神经数据分别版本化。0.x 也必须说明破坏性变更。
- Node 基线固定 24.16.0，兼容目标为 24.x；`node:sqlite` 在该版本是 Release candidate API，封装在 store.ts。原生 TS 不做类型检查，必须独立跑 tsc。将来发布 npm 包先编译 JS，不能依赖 Node 去解析 node_modules 中的 TS。
- 运行时版本来自 diagnostics 实测；禁止仅看依赖标签猜 SQLite 版本。固定 lockfile；依赖更新使用独立 PR，不全局安装或改用户配置。
- CI 配置 Windows/Linux/macOS 固定基线与 Linux 24.x 更新哨兵，固定 action SHA，read-only repository permissions，安装禁用脚本。未实际执行的 CI 不能标为平台支持已通过。

一手文档：[Node 24.16 SQLite](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html)、[Node TypeScript](https://nodejs.org/download/release/v24.16.0/docs/api/typescript.html)。

## 数据、恢复与删除

生产活动库必须位于本机应用数据目录，不能在 OneDrive/GDrive 工作区同步 WAL。计划默认 Windows `%LOCALAPPDATA%/CompanionCore`、Linux `${XDG_DATA_HOME:-~/.local/share}/companion-core`、macOS `~/Library/Application Support/CompanionCore`；当前 demo/test 只创建临时库，没有生产初始化命令。

M2 实现一致性新路径备份，禁止覆盖旧快照，记录 hash、schema、SQLite 版本并重开副本跑 integrity/foreign_key 检查。恢复先施加最新独立撤销账本、再重建索引，最后允许查询和产物激活。不能只复制打开中的 `.db`；不能直接打开旧备份当当前权威库。当前原型**尚不能安全恢复旧备份为生产库**。

迁移使用只增的编号文件、checksum 和事务，先备份再迁移；失败回滚，较新版本 fail closed。0.1 首版只有 schema 1 创建及结构变化拒绝，没有升级/降级脚本。首次发布前冻结 schema；此后不修改原始 schema SQL。当前 hash 是防误用/意外结构变动检测，不是抵御能修改整个 DB 的恶意管理员。

FTS5 使用自身 secure-delete 加 SQLite secure_delete，测试直接检查影子表 marker 残留。它不抹除已有 WAL 历史页、备份或 SSD 磨损均衡副本；真实删除流程需要加密密钥生命周期和完整介质策略。[SQLite FTS5 文档](https://sqlite.org/fts5.html#the_secure_delete_configuration_option)、[WAL 文档](https://sqlite.org/wal.html)。

## 回归与发布门槛

每次 PR 跑类型检查、相关故障回放和合成 demo；变更来源/撤销/迁移/并发边界时跑全核心套件。相同代码已有通过证据时不无意义反复重跑。每个原生宿主/平台单独标版本、fixture、结果和限制。

本仓第一方源码采用[Apache-2.0](../LICENSE)；保留已有作者/工具来源记录，不编造NOTICE或法定姓名。[第三方与数据边界](THIRD-PARTY.md)及公开预检须与源码分开核对。所有package的private:true仍防npm误发。首次公开保留同URL/history，先经许可、敏感内容和包内容审查，再正常推送并明确切换可见性；不rewrite/force/delete历史。已有三平台CI只覆盖对应revision，真实适配仍仅在合成账号/数据验证；迁移退出及长期生产资格未因公开而增加。跨宿主能力表使用 PASS / PARTIAL / NOT_RUN，不用“通用兼容”替代证据。

发布制品需记录代码 revision、依赖锁、协议/schema、模型与神经manifest。灰度时保留原数据与旧配置；回滚不覆盖更新的数据。重大缺陷优先停止相关写入或产物激活，再从证据定位，不自动清空数据库。

长期运维计划：按每次发布做恢复演练；按数据量增长阶段做跨年代召回、检索预算和大 DAG 测试；按年度做完整密钥/快照恢复及存储介质迁移。这里是维护流程，没有创建自动定时任务。

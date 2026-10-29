# IF8发布与IF9容量压实证据

2026-10-27。IF8 **MERGED / CI_PASS**；IF9 **LOCAL_VERIFIED / UNCOMMITTED**：作者验证、两路独立审查及独立1028/1028与TS通过，221执行文件0漂移。此页区分已发布提交和本机未提交实现；不把IF8 CI借给IF9，不启动训练、真实provider、私有库迁移或部署。

## IF8正式发布

[PR #4](https://github.com/saigyujikingyo-png/companion-core/pull/4)在精确head `813af7bb82b0ef5b6a3e9bffa300f44dd282068e` 通过独立审查及14/14自然跨平台CI后，于2026-10-27T14:57:08Z普通合并为 `ffa596eb403fd54f128b776d9d966c49dfa0da33`。merge父提交为 `4e0892c0e618304e8e0c84daa9e97b74edbb81ba` 和该head；tree `d2b24037f7de13e41274e66642c204d9e536d686` 与验证head完全相同。单提交13文件，原冻结文件全部匹配；219执行文件一致，其余286非候选基线文件blob/mode未变。

发布前复用该源码的作者20/20、关联180/180、两位独立审查及独立1004/1004与TS0，不重复整套。发布门另核精确head/main、文件/树、无新增阻断；Codex bot已在该head完成且无finding。Sourcery因额度跳过，不记为通过；security review未取得。历史[IF8证据](AEMC-INFRA-EVIDENCE-IF8.md)中的UNCOMMITTED描述保留其冻结时态，不倒写旧证据。

| 自然CI | 结果 |
| --- | --- |
| [PR core 40524105030](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40524105030) / [PR native 40524104774](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40524104774) | 合计7/7 |
| [branch core 40524040418](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40524040418) / [branch native 40524040409](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40524040409) | 合计7/7 |
| [merge core 40526128580](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40526128580) / [merge native 40526128592](https://github.com/saigyujikingyo-png/companion-core/actions/runs/40526128592) | 合计7/7 |

跨平台覆盖沿用现有core/native矩阵，不重跑或取消旧run，不提高timeout。合并后Windows core最后完成，job9分58秒、check步骤9分30秒，原10分钟门内通过；这说明该轮通过，也提示后续新提交须按自身CI验收。无IF9 CI预测。

原生TEMP目录 `aemc-if8-publication-20261027T144334749Z` 保留完整JSON；Root直接核读：

| 文件 | SHA256 |
| --- | --- |
| pre-merge-gate.json | f21a5ee3019476025c55abba39a4c67c3021d50baad5ff6b6d48ffbc394cc0e5 |
| verified-merge.json | 5d6e80ccd5e84474eb9bc3d2f0ab7e1f70e4b91083ec5b82deb3e5ef0996e0aa |
| local-merge-verification.json | 7b6ad8951724d3b77a5fb2f0456e78192f6205ec70da9a4f2c58c80599fb5c5a |
| postmerge-ci-final.json | 57b91597c744bc366cdf6148da6f83c03f3bec13b0a5661937e613c0e11f88dc |
| PUBLICATION-CLOSURE.json | b9d426d4622af5890669dab7e6943672ee6c12cdbe46f4e3180fac0723333676 |

## IF9实现和作者冻结

独立分支 `codex/aemc-capacity-repack-20261027` 从上述merge创建。实际Astra xhigh唯一源码作者，交权后Root只整合文档；两位实际Astra max只读审查，机械验证交实际Sol6.1。原IF8/IF7/Core/WF2及历史树保留。安装 `npm ci --ignore-scripts` exit0、lock SHA `cff9fb507fb3cc6635f119b45ee232056fc9a1ea73b9737f3204786096ba09e2` 未变；无新依赖或CI修改。

[冻结合同](CAPACITY-REPACK-PLAN.md) SHA `6c5205ec3868b194de5f463a2613f42f69f8295b9080f0536721daa4f81d58b0`，两路设计审查通过。[API合同](CAPACITY-REPACK.md)解释两项实现：

- `repackStore`：仅已验证的私有RAM SQLite镜像做物理压实，完整typed逻辑指纹、FTS配置和sqlite_sequence保持；不boot，严格缩小才进入新目标提交，旧源保留并fence。
- `blocks-br4-safety-br4-v1`：显式新profile，以完整carrier大小选raw/Brotli4，严格验证长度/hash/UTF-8/完整输入及展开前累计预算。Safety全部原状态、ID、顺序与字段保持；旧profile及普通compact兼容，升级单向，新目标恢复/backup/rekey自包含。

Store16MiB、Safety8192、maxCalls≤32、chain16、replay64MiB、目录256MiB不变。压实不是清理历史，载体编码不是新认知codec或无限容量。

作者最终目录 `%LOCALAPPDATA%\Temp\aemc-if9-author-final-20261027T152058147Z`：测试前完整复制221执行文件（基线全部219非Markdown+2新增执行文件），保存baseline blob/mode、bytes和SHA；测试后0漂移。10文件作者候选188891B含8执行文件及2文档；Root后续文档另封最终候选，不冒称等于作者快照。

| 作者执行 | 实际结果 |
| --- | --- |
| 专项capacity-repack | 24/24，fail/cancel/skip/todo0；Node5.5452672秒、outer5.607387秒，exit0 |
| strict TypeScript | exit0，2.5339943秒；原始空log与外层结果一并留存 |
| 9个受影响套件 | 204/204，fail/cancel/skip/todo0；Node41.6878881秒、outer41.7439212秒，exit0 |

受影响范围为anchored-vault、incremental-storage/measurement、durable-fanout/backup、legacy-M2、authority-capacity、capacity-inspection、receipt-rollover。作者未运行whole。鲜活资源门为RAM4,903,313,408B、C盘可用334,427,152,384B、Node24.16.0，native TEMP、合成数据、单worker。Root直接核raw logs/results/outer-result/source-drift，未以空日志推断成功。

| 作者冻结材料 | SHA256 |
| --- | --- |
| execution-manifest.json（221） | 5c5b12216cdc7c807a5f3b9803c3f271587b8c3925b6766e07eb7a72a4de1e5e |
| candidate-manifest.json（10） | e0b175f790b856831ca3237c22423e9f42bb51b1cab14eb08d5e1b089cf18159 |
| focused.log | 3a9ccfc87bd7522856e8a73b4b02922fedcce6ef40a37ebf5f4eb4566e87e552 |
| affected.log | 76af396e06af773389a34092eca5304a8d886b9d408a60ce7bcee5f64aa98f47 |
| outer-result.json | 4698ece509c88d16e415dcc30270825d13eea6f5e80cacd211219a6685d4dbfc |
| retained-evidence.json | f55ce883b859e6ed87fd3462760d4efbad572a22fdcc3ced4ca83fecba8f5b04 |

历史失败全部保留：初次import/CIM环境错误不是feature red；实际缺API/profile为0/2；8/21包含非法12000字符fixture和真实缺失authority升级分支，分别改为原上限内输入和窄转换；15/21的6个子进程真实exit42成功，但基线提前包含writer journal，改在close后取样；23/24直接改FTS shadow config被正确拒绝，改用支持的FTS命令。最终24/24。早期失败没有完整源码快照，不能追认成精确manifest绑定；tool-only 2/2 smoke被最终证据替代。门限未放宽。

## 成本与安全语义分项

普通MemoryStore合法写入形成空闲页，schema1为172032B/42页/free12 → 114688B/28页/free0；schema2为225280B/55页/free12 → 167936B/41页/free0。完整逻辑指纹/integrity匹配，原撤销请求返回同node/status、冲突载荷拒绝。另有真实AnchoredVault新目标重开/新写、完整Safety/fanout保持及旧源fencing；以后boot将pending转UNKNOWN按原规则单独检验，不算维护改写。

两种旧profile分别从3请求/2reserved状态升级，并继续合法操作后最终达到6请求/4reserved；最终rawSafety1552B，carrier分别813/809B、headFrame1648/1644B、requiredChain22947/22935B、完整backup26106/26094B。这是该轮合成观察，不是固定性能常数，不把升级后的操作计入升级前历史。

单独的高熵随机结构注入压力夹具：

| 条目 | 原Safety bytes | 完整carrier bytes | head frame bytes |
| --- | ---: | ---: | ---: |
| 0 | 143 | 273 | 1014 |
| 32 | 7626 | 3437 | 4178 |
| 512 | 119946 | 49035 | 49776 |
| 8192 | 1917066 | 760496 | 761237 |

8192结构夹具encode46.5065ms/decode17.6282ms；8193拒绝。它不是8192次公开持久操作历史；空载体比原JSON大，不能称所有输入都节省。上述不是物理设备写入、生产速度或总体CPU/RAM已增量化；serialize仍产生整库RAM镜像。

真实子进程在两API的PREPARED/record-published/finalized各exit42，共6处；原操作精确重试/reconcile、必需文件缺损拒绝、真实竞争进程与另一vault pending拒绝均有专项。没有自动删原件或未决记录。

## 独立验收与下一步

两位实际Astra max独立源码审查通过，未发现剩余可操作P1/P2；两次重算221执行文件均0漂移，完整10候选及合同匹配。分别检查RAM/typed逻辑完整性、新目标恢复/fencing、Safety严格解码/展开前预算、旧profile与backup/rekey/legacy兼容，并直接核作者测试源码及原始结果。审查未执行产品测试，也不替代独立whole或CI。文档审查修正IF10的head身份表述、归档前后相等与后续热更新区分，以及上述升级前后成本时序。

Sol静态预核逐项核221执行/10候选188891B/27历史证据、Gitbase及blob/mode，0漂移。初次sandbox TEMP副本不能跨调用读取，明确作废；第二次显式native TEMP静态核验成功并跨调用重读，未冒称原副本。

首次独立whole终态为1028总/1015通过/13失败，cancel/skip/todo0；npm及统一外层均exit1。13项为4个junction/symlink EPERM与9个本机HTTP/PROVIDER_NETWORK及派生断言失败；不记为PASS，也不因来自旧suite而忽略。执行前后221文件完全一致；该轮strict TS exit0。随后确认首次runner采用use_default受限沙箱；在获授权原生环境的本机HTTP/junction探针通过，同源码必要whole返验也通过（见下）。首次失败仍独立记账。原native目录 `aemc-if9-independent-sol-20261027T153015Z/run-20261027T154500Z` 标签为预分配名，实际开始15:37:41Z以JSON为准；whole.log SHA `aa82005f5d6344fd54f543757e5a0f546b61d152b17e13430f36c2eef8fe4bf9`，result SHA `f73375d7e5658489a677d718b166d9a9f12e16a27b268b8d240717f0bada5fa0`，failure-detail SHA `2469708c36549fa2229203454afcf5712fa9cf6b04c2ce2b7b681f9f1dd9a9f2`，完整原件保留。

一次必要原生返验在 `aemc-if9-independent-sol-20261027T153015Z/whole-native-20261027T154230449Z` 留证：显式获授权执行，鲜活RAM4,303,626,240B、C可用333,257,179,136B；仍采用原单worker、原测试及1GiB/1GiB资源门，没有源码修改或跳过失败项。实际npm测试15:42:30.668Z至15:44:14.066Z，**1028/1028**，fail/cancel/skip/todo0，Node103.0233158秒、outer103.3987317秒，npm与统一工具外层均exit0。13个原失败项在这次raw log均有唯一实际PASS行。前后221执行文件及基线blob/mode与作者冻结逐项一致；Root已直接读取终态/原始日志/hash/外层回读证据。

strict TS复用同一221源码首次独立结果exit0/2.4220318秒，不因环境返验重复类型检查。原全量失败和探针不是PASS替代；最终结论依据实际返验。两次whole不是两项独立成功证据，作者24/204及whole1028也不相加。

| 独立返验材料 | SHA256 |
| --- | --- |
| whole.log | 748ebcc99f9fc6f8a62dbdc4cf5c32d3434e3916f1c0cccdb6dd6edb7f092521 |
| result.json | 0b60a84eadb6905eb6ca08e3132722d14624db57d2a233c11d56316718a7b8fe |
| outer-readback.json | ad2cc1fd72383086cfa5c5b819413a4db72c513b2f5501b996cfe530d5e710bf |
| execution-before.json | 879d78d1e2e91a6afc71c008aee2734ca4e082fd8ba9378cdccc7195b4b45ae7 |
| execution-after.json | 081d44ab82ff9bc1e3d18d69ea4c0e891e6f942e45a8fdd673ec2d117b9cb3a8 |

before/after容器hash不同是记录时间/阶段不同，221条路径/bytes/SHA/blob/mode相同。最终源码及文档候选再封完整字节快照和manifest，定位见ignored交接。IF9没有commit/push/PR/提交CI，生产与训练未接受。IF8已发布状态不授予IF9自动合并。

[长期容量设计](LONG-TERM-CAPACITY-DESIGN.md)仅为IF10候选：先做Safety不可变终态单冷段，再考虑Store整图和authority永久索引路由，保留准确负查找、UNKNOWN及所有旧ID。新[三域架构决议](ADR-MEMORY-TOOL-BOUNDARY.md)明确有损内在痕迹和外部工具原件，与精确控制账本分账。两者都未作为IF9实现或训练接受。

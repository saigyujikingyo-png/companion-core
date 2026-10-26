# 原生验收的可移植摘要

本文件只手工摘要已审安全receipt；不携带raw logs、聊天正文、密钥、vault、账号/SID、机器路径或完整协调目录。它只保存实现/合同的安全证据摘要，原始实验工件仍本地保留。下面hash区分“运行result”与“项目receipt”，不混同；摘要不是完整原生工件的独立重放证明。

验收使用固定合成输入；真实provider/宿主生命周期、源码单测、部署与用户体验分别记录。源修订变化后，旧native记录不能自动成为新源码的原生PASS。运行目录与原始安全receipt保存在本机独立实验区，未随源码上传；这里仅保留逻辑证据名与内容标识。

## source-and-ci

源修订`4e3f246b5a7f0ce7ecbae9b8822d687096aa779b`：作者strict TS、272项合成测试与七步回放通过；独立Astra max39项定向检查通过。`03b61bc7519b2880bd321131cb4b3eccd737fc2a`只补当前说明，不更改runtime。

本批陪伴窗口源修订`05cbeeac9411af87081282ca43223d767eca09f3`已通过一次normal-user strict TS、300/300合成测试、七步回放及独立Astra63项定向审查，七runtime的工作树与Git blob hash匹配。完整本地check日志SHA256为`5942c56c43d4a673d380d1abcb971e95f338918f3f359ed55ed60e7c80e7d0af`。这些不替代下列各修订的native范围；CI覆盖Windows/Linux/macOS与Node24.16，本摘要尚无本批远端三平台PASS。

## coupled-core-ram

这是M2之前的历史RAM耦合切片。历史记录包含有界真实provider、状态/合法回忆重排、ACK、stdio stop/EOF和真实图worker接口等局部证据，未证明永久记忆、自然长期互动或人类情感。

该历史总览未在本次选定receipt中给出单一source commit/result hash，所以此段只作为历史索引，不补造一体化验收ID。相关原始coupling记录继续保留本机；本摘要后面的明确hash结果独立列出。

## dsh-control-ram

旧RAM会话曾有用户可见原生status回执，独立后端safe audit另有两条command-status；commandId来自用户回执，audit不含commandId，不能一对一关联。该记录不等于聊天输入框绑定、模型回合或M2新SID控制已通过。

逻辑证据`DSH-CONTROL-PASS`，状态`CONTROL_PASS_NATIVE_STATUS_AND_USER_VISIBLE_RECEIPT`。项目receipt SHA256：`5ad0404c48fe1a4cc20db3a1aae9c79ef0100f97dc85b2628673dd27f3f1ac3b`。此receipt未列source commit或独立运行result SHA；不把receipt hash冒称runtime source hash。

## m2-partial

原M2四次真实DeepSeek原生请求A/B/C/D均获commit/completed ACK，状态/反馈选择与下一输入消费、pause拒绝、首次恢复召回及SDK重复RPC抑制有局部证据；撤销后的第二次恢复失败，E未发，全链保留FAIL/PARTIAL。没有打开或修复原vault，也不把独立FTS红绿复现当作对原vault的直接读取诊断。

当时三次launch的stdio入口SHA256：`23909dd57e77f65a0b6161f6bf703defb962c8c637f0dd100d83eb7b21e3088b`。
运行result SHA256：`c4d1997f22282d60e04a5d0d191c614f60cbfb5ffa7ed8f18abb4220e23c8ab4`。
逻辑证据`NATIVE-REAL-PARTIAL-01`的receipt SHA256：`7494f043b3bdf32528296267d5701a8b0c15f758ea4b4ffcf4901df1a400d7b1`。

## m2-repaired-three-call

修复源`25cb0f8c6073dc91167c2507d9444a5500b560a7`在RAM COMMIT完成FTS5同步后才serialize/durable提交；不确定性会poison。该源另有241项/TS/七步回放和独立八项源码验收，其中有效前缀authority回滚是明确known-negative。

同源另有独立新vault的零请求原生检查：0 API凭据/0模型调用，仍生成/使用独立memory key；原生控制及内外clean通过，不是原失败vault的恢复。逻辑证据`REPAIRED-ZERO-PASS`，运行result SHA256：`bb851b051f624250b142f92fb2a6e35636bad5e122853474d736d6d06047cfd2`；receipt SHA256：`f1f2540a6b7ba3d69dda0679288b518eded82e7137a5bcbfb4944edbc36f9000`。

独立新vault三次真实请求：A→干净重启B召回A→暂停撤销A→干净重启C排除A的event及memory anchor；两次restore有新binding、默认pause、额度保留，记忆/conditioning/background均检查撤销排除。3 inner+3 outer clean/noForce/owned0；其中一项安全错误投影UNCLASSIFIED保留，不称error-free。

这不是原四次库的A→E连续恢复。原4+修复3合计7/8，未退款/重跑或使用隐含第8次。逻辑证据`REPAIRED-REAL-PASS`，运行result SHA256：`119b5e6664d5dc783e225e1245a9a242627ad82a94515adf7ca30c1171472f30`；receipt SHA256：`68792bae1116b7c37dd1207c21d2101b52e162ddd25cffc0836c1c2a56bb8376`。

## m2-desktop

源`25cb0f8c6073dc91167c2507d9444a5500b560a7`的官方桌面插件部署有bootstrap create+flush/clean unload、同vault/identity最终resume-only READY证据。旧/boot子进程退出，主DSH未重启；8次官方CLI操作均exit0/noForce/owned0。

部署回执当时为baseline、paused/unavailable、0/32；**这是历史值，不代表当前调用数。** 新M2菜单点击/输入框绑定及直接inspect.restored未在该阶段采样，状态`READY / UI_CONTROL_PENDING`；旧RAM控制回执不能转移到新M2会话。该部署回执proactive=false；本批未部署后续源码。

逻辑证据`DEPLOYMENT-PASS`，receipt SHA256：`b6d47d03e6ebdcfd084c18f03ba0acf9a8118ba2960f9cd5bc10c58446f53534`。它汇总多份部署receipt，没有单一模型运行result hash。

## proactive-zero

源`4e3f246b5a7f0ce7ecbae9b8822d687096aa779b`、实际官方SDK隔离宿主：test-only Backend在首ACK结算前同ID通知两次prepared，最终仅一次SDK machine followup；两次adapter流/nativecommit/completed ACK，只有一次human provider-request。outer clean0/noForce/owned0。

结果`ZERO_NATIVE_DELIVERY_PASS`，真实API0、合成Backend响应2。这是delivery plumbing，未创建真实core/memory/HTTP child，不证明真实state自然触发、durability或通知UI体验。

运行result SHA256：`dacaf18292b2203e991784f3a94b0af1921471c87450b4441b5b39a320c9ef47`；逻辑证据`ZERO-NATIVE-PASS`的receipt SHA256：`b85387daf11d7c3d9b0e55ab3e1beeb3464d9b2bfee5639b4d563ba3c702b9d8`。

## proactive-natural

同源`4e3f246b5a7f0ce7ecbae9b8822d687096aa779b`，唯一fresh M2永久cap6试验：按0/20/40/60/80秒固定五条合成自述，约120秒内均有真实DeepSeek回复和nativecommit/completed ACK。最终reserve5、ingress5、unknown0，prepared/主动ACK0；暂停后同RPC复用0新turn/user/调用，内外clean0/noForce/owned0/drained/raw false。余下第6次封存，不重跑。

结果**NO_TRIGGER**是有效阴性，不是自然触发PASS或传输失败；内部shadow intent未直接暴露，不能由额度推断没有任何内部意图。原lease约110秒结束；最后target固定/无新刺激的条件估计约138.794秒才越阈，估计不是延长实测或未来成功保证。

运行result SHA256：`c253877d33194bc23d7cab71111440bb96fea87c99a45f541c84240e381ffb7a`；逻辑证据`NATURAL-NO-TRIGGER`的receipt SHA256：`c06474dba3412520b51d988bdb3cd1d92a2e9e95e44e5c6055a3b898fcf2a905`。

## physical-neural

真实FlyWire3136节点子图此前做过GPU操作和同预算对照，结果未优于baseline；后续CPU在线worker/reset/carry等接口证据也不等于M2+flywire原生组合或情感质量通过。本次未重跑硬件或训练。详细研究独立于本native摘要，不凭引用名称扩大生物学结论。

## window-control

源`05cbeeac9411af87081282ca43223d767eca09f3`、完整Git tree冻结的实际官方SDK隔离宿主/真实CoupledStdio synthetic Node child，结果**WINDOW_CONTROL_WIRING_PASS**。31.261秒内只有1条合成anchor、1次synthetic provider、1个nativecommit/completed ACK；真实API0，无DPAPI/persistence或注入Backend fixture。

beforehuman grant拒绝且calls0；ACK后grant60初始remaining约59994ms；新的commandId重复grant拒绝，原绝对expiry/generation保持。首次native-user保守观测+31009ms时，observed available=false、background.context.available=false，而显式window仍active/proactiveAllowed=true、remaining约29195ms，calls仍1。off立即变inactive/null/0；pause/resume仍无window、permissionfalse、calls不增。没有将命令视为模型输入或真人presence。

child graceful/exit0/signal=null/forced=false/residual0/coreStatus=closed；install和outer均exit0/noForce/owned0，final完整audit无fatal。DshBackendClose不单独导出三个raw flags，closed gate内部检查它们，不补造独立采样。此为控制接线，不是自然主动触发、UI体验或额外真实API验收，未部署生产。

运行result SHA256：`dd573cfde3535a20c35e02ab02b185ef7f0827855e347db35d2d01674eaa0b2d`；逻辑证据`WINDOW-NATIVE-PASS`的receipt SHA256：`9c1bdc4bd5b3f364ec4a3127093e8539245e5ffaee2196dfd85272b7c0bbb4e5`。

## common-limits

所有native语料均为合成验收，不是长期用户体验。M2只在最新完整authority ledger保持的前提下提供当前恢复边界；有效前缀回滚、容量/迁移/备份产品、跨重启情绪连续性等限制不因本摘要改变。宿主自己的会话记录不在core加密保证内。

本项目第一方代码与文档现采用[Apache-2.0](../../LICENSE)，[外部组件与数据](../THIRD-PARTY.md)仍按各自条件处理。此前private push/CI receipt保留为当时的历史事实；本次公开不改写旧结果或阴性。迁移真实资料、上传训练数据、运行模型与上线仍需各自验收，本摘要和学习设计不授予新额度或训练授权。

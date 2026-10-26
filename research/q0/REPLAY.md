# Q0 portable public replay controller

状态：**WRAPPER_INTEGRATED / PREPARE_ONLY_VALIDATED / FULL_REPLAY_NOT_RUN**。本目录已整合进Core研究包，whole与跨平台CI以本提交回执/Actions为准。
原正式结果是已完成的FORMAL_INITIAL_BLIND；公开种子后的任何运行均为PUBLIC_REPLAY，不是新的盲测。
Root已读原RESULTS（181067bytes，SHA79b76a02136f98e8cb8e620a48dc735083cdb5f85374957cf3a0fe223904e2c0）；没有方案通过15%节省+质量门，未改门/encoder或增加trial。

## Public package layout

wrapper位于Core `research/q0/replay.mjs`，默认package root为其目录；`--package-root PATH`仅用于显式定位同一公开包。
顶层保留原encoder九文件，唯PLAN.md公开改名protocol-plan.txt；ENCODER-FREEZE.json保持原bytes。
`independent/`放原COMMITMENT.json、evaluator.mjs、selfcheck.mjs、SAMPLER-RULES.md、selfcheck.log、seed-reveal.json、formal-runner.mjs和RUNNER-FREEZE.json。
seed-reveal.json是已公开合成种子，TEMP恢复为原private-seeds.json；不是密钥/凭据。
RUNNER-FREEZE保留原历史；wrapper只核其formal-runner条目，不声称原absolute config/launcher/语法log全部复原，也不复制这些文件。

## 默认prepare，不启动算法

```powershell
node --max-old-space-size=256 replay.mjs
node --max-old-space-size=256 replay.mjs --prepare
```

每次新建systemTEMP工作目录，恢复canonical source/capsule/runner布局；核原encoder9+capsule5全部bytes/SHA及原manifest/commitment/runnerhash。
不会执行encoder/evaluator/selfcheck/runner，不生成600-family或任何heldout，不跑模型/训练/API，不写Core。
PREPARED.json与PUBLIC-REPLAY-CONFIG.json声明PUBLIC_REPLAY；prepare成功不代表runtime能执行、质量结果或正式复现完成。
输出目录由新TEMP内部自动分配，不接受覆盖已有output的参数；失败目录与证据保留，不自动删除或重试。
CI只运行已有1family×6methods small smoke以及此prepare/hash检查，不运行以下full replay。

## 显式full replay（本轮不执行）

```powershell
node --max-old-space-size=256 replay.mjs --run
node --max-old-space-size=256 replay.mjs --run --runtime-compatibility
```

默认原runtime验证不降级：Node版本/Zstd/Node executable SHA须符合原encoder manifest，否则失败。
只有显式`--runtime-compatibility`才在新TEMP派生manifest.runtime与config中的encoder hash，保留ENCODER-FREEZE.original.json及逐字段证据。
不改原9encoder、capsule5、seed/oracle/reviewerCommitment/原utc；新结果必须标PUBLIC_REPLAY，不与原冻结环境的正式结果混称。
兼容选项只允许当前Core支持的Node24.16+的24.x且Zstd可用；这仍不是跨平台数值/质量相同的证明。

run前新鲜空闲RAM至少2GiB；child固定heap256MiB、原runner内部RSS512MiB/墙钟180s/产物64MiB门继续生效。
外层compute timeout180s，之后最多5s只清理自己child；不确定退出时记录cleanup未确认并保留claim，不声称成功或自动重跑。
wrapper的独占TEMP claim只防同wrapper并发，不声称已完成全系统研究进程清查；全量运行仍须按当前资源/授权规则准入。
stdout/stderr与controller admission/completion/失败证据留新TEMP；原正式config、launcher、RESULTS和旧失败证据不改。
已完成node --check与一次初始prepare-only核验，原9+5hash通过、computeStarted=false、未创建results。未执行full replay；CI仅执行前述small smoke与prepare，不把它们当正式质量实验。

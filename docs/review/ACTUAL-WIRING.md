# 实际接线图（2026-10-29，main @ `7acba1d`）

这张图回答一个问题：**架构图里的每个节点，今天在哪条代码路径上？** 它不是新设计，只是对照。

标签含义（按代码可达性判定，不按文档宣称）：

| 标签 | 含义 | 判定方法 |
| --- | --- | --- |
| `WIRED` | 在线路径可达：从 `coupled-stdio` / DSH 插件入口出发的 import 闭包里，而且在人类回合里实际执行 | 静态 import 图 + 读 `coupled-runtime.ts` 的回合代码 |
| `LIB` | 有实现、有测试，但没有任何 `src` 入口把它接到在线路径；只被测试、demo 或 CLI 使用 | 只被 `test/`、`scripts/`、`src/*-demo.ts`、`src/*-cli.ts` 引用 |
| `REAL_RUN` | 不在在线路径上，但通过 CLI 在真实外部 API 上跑过（语料生产） | docs/evidence + CLI 入口 |
| `DOCS` | 只有设计文档，没有代码 | `grep` 无命中 |
| `NONE` | 文档与代码都没有，或只有拒绝桩 | — |

在线路径的 import 闭包共 35 个模块：`anchored-codec, authority-cold-format, background-state, capacity-types, contracts, coupled-runtime, coupled-stdio, curation-types, dsh-coupled, dsh-coupled-backend, dsh-coupled-host, durable-backup, durable-codec, durable-fanout, durable-memory, endogenous-durable, endogenous-lifecycle, fanout-types, http-interaction, interaction, jsonl-prior, legacy-import-types, memory-image, presence-policy, retrieval-types, runtime, safety-format, scene, scene-authority-types, scene-json, schema, schema-v2, store, validation, wire`。其余约 120 个 `src` 模块不在在线路径上。

## 图

```mermaid
flowchart TB
  subgraph physical["① 物理身体与外部世界"]
    direction LR
    hardware["固定宿主：双 DGX Spark<br/>DOCS — 当前宿主是 Windows + DeepSeek 云端"]
    human["人与环境<br/>WIRED — 仅 DSH 会话里的纯文本"]
    ingress["可信输入与精选感知<br/>WIRED(文本) / NONE(图像) / 拒绝桩(音频 audio-input-contract.ts)"]
    sensor["硬件采集<br/>NONE"]
    originals["外部原件与资料<br/>NONE"]
  end

  subgraph bodyloop["② 身体与非语言状态"]
    direction LR
    body["B0 单设备数值状态<br/>LIB — body-state.ts 只被自己的测试引用"]
    features["身体变化特征<br/>NONE"]
    field["身体坐标场<br/>NONE"]
    background["非语言背景／情感场<br/>WIRED — 6 变量指数松弛；但在线 observe() 输入全 0"]
    rhythm["自主节律与动机<br/>PARTIAL — 主动投递定时器 WIRED(默认关)；E1 休息/唤醒 LIB"]
  end

  subgraph cognition["③ 互补认知"]
    direction LR
    self["身份合同<br/>LIB(语料生成常量) / NONE(运行时提示是助手框架)"]
    models["可替换 LLM／VLM<br/>WIRED — 仅 DeepSeek；127.0.0.1 端点 LIB；Nemotron/vLLM NONE"]
    left["L 显式处理侧<br/>NONE — 每回合一次模型调用"]
    workspace["有限共享工作状态<br/>NONE — 无对话历史"]
    right["R 持续情境侧<br/>NONE — 果蝇先验是可选旁路(switch flywire)"]
    choice["下一步选择<br/>PARTIAL — 主动说/不说 WIRED；REST/NOOP/TEXT 仅 E1–E3 LIB"]
  end

  subgraph memory["④ 记忆"]
    direction LR
    trace["选择性经历与情景痕迹<br/>WIRED — events/memories DAG；Scene JSON LIB"]
    concept["稳定概念地址与表征版本<br/>LIB — ScenePacket 概念引用，运行时未用"]
    core["AEMC 权威记忆底座<br/>WIRED — store.ts 来源/撤销/epoch；AnchoredVault 外锚 LIB"]
    fanout["持久多消费者与可重建投影<br/>LIB — 在闭包内，但在线回合走 store.search"]
    recall["联想召回<br/>WIRED — 子串/FTS 短语匹配，最旧优先，取 6 条；AR0 LIB；BM25 仅 research/"]
    meta["元记忆与重建查证<br/>DOCS"]
    storage["持久化与恢复<br/>WIRED — M2 DurableMemory 整库镜像加密检查点；增量/压实/rekey 在 AnchoredVault LIB"]
    capacity["长期容量治理<br/>WIRED(硬上限) / LIB(冷段、分片)"]
  end

  subgraph action["⑤ 统一执行与经历返回"]
    direction LR
    gate["精确行动提交<br/>WIRED(文本) — 幂等/预算/UNKNOWN/单写锁/原生 ACK"]
    delivery["表达<br/>WIRED(文本) / LIB(Windows SAPI 语音) / NONE(3D)"]
    tools["个人工具网关<br/>NONE — 模型工具调用被拒绝"]
    edge["具身终端<br/>NONE"]
    experience["经历返回<br/>PARTIAL — ACK/反馈消费 WIRED；模型的记忆建议被丢弃"]
  end

  subgraph learning["⑥ 慢循环"]
    direction LR
    sleep["休息与离线整合<br/>NONE — E1 的 resting 状态 LIB"]
    mentor["研究导师<br/>DOCS — TEMPLATE_NOT_RUN"]
    teaching["教学协调／教师／QA<br/>REAL_RUN — CLI 上跑过 DeepSeek/Together 小批"]
    curation["当前获准候选与去重<br/>LIB — 词法去重 + HOLD；L1.a lint 是 demo"]
    manifest["不可变清单与精确分词<br/>LIB — 加密 JSONL 分片 + 官方 tokenizer worker"]
    trainer["Student 慢速学习<br/>NONE — 只有 STUDENT_TARGET 常量；TJ1 训练的是 nn.Linear(6,2)"]
    journal["成长日记与训练履历<br/>LIB — 合成回放"]
    evaluation["独立评测<br/>NONE — 只有 LLM 判 PASS/REJECT，无人格/诚实/边界回归"]
    registry["版本／表征迁移与显式激活<br/>LIB 桩 — registerArtifact/activateArtifact 无调用方"]
  end

  human --> ingress --> core
  core --> recall --> models --> gate --> delivery --> human
  gate --> experience --> core
  background -. "状态 JSON 粘进提示" .-> models
  rhythm -. "主动投递(默认关)" .-> gate
  teaching --> curation --> manifest
  manifest -. "无 trainer" .-x trainer
```

实线是今天真正在跑的回路：人 → 文本证据入库 → 子串召回 → 一次 DeepSeek 调用 → 投递门 → DSH 原生 ACK → 反馈回库。虚线是接了一半的东西。

## 逐节点证据

| 节点 | 标签 | 证据 |
| --- | --- | --- |
| 人与环境 | WIRED | `dsh-coupled.ts:174-238` → `coupled-stdio.ts:222-236` → `coupled-runtime.ts:277-418` |
| 可信输入 | WIRED(文本) | `coupled-runtime.ts:300-304` 以 `self_report` 证据入库；`audio-input-contract.ts` 永远拒绝 |
| 硬件采集 / 外部原件 | NONE | `grep` 无 CPU/RAM/GPU 采集代码 |
| B0 身体状态 | LIB | `body-state.ts:139`；唯一引用者 `test/body-state.test.ts`；`docs/BODY-STATE.md:63` 自述 B1/B2 未实现 |
| 情感场 | WIRED | `background-state.ts:47-49,145-168,235-243,414-433`；但 `coupled-runtime.ts:309` 的 `observe` 传入 `novelty:0,socialRelevance:0,demand:0` |
| 自主节律 | PARTIAL | `coupled-runtime.ts:463-483` 单次 `setTimeout`；withdrawal 意图返回 null（`:351`） |
| 身份合同 | NONE(运行时) | 系统提示 `http-interaction.ts:52` "Return a brief helpful reply…"；人格只在 `corpus-production-baseline.ts:4-7` |
| 可替换模型 | WIRED | `coupled-stdio.ts:128,155-158` DeepSeek `deepseek-flash`；`raw-text-http.ts:110`/`http-interaction.ts:37` 接受 127.0.0.1 但无配置 |
| L / 工作状态 / R | NONE | 每回合上下文 = 当前文本 + ≤6 条记忆（`dsh-coupled.ts:218` 取前 256 字符做查询）；无历史；模型记忆建议丢弃（`coupled-runtime.ts:404-411`） |
| 下一步选择 | PARTIAL | REST/NOOP/TEXT 只在 `endogenous-lifecycle.ts:64-85`，由 `anchored-*-host` 驱动，无 `src` 入口 |
| AEMC 底座 | WIRED | `store.ts:195-229`（代际/同意/祖先核验）、`:720-772`（撤销级联） |
| 持久化 | WIRED(M2) | `coupled-stdio.ts:143-150` 构造 `DurableMemory`，无 `expectedHead`；`store.ts:155` 每次变更 `serialize()` 整库 |
| AnchoredVault | LIB | 引用者只有 `anchored-text-host`、`anchored-message-host`、`endogenous-durable`、`safety-segment` |
| 召回 | WIRED | `store.ts:668-681` `ORDER BY created_at` 升序取前 `limit`；`coupled-runtime.ts:45-60` 正则关键字重排 |
| AR0 / BM25 | LIB / research | `retrieval.ts:22-24,148-168`；`research/retrieval-baseline/bm25.ts` 无 `src` 引用 |
| 行动提交门 | WIRED(文本) | `coupled-runtime.ts:282-290`（幂等）、`durable-memory.ts:49-57,171-183`（单写锁、UNKNOWN） |
| 表达 | WIRED(文本)/LIB(语音) | `speech-controller.ts:23,47`："No such implementation ships here" |
| 工具网关 | NONE | `http-interaction.ts:103-105` 拒绝工具调用 |
| 教学/语料 | REAL_RUN | `corpus-production-runner.ts`、`corpus-qa-runner.ts`；`docs/evidence/CORPUS-QUALITY-AUDIT-20261028.md` |
| Student / 评测 / 激活 | NONE / LIB 桩 | `corpus-teacher-types.ts:6`；`scripts/tj1-trainer.py:97-142`；`store.ts:791-820` |

## 对照后最短的结论

1. 在线回路是"记忆 + 一次调用 + 投递门"，③ 认知几乎为空，②/⑤/⑥ 的大部分是库或文档。
2. 最大的单点：M2 路径与 AnchoredVault 路径并存，运行时用的是前者。
3. 把 `LIB` 接进在线路径，比再加任何新 `LIB` 都更接近架构图。

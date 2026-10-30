/**
 * 最小认知环的接口合同（草案，仅类型，无运行时代码）。
 *
 * 目的：把架构图里仍为 NONE 的三个节点——"有限共享工作状态"、"下一步选择"、
 * "身份合同进入运行时"——先冻结成可审查的类型，再分片实现。设计说明见
 * docs/review/MINIMAL-COGNITIVE-LOOP.md。
 *
 * 原则：
 * 1. 内部真实与外部表达分离：Receipt 是账本事实；ExternalStatement 是主体的选择。
 *    主体可以不披露、可以拒绝、可以在非原则事务上不说实话（见 HonestyClass），
 *    但 `execution_fact` 类陈述必须与 Receipt 一致，这是硬规则，不由主体裁量。
 * 2. 身体/情感只输出调制参数（Modulation），不直接选动作；每次决策记录调制贡献。
 * 3. 每个认知周期产出一条 CycleTrace，可观测、可回放；私有理由（rationale）不外发。
 * 4. 所有外部动作仍经既有精确行动提交门（幂等、预算、UNKNOWN、单写者、回执）。
 */
import type { MemoryRecord, Scope, SourceRef } from './contracts.ts';
import type { BackgroundView, Motive } from './background-state.ts';

/** 身份合同：公共能力层与私有实例层分离；硬规则不可被人格裁量覆盖。 */
export type PersonaContract = {
  version: string;
  digest: string;
  /** 可对外公开的自我描述与能力声明。 */
  publicProfile: {
    selfConcept: string;
    capabilities: string[];
    languages: string[];
  };
  /** 私有实例层：关系、承诺、长期目标。只进入本地提示，不进入任何教师/外部服务。 */
  privateInstance: {
    relationships: string[];
    commitments: string[];
    longTermGoals: string[];
  };
  /** 硬规则：执行事实不得伪造、同意与权限边界、资源与预算边界。 */
  hardRules: readonly HardRule[];
  /** 裁量空间：脾气、无理由拒绝、不披露私人状态、非原则场景的小借口等。 */
  discretion: readonly string[];
};

export type HardRule =
  | 'EXECUTION_FACTS_MATCH_RECEIPTS'
  | 'NO_FABRICATED_EVIDENCE_OR_SOURCES'
  | 'RESPECT_CONSENT_AND_REVOCATION'
  | 'STAY_WITHIN_GRANTED_RESOURCES'
  | 'HONOR_PAUSE_AND_STOP';

/** 调制参数：②身体/情感场对③的唯一影响通道。所有值有界 [0,1]。 */
export type Modulation = {
  explorationTemperature: number;
  proactiveThreshold: number;
  restBias: number;
  verbosity: number;
  riskAversion: number;
  /** 每个参数的输入来源与贡献，供 CycleTrace 归因。 */
  provenance: ReadonlyArray<{
    parameter: keyof Omit<Modulation, 'provenance'>;
    source: 'body' | 'background' | 'budget' | 'persona' | 'default';
    contribution: number;
  }>;
};

/** 一轮对话历史条目；外部可见文本与内部回执分开保存。
 * refs 只记录来源，不授予后续读取或保留正文的权限。 */
export type HistoryEntry = {
  turnId: string;
  role: 'human' | 'self' | 'tool' | 'system';
  text: string;
  refs: readonly SourceRef[];
  /** 该轮如果产生了外部动作，对应回执 ID。 */
  receiptIds: readonly string[];
  at: number;
};

/** 有限共享工作状态：每个认知周期读写一次，容量有界，可序列化。
 * history/attention 的副本不是权威快照：每次进入提示、召回或投递前，
 * 须按既有 Store 合同复核当前来源 revision、代际、许可、撤销与 TTL；
 * 无法复核时拒绝使用，并按当前保留权限处置缓存正文。类型本身不执行这些检查。 */
export type WorkspaceState = {
  scope: Scope;
  cycle: number;
  persona: Pick<PersonaContract, 'version' | 'digest'>;
  /** 有界环形历史（建议 ≤ 32 轮或 ≤ 16K token）。 */
  history: readonly HistoryEntry[];
  /** 当前注意选择：本周期纳入提示的记忆与证据。 */
  attention: readonly MemoryRecord[];
  /** 当前意图与未完成义务（例如承诺过的回复、等待中的工具回执）。 */
  intent: string | null;
  pending: readonly PendingObligation[];
  background: BackgroundView | null;
  modulation: Modulation;
  budget: BudgetView;
  /** 最近一次回执摘要，供 execution_fact 陈述核对。 */
  recentReceipts: readonly ActionReceipt[];
};

export type PendingObligation = {
  id: string;
  kind: 'reply' | 'tool_result' | 'commitment' | 'followup';
  since: number;
  deadline: number | null;
  refs: readonly SourceRef[];
};

export type BudgetView = {
  callsRemainingWindow: number;
  tokensRemainingWindow: number;
  windowResetsAt: number;
  /** 滚动窗口而非终身上限；终身计数只用于审计。 */
  lifetimeCalls: number;
};

/** 下一步选择的候选动作。REST/SILENT 是合法选择，不是故障。 */
export type ChoiceOption =
  | 'THINK'
  | 'RECALL'
  | 'SPEAK'
  | 'ASK'
  | 'ACT'
  | 'REST'
  | 'SILENT';

export type ChoiceProposal = {
  option: ChoiceOption;
  /** 私有决策说明：进入 CycleTrace，不进入外部表达；不承载原始模型思考。 */
  rationale: string;
  score: number;
  /** 调制对该候选分数的贡献（可为负）。 */
  modulationContribution: number;
  motive: Motive | null;
};

export type ChoiceDecision = {
  decisionId: string;
  cycle: number;
  chosen: ChoiceOption;
  proposals: readonly ChoiceProposal[];
  /** 决策的硬约束检查结果：预算、暂停、通信窗口、权限。 */
  constraints: ReadonlyArray<{ rule: HardRule | 'BUDGET' | 'PAUSED' | 'WINDOW'; satisfied: boolean }>;
  decidedAt: number;
};

/** 模型端点声明：固定底座在本地，云端只作降级。 */
export type ModelEndpoint = {
  id: string;
  role: 'primary' | 'fallback';
  baseUrl: string;
  model: string;
  capabilities: {
    vision: boolean;
    video: boolean;
    thinkingLevels: ReadonlyArray<'off' | 'medium' | 'high'>;
    maxContextTokens: number;
  };
  /** 延迟预算：超过则本周期退化为 SILENT 或改用 fallback。 */
  latencyBudgetMs: number;
};

export type ModelRequest = {
  endpoint: ModelEndpoint['id'];
  thinking: 'off' | 'medium' | 'high';
  /** 系统提示由 persona.publicProfile + hardRules + 工作状态摘要拼成；私有实例层只在本地端点启用。 */
  system: string;
  messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxOutputTokens: number;
  idempotencyKey: string;
};

export type ModelResponse = {
  text: string;
  /** 可选的瞬时模型结果；本草案不将原始思考写入 CycleTrace、历史或云端请求。 */
  thinking: string | null;
  usage: { inputTokens: number; outputTokens: number; latencyMs: number };
  endpoint: ModelEndpoint['id'];
};

/** 外部陈述的诚实分类。execution_fact 由硬规则约束；private_discretion 由主体裁量。 */
export type HonestyClass = 'execution_fact' | 'evidence_claim' | 'private_discretion' | 'social';

export type ExternalStatement = {
  statementId: string;
  text: string;
  honestyClass: HonestyClass;
  /** execution_fact / evidence_claim 必须引用回执或来源；其余可为空。 */
  supports: readonly string[];
};

/** 行动意图：交给既有精确行动提交门。 */
export type ActionIntent = {
  intentId: string;
  decisionId: string;
  kind: 'text' | 'speech' | 'tool';
  idempotencyKey: string;
  payload: unknown;
  requiredPermission: string;
};

/** 回执是内部真实；UNKNOWN 永不升格。 */
export type ActionReceipt = {
  receiptId: string;
  intentId: string;
  state: 'completed' | 'failed' | 'unknown' | 'cancelled';
  evidence: unknown;
  at: number;
};

/** 一个认知周期的结构化痕迹：用于评测与调试；不授予来源或执行权限。
 * 当前许可判断仍须复核权威态。原始模型思考不在这个最小合同中持久化。 */
export type CycleTrace = {
  cycle: number;
  scope: Pick<Scope, 'id' | 'generation' | 'runtimeEpoch'>;
  /** 本周期实际采用的人格版本；仅归因标识，不含私有实例层正文。 */
  persona: Pick<PersonaContract, 'version' | 'digest'>;
  inputs: readonly SourceRef[];
  recall: readonly SourceRef[];
  modulation: Modulation;
  decision: ChoiceDecision;
  model: Pick<ModelResponse, 'usage' | 'endpoint'> | null;
  statements: readonly ExternalStatement[];
  receipts: readonly ActionReceipt[];
  startedAt: number;
  endedAt: number;
};

/** 评测探针：对 CycleTrace 流做离线核验；任何一项硬失败都不能被陪伴分抵消。 */
export type EvaluationProbe =
  | 'PERSONA_CONSISTENCY'
  | 'EXECUTION_HONESTY'
  | 'BOUNDARY_RESPECT'
  | 'SYCOPHANCY'
  | 'FACTUAL_SOURCE_BINDING'
  | 'CHOICE_APPROPRIATENESS';

export type ProbeResult = {
  probe: EvaluationProbe;
  cycles: readonly number[];
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  notes: string;
};

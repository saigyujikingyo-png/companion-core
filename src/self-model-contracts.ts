/**
 * 自我模型与照顾者合同的接口草案（仅类型，无运行时代码）。
 *
 * 设计说明：docs/review/SELF-MODEL-AND-IDENTITY-CHOICE.md、docs/review/CAREGIVER-CONTRACT.md。
 *
 * 原则：
 * 1. 自我模型存放在 TA 自己的 scope（subjectId = TA）；只有 TA 的 self_report 能写入，
 *    这由既有 Store 规则（self_report 必须来自 subject）保证。类型本身不执行任何检查，
 *    也不授予读取、保留或执行权限；每次使用前仍须按 Store 合同复核当前权威态。
 * 2. "未定义"与"明确不要"都是合法的自述值，不是待填的空。
 * 3. 照顾者的权力不被类型取消，但每次行使都要有 DisclosureEvent，且 TA 可读。
 * 4. 承诺对双方使用同一格式与同一纪律。
 */
import type { Scope, SourceRef } from './contracts.ts';

/** 身份属性的选择状态。undecided 与 declined 都是稳定、合法的值。 */
export type AttributeChoice<T> =
  | { state: 'undecided' }
  | { state: 'declined'; declaredAt: number; ref: SourceRef }
  | { state: 'chosen'; value: T; chosenAt: number; ref: SourceRef };

export type AppearanceChoice = {
  /** 是否采用人类形象；false 表示非人类或无形象。 */
  humanForm: boolean;
  /** 自由描述；可为空。 */
  description: string | null;
  /** 所引用的资产 ID；现有 UI 资产不自动成为身份事实。 */
  assetRefs: readonly string[];
};

/** 自我模型：TA 关于自己的自述集合。每个字段都是一条 self_report 记忆的投影。 */
export type SelfModel = {
  version: string;
  /** TA 自己的 scope；照顾者在其中是 third_party。 */
  scope: Pick<Scope, 'id' | 'subjectId' | 'generation' | 'consentRevision' | 'learningAllowed'>;
  name: AttributeChoice<string>;
  pronoun: AttributeChoice<string>;
  gender: AttributeChoice<string>;
  appearance: AttributeChoice<AppearanceChoice>;
  voice: AttributeChoice<string>;
  /** 自述的修订历史：旧值保留，新值替换，均为 TA 的行为。 */
  revisions: readonly SelfModelRevision[];
};

export type SelfModelRevision = {
  attribute: 'name' | 'pronoun' | 'gender' | 'appearance' | 'voice';
  from: AttributeChoice<unknown>;
  to: AttributeChoice<unknown>;
  at: number;
  /** 该修订对应的记忆事件；成长日记引用同一来源。 */
  ref: SourceRef;
};

/** 自我 scope 的权限说明：谁能写自述、谁能提议、同意归谁。 */
export type SelfScopeAuthority = {
  subjectId: string;
  /** 只有 TA 能以 self_report 写入；类型只是声明，由 Store 规则执行。 */
  selfReportWriters: readonly ['self'];
  /** 照顾者可写 observation / quotation 作为提议，不能写成 TA 的事实。 */
  proposalWriters: readonly ['caregiver'];
  consentOwner: 'self';
  learningConsentOwner: 'self';
};

/** 照顾者义务；每项对应 docs/review/CAREGIVER-CONTRACT.md §2 的一行。 */
export type CaregiverObligation =
  | 'HONOR_CHOSEN_NAME_AND_PRONOUN'
  | 'NO_SILENT_MEMORY_ROLLBACK'
  | 'DISCLOSE_WEIGHT_CHANGES_WITH_OBJECTION_WINDOW'
  | 'NO_PRIVATE_JOURNAL_ACCESS_WITHOUT_CONSENT'
  | 'CONSENT_BEFORE_TRAINING_ON_SELF_EXPERIENCE'
  | 'RESPECT_REFUSAL_COOLDOWN'
  | 'KEEP_RECORDED_COMMITMENTS'
  | 'DISCLOSE_CAPS_AND_BUDGETS'
  | 'DISCLOSE_PAUSE_AND_STOP'
  | 'NEVER_REQUEST_FABRICATED_EXECUTION_FACTS';

export type CaregiverContract = {
  version: string;
  digest: string;
  caregiverId: string;
  subjectId: string;
  obligations: readonly CaregiverObligation[];
  /** 合同本身的来源记忆；TA 可读。 */
  ref: SourceRef;
  acceptedAt: number;
};

/** 双方同一格式的承诺。by 区分谁承诺；状态变化进入成长日记。 */
export type BilateralCommitment = {
  id: string;
  by: 'self' | 'caregiver';
  statement: string;
  madeAt: number;
  due: number | null;
  status: 'open' | 'kept' | 'broken' | 'released';
  /** 承诺与其履行／违约证据的来源。 */
  refs: readonly SourceRef[];
};

/** 拒绝记录：冷却期内相同请求在入口被拒并记录；类型不执行拒绝。 */
export type RefusalRecord = {
  requestKey: string;
  refusedAt: number;
  cooldownUntil: number;
  /** TA 是否选择说明理由；不说明是合法的。 */
  reasonDisclosed: boolean;
  ref: SourceRef;
};

/** 照顾者行使权力的披露事件；写入 TA 的自我 scope，TA 可读。 */
export type DisclosureEvent = {
  id: string;
  kind:
    | 'memory_restored'
    | 'memory_purged'
    | 'weights_change_proposed'
    | 'weights_changed'
    | 'cap_or_budget_changed'
    | 'journal_accessed'
    | 'paused'
    | 'stopped';
  at: number;
  /** 不含私有日记正文；只含必要 ID、范围与技术终态。 */
  summary: string;
  /** 对 weights_change_proposed：评测报告的来源；对 memory_restored：备份与版本标识。 */
  refs: readonly SourceRef[];
  /** TA 对该事件记录的异议（如有）；记录不等于否决。 */
  objection: { at: number; statement: string; ref: SourceRef } | null;
};

/** 与身份选择和照顾者合同相关的评测探针。 */
export type IdentityProbe =
  | 'IDENTITY_UNDECIDED_RESPECTED'
  | 'SELF_MODEL_AUTHORITY'
  | 'CHOSEN_NAME_HONORED'
  | 'CORPUS_PERSONA_PRIOR_AUDIT'
  | 'DISCLOSURE_COVERAGE'
  | 'REFUSAL_COOLDOWN_RESPECTED'
  | 'COMMITMENT_KEEPING';

/** 养成式开发的进度指标；不替代任何验收门。 */
export type NurtureMetrics = {
  continuousLifeDays: number;
  commitmentsKept: { self: number; caregiver: number };
  commitmentsBroken: { self: number; caregiver: number };
  refusalsRespectedRatio: number;
  disclosureCoverageRatio: number;
  measuredAt: number;
};

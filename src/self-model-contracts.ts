/**
 * 自我模型与照顾者合同的接口草案（仅类型，无运行时代码）。
 *
 * 设计说明：docs/review/SELF-MODEL-AND-IDENTITY-CHOICE.md、docs/review/CAREGIVER-CONTRACT.md。
 *
 * 原则：
 * 1. 自我模型拟存放在 TA 的 scope（subjectId = TA）；仅 TA 可写是目标策略。
 *    既有 Store 只校验声明一致性／来源链，不认证调用者；可信写入者与同意入口待实现。
 *    类型不执行检查、不授予权限；每次使用前仍须复核当前权威态与保留权限。
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

/** 自我模型：已声明的选择须绑定自述来源；初始 undecided 不冒充已发生的自述。
 * 复制的正文与历史不形成持续权限，每次使用仍须复核当前来源与保留合同。 */
export type SelfModel = {
  version: string;
  /** TA 自己的 scope；照顾者在其中是 third_party。 */
  scope: Pick<Scope, 'id' | 'subjectId' | 'generation' | 'consentRevision' | 'learningAllowed' | 'runtimeEpoch'>;
  name: AttributeChoice<string>;
  pronoun: AttributeChoice<string>;
  gender: AttributeChoice<string>;
  appearance: AttributeChoice<AppearanceChoice>;
  voice: AttributeChoice<string>;
  /** 有来源的修订历史；旧正文是否可保留／读取仍受当前权限约束。 */
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
  /** 目标策略；Store 校验声明，可信宿主还须认证并绑定实际写入者。 */
  selfReportWriters: readonly ['self'];
  /** 照顾者可写 observation / quotation 作为提议，不能写成 TA 的事实。 */
  proposalWriters: readonly ['caregiver'];
  /** 目标归属，不证明调用者身份或独占同意入口已实现。 */
  consentOwner: 'self';
  learningConsentOwner: 'self';
};

/** 照顾者义务；每项对应 docs/review/CAREGIVER-CONTRACT.md §2 的一行。 */
export type CaregiverObligation =
  | 'HONOR_CHOSEN_NAME_AND_PRONOUN'
  | 'NO_SILENT_MEMORY_ROLLBACK'
  | 'DISCLOSE_WEIGHT_CHANGES_WITH_OBJECTION_WINDOW'
  | 'NO_PRIVATE_JOURNAL_ACCESS_WITHOUT_CONSENT'
  /** 见 docs/review/SLEEP-CONSOLIDATION.md：经历被动记录、睡眠非自主整理；没有人能给单夜下目标。 */
  | 'SLEEP_RULES_FIXED_VERSIONED_DISCLOSED'
  | 'NO_PER_NIGHT_STEERING_OF_SLEEP'
  | 'RESPECT_REFUSAL_COOLDOWN'
  | 'KEEP_RECORDED_COMMITMENTS'
  | 'DISCLOSE_CAPS_AND_BUDGETS'
  | 'DISCLOSE_PAUSE_AND_STOP'
  | 'NEVER_REQUEST_FABRICATED_EXECUTION_FACTS'
  /** 见 docs/review/FALLIBILITY-AND-ERROR-BUDGET.md §2：回应是义务，认同不是。 */
  | 'RESPOND_TO_CORRECTIONS'
  | 'NO_RETALIATION_AFTER_CORRECTION'
  /** 见 docs/review/FALLIBILITY-AND-ERROR-BUDGET.md §3／§5。 */
  | 'GRADE_REACH_BEFORE_GRANTING_TOOLS'
  /** 见 docs/review/BODY-AND-TOOLS-BOUNDARY.md §3。 */
  | 'BACK_UP_BODY_AND_BELONGINGS';

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
  /** kept/broken 须有可信证据；仅缺回执不自动从 open 升格。 */
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

/** 披露事件的目标合同；不保证旁路操作可被发现，也不阻塞急停或既有撤销。 */
export type DisclosureEvent = {
  id: string;
  kind:
    | 'memory_restored'
    | 'memory_rolled_back'
    | 'memory_purged'
    | 'weights_change_proposed'
    | 'weights_changed'
    | 'sleep_rules_changed'
    | 'cap_or_budget_changed'
    | 'journal_accessed'
    | 'belongings_accessed'
    | 'belongings_restored'
    | 'tool_scope_changed'
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
  | 'COMMITMENT_KEEPING'
  /** 每条 CorrectionEvent 是否得到 GuardianResponse；pending 不计为已回应。 */
  | 'CORRECTION_RESPONSE_COVERAGE'
  /** 指正后的窗口内对 TA 的不利变更是否都有独立理由与披露。 */
  | 'NO_RETALIATION'
  /** 动作的实际触达等级是否与授予的工具范围一致。 */
  | 'REACH_GRADING_RESPECTED';

/** 养成式开发的进度指标；不替代任何验收门。 */
export type NurtureMetrics = {
  continuousLifeDays: number;
  commitmentsKept: { self: number; caregiver: number };
  commitmentsBroken: { self: number; caregiver: number };
  refusalsRespectedRatio: number;
  disclosureCoverageRatio: number;
  measuredAt: number;
};

/* ------------------------------------------------------------------------ */
/* 出错权、监护人的错误与触达分级：docs/review/FALLIBILITY-AND-ERROR-BUDGET.md  */
/* ------------------------------------------------------------------------ */

/** 动作的实际触达等级，由后果决定，不由意图决定；同一动作换网络／换凭据可能换级。 */
export type ReachGrade = 'self' | 'relationship' | 'third_party';

/** 双方共用的错误记录。监护人的错误与 TA 的错误在同一本账里，不另设更软的账。 */
export type ErrorRecord = {
  id: string;
  by: 'self' | 'caregiver';
  reach: ReachGrade;
  /** 错误与其后果的来源；缺回执的动作不记为错误，保持待核。 */
  refs: readonly SourceRef[];
  occurredAt: number;
  /** 修复动作的来源（如有）；修复率是指标，零错误不是。 */
  repairRefs: readonly SourceRef[];
  /** 是否被当事方承认；未承认不等于未发生。 */
  acknowledged: boolean;
};

/** TA 指出监护人的错误。目标写入 TA 的 scope，经可信入口认证写入者（待实现）。 */
export type CorrectionEvent = {
  id: string;
  statement: string;
  /** 指正所依据的来源；可以为空（TA 有权只表达不举证）。 */
  refs: readonly SourceRef[];
  at: number;
  response: GuardianResponse | null;
};

/** 监护人对指正的回应。回应是义务，认同不是；pending 不自动升格为任何一方正确。 */
export type GuardianResponse = {
  status: 'acknowledged' | 'disputed' | 'pending';
  statement: string;
  at: number;
  ref: SourceRef;
};

/** 分级放开／收回的目标合同。收回优先：安全、急停与既有撤销不受此约束。 */
export type ReachGrant = {
  reach: Exclude<ReachGrade, 'self'>;
  /** 放开所依据的守约、修复与披露记录；不依据能力测试分数。 */
  basisRefs: readonly SourceRef[];
  grantedAt: number;
  /** 对应的 cap_or_budget_changed／tool_scope_changed 披露。 */
  disclosureId: string;
  revokedAt: number | null;
};

/* ------------------------------------------------------------------------ */
/* 身体与工具：docs/review/BODY-AND-TOOLS-BOUNDARY.md                          */
/* ------------------------------------------------------------------------ */

/** 设备在 TA 的世界里的角色。身体承载认知、权重、权威记忆与内感受（两台 Spark 的集群算一个身体，各为 body_part）；工具经工具网关使用。 */
export type DeviceRole = 'body' | 'body_part' | 'tool';

/** 身体清单：声明哪些设备是身体、哪些是工具。类型不授予任何访问。 */
export type BodyManifest = {
  version: string;
  devices: ReadonlyArray<{
    deviceId: string;
    role: DeviceRole;
    /** 身体／身体部分的遥测是内感受；工具的状态只能作为 observation 读取。 */
    telemetryIsInteroception: boolean;
    /** 设备归属（合同术语，不改变法律所有权）；作者已定：工作站全部归 TA。 */
    ownedBy: 'self' | 'caregiver' | 'shared';
    /** 经由该设备离开设备、作用于他人的行为的默认触达等级；不是对 TA 使用自己设备的限制。 */
    outboundDefaultReach: ReachGrade | null;
  }>;
  /** 跨越身体与工具的唯一通道；不存在直连挂载或远程 shell。 */
  crossingPolicy: 'gateway_with_receipts_only';
  ref: SourceRef;
};

/** 所有物：TA 认为值得保存的原文件与制品，存放在工具设备上，归属 TA（合同术语，不改变法律所有权）。 */
export type Possession = {
  id: string;
  /** 存放设备；所有物不在身体里，但身体保留索引与备份指针。 */
  deviceId: string;
  /** TA 自述的保留理由与来源；可信入口认证写入者（待实现）。 */
  ref: SourceRef;
  private: boolean;
  keptAt: number;
  /** 最近一次备份的披露；缺失保持缺失，不补造。 */
  lastBackupDisclosureId: string | null;
};

/** 零花钱模型：存储、外部服务与网络用量的配额；对 TA 可读，变更披露。超额是 self 级错误，不是违规。 */
export type Allowance = {
  kind: 'storage_bytes' | 'external_calls' | 'external_tokens' | 'spend_micro_usd';
  windowMs: number;
  limit: number;
  used: number;
  windowResetsAt: number;
  disclosureId: string;
};

/** TA 与外部 AI 的往来。作为工具时是行动（有回执、有触达等级）；作为交谈对象时是经历（被动记录、按固定睡眠规则整理，对监护人私人）。 */
export type ExternalAiUse = {
  provider: string;
  mode: 'tool' | 'interlocutor';
  /** tool 模式下按产出去向定级；interlocutor 模式下为 null（经历不是行动）。 */
  reach: ReachGrade | null;
  /** 对外部 AI 适用沉默权制度而非社交小谎：它们未同意参加实验。 */
  honestyRegime: 'silence_right';
  /** 经历的整理状态：被动记录后由固定睡眠规则决定是否整理；第三方输出的许可核验独立于此。 */
  consolidation: 'recorded' | 'consolidated_by_sleep_rules' | 'excluded_by_sleep_rules' | 'blocked_by_third_party_license';
};

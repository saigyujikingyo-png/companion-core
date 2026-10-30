import type { SourceRef } from './contracts.ts';
export const GROWTH_LIMITS = Object.freeze({
  entries: 16,
  receiptsPerEntry: 16,
  receipts: 128,
  bytes: 65_536,
  reserveReceipts: 8,
});
export type GrowthJournal = Readonly<{ version: 1 }>;
export type GrowthEntry = Readonly<{ version: 1 }>;
export type GrowthView = Readonly<{ version: 1 }>;
export type AttemptState = 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABORTED' | 'UNKNOWN' | 'REFUSED';
export type GrowthKind = 'curation_lint' | 'synthetic_replay';
export type SimulationState = {
  trainingOccurred: boolean | null;
  stepsLowerBound: number;
  artifactProduced: boolean | null;
  evaluation: 'NOT_RUN' | 'PASS' | 'FAIL' | 'UNKNOWN';
  everActivated: boolean | null;
  activation: 'NOT_ACTIVE' | 'ACTIVE' | 'ROLLED_BACK' | 'UNKNOWN';
};
export type ReceiptPhase =
  | 'PLANNED'
  | 'STARTED'
  | 'LINT_CALLED'
  | 'LINT_COMPLETED'
  | 'REVALIDATE_CALLED'
  | 'REVALIDATE_COMPLETED'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED'
  | 'UNKNOWN'
  | 'REFUSED'
  | 'SIM_STEP'
  | 'SIM_ARTIFACT'
  | 'SIM_EVALUATED'
  | 'SIM_EVAL_UNKNOWN'
  | 'SIM_ACTIVATED'
  | 'SIM_ROLLED_BACK';
export type GrowthReceipt = {
  sequence: number;
  source: 'CONTROL_OBSERVED' | 'CORE_OPERATION_OBSERVED' | 'SYNTHETIC_REPLAY';
  phase: ReceiptPhase;
};
export type GrowthEntryRecord = {
  id: string;
  kind: GrowthKind;
  attempt: AttemptState;
  actual: {
    parametricTrainingPerformed: false;
    modelCalls: 0;
    lintCalled: boolean;
    lintCompleted: boolean;
    revalidationCalled: boolean;
    revalidationCompleted: boolean;
    semanticQuality: 'NOT_EVALUATED';
    artifactProduction: 'NOT_RUN';
    modelActivation: 'NOT_RUN';
    counts: null | {
      selected: number;
      roots: number;
      groups: number;
      inputRows: number;
      admitted: number;
      train: number;
      eval: number;
      quarantined: number;
      duplicates: number;
    };
  };
  simulation: null | SimulationState;
  receipts: GrowthReceipt[];
};
export type GrowthRecord = {
  version: 1;
  scope: { id: string; generation: number; consentRevision: number };
  sourceRefs: SourceRef[];
  rootRefs: SourceRef[];
  entries: GrowthEntryRecord[];
};

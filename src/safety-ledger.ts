import type { Safety } from './durable-codec.ts';
import { sha, validateIdentityBudget } from './durable-codec.ts';
import { validateSafetyState } from './anchored-codec.ts';
import type { VaultIdentity } from './anchored-codec.ts';
import { fail } from './validation.ts';
import { SafetySegment, assertColdClosure } from './safety-segment.ts';
import {
  COLD_SAFETY_PROFILE,
  MAX_COMPLETE_SAFETY,
  canonicalSafetyJSON,
  terminalEligible,
  validateHotEnvelope,
} from './safety-format.ts';
import type { HotSafetyEnvelope, OrderedSafetyEntry, SafetyEntry } from './safety-format.ts';

export function allHotSafety(safety: Safety): HotSafetyEnvelope {
  const { ingress, ...globals } = safety;
  return { version: 1, globals, ingress: ingress.map((entry, ordinal) => ({ ordinal, entry })) };
}
export function completeHotSafety(
  hot: HotSafetyEnvelope,
  cold: OrderedSafetyEntry[],
  identity: VaultIdentity,
  maxCalls: number,
): Safety {
  validateHotEnvelope(hot);
  validateIdentityBudget(identity.identity, maxCalls);
  if (
    identity.storageProfile !== COLD_SAFETY_PROFILE ||
    (identity.safetyCold === null ? cold.length !== 0 : cold.length !== identity.safetyCold?.entryCount)
  )
    fail('SAFETY_COLD_ROWS');
  const rows = [...hot.ingress, ...cold].sort((a, b) => a.ordinal - b.ordinal);
  if (
    rows.length > 8192 ||
    rows.some((row, i) => row.ordinal !== i) ||
    cold.some((row) => !terminalEligible(row.entry))
  )
    fail('SAFETY_HOT_ORDINAL');
  const safety = { ...hot.globals, ingress: rows.map((row) => row.entry) };
  validateSafetyState(safety, identity, maxCalls);
  if (Buffer.byteLength(canonicalSafetyJSON(safety)) > MAX_COMPLETE_SAFETY) fail('SAFETY_LOGICAL_LIMIT');
  return safety;
}
export function validateHotSnapshot(safety: Safety, hot: HotSafetyEnvelope, identity: VaultIdentity): void {
  validateHotEnvelope(hot);
  const ordinals = new Set(hot.ingress.map((row) => row.ordinal));
  const cold = safety.ingress.map((entry, ordinal) => ({ ordinal, entry })).filter((row) => !ordinals.has(row.ordinal));
  if (canonicalSafetyJSON(completeHotSafety(hot, cold, identity, safety.maxCalls)) !== canonicalSafetyJSON(safety))
    fail('SAFETY_LOGICAL_MISMATCH');
  const d = identity.safetyCold;
  if (
    d &&
    (sha(canonicalSafetyJSON(cold)) !== d.entryDigest ||
      cold.filter((r) => r.entry.reserved).length !== d.reservedCount ||
      cold.filter((r) => r.entry.state === 'unknown').length !== d.unknownCount)
  )
    fail('SAFETY_COLD_DIGEST');
}
/** One semantic ledger for old full snapshots and the new ordered partition. */
export class SafetyLedger {
  readonly #identity: VaultIdentity;
  readonly #maxCalls: number;
  readonly #hot: HotSafetyEnvelope;
  readonly #legacy: Safety | undefined;
  readonly #cold: SafetySegment | undefined;
  constructor(
    safety: Safety,
    identity: VaultIdentity,
    maxCalls: number,
    hot?: HotSafetyEnvelope,
    cold?: SafetySegment,
  ) {
    validateIdentityBudget(identity.identity, maxCalls);
    validateSafetyState(safety, identity, maxCalls);
    this.#identity = identity;
    this.#maxCalls = maxCalls;
    this.#cold = cold;
    this.#hot = hot ?? allHotSafety(safety);
    this.#legacy = identity.storageProfile === COLD_SAFETY_PROFILE ? undefined : safety;
    if (!this.#legacy && canonicalSafetyJSON(this.completeSafety()) !== canonicalSafetyJSON(safety))
      fail('SAFETY_LOGICAL_MISMATCH');
    if (this.#legacy && cold) fail('SAFETY_COLD_PROFILE');
  }
  get globals(): Omit<Safety, 'ingress'> {
    return this.#legacy ?? this.#hot.globals;
  }
  get hotCount(): number {
    return this.#hot.ingress.length;
  }
  get coldCount(): number {
    return this.#cold?.descriptor.entryCount ?? 0;
  }
  get count(): number {
    return this.hotCount + this.coldCount;
  }
  lookupRequest(key: string): SafetyEntry | undefined {
    return this.#hot.ingress.find((row) => row.entry.key === key)?.entry ?? this.#cold?.lookupRequest(key)?.entry;
  }
  lookupDelivery(id: string): SafetyEntry | undefined {
    return this.#hot.ingress.find((row) => row.entry.deliveryId === id)?.entry ?? this.#cold?.lookupDelivery(id)?.entry;
  }
  append(entry: SafetyEntry): void {
    if (this.count >= 8192) fail('ANCHOR_LIMIT');
    const ordinal = this.count;
    this.#hot.ingress.push({ ordinal, entry });
    this.#legacy?.ingress.push(entry);
  }
  boot(): void {
    for (const { entry } of this.#hot.ingress)
      if (['pending', 'ready', 'taken'].includes(entry.state)) entry.state = 'unknown';
    this.globals.lastAcknowledgedDeliveryId = null;
  }
  completeSafety(): Safety {
    if (this.#legacy) {
      validateSafetyState(this.#legacy, this.#identity, this.#maxCalls);
      return this.#legacy;
    }
    return completeHotSafety(this.#hot, this.#cold?.rows() ?? [], this.#identity, this.#maxCalls);
  }
  hotEnvelope(): HotSafetyEnvelope {
    this.completeSafety();
    return this.#hot;
  }
  coldRows(): OrderedSafetyEntry[] {
    return this.#cold?.rows() ?? [];
  }
  archivePartition(): { hot: HotSafetyEnvelope; cold: OrderedSafetyEntry[] } {
    const selected = this.#hot.ingress.filter((row) => terminalEligible(row.entry));
    if (!selected.length) fail('SAFETY_ARCHIVE_NO_TERMINALS');
    return {
      hot: {
        version: 1,
        globals: structuredClone(this.globals),
        ingress: structuredClone(this.#hot.ingress.filter((row) => !terminalEligible(row.entry))),
      },
      cold: [...this.coldRows(), ...structuredClone(selected)].sort((a, b) => a.ordinal - b.ordinal),
    };
  }
  assertColdClosure(): void {
    assertColdClosure(this.#identity);
  }
  close(): void {
    this.#cold?.close();
  }
}

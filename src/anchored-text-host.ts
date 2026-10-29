import { createHash } from 'node:crypto';
import type { AnchoredVault } from './anchored-vault.ts';
import type { Scope } from './contracts.ts';
import { CoupledSession } from './coupled-runtime.ts';
import type { InteractionResult, TextCommunicationPermission } from './coupled-runtime.ts';
import type { DurableEndogenousSession, DurableAcceptedEndogenousText } from './endogenous-durable.ts';
import type { EndogenousTextPort, EndogenousTextRequest, EndogenousEntry } from './endogenous-lifecycle.ts';
import { createEndogenousTextPort } from './endogenous-text.ts';
import type { HybridProfile } from './hybrid-profile.ts';
import { profileDigest } from './hybrid-profile.ts';
import type { InteractionResources } from './interaction.ts';
import type { CompanionPermissionSource } from './presence-policy.ts';
import type { RawTextPort } from './raw-text-http.ts';
import { fail } from './validation.ts';

type DeliveryOptions = { vault: AnchoredVault; scope: Scope; profile: HybridProfile;
  resources: InteractionResources; clock: () => number; onReady?: (result: InteractionResult) => void };

/** Internal shared assembly for accepted TEXT. No ingress, decision scheduling or new ledger. */
export class TextDeliveryLane {
  readonly #coupled: CoupledSession;
  readonly #options: DeliveryOptions;
  readonly #scope: Scope;
  readonly #digest: string;
  #closed = false;
  #lastReady: InteractionResult | null = null;
  #offered: { decisionId: string; permission: TextCommunicationPermission; claimed: boolean; ready: boolean;
    acknowledged: boolean; failed: boolean; deliveryId: string | null } | null = null;
  constructor(options: DeliveryOptions) {
    this.#options = Object.freeze({ ...options }); this.#scope = Object.freeze({ ...options.scope }); this.#digest = profileDigest(options.profile);
    const current = options.vault.store.scope(this.#scope.id);
    if ((Object.keys(current) as (keyof Scope)[]).some(key => current[key] !== this.#scope[key])) fail('E1_CONTROL_SCOPE');
    this.#coupled = new CoupledSession(options.vault.store, this.#scope, { durable: options.vault, resources: options.resources,
      clock: options.clock, provider: { interact: async () => fail('E2_INTERACTION_UNSUPPORTED') }, maxEntries: 64 });
  }
  dispatch(request: EndogenousTextRequest, codec: EndogenousTextPort): Promise<string> {
    const attempt = { decisionId: request.decisionId, permission: this.#coupled.captureEndogenousTextPermission(),
      claimed: false, ready: false, acknowledged: false, failed: false, deliveryId: null as string | null };
    this.#offered = attempt;
    return Promise.resolve().then(() => {
      request.validateCurrent();
      const fingerprint = createHash('sha256').update(JSON.stringify({ scope: this.#scope, digest: this.#digest, decisionId: request.decisionId })).digest('hex');
      this.#options.vault.claim(request.decisionId, fingerprint); attempt.claimed = true;
      request.validateCurrent(); this.#options.vault.reserve(request.decisionId); request.validateCurrent();
      return codec(request);
    });
  }
  accept(accepted: DurableAcceptedEndogenousText): boolean {
    if (this.#closed || this.#offered?.decisionId !== accepted.decisionId) return false;
    accepted.validateCurrent();
    const ready = this.#coupled.prepareEndogenousText({ decisionId: accepted.decisionId, text: accepted.text, scope: this.#scope,
      deadlineMonotonicMs: accepted.deadlineMonotonicMs, permission: this.#offered.permission,
      validate: () => { if (this.#closed) fail('E2_HOST_CLOSED'); return accepted.validateDelivery(); } });
    this.#lastReady = ready; this.#offered.ready = true; this.#offered.deliveryId = ready.deliveryId;
    // Run notification after the E1 exclusive frame; never renew the original authority.
    queueMicrotask(() => {
      if (this.#closed || this.#lastReady !== ready) return;
      try { this.#coupled.preparedAuthorization(ready.deliveryId); }
      catch { if (this.#lastReady === ready) this.#lastReady = null; return; }
      try { void Promise.resolve(this.#options.onReady?.(structuredClone(ready))).catch(() => {}); } catch { /* Isolated notification. */ }
    });
    return true;
  }
  settled(entry: EndogenousEntry): void { if (this.#offered?.decisionId === entry.decisionId && !this.#offered.ready) this.failUnfinished(); }
  failUnfinished(): void {
    const attempt = this.#offered;
    if (!attempt?.claimed || attempt.failed || attempt.acknowledged) return;
    attempt.failed = true; this.#options.vault.terminal(attempt.decisionId, 'failed', attempt.deliveryId);
  }
  /** Pure local revocation, including when called from the Vault's mutation guard. */
  revokeLocal(): void { this.#coupled.clearEndogenousTextWindow(); this.#lastReady = null; }
  grant(id: string, durationMs: number, source: CompanionPermissionSource): void { this.#coupled.grantEndogenousTextWindow(id, durationMs, source); }
  clear(): void { this.revokeLocal(); if (this.#offered?.ready) this.failUnfinished(); }
  resume(): void { this.#coupled.resume(); }
  pause(): void { this.#coupled.pause(); this.#lastReady = null; }
  reset(): void { this.#coupled.reset(); }
  close(): void { this.#closed = true; this.pause(); }
  take(id: string) { return this.#coupled.takeDelivery(id); }
  acknowledge(id: string) {
    return this.#coupled.acknowledgeDelivery(id, () => { if (this.#offered?.deliveryId === id) this.#offered.acknowledged = true; });
  }
  read(): InteractionResult | null { return structuredClone(this.#lastReady); }
}

/** Trusted in-process assembly; this is not the legacy DSH stdio/M2 deployment. */
export class AnchoredTextHost {
  readonly #session: DurableEndogenousSession;
  readonly #delivery: TextDeliveryLane;
  #closed = false;
  constructor(options: DeliveryOptions & { raw: RawTextPort }) {
    const scope = Object.freeze({ ...options.scope });
    const codec = createEndogenousTextPort(options.raw, options.profile);
    this.#delivery = new TextDeliveryLane({ ...options, scope });
    this.#session = options.vault.openEndogenousTextControl(request => this.#delivery.dispatch(request, codec),
      accepted => this.#delivery.accept(accepted), entry => this.#delivery.settled(entry), scope);
  }
  #live(): void { if (this.#closed) fail('E2_HOST_CLOSED'); }
  grantCommunicationWindow(id: string, durationMs: number, source: CompanionPermissionSource): void { this.#live(); this.#delivery.grant(id, durationMs, source); }
  clearCommunicationWindow(): void { this.#live(); this.#delivery.clear(); }
  resume(): void { this.#live(); this.#delivery.resume(); this.#session.resume(); }
  pause(): void { this.#live(); this.#delivery.pause(); this.#session.pause(); this.#delivery.failUnfinished(); }
  reset(): void { this.pause(); this.#delivery.reset(); }
  takeDelivery(id: string) { this.#live(); return this.#delivery.take(id); }
  /** Call only after actual native completion. Not feedback or reward. */
  acknowledgeNativeCompletion(id: string) { this.#live(); return this.#delivery.acknowledge(id); }
  read() { return { lifecycle: this.#session.read(), control: this.#session.readControl(), lastReady: this.#delivery.read() }; }
  close(): void { if (this.#closed) return; this.#closed = true; this.#delivery.close(); this.#session.close(); this.#delivery.failUnfinished(); }
}

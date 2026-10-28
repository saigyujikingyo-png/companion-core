import type { AnchoredVault } from './anchored-vault.ts';
import type { Scope } from './contracts.ts';
import { CoupledSession } from './coupled-runtime.ts';
import type { InteractionResult, TextCommunicationPermission } from './coupled-runtime.ts';
import type { DurableEndogenousSession } from './endogenous-durable.ts';
import { createEndogenousTextPort } from './endogenous-text.ts';
import type { HybridProfile } from './hybrid-profile.ts';
import { profileDigest } from './hybrid-profile.ts';
import type { InteractionResources } from './interaction.ts';
import type { CompanionPermissionSource } from './presence-policy.ts';
import type { RawTextPort } from './raw-text-http.ts';
import { fail } from './validation.ts';

/** Trusted in-process assembly. The caller owns this same Vault and raw transport
 * for their full lifetime. This is not the legacy DSH stdio/M2 deployment. */
export class AnchoredTextHost {
  readonly #session: DurableEndogenousSession;
  readonly #coupled: CoupledSession;
  readonly #vault: AnchoredVault;
  #closed = false;
  #lastReady: InteractionResult | null = null;
  #offered: { decisionId: string; permission: TextCommunicationPermission; claimed: boolean; ready: boolean;
    acknowledged: boolean; failed: boolean; deliveryId: string | null } | null = null;
  constructor(options: { vault: AnchoredVault; scope: Scope; raw: RawTextPort; profile: HybridProfile;
    resources: InteractionResources; clock: () => number; onReady?: (result: InteractionResult) => void }) {
    const scope = Object.freeze({ ...options.scope }), codec = createEndogenousTextPort(options.raw, options.profile);
    this.#vault = options.vault;
    const digest = profileDigest(options.profile);
    const current = options.vault.store.scope(scope.id);
    if ((Object.keys(current) as (keyof Scope)[]).some(key => current[key] !== scope[key])) fail('E1_CONTROL_SCOPE');
    this.#coupled = new CoupledSession(options.vault.store, scope, { durable: options.vault, resources: options.resources,
      clock: options.clock, provider: { interact: async () => fail('E2_INTERACTION_UNSUPPORTED') }, maxEntries: 64 });
    this.#session = options.vault.openEndogenousTextControl(request => {
      const attempt = { decisionId: request.decisionId, permission: this.#coupled.captureEndogenousTextPermission(),
        claimed: false, ready: false, acknowledged: false, failed: false, deliveryId: null as string | null };
      this.#offered = attempt;
      return Promise.resolve().then(() => {
        request.validateCurrent();
        const fingerprint = createHash('sha256').update(JSON.stringify({ scope, digest, decisionId: request.decisionId })).digest('hex');
        this.#vault.claim(request.decisionId, fingerprint); attempt.claimed = true;
        request.validateCurrent();
        this.#vault.reserve(request.decisionId);
        request.validateCurrent();
        return codec(request);
      });
    }, accepted => {
      if (this.#closed || this.#offered?.decisionId !== accepted.decisionId) return false;
      accepted.validateCurrent();
      const ready = this.#coupled.prepareEndogenousText({ decisionId: accepted.decisionId, text: accepted.text, scope,
        deadlineMonotonicMs: accepted.deadlineMonotonicMs, permission: this.#offered.permission,
        validate: () => { if (this.#closed) fail('E2_HOST_CLOSED'); return accepted.validateDelivery(); } });
      this.#lastReady = ready;
      this.#offered.ready = true; this.#offered.deliveryId = ready.deliveryId;
      // Run host callbacks after the E1 exclusive settlement frame has returned.
      // A queued notification never extends or revives the original delivery authority.
      queueMicrotask(() => {
        if (this.#closed || this.#lastReady !== ready) return;
        try { this.#coupled.preparedAuthorization(ready.deliveryId); }
        catch { if (this.#lastReady === ready) this.#lastReady = null; return; }
        // Metadata only; ordinary asynchronous notification failures are isolated too.
        try { void Promise.resolve(options.onReady?.(structuredClone(ready))).catch(() => {}); } catch { /* Ready remains locally available. */ }
      });
      return true;
    }, entry => { if (this.#offered?.decisionId === entry.decisionId && !this.#offered.ready) this.#failUnfinished(); });
  }
  #failUnfinished(): void {
    const attempt = this.#offered;
    if (!attempt?.claimed || attempt.failed || attempt.acknowledged) return;
    attempt.failed = true;
    this.#vault.terminal(attempt.decisionId, 'failed', attempt.deliveryId);
  }
  #live(): void { if (this.#closed) fail('E2_HOST_CLOSED'); }
  grantCommunicationWindow(id: string, durationMs: number, source: CompanionPermissionSource): void {
    this.#live(); this.#coupled.grantEndogenousTextWindow(id, durationMs, source);
  }
  clearCommunicationWindow(): void { this.#live(); this.#coupled.clearEndogenousTextWindow(); this.#lastReady = null;
    if (this.#offered?.ready) this.#failUnfinished(); }
  resume(): void { this.#live(); this.#coupled.resume(); this.#session.resume(); }
  pause(): void { this.#live(); this.#coupled.pause(); this.#lastReady = null; this.#session.pause(); this.#failUnfinished(); }
  reset(): void { this.pause(); this.#coupled.reset(); }
  takeDelivery(id: string) { this.#live(); return this.#coupled.takeDelivery(id); }
  /** Call only after the actual native consumer confirms completion. Not feedback/reward. */
  acknowledgeNativeCompletion(id: string) {
    this.#live();
    // An ACK is irreversible even if its synchronous commit crosses the delivery deadline.
    return this.#coupled.acknowledgeDelivery(id, () => { if (this.#offered?.deliveryId === id) this.#offered.acknowledged = true; });
  }
  read() { return { lifecycle: this.#session.read(), control: this.#session.readControl(), lastReady: structuredClone(this.#lastReady) }; }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#coupled.pause(); this.#lastReady = null; this.#session.close(); this.#failUnfinished();
  }
}
import { createHash } from 'node:crypto';

import type { AnchoredVault } from './anchored-vault.ts';
import type { Scope } from './contracts.ts';
import type { InteractionResult } from './coupled-runtime.ts';
import { TextDeliveryLane } from './anchored-text-host.ts';
import { messageString, copyMessageInput } from './endogenous-durable.ts';
import type { DurableMessageSession, MessageBinding, MessageInput, MessageReceipt } from './endogenous-durable.ts';
import { createMessageChoicePort } from './message-choice.ts';
import type { HybridProfile } from './hybrid-profile.ts';
import type { InteractionResources } from './interaction.ts';
import type { CompanionPermissionSource } from './presence-policy.ts';
import type { RawTextPort } from './raw-text-http.ts';
import { fail } from './validation.ts';

/** SINGLE_MESSAGE_CONTROL_PROTOTYPE: one lifetime inbound slot, one explicit consideration.
 * The trusted caller authenticates origin/route before construction. No AgentAPI mount or executor. */
export class AnchoredMessageHost {
  readonly #session: DurableMessageSession;
  readonly #delivery: TextDeliveryLane;
  #body: MessageInput | null = null;
  #closed = false;
  constructor(options: { vault: AnchoredVault; scope: Scope; binding: MessageBinding; raw: RawTextPort; profile: HybridProfile;
    resources: InteractionResources; clock: () => number; onReady?: (result: InteractionResult) => void }) {
    const scope = Object.freeze({ ...options.scope });
    messageString(options.binding.origin, 128); messageString(options.binding.route, 128);
    const binding = Object.freeze({ origin: options.binding.origin, route: options.binding.route });
    const codec = createMessageChoicePort(options.raw, options.profile, binding);
    this.#delivery = new TextDeliveryLane({ ...options, scope });
    this.#session = options.vault.openEndogenousMessageControl(binding, request => {
      const input = this.#body ?? fail('E3_BODY_UNAVAILABLE');
      return this.#delivery.dispatch(request, current => codec(current, input));
    }, accepted => this.#delivery.accept(accepted), entry => this.#delivery.settled(entry),
    () => { this.#body = null; this.#delivery.revokeLocal(); }, scope);
  }
  #live(): void { if (this.#closed) fail('E3_HOST_CLOSED'); }
  receive(input: MessageInput): MessageReceipt {
    this.#live();
    input = copyMessageInput(input);
    const result = this.#session.receive(input);
    if (result.fresh) this.#body = Object.freeze({ messageId: input.messageId, text: input.text, expiresAt: input.expiresAt });
    return result.receipt;
  }
  consider(): void {
    this.#live(); if (!this.#body) fail('E3_BODY_UNAVAILABLE');
    try { this.#delivery.resume(); this.#session.consider(); } finally { this.#body = null; }
  }
  grantCommunicationWindow(id: string, durationMs: number, source: CompanionPermissionSource): void { this.#live(); this.#delivery.grant(id, durationMs, source); }
  clearCommunicationWindow(): void { this.#live(); this.#delivery.clear(); }
  /** Revokes the original RAM admission/output; same-message receive cannot replenish it. */
  withdraw(): void { this.pause(); }
  pause(): void {
    this.#live(); this.#body = null; this.#delivery.revokeLocal();
    try { this.#delivery.pause(); } finally { this.#session.pause(); this.#delivery.failUnfinished(); }
  }
  takeDelivery(id: string) { this.#live(); return this.#delivery.take(id); }
  /** Trusted call only after actual native consumer completion; no reward or execution receipt. */
  acknowledgeNativeCompletion(id: string) { this.#live(); return this.#delivery.acknowledge(id); }
  read() { return { prototype: 'SINGLE_MESSAGE_CONTROL_PROTOTYPE' as const, receipt: this.#session.receipt(),
    bodyAvailable: this.#body !== null, lifecycle: this.#session.read(), control: this.#session.readControl(), lastReady: this.#delivery.read() }; }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#body = null; this.#delivery.revokeLocal();
    try { this.#delivery.close(); } finally { this.#session.close(); this.#delivery.failUnfinished(); }
  }
}

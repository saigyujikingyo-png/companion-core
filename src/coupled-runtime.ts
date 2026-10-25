import { createHash, randomUUID } from 'node:crypto';
import type { Epoch, MemoryRecord, Proposal, RunTicket, SourceRef } from './contracts.ts';
import { BackgroundState } from './background-state.ts';
import type { BackgroundView, ShadowIntent } from './background-state.ts';
import { MemoryStore } from './store.ts';
import { bounded, timeoutMs } from './runtime.ts';
import { CoreError, fail, text } from './validation.ts';
import { InteractionResources, interactionResponse, validatePrior } from './interaction.ts';
import type { BackendMode, InteractionProvider, Prior, PriorAdapter, RecallAudit } from './interaction.ts';
import type { DurableMemory } from './durable-memory.ts';

export type UserInteraction = { sessionId: string; id: string; selectedText: string; recallQuery?: string;
  feedback?: { deliveryId: string; outcome: 'engaged' | 'declined' | 'neutral' } };
export type LocalDelivery = { sessionId: string; deliveryId: string; requestId: string; kind: 'user' | 'proactive';
  text: string; sourceRefs: SourceRef[]; recall: RecallAudit[]; appraisalStatus: 'applied' | 'not-applied';
  memoryRef: null; memoryCandidate: Proposal | null; backend: BackendMode; expiresAtMonotonicMs: number };
export type InteractionResult = { sessionId: string; requestId: string; deliveryId: string;
  status: 'ready' | 'taken' | 'acknowledged'; recall: RecallAudit[]; appraisalStatus: LocalDelivery['appraisalStatus'] };
type PendingInput = { hash: string; result?: InteractionResult; failed: boolean };
type DeliveryEntry = { value: LocalDelivery; generation: number; contextRevision: number;
  status: 'ready' | 'taken' | 'acknowledged' | 'cancelled'; feedbackId: string | null; schedulerVersion:number|null };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refKey = (ref: SourceRef) => `${ref.id}:${ref.revision}`;
// Process-lifetime ownership is outside sessions/resources. A retired worker is
// never relabelled as a new clean binding, including after authority revocation.
const priorOwners = new WeakMap<PriorAdapter,{owner:string;poisoned:boolean}>();
const zeroPrior: Prior = Object.freeze({social:0,novelty:0,disengagement:0});
function notify<T>(callback:(value:T)=>void,value:T):void {
  try { void Promise.resolve(callback(value)).catch(()=>{}); } catch { /* Consumer failure cannot crash the runtime. */ }
}

/** Literal, auditable prototype features; no semantic classifier or user-emotion claim. */
export function recallFeatures(statement: string): Prior {
  return { social: /一起|聊|交流|朋友|陪|together|chat|friend|social/i.test(statement) ? 1 : 0,
    disengagement: /安静|独处|休息|暂停|quiet|alone|rest|pause/i.test(statement) ? 1 : 0,
    novelty: /新|探索|学习|new|explor|learn/i.test(statement) ? 1 : 0 };
}
export function rankLegalMemories(records: MemoryRecord[], prior: Prior, neural: Prior | null): RecallAudit[] {
  validatePrior(prior); if (neural) validatePrior(neural);
  const scores = records.map((record,i) => {
    const features = recallFeatures(record.statement), beforeScore = 1 - i * 0.000001;
    const bias = (p: Prior) => p.social * features.social + p.disengagement * features.disengagement + p.novelty * features.novelty;
    return { ref:{id:record.id,revision:record.revision}, statement:record.statement, basis:record.basis,
      beforeRank:i + 1, afterRank:0, beforeScore, afterScore:beforeScore + bias(prior) + (neural ? 0.25 * bias(neural) : 0), features };
  });
  scores.sort((a,b) => b.afterScore-a.afterScore || a.beforeRank-b.beforeRank);
  return scores.map((entry,i) => ({...entry,afterRank:i+1}));
}

/** Trusted coordinator with optional durable memory/safety authority. Runtime
 * bindings stay ephemeral; no automatic rebind or credential access. ACK is not engagement. */
export class CoupledSession {
  readonly sessionId = randomUUID();
  readonly #store: MemoryStore; readonly #ticket: RunTicket; readonly #clock: () => number;
  readonly #provider: InteractionProvider; readonly #resources: InteractionResources;
  readonly #duration: number; readonly #maxEntries: number;
  readonly #durable: DurableMemory | undefined;
  #lastSourceRef: SourceRef | null = null; #lastAcknowledgedDeliveryId: string | null = null;
  #lastMemoryRef: SourceRef | null = null;
  #state: BackgroundState; #backend: BackendMode; #adapter: PriorAdapter | undefined;
  #adapterNeedsReset = true; #neuralRefs = new Map<string,SourceRef>();
  #last = 0; #lastNeural = 0; #generation = 1; #contextRevision = 0; #paused = true; #invalid = false;
  #host = { quiet:true, available:false, expiresAt:0 };
  #inputs = new Map<string,PendingInput>(); #deliveries = new Map<string,DeliveryEntry>(); #intents = new Set<string>();
  #pending: AbortController | null = null; #timer: ReturnType<typeof setTimeout> | undefined;
  #schedulerVersion = 0; #pendingSchedulerVersion: number | null = null;
  #scheduler: { recallQuery:string; onReady:(result:InteractionResult) => void; onError:(code:string) => void;
    refreshContext:() => {quiet:boolean;available:boolean;ttlMs:number} } | undefined;
  constructor(store: MemoryStore, epoch: Epoch, options: { provider: InteractionProvider; resources: InteractionResources;
    backend?: BackendMode; priorAdapter?: PriorAdapter; clock?: () => number; timeoutMs?: number; maxEntries?: number; durable?: DurableMemory }) {
    this.#durable = options.durable;
    this.#store = store; this.#ticket = Object.freeze({...store.beginRun(epoch)}); store.validateRun(this.#ticket);
    this.#clock = options.clock ?? (() => performance.now()); this.#provider = options.provider; this.#resources = options.resources;
    this.#duration = timeoutMs(options.timeoutMs ?? 30_000); this.#maxEntries = options.maxEntries ?? 128;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1 || this.#maxEntries > 256) fail('INVALID_SESSION_CAPACITY');
    this.#backend = options.backend ?? 'baseline'; this.#adapter = options.priorAdapter;
    this.#validateBackend(this.#backend,this.#adapter); this.#claimAdapter(this.#adapter); this.#last = this.#now(); this.#lastNeural = this.#last;
    this.#state = this.#newState(); this.#state.pause();
  }
  #validateBackend(mode: BackendMode, adapter?: PriorAdapter): void {
    if (!['baseline','no-state','flywire'].includes(mode) || (mode === 'flywire' && !adapter)) fail('BACKEND_UNAVAILABLE');
    if (adapter && (adapter.manifest.biologicalClaim !== 'none' || !/^[a-f0-9]{64}$/.test(adapter.manifest.sourceHash))) fail('INVALID_NEURAL_MANIFEST');
  }
  #newState(): BackgroundState { return new BackgroundState(this.#store,this.#ticket,{clock:this.#clock,ablation:this.#backend === 'no-state' ? 'no-state':'none'}); }
  #claimAdapter(adapter?: PriorAdapter): void {
    if (!adapter) return;
    const owner = priorOwners.get(adapter);
    if (owner && (owner.owner !== this.sessionId || owner.poisoned)) fail('NEURAL_BINDING_REUSE_FORBIDDEN');
    if (!owner) priorOwners.set(adapter,{owner:this.sessionId,poisoned:false});
  }
  #poisonAdapter(): void { if (this.#adapter) { const owner = priorOwners.get(this.#adapter); if (owner) owner.poisoned = true; } }
  #now(): number {
    const now = this.#clock();
    if (!Number.isFinite(now) || now < this.#last || now > Number.MAX_SAFE_INTEGER) { this.#invalidate(); fail('SESSION_CLOCK_INVALID'); }
    this.#last = now; return now;
  }
  #cancel(): void {
    this.#generation++; this.#pending?.abort(); this.#adapterNeedsReset = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer); this.#timer = undefined;
    for (const delivery of this.#deliveries.values()) delivery.status = 'cancelled';
  }
  #invalidate(): void { this.#invalid = true; this.#paused = true; this.#cancel(); this.#poisonAdapter(); }
  #guard(requireContext = false, allowPaused = false): number {
    if (this.#durable) void this.#durable.status;
    if (this.#invalid) fail('SESSION_REBIND_REQUIRED');
    const now = this.#now();
    try { this.#store.validateRun(this.#ticket); this.#state.read(); }
    catch(error) { this.#invalidate(); throw error; }
    if (this.#host.available && now >= this.#host.expiresAt) {
      this.#host = {...this.#host,available:false}; this.#contextRevision++; this.#cancel();
      this.#state.setContext({quiet:this.#host.quiet,available:false});
    }
    if (this.#paused && !allowPaused) fail('SESSION_PAUSED');
    if (requireContext && (this.#host.quiet || !this.#host.available)) fail('HOST_CONTEXT_BLOCKED');
    return now;
  }
  #validateRefs(refs: SourceRef[]): void {
    this.#store.validateRun(this.#ticket);
    for (const ref of refs) if (!this.#store.read(this.#ticket,ref)) { this.#invalidate(); fail('INTERACTION_SOURCE_INVALID'); }
  }
  #publish(refs: SourceRef[], proposal: Proposal): SourceRef {
    const job = this.#store.beginJob(this.#ticket,refs), lease = this.#store.claimLease(this.#ticket,job.id);
    try { this.#store.propose(this.#ticket,job.id,lease.token,proposal); return {id:this.#store.publish(this.#ticket,job.id,lease.token).id,revision:1}; }
    catch(error) { this.#store.abandonJob(job,lease.token); throw error; }
  }
  setHostContext(context: { quiet:boolean; available:boolean; ttlMs:number }): void {
    if (this.#invalid) fail('SESSION_REBIND_REQUIRED');
    if (typeof context.quiet !== 'boolean' || typeof context.available !== 'boolean' || !Number.isSafeInteger(context.ttlMs)
      || context.ttlMs < 1 || context.ttlMs > 300_000) fail('INVALID_HOST_CONTEXT');
    const now = this.#now(); this.#store.validateRun(this.#ticket);
    // An expired availability lease cannot be revived around an in-flight action.
    const expired = this.#host.available && now >= this.#host.expiresAt;
    if (expired || context.quiet !== this.#host.quiet || context.available !== this.#host.available) { this.#contextRevision++; this.#cancel(); }
    this.#host = {quiet:context.quiet,available:context.available,expiresAt:now+context.ttlMs};
    this.#state.setContext(context); this.#arm();
  }
  resume(): void {
    if (this.#invalid) fail('SESSION_REBIND_REQUIRED');
    if (!this.#paused) { this.#guard(); return; }
    this.#store.validateRun(this.#ticket); this.#claimAdapter(this.#adapter); this.#state.resume(); this.#paused = false; this.#generation++; this.#arm();
  }
  pause(): void { this.#paused = true; this.#cancel(); if (!this.#invalid) this.#state.pause(); }
  reset(): void { this.#guard(false,true); this.#cancel(); this.#state.reset(); this.#arm(); }
  async switchBackend(mode: BackendMode, adapter?: PriorAdapter): Promise<void> {
    this.#guard(false,true); this.#validateBackend(mode,adapter); this.#claimAdapter(adapter); this.#cancel(); this.#state.pause();
    if (adapter !== this.#adapter) this.#poisonAdapter();
    // Reset both outgoing and incoming workers. Raw neural permit is shared across bindings.
    const generation = this.#generation; this.#paused = true;
    try {
      await bounded(new AbortController().signal,this.#duration,signal => this.#resources.neural.run(signal,async () => {
        await this.#adapter?.reset(); if (adapter !== this.#adapter) await adapter?.reset();
      }));
      this.#store.validateRun(this.#ticket);
      if (generation !== this.#generation || this.#invalid) fail('INTERACTION_STALE');
      this.#backend = mode; this.#adapter = adapter; this.#state = this.#newState();
      this.#state.setContext({quiet:this.#host.quiet,available:this.#host.available}); this.#state.pause();
      this.#lastNeural = this.#now(); this.#adapterNeedsReset = false; this.#neuralRefs.clear();
    } catch(error) { this.#paused = true; throw error; }
    // Explicit resume required; consumed ingress/delivery IDs and shared permits/budget survive.
  }
  revoke(ref: SourceRef): void { this.#guard(false,true); this.#store.revoke(this.#ticket,ref); this.#invalidate(); }
  purge(): void { this.#guard(false,true); this.#store.purge(this.#ticket); this.#invalidate(); }
  setLearningConsent(allowed: boolean): void { this.#guard(false,true); this.#store.setLearningConsent(this.#ticket,allowed); this.#invalidate(); }
  get status() { return {sessionId:this.sessionId,backend:this.#backend,paused:this.#paused,invalidated:this.#invalid,
    entries:this.#inputs.size,deliveries:this.#deliveries.size,rawActive:this.#resources.calls.active,
    transportActive:this.#resources.transport.active,budget:this.#resources.budget.usage,
    lastSourceRef:this.#lastSourceRef??this.#durable?.status.lastSourceRef??null,lastMemoryRef:this.#lastMemoryRef,
    lastAcknowledgedDeliveryId:this.#lastAcknowledgedDeliveryId,requestAudit:this.#resources.lastRequestAudit}; }
  validateFeedback(deliveryId: string): void {
    const entry = this.#delivery(deliveryId);
    if (entry.status !== 'acknowledged') fail('FEEDBACK_REQUIRES_DELIVERED_RECEIPT');
    if (entry.feedbackId !== null) fail('DELIVERY_FEEDBACK_ALREADY_CONSUMED');
  }
  background(): BackgroundView { this.#guard(); return this.#state.read(); }
  recall(query: string): RecallAudit[] {
    this.#guard(); text(query,256);
    const records = this.#store.search(this.#ticket,query,6);
    this.#validateRefs(records); return rankLegalMemories(records,this.#backend === 'no-state' ? zeroPrior:this.#state.read().attentionPrior,null);
  }
  async submit(input: UserInteraction): Promise<InteractionResult> {
    this.#guard(true);
    if (input.sessionId !== this.sessionId) fail('SESSION_TOKEN_MISMATCH');
    text(input.id,128); text(input.selectedText,4096); if (input.recallQuery !== undefined) text(input.recallQuery,256);
    if (input.feedback) { text(input.feedback.deliveryId,128); if (!['engaged','declined','neutral'].includes(input.feedback.outcome)) fail('INVALID_FEEDBACK'); }
    const fingerprint = hash([input.selectedText,input.recallQuery ?? null,input.feedback ?? null]);
    const previous = this.#inputs.get(input.id);
    if (previous) {
      if (previous.hash !== fingerprint) fail('INTERACTION_IDEMPOTENCY_CONFLICT');
      if (previous.failed) fail('INTERACTION_TERMINATED');
      if (!previous.result) fail('INTERACTION_IN_PROGRESS');
      const entry = this.#delivery(previous.result.deliveryId);
      return {...structuredClone(previous.result),status:entry.status as InteractionResult['status']};
    }
    if (this.#inputs.size >= this.#maxEntries || this.#deliveries.size >= this.#maxEntries) fail('SESSION_CAPACITY_REACHED');
    this.#durable?.claim(input.id,fingerprint);
    const ledger: PendingInput = {hash:fingerprint,failed:false}; this.#inputs.set(input.id,ledger);
    try {
      if (this.#pending || this.#resources.calls.active || this.#resources.neural.active) fail('INTERACTION_BACKPRESSURE');
      let feedback: DeliveryEntry | undefined;
      if (input.feedback) {
        feedback = this.#delivery(input.feedback.deliveryId);
        if (feedback.status !== 'acknowledged') fail('FEEDBACK_REQUIRES_DELIVERED_RECEIPT');
        if (feedback.feedbackId !== null) fail('DELIVERY_FEEDBACK_ALREADY_CONSUMED');
      }
      const scope = this.#store.scope(this.#ticket.id);
      const event = this.#store.acceptEvent(this.#ticket,{source:this.#durable?'coupled:durable-v1':`coupled:${this.sessionId}`,eventKey:input.id,evidence:{
        speakerId:scope.subjectId,speakerRole:'subject',mode:'self_report',selectedText:input.selectedText,occurredAt:null}});
      const anchor = this.#publish([event],{kind:'episode',basis:'self_report',statement:input.selectedText,validFrom:null,validTo:null});
      this.#lastSourceRef = {id:event.id,revision:event.revision}; this.#lastMemoryRef=anchor; this.#durable?.source(this.#lastSourceRef);
      this.#state.observe({id:`observe:${input.id}`,refs:[anchor],novelty:0,socialRelevance:0,demand:0});
      if (feedback && input.feedback) {
        this.#durable?.consumeFeedback(input.feedback.deliveryId);
        this.#guard(true);
        this.#state.recordOutcome({id:`feedback:${input.id}`,ref:anchor,origin:'external-observation',outcome:input.feedback.outcome});
        feedback.feedbackId = input.id;
      }
      const result = await this.#perform({requestId:input.id,selectedText:input.selectedText,query:input.recallQuery,
        anchor,event,kind:'user',motive:null});
      ledger.result = result; return structuredClone(result);
    } catch(error) { ledger.failed = true; this.#durable?.terminal(input.id,'failed'); throw error; }
    finally { this.#arm(); }
  }
  considerShadow(): ShadowIntent | null { this.#guard(true); return this.#state.consider().intent; }
  async considerProactive(query: string, suppliedIntent?: ShadowIntent): Promise<InteractionResult | null> {
    return this.#proactive(query,suppliedIntent,null);
  }
  async #proactive(query: string, suppliedIntent: ShadowIntent | undefined, schedulerVersion:number|null): Promise<InteractionResult | null> {
    this.#guard(true); text(query,256);
    if (this.#pending || this.#resources.calls.active || this.#resources.neural.active) fail('INTERACTION_BACKPRESSURE');
    const intent = suppliedIntent ?? this.#state.consider().intent; if (!intent) { this.#arm(); return null; }
    this.#state.validateIntent(intent);
    if (this.#intents.has(intent.id)) fail('INTENT_ALREADY_CONSUMED');
    if (this.#intents.size >= this.#maxEntries || this.#deliveries.size >= this.#maxEntries) fail('SESSION_CAPACITY_REACHED');
    this.#intents.add(intent.id); // Single acceptance while the original five-second seal is still valid.
    if (intent.motive === 'withdrawal') { this.#arm(); return null; } // Reduce engagement without generating another message.
    const requestId = `proactive:${intent.id}`;
    this.#durable?.claim(requestId,hash([query,intent.id]));
    try { return await this.#perform({requestId,selectedText:null,query,kind:'proactive',motive:intent.motive,schedulerVersion}); }
    catch (error) { this.#durable?.terminal(requestId,'failed'); throw error; }
    finally { this.#arm(); }
  }
  async #perform(input: {requestId:string;selectedText:string|null;query:string|undefined;anchor?:SourceRef;event?:SourceRef;
    kind:'user'|'proactive';motive:'affiliation'|'withdrawal'|null;schedulerVersion?:number|null}): Promise<InteractionResult> {
    const startedAt = this.#guard(true), generation = this.#generation, contextRevision = this.#contextRevision;
    const deadline = startedAt + this.#duration; // Never refreshed by heartbeat or re-validating a shadow token.
    const controller = new AbortController(); this.#pending = controller; this.#pendingSchedulerVersion = input.schedulerVersion ?? null;
    const valid = () => { const now = this.#guard(true); if (controller.signal.aborted || generation !== this.#generation
      || contextRevision !== this.#contextRevision || now >= deadline) fail('INTERACTION_STALE'); };
    try {
      const background = this.#state.read();
      const records = input.query === undefined ? [] : this.#store.search(this.#ticket,input.query,6);
      let refs = [...new Map([...(input.anchor ? [input.anchor]:[]), ...records.map(r => ({id:r.id,revision:r.revision})),
        ...(this.#backend === 'no-state' ? [] : background.sourceRefs)]
        .map(ref => [refKey(ref),ref])).values()];
      if (input.kind === 'proactive' && refs.length === 0) fail('PROACTIVE_SOURCE_REQUIRED');
      this.#validateRefs(refs);
      let neural: Prior | null = null;
      if (this.#backend === 'flywire') {
        this.#claimAdapter(this.#adapter);
        const dtMs = Math.min(startedAt-this.#lastNeural,300_000);
        neural = validatePrior(await bounded(controller.signal,Math.min(this.#duration,5_000),signal => this.#resources.neural.run(signal,async () => {
          if (this.#adapterNeedsReset) {
            await this.#adapter!.reset(); valid(); signal.throwIfAborted(); this.#neuralRefs.clear(); this.#adapterNeedsReset = false;
          }
          const combined = new Map([...this.#neuralRefs,...refs.map(ref => [refKey(ref),ref] as const)]);
          if (combined.size > 128) fail('NEURAL_SOURCE_CAPACITY');
          refs = [...combined.values()]; this.#validateRefs(refs); this.#neuralRefs = combined;
          try { return await this.#adapter!.step({dtMs,features:background.attentionPrior,signal}); }
          catch(error) { this.#adapterNeedsReset = true; throw error; }
        })));
        this.#lastNeural = this.#now(); valid(); this.#validateRefs(refs);
      }
      const recall = rankLegalMemories(records,this.#backend === 'no-state' ? zeroPrior:background.attentionPrior,neural);
      const remaining = Math.max(1,Math.floor(deadline-this.#now())); valid();
      const response = bounded(controller.signal,remaining,signal => this.#resources.calls.run(signal,() => this.#provider.interact({
        sessionId:this.sessionId,requestId:input.requestId,kind:input.kind,selectedText:input.selectedText,recalled:structuredClone(recall),
        engineeredPrior:{background:this.#backend === 'no-state' ? null:structuredClone(background),neural,backend:this.#backend},motive:input.motive,signal,validateBeforeSend:valid}))).then(interactionResponse);
      // Only a fresh user stimulus can produce a new appraisal. Recalled/generated text never rewards itself.
      const appraisal = input.anchor ? this.#state.appraise({id:`appraise:${input.requestId}`,refs:[input.anchor],
        conditioningRefs:refs},async () => (await response).appraisal)
        .then(() => 'applied' as const,() => 'not-applied' as const) : Promise.resolve('not-applied' as const);
      const value = await response, appraisalStatus = await appraisal;
      valid(); this.#validateRefs(refs);
      // A coupled response has seen recalled facts and historical priors. It
      // cannot prove extraction solely from selectedText; retain the optional
      // proposal as an uncommitted candidate, never a new self-report fact.
      valid(); this.#validateRefs(refs);
      const deliveryId = randomUUID();
      const delivery: LocalDelivery = {sessionId:this.sessionId,deliveryId,requestId:input.requestId,kind:input.kind,text:value.responseText,
        sourceRefs:refs,recall,appraisalStatus,memoryRef:null,memoryCandidate:value.memoryProposal,
        backend:this.#backend,expiresAtMonotonicMs:deadline};
      this.#durable?.terminal(input.requestId,'ready',deliveryId);
      valid(); this.#validateRefs(refs);
      this.#deliveries.set(deliveryId,{value:delivery,generation,contextRevision,status:'ready',feedbackId:null,schedulerVersion:input.schedulerVersion??null});
      return {sessionId:this.sessionId,requestId:input.requestId,deliveryId,status:'ready',recall,appraisalStatus};
    } catch(error) { if (this.#backend === 'flywire') this.#adapterNeedsReset = true; throw error; }
    finally { if (this.#pending === controller) { this.#pending = null; this.#pendingSchedulerVersion = null; } }
  }
  #delivery(id: string): DeliveryEntry {
    const now = this.#guard(true), entry = this.#deliveries.get(id);
    if (!entry || entry.status === 'cancelled' || entry.generation !== this.#generation || entry.contextRevision !== this.#contextRevision)
      fail('DELIVERY_STALE');
    // Delivered receipts remain usable for feedback; undelivered payloads expire.
    if (entry.status !== 'acknowledged' && now >= entry.value.expiresAtMonotonicMs) { entry.status = 'cancelled'; fail('DELIVERY_EXPIRED'); }
    this.#validateRefs(entry.value.sourceRefs); return entry;
  }
  takeDelivery(id: string): LocalDelivery {
    const entry = this.#delivery(id); if (entry.status !== 'ready') fail('DELIVERY_ALREADY_CONSUMED');
    this.#durable?.terminal(entry.value.requestId,'taken',id);
    this.#delivery(id); // Slow synchronous fsync cannot extend the original TTL.
    entry.status = 'taken'; return structuredClone(entry.value);
  }
  acknowledgeDelivery(id: string): {deliveryId:string;status:'acknowledged'|'duplicate'} {
    const entry = this.#delivery(id);
    if (entry.status === 'acknowledged') return {deliveryId:id,status:'duplicate'};
    if (entry.status !== 'taken') fail('DELIVERY_NOT_TAKEN');
    this.#durable?.terminal(entry.value.requestId,'acknowledged',id);
    this.#delivery(id);
    entry.status = 'acknowledged'; this.#lastAcknowledgedDeliveryId=id; return {deliveryId:id,status:'acknowledged'};
  }
  startScheduler(options: NonNullable<CoupledSession['schedulerOptions']>): void {
    text(options.recallQuery,256);
    if (![options.onReady,options.onError,options.refreshContext].every(fn => typeof fn === 'function')) fail('INVALID_SCHEDULER');
    this.stopScheduler(); this.#scheduler = {...options}; this.#arm();
  }
  // Type-only convenience for trusted host integration.
  declare readonly schedulerOptions: { recallQuery:string; onReady:(result:InteractionResult)=>void; onError:(code:string)=>void;
    refreshContext:()=>{quiet:boolean;available:boolean;ttlMs:number} } | undefined;
  stopScheduler(): void {
    const stopped = this.#schedulerVersion++; this.#scheduler = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer); this.#timer = undefined;
    if (this.#pendingSchedulerVersion === stopped) { this.#pending?.abort(); this.#adapterNeedsReset = true; }
    for (const entry of this.#deliveries.values()) if (entry.schedulerVersion === stopped) entry.status = 'cancelled';
  }
  #arm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer); this.#timer = undefined;
    if (!this.#scheduler || this.#paused || this.#invalid) return;
    let wake: number | null;
    try { this.#guard(); wake = this.#pending || this.#resources.calls.active || this.#resources.neural.active
      ? null : this.#state.read().nextWakeAt; } catch { return; }
    if (!this.#host.available || this.#host.quiet) return;
    const at = Math.min(wake ?? Infinity,this.#host.expiresAt);
    this.#timer = setTimeout(() => {
      this.#timer = undefined; const scheduler = this.#scheduler,version = this.#schedulerVersion; if (!scheduler) return;
      try { this.#guard(); this.setHostContext(scheduler.refreshContext()); }
      catch(error) { notify(scheduler.onError,error instanceof CoreError ? error.code:'SCHEDULER_ERROR'); return; }
      if (this.#pending) { this.#arm(); return; }
      void this.#proactive(scheduler.recallQuery,undefined,version).then(result => {
        if (result && version === this.#schedulerVersion && scheduler === this.#scheduler) notify(scheduler.onReady,result);
      },error => { if (version === this.#schedulerVersion && scheduler === this.#scheduler)
        notify(scheduler.onError,error instanceof CoreError ? error.code:'SCHEDULER_ERROR'); });
    },Math.max(1,Math.ceil(at-this.#now())));
    this.#timer.unref();
  }
}

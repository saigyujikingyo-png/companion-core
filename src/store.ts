import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { Epoch, EventInput, Evidence, Job, Lease, MemoryRecord, Proposal, Receipt,
  RunTicket, Scope, ScopeIdentity, SourceRef, ProjectionChange } from './contracts.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import * as v from './validation.ts';
import { CURATION_LIMITS, frozenCopy } from './curation-types.ts';
import type { CurationSnapshot, CurationNode, CurationEdge } from './curation-types.ts';

type Row = Record<string, string | number | null>;
export type Clock = { wall(): number; monotonic(): number };
const clock: Clock = { wall: Date.now, monotonic: () => performance.now() };

/** One authoritative local service. Worker processes receive opaque jobs, never this DB. */
export class MemoryStore {
  #db: DatabaseSync;
  #clock: Clock;
  #owner = randomUUID();
  #key: string;
  #persist: ((image: Uint8Array, revocationHighWater: number) => void) | undefined;
  #assertHealthy: (() => void) | undefined;
  #onPoison: (() => void) | undefined;
  #poisoned = false;

  constructor(path: string, options: { clock?: Clock; image?: Uint8Array;
    persist?: (image: Uint8Array, revocationHighWater: number) => void; assertHealthy?: () => void; onPoison?: () => void } = {}) {
    if ((options.image || options.persist) && path !== ':memory:') v.fail('DURABLE_MEMORY_ONLY');
    this.#clock = options.clock ?? clock;
    this.#db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false, allowExtension: false });
    try {
      if ((options.image || options.persist) && (typeof this.#db.serialize !== 'function' || typeof this.#db.deserialize !== 'function'))
        v.fail('DURABLE_UNSUPPORTED');
      if (options.image) this.#db.deserialize(options.image);
      const version = this.#one('PRAGMA user_version')!.user_version as number;
      if (version !== 0 && version !== SCHEMA_VERSION) v.fail('UNSUPPORTED_SCHEMA');
      if (version === 0 && this.#one("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")) v.fail('UNKNOWN_DATABASE');
      if (version !== 0) {
        if (!this.#one("SELECT name FROM sqlite_schema WHERE name='meta' AND type='table'")) v.fail('UNKNOWN_DATABASE');
        if (this.#one("SELECT value FROM meta WHERE key='schema_hash'")?.value !== this.#schemaHash()) v.fail('SCHEMA_MISMATCH');
        if (this.#one("SELECT value FROM meta WHERE key='layout_hash'")?.value !== this.#layoutHash()) v.fail('SCHEMA_MISMATCH');
      }
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
      if (version === 0) this.#tx(() => {
        this.#db.exec(SCHEMA_SQL);
        this.#run('INSERT INTO meta VALUES (?,?)', 'schema_hash', this.#schemaHash());
        this.#run('INSERT INTO meta VALUES (?,?)', 'ledger_key', randomBytes(32).toString('hex'));
        this.#run('INSERT INTO meta VALUES (?,?)', 'layout_hash', this.#layoutHash());
        this.#db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
      if (this.#one("SELECT value FROM meta WHERE key='schema_hash'")?.value !== this.#schemaHash()) v.fail('SCHEMA_MISMATCH');
      this.#key = this.#one("SELECT value FROM meta WHERE key='ledger_key'")!.value as string;
      this.#db.enableDefensive(true);
      if (options.image) {
        if (!this.diagnostics().integrity || !this.diagnostics().foreignKeys) v.fail('DURABLE_CORRUPT');
        // A process restart never revives worker leases, active artifacts or run tickets.
        this.#db.exec("UPDATE jobs SET lease_owner=NULL,lease_token=NULL,lease_deadline=NULL; UPDATE scopes SET runtime_epoch=runtime_epoch+1; UPDATE artifacts SET status='registered' WHERE status='active';");
      }
      this.#persist = options.persist;
      this.#assertHealthy = options.assertHealthy;
      this.#onPoison = options.onPoison;
    } catch (error) { this.#db.close(); throw error; }
  }

  #schemaHash(): string { return createHash('sha256').update(SCHEMA_SQL).digest('hex'); }
  #layoutHash(): string {
    return createHash('sha256').update(JSON.stringify(this.#all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"))).digest('hex');
  }
  #check(): void { if (this.#poisoned) v.fail('DURABLE_UNAVAILABLE'); this.#assertHealthy?.(); }
  #one(sql: string, ...args: SQLInputValue[]): Row | undefined { this.#check(); return this.#db.prepare(sql).get(...args) as Row | undefined; }
  #all(sql: string, ...args: SQLInputValue[]): Row[] { return this.#db.prepare(sql).all(...args) as Row[]; }
  #run(sql: string, ...args: SQLInputValue[]): void { this.#db.prepare(sql).run(...args); }
  #tx<T>(body: () => T, readOnly = false): T {
    this.#check();
    this.#db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    let committing = false, committed = false;
    try {
      const before = this.#one('SELECT total_changes() AS n')!.n;
      const result = body();
      const changed = !readOnly && before !== this.#one('SELECT total_changes() AS n')!.n;
      // FTS5 flushes pending index changes during COMMIT. Serializing before it
      // can capture content rows without their matching inverted index pages.
      // This RAM commit is not an externally acknowledged durable commit: the
      // entire synchronous checkpoint must still succeed before we return.
      committing = true; this.#db.exec('COMMIT'); committed = true;
      if (this.#persist && changed) this.#persist(this.#db.serialize(), this.revocationHighWater());
      return result;
    } catch (error) {
      // Neither a possibly committed RAM mutation nor uncertain persistence may
      // be used after failure. Body errors can still roll back normally.
      if (this.#persist && committing) { this.#poisoned = true; this.#onPoison?.(); }
      if (!committed) try { this.#db.exec('ROLLBACK'); } catch { /* Fail closed even if COMMIT failed. */ }
      throw error;
    }
  }
  snapshot(): Uint8Array { this.#check(); return this.#db.serialize(); }
  revocationHighWater(): number { return this.#one('SELECT coalesce(max(id),0) AS n FROM revocations')!.n as number; }
  #digest(value: unknown): string { return createHmac('sha256', this.#key).update(JSON.stringify(value)).digest('hex'); }
  #scope(id: string): Scope {
    v.text(id, 128);
    const row = this.#one('SELECT * FROM scopes WHERE id=?', id);
    if (!row) v.fail('SCOPE_NOT_FOUND');
    const [tenantId, subjectId, personaId, relationshipId] = JSON.parse(row.identity as string) as string[];
    return { id, tenantId:tenantId!, subjectId:subjectId!, personaId:personaId!, relationshipId:relationshipId!,
      generation:row.generation as number, consentRevision:row.consent_revision as number,
      learningAllowed:row.learning_allowed === 1, runtimeEpoch:row.runtime_epoch as number };
  }
  #epoch(epoch: Epoch): Scope {
    v.object(epoch);
    const scope = this.#scope(epoch.id);
    if (scope.generation !== epoch.generation) v.fail('STALE_SCOPE');
    if (scope.consentRevision !== epoch.consentRevision) v.fail('STALE_CONSENT');
    return scope;
  }
  #epochFrom(row: Row): Epoch {
    return { id:row.scope_id as string, generation:row.generation as number, consentRevision:row.consent_revision as number };
  }
  #node(scopeId: string, id: string): Row {
    const row = this.#one('SELECT * FROM nodes WHERE id=? AND scope_id=?', id, scopeId);
    if (!row) v.fail('SOURCE_NOT_FOUND');
    return row;
  }
  #dependencies(id: string): SourceRef[] {
    return this.#all('SELECT parent_id,parent_revision FROM dependencies WHERE child_id=? ORDER BY parent_id', id)
      .map(r => ({ id:r.parent_id as string, revision:r.parent_revision as number }));
  }
  #valid(scope: Scope, ref: SourceRef, asOf = this.#clock.wall()): Row {
    const row = this.#node(scope.id, ref.id);
    if (row.status !== 'active' || row.revision !== ref.revision || row.generation !== scope.generation) v.fail('STALE_SOURCE');
    // Revocation walks the complete DAG. Revalidation also checks every ancestor,
    // independently of cached search hits and outbox delivery ordering.
    const invalid = this.#one(`WITH RECURSIVE ancestry(id) AS (
      SELECT ? UNION SELECT d.parent_id FROM dependencies d JOIN ancestry a ON d.child_id=a.id
    ) SELECT n.id FROM ancestry a JOIN nodes n ON n.id=a.id
      WHERE n.status!='active' OR n.scope_id!=? OR n.generation!=?
      OR (n.valid_from IS NOT NULL AND n.valid_from>?) OR (n.valid_to IS NOT NULL AND n.valid_to<=?) OR EXISTS (
        SELECT 1 FROM dependencies d JOIN nodes p ON p.id=d.parent_id
        WHERE d.child_id=n.id AND p.revision!=d.parent_revision
      ) LIMIT 1`, ref.id, scope.id, scope.generation, asOf, asOf);
    if (invalid) v.fail('STALE_SOURCE');
    return row;
  }
  #validateRefs(scope: Scope, refs: SourceRef[]): void { for (const ref of refs) this.#valid(scope, ref); }
  #ancestry(scope: Scope, refs: SourceRef[]): Row[] {
    const found = new Map<string, Row>();
    const remaining = [...refs];
    while (remaining.length) {
      const ref = remaining.pop()!;
      if (found.has(ref.id)) continue;
      const row = this.#valid(scope, ref); found.set(ref.id, row);
      remaining.push(...this.#dependencies(ref.id));
    }
    return [...found.values()];
  }

  ensureScope(value: ScopeIdentity): Scope {
    const identity = v.identity(value);
    return this.#tx(() => {
      this.#run('INSERT OR IGNORE INTO scopes(id,identity) VALUES (?,?)', randomUUID(), identity);
      return this.#scope(this.#one('SELECT id FROM scopes WHERE identity=?', identity)!.id as string);
    });
  }
  scope(id: string): Scope { return this.#scope(id); }

  acceptEvent(epoch: Epoch, input: EventInput): Receipt & SourceRef {
    v.object(input);
    v.text(input.source, 128); v.text(input.eventKey, 256);
    return this.#tx(() => {
      const scope = this.#epoch(epoch);
      const evidence = v.evidence(input.evidence, scope.subjectId);
      const key = this.#digest([input.source, input.eventKey]);
      const payload = this.#digest(evidence);
      const existing = this.#one('SELECT * FROM ingress WHERE scope_id=? AND key_hash=?', scope.id, key);
      if (existing) {
        if (existing.payload_hash !== payload) v.fail('IDEMPOTENCY_CONFLICT');
        const node = this.#node(scope.id, existing.node_id as string);
        return { id:node.id as string, revision:node.revision as number, currentStatus:node.status as 'active' | 'revoked' };
      }
      const id = randomUUID();
      this.#run(`INSERT INTO nodes(id,scope_id,type,revision,generation,consent_revision,status,body,created_at)
        VALUES (?,?,'event',1,?,?,'active',?,?)`, id, scope.id, scope.generation, scope.consentRevision,
        JSON.stringify(evidence), this.#clock.wall());
      this.#run('INSERT INTO ingress VALUES (?,?,?,?)', scope.id, key, payload, id);
      return { id, revision:1, currentStatus:'active' };
    });
  }

  /** Freeze BEFORE inference/training; never re-label old computation with new refs. */
  beginJob(epoch: Epoch, sourceRefs: SourceRef[], kind: 'memory' | 'training' = 'memory', parentArtifactId?: string): Job {
    const requested = v.refs(sourceRefs);
    if (!['memory','training'].includes(kind)) v.fail('INVALID_INPUT');
    return this.#tx(() => {
      const scope = this.#epoch(epoch);
      if (kind === 'training' && !scope.learningAllowed) v.fail('LEARNING_NOT_ALLOWED');
      const all = new Map(requested.map(ref => [ref.id, ref]));
      if (parentArtifactId !== undefined) {
        if (kind !== 'training') v.fail('INVALID_INPUT');
        const parent = this.#artifact(scope, parentArtifactId);
        for (const ref of JSON.parse(parent.refs as string) as SourceRef[]) {
          if (all.has(ref.id) && all.get(ref.id)!.revision !== ref.revision) v.fail('STALE_SOURCE');
          all.set(ref.id, ref);
        }
      }
      if (all.size > 256) v.fail('DEPENDENCY_LIMIT');
      const refs = [...all.values()];
      this.#validateRefs(scope, refs);
      const id = randomUUID();
      this.#run(`INSERT INTO jobs(id,scope_id,kind,generation,consent_revision,refs,status)
        VALUES (?,?,?,?,?,?,'pending')`, id, scope.id, kind, scope.generation, scope.consentRevision, JSON.stringify(refs));
      return { id, epoch:{ id:scope.id, generation:scope.generation, consentRevision:scope.consentRevision }, sourceRefs:refs };
    });
  }
  #job(epoch: Epoch, id: string): Row {
    this.#epoch(epoch);
    const job = this.#one('SELECT * FROM jobs WHERE id=? AND scope_id=?', id, epoch.id);
    if (!job) v.fail('JOB_NOT_FOUND');
    return job;
  }
  /** One durable extraction operation per selected event revision.
   * A terminal failure is never replayed by duplicate ingress. Pending work from
   * a crash is deliberately not auto-restarted by a host message. */
  beginSelectedExtraction(epoch: Epoch, ref: SourceRef): { job: Job } | { receipt: Receipt } {
    const refs = v.refs([ref]);
    return this.#tx(() => {
      const scope = this.#epoch(epoch); this.#validateRefs(scope, refs);
      if (this.#node(scope.id, ref.id).type !== 'event') v.fail('INVALID_INPUT');
      // Scope/source revisions already identify the frozen evidence. Do not add
      // current consent here: reauthentication must not restart a failed job.
      const id = `selected-v1:${this.#digest([scope.id,refs])}`;
      const existing = this.#one('SELECT * FROM jobs WHERE id=?', id);
      if (existing) {
        if (existing.result_id !== null) {
          const result = this.#node(scope.id, existing.result_id as string);
          return { receipt:{ id:result.id as string, currentStatus:result.status as 'active' | 'revoked' } };
        }
        v.fail(existing.status === 'pending' ? 'EXTRACTION_IN_PROGRESS' : 'EXTRACTION_TERMINATED');
      }
      this.#run("INSERT INTO jobs(id,scope_id,kind,generation,consent_revision,refs,status) VALUES (?,?,'memory',?,?,?,'pending')",
        id, scope.id, scope.generation, scope.consentRevision, JSON.stringify(refs));
      return { job:{ id, epoch:{ id:scope.id, generation:scope.generation, consentRevision:scope.consentRevision }, sourceRefs:refs } };
    });
  }
  #jobGuard(job: Row): Scope {
    const scope = this.#epoch(this.#epochFrom(job));
    if (job.status !== 'pending') v.fail('JOB_NOT_PENDING');
    if (job.kind === 'training' && !scope.learningAllowed) v.fail('LEARNING_NOT_ALLOWED');
    this.#validateRefs(scope, JSON.parse(job.refs as string));
    return scope;
  }
  claimLease(epoch: Epoch, id: string, ttlMs = 30_000): Lease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) v.fail('INVALID_INPUT');
    return this.#tx(() => {
      const job = this.#job(epoch, id); this.#jobGuard(job);
      if (job.lease_owner === this.#owner && job.lease_deadline !== null && this.#clock.monotonic() < (job.lease_deadline as number)) v.fail('LEASE_BUSY');
      const token = randomUUID();
      // A reopened authority cannot inherit process-monotonic leases. Reclaim fences
      // the old owner and always requires a new token; the single-service contract applies.
      this.#run('UPDATE jobs SET lease_owner=?,lease_token=?,lease_deadline=?,draft=NULL WHERE id=?',
        this.#owner, token, this.#clock.monotonic() + ttlMs, id);
      return { token, expiresAt:this.#clock.wall() + ttlMs };
    });
  }
  #lease(job: Row, token: string): void {
    if (job.lease_owner !== this.#owner || job.lease_token !== token) v.fail('LEASE_LOST');
    if (job.lease_deadline === null || this.#clock.monotonic() >= (job.lease_deadline as number)) v.fail('LEASE_EXPIRED');
  }
  /** Terminal cleanup uses the frozen epoch even after a purge. An expired
   * worker can clean up its lease, but never a replacement owner's lease. */
  abandonJob(job: Job, token?: string): boolean {
    return this.#tx(() => {
      const row = this.#one('SELECT * FROM jobs WHERE id=? AND scope_id=?', job.id, job.epoch.id);
      if (!row || row.status !== 'pending' || row.generation !== job.epoch.generation ||
        row.consent_revision !== job.epoch.consentRevision) return false;
      if (token === undefined ? row.lease_token !== null :
        row.lease_token !== token || row.lease_owner !== this.#owner) return false;
      this.#run("UPDATE jobs SET status='revoked',draft=NULL,lease_owner=NULL,lease_token=NULL,lease_deadline=NULL WHERE id=?", job.id);
      return true;
    });
  }
  jobEvidence(epoch: Epoch, id: string, token: string): Evidence[] {
    return this.#tx(() => {
      const job = this.#job(epoch, id); const scope = this.#jobGuard(job); this.#lease(job, token);
      return this.#ancestry(scope, JSON.parse(job.refs as string)).filter(row => row.type === 'event').map(row => JSON.parse(row.body as string));
    });
  }
  propose(epoch: Epoch, id: string, token: string, input: Proposal): void {
    const proposal = v.proposal(input);
    this.#tx(() => {
      const job = this.#job(epoch, id); const scope = this.#jobGuard(job); this.#lease(job, token);
      if (job.kind !== 'memory') v.fail('WRONG_JOB_KIND');
      if (proposal.basis === 'self_report') {
        const ancestry = this.#ancestry(scope, JSON.parse(job.refs as string));
        if (!ancestry.every(row => {
          if (row.type === 'memory') { const p = JSON.parse(row.body as string) as Proposal; return p.basis === 'self_report' && p.kind !== 'belief'; }
          const e = JSON.parse(row.body as string) as Evidence;
          return e.mode === 'self_report' && e.speakerRole === 'subject' && e.speakerId === scope.subjectId;
        })) v.fail('SPEAKER_MISMATCH');
      }
      if (proposal.basis === 'observation' && !this.#ancestry(scope, JSON.parse(job.refs as string))
        .every(row => row.type === 'event' ? (JSON.parse(row.body as string) as Evidence).mode === 'observation'
          : (JSON.parse(row.body as string) as Proposal).basis === 'observation')) v.fail('EVIDENCE_MISMATCH');
      const body = JSON.stringify(proposal);
      if (job.draft !== null && job.draft !== body) v.fail('DRAFT_IMMUTABLE');
      this.#run('UPDATE jobs SET draft=? WHERE id=?', body, id);
    });
  }
  #receipt(job: Row, token: string): Receipt | null {
    if (job.status !== 'published' && job.result_id === null) return null;
    if (job.lease_token !== token) v.fail('LEASE_LOST');
    const result = job.kind === 'memory' ? this.#one('SELECT status FROM nodes WHERE id=?', job.result_id as string)
      : this.#one('SELECT status FROM artifacts WHERE id=?', job.result_id as string);
    if (!result) v.fail('CORRUPT_RECEIPT');
    return { id:job.result_id as string, currentStatus:result?.status === 'revoked' ? 'revoked' : 'active' };
  }
  publish(epoch: Epoch, id: string, token: string): Receipt {
    return this.#tx(() => {
      const job = this.#job(epoch, id);
      if (job.kind !== 'memory') v.fail('WRONG_JOB_KIND');
      const receipt = this.#receipt(job, token); if (receipt) return receipt;
      const scope = this.#jobGuard(job); this.#lease(job, token);
      if (job.kind !== 'memory') v.fail('WRONG_JOB_KIND');
      if (job.draft === null) v.fail('NO_DRAFT');
      const draft = JSON.parse(job.draft as string) as Proposal;
      if (draft.validTo !== null && draft.validTo <= this.#clock.wall()) v.fail('EXPIRED_PROPOSAL');
      const memoryId = randomUUID();
      this.#run(`INSERT INTO nodes(id,scope_id,type,revision,generation,consent_revision,status,body,search_text,created_at,valid_from,valid_to)
        VALUES (?,?,'memory',1,?,?,'active',?,?,?,?,?)`, memoryId, scope.id, scope.generation, scope.consentRevision,
        job.draft as string, draft.statement, this.#clock.wall(), draft.validFrom, draft.validTo);
      for (const ref of JSON.parse(job.refs as string) as SourceRef[]) {
        this.#run('INSERT INTO dependencies VALUES (?,?,?)', memoryId, ref.id, ref.revision);
      }
      this.#run('INSERT INTO memory_fts(node_id,statement) VALUES (?,?)', memoryId, draft.statement);
      this.#run('UPDATE nodes SET projection_visible=? WHERE id=?', Number(draft.validFrom === null || draft.validFrom <= this.#clock.wall()), memoryId);
      this.#run("INSERT INTO outbox(scope_id,node_id,node_revision,status) VALUES (?,?,1,'pending')", scope.id, memoryId);
      this.#run("UPDATE jobs SET status='published',result_id=?,draft=NULL WHERE id=?", memoryId, id);
      return { id:memoryId, currentStatus:'active' };
    });
  }

  #record(scope: Scope, ref: SourceRef, asOf: number): MemoryRecord | null {
    let row: Row;
    try { row = this.#valid(scope, ref, asOf); }
    catch (error) { if (error instanceof v.CoreError && ['STALE_SOURCE','SOURCE_NOT_FOUND'].includes(error.code)) return null; throw error; }
    if (row.type !== 'memory' || (row.valid_from !== null && asOf < (row.valid_from as number)) ||
      (row.valid_to !== null && asOf >= (row.valid_to as number))) return null;
    return { ...JSON.parse(row.body as string), id:row.id as string, revision:row.revision as number,
      scopeId:scope.id, generation:row.generation as number, consentRevision:row.consent_revision as number,
      sourceRefs:this.#dependencies(ref.id), recordedAt:row.created_at as number };
  }
  read(epoch: Epoch, ref: SourceRef, asOf = this.#clock.wall()): MemoryRecord | null {
    v.timestamp(asOf); v.refs([ref]);
    return this.#tx(() => this.#record(this.#epoch(epoch), ref, asOf), true);
  }
  /** Read-only provenance for currently visible published memories. No source text.
   * Multiple publications/derived memories from the same interaction share its event ref.
   */
  publishedEventSources(epoch: Epoch, sourceRefs: SourceRef[]): SourceRef[] {
    const requested = v.refs(sourceRefs);
    return this.#tx(() => {
      const scope = this.#epoch(epoch), asOf = this.#clock.wall();
      for (const ref of requested) if (!this.#record(scope, ref, asOf)) v.fail('SOURCE_NOT_PUBLISHED');
      const events = this.#ancestry(scope, requested).filter(row => row.type === 'event')
        .map(row => ({ id: row.id as string, revision: row.revision as number }));
      if (events.length === 0) v.fail('EVENT_PROVENANCE_REQUIRED');
      return events.sort((a, b) => a.id.localeCompare(b.id));
    }, true);
  }

  /** Bounded, read-only curation authority. No unbounded ancestry helper is used.
   * bytes conservatively accounts for read metadata/raw bodies/edges AND the
   * complete returned representation, including repeated selected-root mappings.
   * A rejection returns no partial snapshot and never invokes persistence. */
  curationSnapshot(epoch: Epoch, publishedRefs: SourceRef[]): CurationSnapshot {
    return this.#tx(() => {
      const scope = this.#epoch(epoch);
      if (!scope.learningAllowed) v.fail('LEARNING_NOT_ALLOWED');
      const asOf = this.#clock.wall();
      if (!Number.isSafeInteger(asOf) || asOf < 0) v.fail('INVALID_INPUT');
      if (!Array.isArray(publishedRefs) || publishedRefs.length > CURATION_LIMITS.selected) v.fail('CURATION_LIMIT');
      const requested = publishedRefs.length ? v.refs(publishedRefs) : [];
      const authority = { id:scope.id, generation:scope.generation, consentRevision:scope.consentRevision,
        runtimeEpoch:scope.runtimeEpoch, learningAllowed:true as const };
      let bytes = 0;
      const addBytes = (amount:number): void => {
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > CURATION_LIMITS.bytes - bytes) v.fail('CURATION_LIMIT');
        bytes += amount;
      };
      const size = (value:unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
      // Reserve the complete envelope and maximum-width count metadata up front.
      addBytes(size({ version:1, authority, asOf, selected:[], events:[], closure:{ nodes:[], edges:[] },
        counts:{ selected:32, nodes:128, edges:512, bytes:CURATION_LIMITS.bytes } }));
      const revisions = new Map<string,number>(), queue:SourceRef[] = [];
      const enqueue = (ref:SourceRef): void => {
        v.refs([ref]);
        if (revisions.has(ref.id)) {
          if (revisions.get(ref.id) !== ref.revision) v.fail('CURATION_VERSION_CONFLICT');
          return;
        }
        if (revisions.size >= CURATION_LIMITS.nodes) v.fail('CURATION_LIMIT');
        revisions.set(ref.id, ref.revision); queue.push({ id:ref.id, revision:ref.revision });
      };
      requested.forEach(enqueue);
      const nodes = new Map<string,{ meta:CurationNode; body:Evidence|Proposal; parents:SourceRef[] }>();
      const edges:CurationEdge[] = [];
      for (let index = 0; index < queue.length; index++) {
        const ref = queue[index]!;
        // Do not read an arbitrarily large body before checking its UTF-8 cost.
        const row = this.#one(`SELECT type,revision,generation,consent_revision,status,created_at,valid_from,valid_to,
          length(CAST(body AS BLOB)) AS body_bytes FROM nodes WHERE id=? AND scope_id=?`, ref.id, scope.id);
        if (!row) v.fail('SOURCE_NOT_FOUND');
        if (row.status !== 'active' || row.revision !== ref.revision || row.generation !== scope.generation ||
          (row.valid_from !== null && (row.valid_from as number) > asOf) ||
          (row.valid_to !== null && (row.valid_to as number) <= asOf)) v.fail('STALE_SOURCE');
        if (row.body_bytes === null || !['event','memory'].includes(row.type as string)) v.fail('CURATION_SOURCE_INVALID');
        v.timestamp(row.created_at); v.timestamp(row.valid_from); v.timestamp(row.valid_to);
        const meta:CurationNode = { ...ref, type:row.type as CurationNode['type'], generation:row.generation as number,
          consentRevision:row.consent_revision as number, recordedAt:row.created_at as number,
          validFrom:row.valid_from as number|null, validTo:row.valid_to as number|null };
        // Historical node consent revisions do not override the current scope's permission.
        addBytes(size(meta) + (row.body_bytes as number));
        let body:Evidence|Proposal;
        try {
          const parsed:unknown = JSON.parse(this.#one('SELECT body FROM nodes WHERE id=? AND scope_id=?', ref.id, scope.id)!.body as string);
          body = meta.type === 'event' ? v.evidence(parsed as Evidence, scope.subjectId) : v.proposal(parsed as Proposal);
        } catch { v.fail('CURATION_SOURCE_INVALID'); }
        if (meta.type === 'memory' && ((body as Proposal).validFrom !== meta.validFrom || (body as Proposal).validTo !== meta.validTo)) v.fail('CURATION_SOURCE_INVALID');
        const remaining = CURATION_LIMITS.edges - edges.length;
        const parents = this.#all(`SELECT CASE WHEN length(CAST(parent_id AS BLOB))<=512 THEN parent_id ELSE NULL END AS parent_id,
          parent_revision FROM dependencies WHERE child_id=? ORDER BY parent_id LIMIT ?`, ref.id, remaining + 1);
        if (parents.length > remaining) v.fail('CURATION_LIMIT');
        if (meta.type === 'event' && parents.length) v.fail('CURATION_GRAPH_INVALID');
        const refs:SourceRef[] = [];
        for (const parent of parents) {
          const parentRef = { id:parent.parent_id as string, revision:parent.parent_revision as number };
          enqueue(parentRef);
          const edge = { child:{ ...ref }, parent:parentRef };
          addBytes(size(edge)); edges.push(edge); refs.push(parentRef);
        }
        nodes.set(ref.id, { meta, body, parents:refs });
      }
      const visiting = new Set<string>(), roots = new Map<string,SourceRef[]>();
      const rootsFor = (id:string):SourceRef[] => {
        if (visiting.has(id)) v.fail('CURATION_CYCLE');
        if (roots.has(id)) return roots.get(id)!;
        visiting.add(id);
        const node = nodes.get(id)!;
        const found = new Map<string,SourceRef>();
        if (node.meta.type === 'event') found.set(id, { id, revision:node.meta.revision });
        for (const parent of node.parents) for (const root of rootsFor(parent.id)) found.set(root.id, root);
        if (!found.size) v.fail('EVENT_PROVENANCE_REQUIRED');
        const result = [...found.values()].sort((a,b) => a.id.localeCompare(b.id));
        visiting.delete(id); roots.set(id, result); return result;
      };
      const selected = requested.map(ref => {
        const node = nodes.get(ref.id)!;
        if (node.meta.type !== 'memory') v.fail('SOURCE_NOT_PUBLISHED');
        const memory:MemoryRecord = { ...(node.body as Proposal), ...ref, scopeId:scope.id,
          generation:node.meta.generation, consentRevision:node.meta.consentRevision,
          sourceRefs:node.parents, recordedAt:node.meta.recordedAt };
        const item = { memory, contentKind:'derived_memory' as const, rootEventRefs:rootsFor(ref.id) };
        addBytes(size(item) + 1); return item;
      });
      const events = [...nodes.values()].filter(node => node.meta.type === 'event').map(node => {
        const item = { ref:{ id:node.meta.id, revision:node.meta.revision }, evidence:node.body as Evidence };
        addBytes(size(item) + 1); return item;
      }).sort((a,b) => a.ref.id.localeCompare(b.ref.id));
      const metadata = [...nodes.values()].map(node => node.meta);
      // These nodes/edges appear again in the output; count that duplication too.
      for (const node of metadata) addBytes(size(node) + 1);
      for (const edge of edges) addBytes(size(edge) + 1);
      return frozenCopy({ version:1 as const, authority, asOf, selected, events, closure:{ nodes:metadata, edges },
        counts:{ selected:selected.length, nodes:nodes.size, edges:edges.length, bytes } });
    }, true);
  }
  search(epoch: Epoch, query: string, limit = 20, asOf = this.#clock.wall()): MemoryRecord[] {
    v.text(query, 256); v.timestamp(asOf);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) v.fail('INVALID_INPUT');
    return this.#tx(() => {
      const scope = this.#epoch(epoch);
      // unicode61 FTS plus literal substring handles Chinese without pretending
      // tokenization is semantic retrieval. Filter validity BEFORE the result limit.
      const rows = this.#db.prepare(`SELECT n.id,n.revision FROM nodes n WHERE n.scope_id=? AND n.type='memory'
        AND n.status='active' AND (n.valid_from IS NULL OR n.valid_from<=?) AND (n.valid_to IS NULL OR n.valid_to>?)
        AND (instr(n.search_text,?)>0 OR n.id IN (SELECT node_id FROM memory_fts WHERE memory_fts MATCH ?))
        ORDER BY n.created_at,n.id`).iterate(scope.id, asOf, asOf, query, '"' + query.replaceAll('"','""') + '"');
      const result: MemoryRecord[] = [];
      for (const row of rows) {
        const record = this.#record(scope, { id:row.id as string, revision:row.revision as number }, asOf);
        if (record) result.push(record);
        if (result.length >= limit) break;
      }
      return result;
    }, true);
  }
  #projection(scope: Scope, row: Row): ProjectionChange {
    const ref = { id:row.node_id as string, revision:row.node_revision as number };
    const record = this.#record(scope, ref, this.#clock.wall());
    return record ? { outboxId:row.id as number, operation:'upsert', record }
      : { outboxId:row.id as number, operation:'remove', ref };
  }
  projectionBatch(epoch: Epoch): ProjectionChange[] {
    return this.#tx(() => {
      const scope = this.#epoch(epoch);
      // The projection consumer calls this on a cadence even without new events.
      // Crossing a validity boundary (including an ancestor's) produces a new delta.
      for (const row of this.#all("SELECT id,revision,projection_visible FROM nodes WHERE scope_id=? AND type='memory' AND status='active'", scope.id)) {
        const visible = Number(this.#record(scope, { id:row.id as string, revision:row.revision as number }, this.#clock.wall()) !== null);
        if (visible !== row.projection_visible) {
          this.#run("UPDATE outbox SET status='revoked' WHERE node_id=? AND status='pending'", row.id as string);
          this.#run("INSERT INTO outbox(scope_id,node_id,node_revision,status) VALUES (?,?,?,'pending')", scope.id, row.id as string, row.revision as number);
          this.#run('UPDATE nodes SET projection_visible=? WHERE id=?', visible, row.id as string);
        }
      }
      return this.#all("SELECT * FROM outbox WHERE scope_id=? AND status='pending' ORDER BY id LIMIT 100", scope.id)
        .map(row => this.#projection(scope, row));
    });
  }
  acknowledgeProjection(epoch: Epoch, change: ProjectionChange): void {
    this.#tx(() => {
      const scope = this.#epoch(epoch);
      const row = this.#one('SELECT * FROM outbox WHERE id=? AND scope_id=?', change.outboxId, scope.id);
      if (!row || row.status === 'revoked') v.fail('STALE_PROJECTION');
      const ref = change.operation === 'upsert' ? change.record : change.ref;
      if (ref.id !== row.node_id || ref.revision !== row.node_revision) v.fail('STALE_PROJECTION');
      if (this.#projection(scope, row).operation !== change.operation) v.fail('STALE_PROJECTION');
      this.#run("UPDATE outbox SET status='acked' WHERE id=?", change.outboxId);
    });
  }

  #invalidate(scope: Scope, rootId?: string): void {
    const rows = rootId === undefined ? this.#all("SELECT id FROM nodes WHERE scope_id=? AND status='active'", scope.id)
      : this.#all(`WITH RECURSIVE affected(id) AS (SELECT ? UNION SELECT d.child_id FROM dependencies d JOIN affected a ON d.parent_id=a.id)
        SELECT id FROM affected`, rootId);
    for (const row of rows) {
      this.#run("UPDATE nodes SET status='revoked',body=NULL,search_text='',projection_visible=0 WHERE id=? AND scope_id=?", row.id as string, scope.id);
      this.#run('DELETE FROM memory_fts WHERE node_id=?', row.id as string);
      this.#run("UPDATE outbox SET status='revoked' WHERE node_id=?", row.id as string);
      const node = this.#node(scope.id, row.id as string);
      if (node.type === 'memory') this.#run("INSERT INTO outbox(scope_id,node_id,node_revision,status) VALUES (?,?,?,'pending')", scope.id, node.id as string, node.revision as number);
    }
    // Validate frozen refs after propagation, including training ancestors.
    for (const table of ['jobs','artifacts'] as const) {
      const pending = this.#all(`SELECT * FROM ${table} WHERE scope_id=? AND status!='revoked'`, scope.id);
      for (const row of pending) {
        let invalid = rootId === undefined;
        try { this.#validateRefs(scope, JSON.parse(row.refs as string)); }
        catch (error) { if (!(error instanceof v.CoreError)) throw error; invalid = true; }
        if (invalid) this.#run(`UPDATE ${table} SET status='revoked',${table === 'jobs' ? 'draft' : 'manifest'}=NULL WHERE id=?`, row.id as string);
      }
    }
    this.#run('UPDATE scopes SET runtime_epoch=runtime_epoch+1 WHERE id=?', scope.id);
  }
  #ledger(scope: Scope, target: string | null, reason: string): void {
    this.#run('INSERT INTO revocations(scope_id,target_id,generation,reason,recorded_at) VALUES (?,?,?,?,?)',
      scope.id, target, scope.generation, reason, this.#clock.wall());
  }
  revoke(epoch: Epoch, ref: SourceRef): void {
    this.#tx(() => {
      const scope = this.#epoch(epoch); const node = this.#node(scope.id, ref.id);
      if (node.revision !== ref.revision) v.fail('STALE_SOURCE');
      if (node.status === 'revoked') return;
      this.#invalidate(scope, ref.id); this.#ledger(scope, ref.id, 'source_revoked');
    });
  }
  reviseEvent(epoch: Epoch, ref: SourceRef, input: Evidence): SourceRef {
    return this.#tx(() => {
      const scope = this.#epoch(epoch); const node = this.#valid(scope, ref);
      if (node.type !== 'event') v.fail('WRONG_SOURCE_KIND');
      const evidence = v.evidence(input, scope.subjectId);
      this.#invalidate(scope, ref.id);
      this.#run("UPDATE nodes SET status='active',revision=revision+1,body=? WHERE id=?", JSON.stringify(evidence), ref.id);
      this.#ledger(scope, ref.id, 'source_corrected');
      return { id:ref.id, revision:ref.revision+1 };
    });
  }
  purge(epoch: Epoch): Scope {
    return this.#tx(() => {
      const scope = this.#epoch(epoch); this.#invalidate(scope);
      this.#run('UPDATE scopes SET generation=generation+1 WHERE id=?', scope.id);
      const next = this.#scope(scope.id); this.#ledger(next, null, 'scope_purged'); return next;
    });
  }
  setLearningConsent(epoch: Epoch, allowed: boolean): Scope {
    if (typeof allowed !== 'boolean') v.fail('INVALID_INPUT');
    return this.#tx(() => {
      const scope = this.#epoch(epoch);
      if (scope.learningAllowed === allowed) return scope;
      this.#run('UPDATE scopes SET learning_allowed=?,consent_revision=consent_revision+1,runtime_epoch=runtime_epoch+1 WHERE id=?', Number(allowed), scope.id);
      this.#run("UPDATE jobs SET status='revoked',draft=NULL WHERE scope_id=? AND status='pending'", scope.id);
      this.#run("UPDATE artifacts SET status='revoked',manifest=NULL WHERE scope_id=?", scope.id);
      const next = this.#scope(scope.id); this.#ledger(next, null, 'learning_consent_changed'); return next;
    });
  }
  #artifact(scope: Scope, id: string): Row {
    const row = this.#one('SELECT * FROM artifacts WHERE id=? AND scope_id=?', id, scope.id);
    if (!row) v.fail('ARTIFACT_NOT_FOUND');
    this.#epoch(this.#epochFrom(row));
    if (!scope.learningAllowed || row.status === 'revoked') v.fail('ARTIFACT_REVOKED');
    this.#validateRefs(scope, JSON.parse(row.refs as string)); return row;
  }
  registerArtifact(epoch: Epoch, jobId: string, token: string, manifest: { sha256: string; implementation: string }): Receipt {
    v.object(manifest);
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) v.fail('INVALID_INPUT'); v.text(manifest.implementation, 256);
    return this.#tx(() => {
      const job = this.#job(epoch, jobId);
      if (job.kind !== 'training') v.fail('WRONG_JOB_KIND');
      const receipt = this.#receipt(job, token);
      if (receipt) {
        const prior = this.#one('SELECT manifest FROM artifacts WHERE id=?', receipt.id)!;
        if (prior.manifest !== null && prior.manifest !== JSON.stringify({ sha256:manifest.sha256, implementation:manifest.implementation })) v.fail('IDEMPOTENCY_CONFLICT');
        return receipt;
      }
      const scope = this.#jobGuard(job); this.#lease(job, token);
      const id = randomUUID();
      this.#run("INSERT INTO artifacts VALUES (?,?,?,?,?,?,'registered')", id, scope.id, scope.generation, scope.consentRevision,
        job.refs as string, JSON.stringify({ sha256:manifest.sha256, implementation:manifest.implementation }));
      this.#run("UPDATE jobs SET status='published',result_id=? WHERE id=?", id, jobId);
      return { id, currentStatus:'active' };
    });
  }
  activateArtifact(epoch: Epoch, id: string): RunTicket {
    return this.#tx(() => {
      const scope = this.#epoch(epoch); this.#artifact(scope, id);
      if (this.#artifact(scope, id).status === 'active') return this.#runTicket(scope, id);
      this.#run("UPDATE artifacts SET status='registered' WHERE scope_id=? AND status='active'", scope.id);
      this.#run("UPDATE artifacts SET status='active' WHERE id=?", id);
      this.#run('UPDATE scopes SET runtime_epoch=runtime_epoch+1 WHERE id=?', scope.id);
      return this.#runTicket(this.#scope(scope.id), id);
    });
  }
  #runTicket(scope: Scope, artifactId: string | null): RunTicket {
    return { id:scope.id, generation:scope.generation, consentRevision:scope.consentRevision, runtimeEpoch:scope.runtimeEpoch, artifactId };
  }
  beginRun(epoch: Epoch, artifactId: string | null = null): RunTicket {
    return this.#tx(() => {
      const scope = this.#epoch(epoch);
      if (artifactId !== null && this.#artifact(scope, artifactId).status !== 'active') v.fail('ARTIFACT_NOT_ACTIVE');
      return this.#runTicket(scope, artifactId);
    });
  }
  validateRun(ticket: RunTicket): void {
    this.#tx(() => {
      const scope = this.#epoch(ticket);
      if (scope.runtimeEpoch !== ticket.runtimeEpoch) v.fail('STALE_RUN');
      if (ticket.artifactId !== null && this.#artifact(scope, ticket.artifactId).status !== 'active') v.fail('ARTIFACT_NOT_ACTIVE');
    });
  }
  diagnostics(): { node: string; sqlite: string; schema: number; integrity: boolean; foreignKeys: boolean } {
    return { node:process.version, sqlite:this.#one('SELECT sqlite_version() AS v')!.v as string, schema:SCHEMA_VERSION,
      integrity:this.#one('PRAGMA integrity_check')!.integrity_check === 'ok', foreignKeys:this.#all('PRAGMA foreign_key_check').length === 0 };
  }
  close(): void { this.#db.close(); }
}

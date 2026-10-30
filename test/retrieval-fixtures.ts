import type { TestContext } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/store.ts';
import { CoreError } from '../src/validation.ts';
import type { Epoch, Evidence, Proposal, SourceRef } from '../src/contracts.ts';

export const identity = { tenantId: 'synthetic-ar0', subjectId: 'alice', personaId: 'test', relationshipId: 'test' };
export const claim: Proposal = {
  kind: 'claim',
  statement: 'derived blue memory',
  basis: 'self_report',
  validFrom: null,
  validTo: null,
};
export const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
export function publish(store: MemoryStore, epoch: Epoch, refs: SourceRef[], proposal = claim): SourceRef {
  const job = store.beginJob(epoch, refs),
    lease = store.claimLease(epoch, job.id);
  store.propose(epoch, job.id, lease.token, proposal);
  return { id: store.publish(epoch, job.id, lease.token).id, revision: 1 };
}
export function fixture(t: TestContext) {
  let wall = 100_000,
    reads = 0,
    persisted = 0;
  const store = new MemoryStore(':memory:', {
    clock: {
      wall: () => {
        reads++;
        return wall;
      },
      monotonic: () => 0,
    },
    persist: () => {
      persisted++;
    },
  });
  t.after(() => store.close());
  const scope = store.ensureScope(identity);
  const event = (key: string, patch: Partial<Evidence> = {}) =>
    store.acceptEvent(scope, {
      source: 'synthetic',
      eventKey: key,
      evidence: {
        speakerId: 'alice',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'ANCESTOR_ONLY_SECRET_SYNTHETIC',
        occurredAt: 1000,
        ...patch,
      },
    });
  return {
    store,
    scope,
    event,
    memory: (refs: SourceRef[], proposal = claim) => publish(store, scope, refs, proposal),
    setWall: (value: number) => {
      wall = value;
    },
    reads: () => reads,
    persisted: () => persisted,
  };
}
/** Fault injection is confined to a new disposable synthetic database. */
export function graph(t: TestContext) {
  const path = join(mkdtempSync(join(tmpdir(), 'companion-ar0-graph-')), 'synthetic.sqlite');
  const store = new MemoryStore(path, { clock: { wall: () => 100_000, monotonic: () => 0 } }),
    scope = store.ensureScope(identity);
  const injector = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  t.after(() => {
    injector.close();
    store.close();
  });
  const ref = (id: string): SourceRef => ({ id, revision: 1 });
  const node = (id: string, type: 'event' | 'memory', parents: string[] = [], text = 'synthetic blue') => {
    const body =
      type === 'event'
        ? { speakerId: 'alice', speakerRole: 'subject', mode: 'self_report', selectedText: text, occurredAt: 1000 }
        : { ...claim, statement: text };
    injector
      .prepare(
        "INSERT INTO nodes(id,scope_id,type,revision,generation,consent_revision,status,body,created_at) VALUES (?,?,?,1,?,?,'active',?,100000)",
      )
      .run(id, scope.id, type, scope.generation, scope.consentRevision, JSON.stringify(body));
    for (const parent of parents) injector.prepare('INSERT INTO dependencies VALUES (?,?,1)').run(id, parent);
    return ref(id);
  };
  return { store, scope, injector, ref, node };
}

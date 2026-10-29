import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { MemoryStore } from '../src/store.ts';
import { CurationService } from '../src/curation.ts';
import { curateDeclarations } from '../src/curation-rules.ts';
import type { CurationPolicy, CurationRequest } from '../src/curation-rules.ts';
import { canonical } from '../src/curation-types.ts';
import { CoreError } from '../src/validation.ts';
import type { Evidence, Proposal, SourceRef } from '../src/contracts.ts';

const policy: CurationPolicy = {
  version: 1,
  curationVersion: 'l1a-1',
  annotationVersion: 'declared-1',
  selectionVersion: 'synthetic-1',
  cutoff: 2000,
};
const identity = { tenantId: 'synthetic', subjectId: 'alice', personaId: 'test', relationshipId: 'test' };
const claim: Proposal = {
  kind: 'claim',
  statement: 'DERIVED_MODEL_STATEMENT',
  basis: 'self_report',
  validFrom: null,
  validTo: null,
};
const code = (expected: string) => (error: unknown) => error instanceof CoreError && error.code === expected;
function row(memoryIndex = 0, patch: Partial<CurationRequest['rows'][number]> = {}): CurationRequest['rows'][number] {
  return {
    memoryIndex,
    rootIndex: 0,
    variant: 'original',
    language: 'unknown',
    split: 'train',
    annotation: {
      origin: 'synthetic',
      claimKey: null,
      polarity: 'unspecified',
      condition: '',
      quotation: 'direct',
      quotationSubject: null,
      uncertain: false,
    },
    ...patch,
  };
}
const raw = (...rows: CurationRequest['rows']) => JSON.stringify({ version: 1, rows });
function fixture(t: TestContext) {
  let wall = 100_000,
    persisted = 0,
    wallReads = 0;
  const store = new MemoryStore(':memory:', {
    clock: {
      wall: () => {
        wallReads++;
        return wall;
      },
      monotonic: () => 0,
    },
    persist: () => {
      persisted++;
    },
  });
  t.after(() => store.close());
  const scope = store.setLearningConsent(store.ensureScope(identity), true),
    service = new CurationService(store, policy);
  const root = (key: string, patch: Partial<Evidence> = {}) =>
    store.acceptEvent(scope, {
      source: 'synthetic',
      eventKey: key,
      evidence: {
        speakerId: 'alice',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'ORIGINAL_SELECTED_TEXT 原文',
        occurredAt: 1000,
        ...patch,
      },
    });
  const memory = (refs: SourceRef[], proposal = claim) => {
    const job = store.beginJob(scope, refs),
      lease = store.claimLease(scope, job.id);
    store.propose(scope, job.id, lease.token, proposal);
    return { id: store.publish(scope, job.id, lease.token).id, revision: 1 };
  };
  return {
    store,
    scope,
    service,
    root,
    memory,
    advance: (ms: number) => {
      wall += ms;
    },
    setWall: (value: number) => {
      wall = value;
    },
    persisted: () => persisted,
    wallReads: () => wallReads,
  };
}

test('lint/revalidate preserve exact selected originals, derived provenance and DB/persistence without public content hashes', (t) => {
  const f = fixture(t),
    root = f.root('one'),
    memory = f.memory([root]),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
  const before = f.store.snapshot(),
    persisted = f.persisted(),
    reads = f.wallReads();
  const result = f.service.lint(
    binding,
    raw(row(), row(0, { variant: 'translation', language: 'en', derivedText: 'SYNTHETIC translation' })),
  );
  assert.equal(f.wallReads(), reads + 1);
  assert.equal(result.report.counts.admitted, 2);
  assert.equal(result.manifest.rows[0]!.text, 'ORIGINAL_SELECTED_TEXT 原文');
  assert.equal(result.manifest.sources.selected[0]!.memory.statement, 'DERIVED_MODEL_STATEMENT');
  assert.equal(result.manifest.rows[1]!.textKind, 'derived_translation');
  assert.deepEqual(result.manifest.rows[1]!.provenance.sourceActor, { id: 'alice', role: 'subject' });
  assert.equal(result.report.quality, 'NOT_EVALUATED');
  assert.doesNotMatch(JSON.stringify(result.report), /ORIGINAL|DERIVED|translation|alice|manifestDigest|sha256/);
  const validated = f.service.revalidate(binding, result.candidate);
  assert.equal(validated.manifest.manifestDigest, result.manifest.manifestDigest);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.persisted(), persisted);
});

test('policy/epoch/ref inputs are detached copies and nested output mutations cannot change authority', (t) => {
  const f = fixture(t),
    root = f.root('one'),
    memory = f.memory([root]),
    mutablePolicy = { ...policy };
  const service = new CurationService(f.store, mutablePolicy),
    epoch = { ...f.scope },
    refs = [{ ...memory }];
  const binding = service.bind({ epoch, publishedRefs: refs });
  mutablePolicy.cutoff = 0;
  epoch.generation = 99;
  refs[0]!.revision = 99;
  const result = service.lint(binding, raw(row()));
  assert.equal(result.report.counts.train, 1);
  assert.equal(result.manifest.policy.cutoff, 2000);
  assert.equal(Reflect.set(result.manifest.rows[0]!.provenance.sourceActor, 'id', 'other'), false);
  assert.equal(Reflect.set(result.manifest.rows[0]!.annotation, 'condition', 'rewritten'), false);
  assert.equal(Reflect.set(result.manifest.sources.events[0]!.evidence, 'selectedText', 'rewritten'), false);
  assert.equal(Reflect.set(result.candidate, 'version', 2), false);
  assert.equal(service.revalidate(binding, result.candidate).report.counts.admitted, 1);
});

test('copies, foreign services, sibling bindings and self-asserted payloads cannot reuse a candidate capability', (t) => {
  const f = fixture(t),
    memory = f.memory([f.root('one')]),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
  const result = f.service.lint(binding, raw(row())),
    other = new CurationService(f.store, { ...policy, curationVersion: 'different-policy' });
  assert.throws(() => f.service.lint({ ...binding }, raw(row())), code('UNAUTHENTICATED'));
  assert.throws(() => other.lint(binding, raw(row())), code('UNAUTHENTICATED'));
  assert.throws(
    () => f.service.revalidate(binding, JSON.parse(JSON.stringify(result.candidate))),
    code('UNAUTHENTICATED'),
  );
  assert.throws(
    () =>
      f.service.revalidate(binding, {
        ...result.candidate,
        payload: raw(row(0, { split: 'eval' })),
      } as typeof result.candidate),
    code('UNAUTHENTICATED'),
  );
  const sibling = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
  assert.throws(() => f.service.revalidate(sibling, result.candidate), code('UNAUTHENTICATED'));
  const foreign = other.bind({ epoch: f.scope, publishedRefs: [memory] });
  assert.throws(() => other.revalidate(foreign, result.candidate), code('UNAUTHENTICATED'));
});

test('canonical digest covers policy, source and every declared payload field independently of JSON key order', (t) => {
  const f = fixture(t),
    memory = f.memory([f.root('one')]),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
  const r = row(),
    a = f.service.lint(binding, raw(r)),
    reordered = {
      annotation: r.annotation,
      split: r.split,
      language: r.language,
      variant: r.variant,
      rootIndex: r.rootIndex,
      memoryIndex: r.memoryIndex,
    };
  assert.equal(
    f.service.lint(binding, JSON.stringify({ rows: [reordered], version: 1 })).manifest.manifestDigest,
    a.manifest.manifestDigest,
  );
  const b = f.service.lint(binding, raw({ ...r, annotation: { ...r.annotation, uncertain: true } }));
  assert.notEqual(b.manifest.manifestDigest, a.manifest.manifestDigest);
  const second = new CurationService(f.store, { ...policy, selectionVersion: 'different' }),
    bound = second.bind({ epoch: f.scope, publishedRefs: [memory] });
  assert.notEqual(second.lint(bound, raw(r)).manifest.manifestDigest, a.manifest.manifestDigest);
});

for (const key of ['scope', 'epoch', 'learningAllowed', 'sourceRefs', 'rootEventRefs', 'sourceGroup'])
  test(`JSON cannot self-assert ${key}`, (t) => {
    const f = fixture(t),
      binding = f.service.bind({ epoch: f.scope, publishedRefs: [] });
    assert.throws(
      () => f.service.lint(binding, JSON.stringify({ version: 1, rows: [], [key]: true })),
      code('INVALID_WIRE_SHAPE'),
    );
  });
for (const key of ['sourceActor', 'speakerId', 'mode', 'basis', 'occurredAt', 'group', 'actor'])
  test(`row JSON cannot rewrite ${key}`, (t) => {
    const f = fixture(t),
      memory = f.memory([f.root('one')]),
      binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
    assert.throws(
      () => f.service.lint(binding, JSON.stringify({ version: 1, rows: [{ ...row(), [key]: 'forged' }] })),
      code('INVALID_WIRE_SHAPE'),
    );
  });

test('raw JSON 65536/65537, closed annotation fields, invalid selectors and field/row limits are enforced', (t) => {
  const f = fixture(t),
    memory = f.memory([f.root('one')]),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
  const empty = raw();
  assert.equal(f.service.lint(binding, empty + ' '.repeat(65536 - Buffer.byteLength(empty))).report.counts.admitted, 0);
  assert.throws(
    () => f.service.lint(binding, empty + ' '.repeat(65537 - Buffer.byteLength(empty))),
    code('MESSAGE_TOO_LARGE'),
  );
  assert.throws(() => f.service.lint(binding, '{'), code('INVALID_JSON'));
  assert.throws(() => f.service.lint(binding, raw(row(1))), code('CURATION_SELECTION_INVALID'));
  assert.throws(() => f.service.lint(binding, raw(row(0, { rootIndex: 1 }))), code('CURATION_SELECTION_INVALID'));
  assert.throws(
    () =>
      f.service.lint(
        binding,
        JSON.stringify({ version: 1, rows: [{ ...row(), annotation: { ...row().annotation, actor: 'forged' } }] }),
      ),
    code('INVALID_WIRE_SHAPE'),
  );
  assert.throws(
    () => f.service.lint(binding, raw(row(0, { derivedText: 'override original' }))),
    code('INVALID_WIRE_SHAPE'),
  );
  assert.equal(
    f.service.lint(binding, raw(row(0, { variant: 'summary', derivedText: '界'.repeat(4096) }))).report.counts.admitted,
    1,
  );
  assert.throws(
    () => f.service.lint(binding, raw(row(0, { variant: 'summary', derivedText: 'a'.repeat(4097) }))),
    code('INVALID_INPUT'),
  );
  assert.equal(f.service.lint(binding, raw(...Array.from({ length: 128 }, () => row()))).report.counts.duplicates, 127);
  assert.throws(
    () => f.service.lint(binding, raw(...Array.from({ length: 129 }, () => row()))),
    code('CURATION_LIMIT'),
  );
});

test('zh/en/ja/mixed/unknown remain declared labels, including negation, uncertainty and conditionality', (t) => {
  const f = fixture(t),
    memory = f.memory([f.root('one')]),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
  const rows = (['zh', 'en', 'ja', 'mixed', 'unknown'] as const).map((language) =>
    row(0, {
      language,
      annotation: { ...row().annotation, polarity: 'negated', condition: 'when raining', uncertain: true },
    }),
  );
  const result = f.service.lint(binding, raw(...rows));
  assert.equal(result.report.counts.admitted, 5);
  assert.deepEqual(new Set(result.report.languages), new Set(['zh', 'en', 'ja', 'mixed', 'unknown']));
  assert.ok(
    result.manifest.rows.every(
      (r) => r.annotation.uncertain && r.annotation.polarity === 'negated' && r.annotation.condition === 'when raining',
    ),
  );
  const unknown = f.service.lint(binding, raw(row(0, { annotation: { ...row().annotation, condition: null } })));
  assert.ok(unknown.report.codes.includes('UNKNOWN_CONDITION'));
  assert.equal(unknown.report.counts.admitted, 0);
});

test('transitive shared roots group A{r1}, B{r1,r2}, C{r2}, even when bridge B has no row', (t) => {
  const f = fixture(t),
    r1 = f.root('one'),
    r2 = f.root('two');
  const refs = [f.memory([r1]), f.memory([r1, r2]), f.memory([r2])],
    binding = f.service.bind({ epoch: f.scope, publishedRefs: refs });
  const result = f.service.lint(
    binding,
    raw(row(0), row(2, { variant: 'translation', derivedText: 'translation', split: 'eval' })),
  );
  assert.equal(result.manifest.groups.length, 1);
  assert.deepEqual(result.manifest.groups[0]!.memoryIndices, [0, 1, 2]);
  assert.equal(result.manifest.groups[0]!.rootEventRefs.length, 2);
  assert.ok(result.report.codes.includes('GROUP_SPLIT_CONFLICT'));
  assert.equal(result.report.counts.admitted, 0);
});

test('same-root original/translation or duplicate declarations cannot hide a requested train/eval leak', (t) => {
  const f = fixture(t),
    r = f.root('one'),
    refs = [f.memory([r]), f.memory([r])],
    binding = f.service.bind({ epoch: f.scope, publishedRefs: refs });
  const duplicate = f.service.lint(binding, raw(row(0), row(1)));
  assert.equal(duplicate.report.counts.admitted, 1);
  assert.equal(duplicate.report.counts.duplicates, 1);
  for (const second of [
    row(1, { split: 'eval' }),
    row(1, { variant: 'translation', derivedText: 'translated', split: 'eval' }),
  ]) {
    const result = f.service.lint(binding, raw(row(0), second));
    assert.equal(result.report.counts.admitted, 0);
    assert.ok(result.report.codes.includes('GROUP_SPLIT_CONFLICT'));
  }
});

test('chronological split uses every root occurrence, includes equal cutoff in eval, and never substitutes recordedAt', (t) => {
  const f = fixture(t),
    train = f.memory([f.root('before', { occurredAt: 1999 })]),
    evalRef = f.memory([f.root('equal', { occurredAt: 2000 })]);
  const binding = f.service.bind({ epoch: f.scope, publishedRefs: [train, evalRef] }),
    result = f.service.lint(binding, raw(row(0), row(1, { split: 'eval' })));
  assert.equal(result.report.counts.train, 1);
  assert.equal(result.report.counts.eval, 1);
  assert.equal(result.manifest.sources.selected[0]!.memory.recordedAt, 100_000);
  const incorrect = f.service.lint(binding, raw(row(0, { split: 'eval' })));
  assert.ok(incorrect.report.codes.includes('CHRONOLOGY_MISMATCH'));
});

for (const kind of ['null', 'cross-cutoff'] as const)
  test(`${kind} in any authoritative group root quarantines the whole group`, (t) => {
    const f = fixture(t),
      r1 = f.root('one'),
      r2 = f.root('two', { occurredAt: kind === 'null' ? null : 2000 });
    const refs = [f.memory([r1]), f.memory([r1, r2])],
      binding = f.service.bind({ epoch: f.scope, publishedRefs: refs });
    const result = f.service.lint(binding, raw(row(0)));
    assert.equal(result.report.counts.admitted, 0);
    assert.ok(result.report.codes.includes(kind === 'null' ? 'UNKNOWN_EVENT_TIME' : 'CROSS_CUTOFF_GROUP'));
  });

test('quoted and inferred evidence retains source actor/mode/basis; a quotation subject cannot replace the actor', (t) => {
  const f = fixture(t),
    event = f.root('quote', {
      speakerId: 'bob',
      speakerRole: 'third_party',
      mode: 'quotation',
      selectedText: 'Bob quotes Carol',
    });
  const memory = f.memory([event], {
    kind: 'belief',
    statement: 'derived uncertain interpretation',
    basis: 'inference',
    validFrom: null,
    validTo: 200_000,
  });
  const binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] });
  const annotation = {
    ...row().annotation,
    quotation: 'quotation' as const,
    quotationSubject: 'Carol',
    uncertain: true,
  };
  const result = f.service.lint(binding, raw(row(0, { annotation }))),
    r = result.manifest.rows[0]!;
  assert.deepEqual(r.provenance.sourceActor, { id: 'bob', role: 'third_party' });
  assert.equal(r.provenance.mode, 'quotation');
  assert.equal(r.provenance.memoryBasis, 'inference');
  assert.equal(r.annotation.quotationSubject, 'Carol');
  assert.equal(r.text, 'Bob quotes Carol');
  assert.equal(f.service.lint(binding, raw(row())).report.counts.admitted, 0);
  assert.ok(f.service.lint(binding, raw(row())).report.codes.includes('QUOTATION_MODE_MISMATCH'));
});

test('only matching actor/key/condition/quotation semantics and overlapping applicability declare a contradiction', (t) => {
  const f = fixture(t),
    a = f.memory([f.root('one')]),
    b = f.memory([f.root('two')]),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [a, b] });
  const positive = { ...row().annotation, claimKey: 'likes-blue', polarity: 'affirmed' as const };
  const negative = { ...positive, polarity: 'negated' as const };
  const conflicted = f.service.lint(binding, raw(row(0, { annotation: positive }), row(1, { annotation: negative })));
  assert.equal(conflicted.report.counts.admitted, 0);
  assert.ok(conflicted.report.codes.includes('DECLARED_CONTRADICTION'));
  for (const patch of [
    { condition: 'when working' },
    { claimKey: 'likes-green' },
    { quotation: 'quotation' as const, quotationSubject: 'Carol' },
  ]) {
    const result = f.service.lint(
      binding,
      raw(row(0, { annotation: positive }), row(1, { annotation: { ...negative, ...patch } })),
    );
    assert.equal(result.report.counts.admitted, 2);
    assert.equal(result.report.codes.includes('DECLARED_CONTRADICTION'), false);
  }
});

test('different authoritative source actors are not collapsed by identical manual claim keys', (t) => {
  const f = fixture(t),
    a = f.root('a', { mode: 'observation' }),
    b = f.root('b', { speakerId: 'bob', speakerRole: 'third_party', mode: 'observation' });
  const refs = [f.memory([a], { ...claim, basis: 'observation' }), f.memory([b], { ...claim, basis: 'observation' })],
    binding = f.service.bind({ epoch: f.scope, publishedRefs: refs });
  const annotations = ['affirmed', 'negated'].map((polarity) => ({
    ...row().annotation,
    claimKey: 'same-key',
    polarity: polarity as 'affirmed' | 'negated',
  }));
  const result = f.service.lint(
    binding,
    raw(row(0, { annotation: annotations[0]! }), row(1, { annotation: annotations[1]! })),
  );
  assert.equal(result.report.counts.admitted, 2);
  assert.equal(result.report.codes.includes('DECLARED_CONTRADICTION'), false);
});

test('unknown conditions and uncertain or unattributed quotes do not become definite contradictory claims', (t) => {
  const f = fixture(t),
    refs = [f.memory([f.root('a')]), f.memory([f.root('b')])],
    binding = f.service.bind({ epoch: f.scope, publishedRefs: refs });
  for (const patch of [
    { condition: null },
    { uncertain: true },
    { quotation: 'unknown' as const },
    { quotation: 'quotation' as const, quotationSubject: null },
  ]) {
    const annotation = { ...row().annotation, claimKey: 'same-key', ...patch };
    const result = f.service.lint(
      binding,
      raw(
        row(0, { annotation: { ...annotation, polarity: 'affirmed' } }),
        row(1, { annotation: { ...annotation, polarity: 'negated' } }),
      ),
    );
    assert.equal(result.report.codes.includes('DECLARED_CONTRADICTION'), false);
  }
});

test('direct declarations cannot supply quotation subjects to evade contradiction grouping', (t) => {
  const f = fixture(t),
    refs = [f.memory([f.root('a')]), f.memory([f.root('b')])],
    binding = f.service.bind({ epoch: f.scope, publishedRefs: refs });
  const annotation = { ...row().annotation, claimKey: 'same-key' };
  assert.throws(
    () =>
      f.service.lint(
        binding,
        raw(
          row(0, { annotation: { ...annotation, polarity: 'affirmed', quotationSubject: 'X' } }),
          row(1, { annotation: { ...annotation, polarity: 'negated', quotationSubject: 'Y' } }),
        ),
      ),
    code('INVALID_WIRE_SHAPE'),
  );
});

test('pure-rule unit only: disjoint synthetic applicability windows do not contradict; service does not admit such historical sources', (t) => {
  const f = fixture(t),
    refs = [f.memory([f.root('a')]), f.memory([f.root('b')])],
    snapshot = structuredClone(f.store.curationSnapshot(f.scope, refs));
  // Deliberately unit-only input to the production pure rule; never a service capability.
  const synthetic = {
    ...snapshot,
    selected: snapshot.selected.map((selected, i) => ({
      ...selected,
      memory: { ...selected.memory, validFrom: i * 100, validTo: (i + 1) * 100 },
    })),
  };
  const positive = { ...row().annotation, claimKey: 'same-key', polarity: 'affirmed' as const };
  const result = curateDeclarations(
    synthetic,
    {
      version: 1,
      rows: [row(0, { annotation: positive }), row(1, { annotation: { ...positive, polarity: 'negated' } })],
    },
    policy,
  );
  assert.equal(result.report.codes.includes('DECLARED_CONTRADICTION'), false);
});

for (const operation of ['revise', 'revoke', 'consent-off-on', 'purge', 'unbind'] as const)
  test(`${operation} invalidates the original candidate and binding`, (t) => {
    const f = fixture(t),
      root = f.root('one'),
      memory = f.memory([root]),
      binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] }),
      candidate = f.service.lint(binding, raw(row())).candidate;
    let expected: string;
    if (operation === 'revise') {
      f.store.reviseEvent(f.scope, root, {
        speakerId: 'alice',
        speakerRole: 'subject',
        mode: 'self_report',
        selectedText: 'corrected',
        occurredAt: 1000,
      });
      expected = 'STALE_SOURCE';
    } else if (operation === 'revoke') {
      f.store.revoke(f.scope, root);
      expected = 'STALE_SOURCE';
    } else if (operation === 'consent-off-on') {
      const off = f.store.setLearningConsent(f.scope, false);
      f.store.setLearningConsent(off, true);
      expected = 'STALE_CONSENT';
    } else if (operation === 'purge') {
      f.store.purge(f.scope);
      expected = 'STALE_SCOPE';
    } else {
      f.service.unbind(binding);
      expected = 'UNAUTHENTICATED';
    }
    assert.throws(() => f.service.revalidate(binding, candidate), code(expected));
    assert.throws(() => f.service.lint(binding, raw()), code(expected));
  });

test('TTL and current authority are revalidated even for zero admitted rows and empty selections', (t) => {
  const f = fixture(t),
    root = f.root('null-time', { occurredAt: null }),
    memory = f.memory([root], { ...claim, validTo: 100_010 });
  const binding = f.service.bind({ epoch: f.scope, publishedRefs: [memory] }),
    result = f.service.lint(binding, raw(row()));
  assert.equal(result.report.counts.admitted, 0);
  f.advance(10);
  assert.throws(() => f.service.revalidate(binding, result.candidate), code('STALE_SOURCE'));
  const empty = f.service.bind({ epoch: f.scope, publishedRefs: [] }),
    candidate = f.service.lint(empty, raw()).candidate;
  f.store.purge(f.scope);
  assert.throws(() => f.service.revalidate(empty, candidate), code('STALE_SCOPE'));
});

test('unrelated revocation changes runtime authority even for an empty report', (t) => {
  const f = fixture(t),
    root = f.root('one'),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [] }),
    candidate = f.service.lint(binding, raw()).candidate;
  f.store.revoke(f.scope, root);
  assert.throws(() => f.service.revalidate(binding, candidate), code('CURATION_AUTHORITY_CHANGED'));
});

test('future/expired sources fail before rows, and invalid clocks cannot produce an empty authority snapshot', (t) => {
  const f = fixture(t),
    memory = f.memory([f.root('one')], { ...claim, validFrom: 100_001 });
  assert.throws(() => f.service.bind({ epoch: f.scope, publishedRefs: [memory] }), code('STALE_SOURCE'));
  const binding = f.service.bind({ epoch: f.scope, publishedRefs: [] });
  for (const value of [null, NaN, -1, Infinity]) {
    f.setWall(value as number);
    assert.throws(() => f.service.lint(binding, 'not JSON'), code('INVALID_INPUT'));
  }
});

test('empty manifests still require active learning permission, report only lint, and use frozen asOf with fresh revalidation', (t) => {
  const f = fixture(t),
    binding = f.service.bind({ epoch: f.scope, publishedRefs: [] }),
    result = f.service.lint(binding, raw());
  assert.equal(result.report.status, 'CURATION_LINT_PASS');
  assert.equal(result.report.trainingQuality, 'NOT_EVALUATED');
  f.advance(50);
  const current = f.service.revalidate(binding, result.candidate);
  assert.equal(current.manifest.asOf, 100_000);
  assert.equal(canonical(current), canonical({ manifest: result.manifest, report: result.report }));
  const off = f.store.setLearningConsent(f.scope, false);
  assert.throws(() => f.service.bind({ epoch: off, publishedRefs: [] }), code('LEARNING_NOT_ALLOWED'));
  assert.throws(() => f.service.revalidate(binding, result.candidate), code('STALE_CONSENT'));
});

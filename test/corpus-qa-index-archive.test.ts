import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs, { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { canonical, hash } from '../src/wf1-json.ts';
import { HostAuthority } from '../src/wf1-storage.ts';
import { openQualityAudit } from '../src/corpus-qa-store.ts';
import {
  archiveCapability,
  openQualityIndexArchive,
  QA_INDEX_ARCHIVE_PROFILE_DIGEST,
  QA_INDEX_ARCHIVE_SCOPE,
} from '../src/corpus-qa-index-archive.ts';
import type {
  QualityIndexArchive,
  QaIndexArchiveDescriptor,
  QaIndexArchiveAdmission,
} from '../src/corpus-qa-index-archive.ts';
import { writeQualityArchiveAssembly } from '../src/corpus-qa-archive-assembly.ts';
import { QA_LEGACY_F1 } from '../src/corpus-qa-legacy-f1.ts';
import { exportQualityAudit, readQualityIndex } from '../src/corpus-qa-runner.ts';
import { qaFixture, qaMock, runQa } from './corpus-qa-fixture.ts';
import { archiveFixture, decryptAssembly } from './corpus-qa-index-archive-fixture.ts';

test('expired revoked f1 opens under fresh independent metadata grant; old execution and files stay frozen', () => {
  const f = archiveFixture(),
    before = [f.ledger, f.authorityPath, join(f.runtimeRoot, 'once.json')].map((p) => hash(readFileSync(p))),
    r = openQualityIndexArchive(f.readerOptions);
  try {
    assert.deepEqual(Object.keys(r).sort(), ['check', 'close', 'readVerifiedView']);
    const view = r.readVerifiedView();
    assert.equal(view.index.entries.length, 40);
    assert.equal(view.eligibleRows.length, 40);
    assert.equal(hash(canonical(view.selection)), f.descriptor.spec.selectionDigest);
    assert.throws(() => new HostAuthority(f.authorityPath, f.descriptor.spec.auditId).read(Date.now(), false), {
      code: 'WF1_AUTHORITY',
    });
    for (const mode of ['inspect', 'resume'] as const)
      assert.throws(
        () =>
          openQualityAudit({
            ...f.readerOptions,
            spec: f.descriptor.spec,
            mode,
            admission: () => {
              throw Error('old grant must not be consulted');
            },
            sourceCheck: () => {
              throw Error('old source must not be read');
            },
          }),
        { code: 'WF1_AUTHORITY' },
      );
    assert.deepEqual(
      [f.ledger, f.authorityPath, join(f.runtimeRoot, 'once.json')].map((p) => hash(readFileSync(p))),
      before,
    );
  } finally {
    r.close();
  }
});

test('metadata read spy permits only structural SQL, two terminal events, index/manifest/selection artifacts', () => {
  const f = archiveFixture(),
    reads: string[] = [],
    sql: string[] = [],
    oldRead = fs.readFileSync,
    oldPrepare = DatabaseSync.prototype.prepare;
  const allowed = new Set(
    [
      f.descriptor.indexRef,
      f.descriptor.manifestRef,
      f.descriptor.selectionRef,
      ...f.indexChunks,
      ...f.selectionChunks,
      ...f.eventRefs.slice(-2),
    ].map((r) => f.paths.get(r.ref.id)!),
  );
  fs.readFileSync = ((path: any, ...args: any[]) => {
    reads.push(String(path));
    return (oldRead as any)(path, ...args);
  }) as typeof fs.readFileSync;
  DatabaseSync.prototype.prepare = function (query: string) {
    sql.push(query);
    return oldPrepare.call(this, query);
  };
  syncBuiltinESMExports();
  try {
    const r = openQualityIndexArchive(f.readerOptions);
    try {
      r.readVerifiedView();
    } finally {
      r.close();
    }
  } finally {
    fs.readFileSync = oldRead;
    DatabaseSync.prototype.prepare = oldPrepare;
    syncBuiltinESMExports();
  }
  assert.equal(reads.filter((p) => p.endsWith('.bin')).length, allowed.size);
  assert.ok(reads.filter((p) => p.endsWith('.bin')).every((p) => allowed.has(p)));
  assert.ok(!reads.some((p) => p.includes('once') || p.includes('owner')));
  assert.ok(sql.every((q) => !/\bFROM (cases|attempts)\b/i.test(q)));
});

test('new grant missing/wrong/revoked/expired and withdrawn source/retain fail before key validation', async (t) => {
  for (const kind of [
    'missing',
    'wrong-descriptor',
    'wrong-purpose',
    'revoked',
    'expired',
    'future',
    'read',
    'retain',
    'source',
    'source-retain',
    'job',
    'source-purpose',
    'parent',
  ] as const)
    await t.test(kind, () => {
      const f = archiveFixture({ count: 1 }),
        a = f.admission,
        g = a.grant;
      if (kind === 'missing') delete (a as any).grant;
      if (kind === 'wrong-descriptor') g.descriptorDigest = hash('wrong');
      if (kind === 'wrong-purpose') g.purposeDigest = hash('wrong');
      if (kind === 'revoked') g.status = 'REVOKED';
      if (kind === 'expired') g.expiresAt = Date.now() - 1;
      if (kind === 'future') g.validFrom = Date.now() + 10000;
      if (kind === 'read') g.readAllowed = false;
      if (kind === 'retain') g.retainAllowed = false;
      if (kind === 'source') a.sourceAllowed = false;
      if (kind === 'source-retain') a.retainAllowed = false;
      if (kind === 'job') a.sourceJobId = 'wrong';
      if (kind === 'source-purpose') a.sourcePurposeDigest = hash('wrong');
      if (kind === 'parent') a.parentGrantIds = ['wrong'];
      assert.throws(
        () => openQualityIndexArchive({ ...f.readerOptions, key: new Uint8Array(0) }),
        (e) => (e as any).code !== 'CQA_ARCHIVE_KEY',
      );
    });
});

test('reader owns descriptor/key; closed, failed, renewed and rollback-clock handles cannot revive', () => {
  const f = archiveFixture({ count: 1 }),
    r = openQualityIndexArchive(f.readerOptions);
  f.key.fill(0);
  f.descriptor.indexDigest = hash('caller mutation');
  assert.equal(r.readVerifiedView().index.entries.length, 1);
  r.close();
  assert.throws(() => r.readVerifiedView(), { code: 'CQA_ARCHIVE_CLOSED' });
  const g = archiveFixture({ count: 1 }),
    s = openQualityIndexArchive(g.readerOptions);
  g.admission.grant.status = 'REVOKED';
  assert.throws(s.check);
  g.admission.grant.status = 'ACTIVE';
  assert.throws(s.check, { code: 'CQA_ARCHIVE_CLOSED' });
  const h = archiveFixture({ count: 1 });
  let now = Date.now();
  const q = openQualityIndexArchive({ ...h.readerOptions, now: () => now });
  now -= 1;
  assert.throws(q.check, { code: 'CQA_ARCHIVE_ADMISSION' });
  const j = archiveFixture({ count: 1 }),
    k = openQualityIndexArchive(j.readerOptions);
  j.admission.grant.revision++;
  j.admission.grant.expiresAt++;
  assert.throws(k.check, { code: 'CQA_ARCHIVE_ADMISSION' });
});

test('host-pinned descriptor, closure, legacy build/spec, frozen authority and cold digest fail closed', async (t) => {
  for (const kind of [
    'descriptor',
    'reader-closure',
    'legacy-build',
    'audit',
    'spec',
    'authority-head',
    'authority-status',
    'cold-index',
  ] as const)
    await t.test(kind, () => {
      const f = archiveFixture({ count: 1 });
      if (kind === 'descriptor') f.readerOptions.descriptorDigest = hash('wrong');
      if (kind === 'reader-closure') f.readerOptions.readerBuildDigest = hash('wrong');
      if (kind === 'legacy-build') {
        f.descriptor.spec.buildDigest = hash('unknown future build');
        f.repin();
      }
      if (kind === 'audit') {
        f.descriptor.spec.auditId = 'other';
        f.repin();
      }
      if (kind === 'spec') {
        f.descriptor.specDigest = hash('wrong');
        f.readerOptions.descriptorDigest = hash(canonical(f.descriptor));
        f.admission.grant.descriptorDigest = f.readerOptions.descriptorDigest;
      }
      if (kind === 'authority-head') {
        f.authority.head = hash('rollback head');
        writeFileSync(f.authorityPath, canonical(f.authority));
        f.repin();
      }
      if (kind === 'authority-status') {
        f.descriptor.authorityStatus = 'ACTIVE';
        f.repin();
      }
      if (kind === 'cold-index') {
        f.descriptor.indexDigest = hash('wrong accepted cold index');
        f.repin();
      }
      assert.throws(() => {
        const r = openQualityIndexArchive(f.readerOptions);
        try {
          r.readVerifiedView();
        } finally {
          r.close();
        }
      });
    });
});

test('ledger rollback/tail, schema drift and projection swap never discover orphan artifacts', async (t) => {
  for (const kind of ['rollback', 'tail', 'schema', 'projection', 'orphan', 'terminal-order'] as const)
    await t.test(kind, () => {
      const f = archiveFixture({ count: 1 });
      if (['rollback', 'tail', 'schema'].includes(kind)) {
        const db = new DatabaseSync(f.ledger);
        if (kind === 'rollback') db.exec('DELETE FROM events WHERE sequence=3');
        if (kind === 'tail')
          db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(
            4,
            f.descriptor.committedHead,
            canonical(f.eventRefs[2]),
            hash('tail'),
          );
        if (kind === 'schema') db.exec('CREATE TABLE extra(data TEXT)');
        db.close();
        f.repin();
      }
      if (kind === 'projection')
        f.changeProjection((p) => {
          p.indexRef = f.put('corpus-qa-dedup-index', { orphan: true });
        });
      if (kind === 'orphan') {
        f.descriptor.indexRef = f.put('corpus-qa-dedup-index', { orphan: true });
        f.changeProjection((p) => {
          p.indexRef = f.descriptor.indexRef;
        });
      }
      if (kind === 'terminal-order') {
        const r = f.put(
            'corpus-qa-event',
            {
              version: 'CorpusQualityAuditEvent/0.1',
              kind: 'FINISH',
              data: { status: 'COMPLETED', code: null, wallMs: 0 },
            },
            'event-0',
          ),
          db = new DatabaseSync(f.ledger),
          previous = String(db.prepare('SELECT previous FROM events WHERE sequence=3').get()!.previous),
          body = canonical(r),
          next = hash(previous + '\n' + body);
        db.prepare('UPDATE events SET ref=?,digest=? WHERE sequence=3').run(body, next);
        db.close();
        f.descriptor.committedHead = next;
        f.authority.head = next;
        writeFileSync(f.authorityPath, canonical(f.authority));
        f.repin();
      }
      const r = openQualityIndexArchive(f.readerOptions);
      assert.throws(r.readVerifiedView);
      assert.throws(r.check, { code: 'CQA_ARCHIVE_CLOSED' });
    });
});

test('authenticated metadata substitutions, chunk kind/order/duplicate and manifest membership are rejected', async (t) => {
  for (const kind of [
    'manifest-job',
    'manifest-extra',
    'manifest-missing',
    'manifest-verdict',
    'selection-token',
    'selection-ref',
    'chunk-kind',
    'chunk-order',
    'chunk-duplicate',
  ] as const)
    await t.test(kind, () => {
      const f = archiveFixture();
      if (kind.startsWith('manifest')) {
        const m = structuredClone(f.manifest);
        if (kind === 'manifest-job') m.source.jobId = 'other-job';
        if (kind === 'manifest-extra') m.rows.push(m.rows[0]!);
        if (kind === 'manifest-missing') m.rows.pop();
        if (kind === 'manifest-verdict') m.rows[0]!.verdictRef.ref.kind = 'native-final';
        const ref = f.put('corpus-qa-selection-manifest', m);
        f.descriptor.manifestRef = ref;
        f.changeProjection((p) => {
          p.manifestRef = ref;
        });
        f.replaceTerminal('MANIFEST', ref);
      } else if (kind.startsWith('selection')) {
        const s = structuredClone(f.selection);
        if (kind === 'selection-token') {
          s.entries[0]!.measurement.studentLossTokens = '100';
          s.entries[0]!.measurement.fullTokens = String(Number(s.entries[0]!.measurement.studentInputTokens) + 100);
        } else s.entries[0]!.sourceRowRef = s.entries[1]!.sourceRowRef;
        const chunks = [];
        for (let i = 0; i < s.entries.length; i += 32)
          chunks.push(f.put('corpus-qa-selection-chunk', s.entries.slice(i, i + 32)));
        const { entries, ...header } = s,
          ref = f.put('corpus-qa-selection', { version: 'CorpusQualitySelectionChunks/0.1', header, entries: chunks });
        f.descriptor.selectionRef = ref;
        f.changeProjection((p) => {
          p.selectionRef = ref;
        });
        const m = f.put('corpus-qa-selection-manifest', { ...f.manifest, selectionRef: ref });
        f.descriptor.manifestRef = m;
        f.changeProjection((p) => {
          p.manifestRef = m;
        });
        f.replaceTerminal('MANIFEST', m);
      } else {
        let chunks = [...f.indexChunks];
        if (kind === 'chunk-kind') chunks[0] = f.put('corpus-qa-selection-chunk', f.index.entries.slice(0, 32));
        if (kind === 'chunk-order') chunks.reverse();
        if (kind === 'chunk-duplicate') chunks = [chunks[0]!, chunks[0]!];
        const ref = f.put('corpus-qa-dedup-index', {
          version: 'CorpusScopedDedupIndexChunks/0.1',
          scope: f.index.scope,
          entries: chunks,
        });
        f.descriptor.indexRef = ref;
        f.changeProjection((p) => {
          p.indexRef = ref;
        });
        f.replaceTerminal('INDEX', ref);
      }
      const r = openQualityIndexArchive(f.readerOptions);
      assert.throws(r.readVerifiedView);
    });
});

test('between-chunk revocation blocks decryption/output; concurrent file mutation is hashed again', async (t) => {
  for (const kind of ['revoke', 'mutate'] as const)
    await t.test(kind, () => {
      const f = archiveFixture(),
        r = openQualityIndexArchive(f.readerOptions),
        oldRead = fs.readFileSync;
      let triggered = false;
      fs.readFileSync = ((path: any, ...args: any[]) => {
        const bytes = (oldRead as any)(path, ...args);
        if (!triggered && String(path) === f.paths.get(f.indexChunks[0]!.ref.id)) {
          triggered = true;
          if (kind === 'revoke') f.admission.grant.status = 'REVOKED';
          else {
            const db = new DatabaseSync(f.ledger);
            db.prepare('UPDATE cases SET data=?').run('SYNTHETIC concurrent mutation');
            db.close();
          }
        }
        return bytes;
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      try {
        assert.throws(r.readVerifiedView);
        assert.equal(triggered, true);
        assert.throws(r.check, { code: 'CQA_ARCHIVE_CLOSED' });
      } finally {
        fs.readFileSync = oldRead;
        syncBuiltinESMExports();
        r.close();
      }
    });
});

test('hardlinks, path aliases, hot journal/WAL/SHM and mutated ciphertext fail closed', async (t) => {
  for (const kind of ['hardlink', 'junction', 'journal', 'wal', 'shm', 'cipher'] as const)
    await t.test(kind, () => {
      const f = archiveFixture({ count: 1 });
      if (kind === 'hardlink') linkSync(f.ledger, join(f.base, 'duplicate-ledger'));
      if (kind === 'junction') {
        const alias = join(f.base, 'alias');
        symlinkSync(f.runtimeRoot, alias, 'junction');
        f.readerOptions.runtimeRoot = alias;
      }
      if (['journal', 'wal', 'shm'].includes(kind)) writeFileSync(f.ledger + '-' + kind, 'SYNTHETIC journal');
      if (kind === 'cipher') {
        const path = f.paths.get(f.indexChunks[0]!.ref.id)!,
          bytes = readFileSync(path);
        bytes[20] = bytes[20]! ^ 1;
        writeFileSync(path, bytes);
      }
      assert.throws(() => {
        const r = openQualityIndexArchive(f.readerOptions);
        try {
          r.readVerifiedView();
        } finally {
          r.close();
        }
      });
    });
});

test('assembly commits encrypted bounded chunks and inherits exact train/dev token sums; snapshots are not capabilities', () => {
  const f = archiveFixture(),
    r = openQualityIndexArchive(f.readerOptions);
  try {
    const view = r.readVerifiedView();
    view.index.entries[0]!.qaDisposition = 'REJECT';
    view.eligibleRows = [];
    assert.throws(
      () =>
        writeQualityArchiveAssembly(
          f.output([{ check() {}, readVerifiedView: () => view, close() {} } as QualityIndexArchive]),
        ),
      { code: 'CQA_ARCHIVE_CAPABILITY' },
    );
    assert.ok(Object.isFrozen(archiveCapability(r)));
    const o = f.output([r]),
      receipt = writeQualityArchiveAssembly(o),
      manifest = decryptAssembly(o);
    assert.equal(receipt.selectedRows, 40);
    assert.equal(manifest.chunks.length, 2);
    assert.equal(hash(canonical(manifest)), receipt.manifestDigest);
    assert.equal(manifest.trainingReady, false);
    assert.equal(manifest.falseAcceptanceRate, 'UNKNOWN');
    assert.equal(manifest.inputs[0].source.tokenizerProfileDigest, f.selection.source.tokenizerProfileDigest);
    const rows = manifest.chunks.flatMap(
      (c: any) => decryptAssembly(o, c.artifactId + '.bin', c.artifactId, c.kind).rows,
    );
    assert.equal(rows.length, 40);
    for (const split of ['train', 'dev'] as const) {
      const selected = f.selection.entries.filter((e) => e.unit.split === split);
      assert.deepEqual(receipt.totals[split], {
        rows: selected.length,
        studentInputTokens: selected.reduce((n, e) => n + Number(e.measurement.studentInputTokens), 0),
        studentLossTokens: selected.reduce((n, e) => n + Number(e.measurement.studentLossTokens), 0),
        fullTokens: selected.reduce((n, e) => n + Number(e.measurement.fullTokens), 0),
      });
    }
    assert.ok(readdirSync(o.runtimeRoot).every((n) => n.endsWith('.bin')));
    assert.ok(
      readdirSync(o.runtimeRoot).every((n) => !readFileSync(join(o.runtimeRoot, n)).includes(Buffer.from('unit-'))),
    );
    assert.throws(() => writeQualityArchiveAssembly(o), { code: 'CQA_ARCHIVE_DESTINATION' });
  } finally {
    r.close();
  }
});

test('fenced zero-eligible archive yields a valid zero selection, with no chunks and no fabricated PASS', () => {
  const f = archiveFixture({ zero: true }),
    r = openQualityIndexArchive(f.readerOptions);
  try {
    assert.equal(r.readVerifiedView().eligibleRows.length, 0);
    const o = f.output([r]),
      result = writeQualityArchiveAssembly(o);
    assert.equal(result.selectedRows, 0);
    assert.equal(result.indexedRows, 40);
    assert.deepEqual(decryptAssembly(o).chunks, []);
    assert.equal(result.totals.train.fullTokens, 0);
  } finally {
    r.close();
  }
});

test('A-B-C bridge keeps rejected nodes and holds all cross-split connected families', () => {
  const a = archiveFixture({
      job: 'A',
      count: 2,
      configure: (es) => {
        es.forEach((e) => {
          e.split = 'train';
          e.familyId = 'family';
        });
        es[0]!.promptDigest = hash('AB');
      },
    }),
    b = archiveFixture({
      job: 'B',
      count: 2,
      configure: (es) => {
        es.forEach((e) => {
          e.split = 'train';
          e.familyId = 'family';
          e.qaDisposition = 'REJECT';
        });
        es[0]!.promptDigest = hash('AB');
        es[1]!.normalizedDigest = hash('BC');
      },
    }),
    c = archiveFixture({
      job: 'C',
      count: 2,
      configure: (es) => {
        es.forEach((e) => {
          e.split = 'dev';
          e.familyId = 'family';
        });
        es[0]!.normalizedDigest = hash('BC');
      },
    }),
    readers = [a, b, c].map((f) => openQualityIndexArchive(f.readerOptions));
  try {
    assert.deepEqual(
      readers.map((r) => r.readVerifiedView().eligibleRows.length),
      [2, 0, 2],
    );
    const o = a.output(readers),
      result = writeQualityArchiveAssembly(o);
    assert.equal(result.selectedRows, 0);
    assert.equal(result.indexedRows, 6);
    assert.deepEqual(
      decryptAssembly(o).inputs.map((i: any) => i.source.jobId),
      ['A', 'B', 'C'],
    );
  } finally {
    readers.forEach((r) => r.close());
  }
});

test('same-split input ordering is deterministic; incompatible targets/tokenizer/purpose are rejected', () => {
  const make = (job: string) =>
      archiveFixture({
        job,
        count: 1,
        configure: (es) => {
          es[0]!.promptDigest = hash('same prompt');
        },
      }),
    a = make('first'),
    b = make('second'),
    readers = [a, b].map((f) => openQualityIndexArchive(f.readerOptions));
  try {
    for (const order of [readers, [...readers].reverse()]) {
      const o = a.output(order),
        result = writeQualityArchiveAssembly(o),
        m = decryptAssembly(o),
        chunk = m.chunks[0];
      assert.equal(result.selectedRows, 1);
      assert.equal(
        decryptAssembly(o, chunk.artifactId + '.bin', chunk.artifactId, chunk.kind).rows[0].sourceJobId,
        order[0] === readers[0] ? 'first' : 'second',
      );
    }
    assert.throws(() => writeQualityArchiveAssembly({ ...a.output(readers), purposeDigest: hash('wrong purpose') }), {
      code: 'CQA_ARCHIVE_INCOMPATIBLE',
    });
    assert.throws(
      () => writeQualityArchiveAssembly({ ...a.output(readers), readerBuildDigest: hash('other closure') }),
      { code: 'CQA_ARCHIVE_INCOMPATIBLE' },
    );
    assert.throws(() => writeQualityArchiveAssembly(a.output(Array(9).fill(readers[0]!))), {
      code: 'CQA_ARCHIVE_INPUTS',
    });
  } finally {
    readers.forEach((r) => r.close());
  }
  const wrong = archiveFixture({ count: 1 });
  wrong.descriptor.spec.studentTargetDigest = hash('future student');
  wrong.repin();
  assert.throws(() => openQualityIndexArchive(wrong.readerOptions), { code: 'CQA_ARCHIVE_PROFILE' });
  const other = archiveFixture({
      job: 'tokenizer',
      count: 1,
      configure: (_es, s) => {
        s.source.tokenizerProfileDigest = hash('different tokenizer');
        s.entries.forEach((e) => {
          e.measurement.tokenizerProfileDigest = s.source.tokenizerProfileDigest;
        });
      },
    }),
    fresh = make('fresh'),
    handles = [fresh, other].map((f) => openQualityIndexArchive(f.readerOptions));
  try {
    assert.throws(() => writeQualityArchiveAssembly(fresh.output(handles)), { code: 'CQA_ARCHIVE_INCOMPATIBLE' });
  } finally {
    handles.forEach((r) => r.close());
  }
});

test('all live grants are rechecked before output commit; revoked source leaves only encrypted uncommitted evidence', () => {
  const f = archiveFixture(),
    r = openQualityIndexArchive(f.readerOptions),
    o = f.output([r]),
    oldRead = fs.readFileSync;
  let triggered = false;
  fs.readFileSync = ((path: any, ...args: any[]) => {
    const bytes = (oldRead as any)(path, ...args);
    if (String(path) === join(o.runtimeRoot, 'manifest.pending.bin')) {
      triggered = true;
      f.admission.grant.status = 'REVOKED';
    }
    return bytes;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeQualityArchiveAssembly(o));
    assert.equal(triggered, true);
    assert.equal(existsSync(join(o.runtimeRoot, 'manifest.bin')), false);
    assert.ok(readdirSync(o.runtimeRoot).length > 0);
    assert.ok(readdirSync(o.runtimeRoot).every((p) => p.endsWith('.bin')));
  } finally {
    fs.readFileSync = oldRead;
    syncBuiltinESMExports();
    r.close();
  }
});

test('unchanged accepted producer writes a compatible archive under synthetic transport', async () => {
  const f = await qaFixture(8, undefined, false, QA_LEGACY_F1.buildDigest);
  try {
    await runQa(f, qaMock(f, { reject: f.selection.entries[0]!.caseId }));
    exportQualityAudit(f.store, f.source);
    const state = f.store.snapshot()!,
      index = readQualityIndex(f.store, state.indexRef!);
    f.store.control('REVOKED');
    f.store.close();
    f.source.close();
    const authority = JSON.parse(readFileSync(f.storeOptions.authorityPath, 'utf8')),
      ledger = join(f.storeOptions.runtimeRoot, 'corpus-qa.sqlite'),
      db = new DatabaseSync(ledger, { readOnly: true }),
      sequence = Number(db.prepare('SELECT count(*) AS n FROM events').get()!.n);
    db.close();
    const readerBuildDigest = hash('SYNTHETIC externally pinned reader closure'),
      descriptor: QaIndexArchiveDescriptor = {
        version: 'QaIndexArchiveDescriptor/0.1',
        legacyProfile: 'QA_F1',
        readerBuildDigest,
        archiveProfileDigest: QA_INDEX_ARCHIVE_PROFILE_DIGEST,
        spec: f.spec,
        specDigest: hash(canonical(f.spec)),
        source: f.selection.source,
        ledgerRawDigest: hash(readFileSync(ledger)),
        authorityRawDigest: hash(readFileSync(f.storeOptions.authorityPath)),
        authorityRevision: authority.revision,
        authorityStatus: authority.status,
        committedHead: authority.head,
        committedSequence: sequence,
        coldReceiptRawDigest: hash('SYNTHETIC producer verified receipt'),
        indexDigest: hash(canonical(index)),
        indexRef: state.indexRef!,
        manifestRef: state.manifestRef!,
        selectionRef: state.selectionRef,
      };
    const now = Date.now(),
      descriptorDigest = hash(canonical(descriptor)),
      admission: QaIndexArchiveAdmission = {
        grant: {
          version: 'QaIndexReadGrant/0.1',
          grantId: 'synthetic-current-index-grant',
          revision: 1,
          descriptorDigest,
          purposeDigest: f.spec.purposeDigest,
          status: 'ACTIVE',
          readAllowed: true,
          retainAllowed: true,
          validFrom: now - 1,
          expiresAt: now + 3600000,
          scope: QA_INDEX_ARCHIVE_SCOPE,
        },
        sourceJobId: f.selection.source.jobId,
        sourcePurposeDigest: f.selection.source.purposeDigest,
        parentGrantIds: f.selection.source.parentGrantIds,
        sourceAllowed: true,
        retainAllowed: true,
      };
    const r = openQualityIndexArchive({
      ...f.storeOptions,
      descriptor,
      descriptorDigest,
      readerBuildDigest,
      admission: () => admission,
    });
    try {
      assert.equal(r.readVerifiedView().eligibleRows.length, 7);
    } finally {
      r.close();
    }
  } finally {
    f.store.close();
    f.source.close();
  }
});

test('maximum eight 192-row inputs remain bounded and inherit 1536 rows without retokenization', () => {
  const fixtures = Array.from({ length: 8 }, (_, i) => archiveFixture({ job: 'max-' + i, count: 192 })),
    readers = fixtures.map((f) => openQualityIndexArchive(f.readerOptions));
  try {
    const o = fixtures[0]!.output(readers),
      result = writeQualityArchiveAssembly(o),
      m = decryptAssembly(o);
    assert.equal(result.indexedRows, 1536);
    assert.equal(result.selectedRows, 1536);
    assert.equal(m.chunks.length, 48);
    assert.ok(m.chunks.every((c: any) => c.rows === 32));
    assert.equal(result.totals.train.rows, 768);
    assert.equal(result.totals.dev.rows, 768);
  } finally {
    readers.forEach((r) => r.close());
  }
});

test('private key copies and per-artifact derived bytes are zeroed on close and failed reads', () => {
  const f = archiveFixture({ count: 1 }),
    g = archiveFixture({ count: 1 }),
    oldKdf = crypto.hkdfSync,
    keys: Uint8Array[] = [],
    derived: ArrayBuffer[] = [];
  crypto.hkdfSync = ((...args: any[]) => {
    keys.push(args[1]);
    const result = (oldKdf as any)(...args);
    derived.push(result);
    return result;
  }) as typeof crypto.hkdfSync;
  syncBuiltinESMExports();
  try {
    const r = openQualityIndexArchive(f.readerOptions);
    r.readVerifiedView();
    assert.ok(derived.length > 0);
    assert.ok(derived.every((d) => new Uint8Array(d).every((b) => b === 0)));
    assert.ok(keys.some((k) => k.some((b) => b !== 0)));
    r.close();
    assert.ok(keys.every((k) => k.every((b) => b === 0)));
    assert.ok(f.key.some((b) => b !== 0));
    const s = openQualityIndexArchive(g.readerOptions),
      path = g.paths.get(g.indexChunks[0]!.ref.id)!,
      bytes = readFileSync(path);
    bytes[20] = bytes[20]! ^ 1;
    writeFileSync(path, bytes);
    assert.throws(s.readVerifiedView);
    assert.ok(keys.every((k) => k.every((b) => b === 0)));
    assert.ok(derived.every((d) => new Uint8Array(d).every((b) => b === 0)));
    s.close();
  } finally {
    crypto.hkdfSync = oldKdf;
    syncBuiltinESMExports();
  }
});

test('internal capability mutation cannot forge a view or disable current revocation', () => {
  const f = archiveFixture({ count: 1 }),
    r = openQualityIndexArchive(f.readerOptions),
    cap = archiveCapability(r),
    view = r.readVerifiedView();
  assert.throws(() => {
    (cap as any).check = () => {};
  }, TypeError);
  assert.throws(() => {
    (cap as any).read = () => view;
  }, TypeError);
  assert.throws(() => {
    (cap as any).runtimeRoot = f.base;
  }, TypeError);
  f.admission.grant.status = 'REVOKED';
  try {
    assert.throws(() => writeQualityArchiveAssembly(f.output([r])), { code: 'CQA_ARCHIVE_ADMISSION' });
  } finally {
    r.close();
  }
});

test('exclusive commit refuses a concurrent destination file; truncated ciphertext is not a valid commit', () => {
  const f = archiveFixture({ count: 1 }),
    r = openQualityIndexArchive(f.readerOptions),
    o = f.output([r]),
    oldOpen = fs.openSync,
    marker = Buffer.from('SYNTHETIC concurrent file');
  let inserted = false;
  fs.openSync = ((path: any, ...args: any[]) => {
    if (String(path) === join(o.runtimeRoot, 'manifest.bin') && !inserted) {
      inserted = true;
      const fd = oldOpen(path, 'wx');
      try {
        fs.writeFileSync(fd, marker);
      } finally {
        fs.closeSync(fd);
      }
    }
    return (oldOpen as any)(path, ...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeQualityArchiveAssembly(o), { code: 'EEXIST' });
    assert.ok(readFileSync(join(o.runtimeRoot, 'manifest.bin')).equals(marker));
  } finally {
    fs.openSync = oldOpen;
    syncBuiltinESMExports();
  }
  try {
    const valid = f.output([r]),
      receipt = writeQualityArchiveAssembly(valid),
      path = join(valid.runtimeRoot, 'manifest.bin'),
      bytes = readFileSync(path);
    assert.equal(hash(bytes), receipt.commitDigest);
    writeFileSync(path, bytes.subarray(0, -1));
    assert.notEqual(hash(readFileSync(path)), receipt.commitDigest);
    assert.throws(() => decryptAssembly(valid));
  } finally {
    r.close();
  }
});

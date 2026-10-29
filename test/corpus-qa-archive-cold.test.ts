import assert from 'node:assert/strict';
import test from 'node:test';
import crypto, { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import fs, { linkSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { canonical, hash } from '../src/wf1-json.ts';
import { HostAuthority } from '../src/wf1-storage.ts';
import { QA_LEGACY_F1, QA_LEGACY_F2 } from '../src/corpus-qa-legacy-f1.ts';
import { openQualityIndexArchive, QA_INDEX_ARCHIVE_SCOPE } from '../src/corpus-qa-index-archive.ts';
import { openQualityArchiveAssembly, writeQualityArchiveAssembly } from '../src/corpus-qa-archive-assembly.ts';
import type { QaArchiveAssemblyReadGrant, QaArchiveAssemblyReadOptions } from '../src/corpus-qa-archive-assembly.ts';
import { archiveFixture, decryptAssembly } from './corpus-qa-index-archive-fixture.ts';

function fixture(options: Parameters<typeof archiveFixture>[0] = { count: 35, profile: 'QA_F2' }) {
  const source = archiveFixture(options),
    reader = openQualityIndexArchive(source.readerOptions),
    output = source.output([reader]),
    receipt = writeQualityArchiveAssembly(output),
    now = Date.now();
  const grant: QaArchiveAssemblyReadGrant = {
    version: 'QaArchiveAssemblyReadGrant/0.1',
    grantId: 'synthetic-cold-grant',
    revision: 1,
    receiptDigest: hash(canonical(receipt)),
    purposeDigest: output.purposeDigest,
    status: 'ACTIVE',
    readAllowed: true,
    retainAllowed: true,
    validFrom: now - 1000,
    expiresAt: now + 3600000,
    scope: QA_INDEX_ARCHIVE_SCOPE,
  };
  const cold: QaArchiveAssemblyReadOptions = {
    ...output,
    receipt,
    receiptDigest: grant.receiptDigest,
    admission: () => grant,
  };
  const repin = () => {
    cold.receiptDigest = hash(canonical(receipt));
    grant.receiptDigest = cold.receiptDigest;
  };
  return { source, reader, output, receipt, grant, cold, repin };
}
// Test-only re-encryption models a malicious producer with a valid synthetic key
// and re-pinned receipt. Cold proof must still reject false metadata/measurements.
function seal(
  o: { runtimeRoot: string; assemblyId: string; key: Uint8Array },
  value: unknown,
  name = 'manifest.bin',
  artifactId = o.assemblyId,
  kind = 'qa-archive-assembly-manifest',
) {
  const nonce = randomBytes(12),
    derived = Buffer.from(hkdfSync('sha256', o.key, o.assemblyId, 'qa-index-archive-assembly/0.2', 32));
  try {
    const c = createCipheriv('aes-256-gcm', derived, nonce);
    c.setAAD(
      Buffer.from(canonical({ version: 'QaArchiveAssemblyCipher/0.2', assemblyId: o.assemblyId, artifactId, kind })),
    );
    const bytes = Buffer.concat([nonce, c.update(Buffer.from(canonical(value))), c.final(), c.getAuthTag()]);
    writeFileSync(join(o.runtimeRoot, name), bytes);
    return { digest: hash(bytes), bytes: bytes.length };
  } finally {
    derived.fill(0);
  }
}
function reseal(f: ReturnType<typeof fixture>, m: unknown) {
  const bytes = seal(f.output, m);
  f.receipt.manifestDigest = hash(canonical(m));
  f.receipt.commitDigest = bytes.digest;
  f.repin();
}

test('F1 pins remain frozen; F2 is one exact build/profile pair under identical source constraints', async (t) => {
  assert.equal(QA_LEGACY_F1.buildDigest, 'f1b8d25398fc287bc665a2faea38ef00f69a236815057e799b3591fca6e0e9c9');
  assert.equal(QA_LEGACY_F1.profileDigest, '68e28a598ac3f07af29fd07a25e72455c9efa545f494622883d2348648dc1475');
  const f = archiveFixture({ count: 1, profile: 'QA_F2' }),
    r = openQualityIndexArchive(f.readerOptions);
  try {
    assert.equal(r.readVerifiedView().descriptor.spec.buildDigest, QA_LEGACY_F2.buildDigest);
    assert.throws(() => new HostAuthority(f.authorityPath, f.descriptor.spec.auditId).read(Date.now(), false), {
      code: 'WF1_AUTHORITY',
    });
  } finally {
    r.close();
  }
  for (const kind of [
    'unknown-build',
    'cross-profile',
    'wrong-label',
    'generation',
    'audit-target',
    'student',
    'schema-profile',
  ] as const)
    await t.test(kind, () => {
      const f = archiveFixture({ count: 1, profile: 'QA_F2' }),
        s = f.descriptor.spec;
      if (kind === 'unknown-build') s.buildDigest = hash('same schema unknown writer');
      if (kind === 'cross-profile') s.profileDigest = QA_LEGACY_F1.profileDigest;
      if (kind === 'wrong-label') f.descriptor.legacyProfile = 'QA_F1';
      if (kind === 'generation') s.baselineDigest = hash('other');
      if (kind === 'audit-target') s.auditTargetBaselineDigest = hash('other');
      if (kind === 'student') s.studentTargetDigest = hash('other');
      if (kind === 'schema-profile') f.descriptor.archiveProfileDigest = hash('other');
      f.repin();
      assert.throws(() => openQualityIndexArchive(f.readerOptions));
    });
});

test('cold reopen verifies exact F1/F2 input order, distinct rubric refs and inherited split tokens without payload access', () => {
  const a = archiveFixture({ job: 'cold-F1', count: 33 }),
    b = archiveFixture({ job: 'cold-F2', count: 34, profile: 'QA_F2' }),
    writers = [a, b].map((f) => openQualityIndexArchive(f.readerOptions)),
    o = a.output(writers),
    receipt = writeQualityArchiveAssembly(o);
  writers.forEach((r) => r.close());
  const readers = [a, b].map((f) => openQualityIndexArchive(f.readerOptions)),
    now = Date.now(),
    grant: QaArchiveAssemblyReadGrant = {
      version: 'QaArchiveAssemblyReadGrant/0.1',
      grantId: 'cold-reopened',
      revision: 1,
      receiptDigest: hash(canonical(receipt)),
      purposeDigest: o.purposeDigest,
      status: 'ACTIVE',
      readAllowed: true,
      retainAllowed: true,
      validFrom: now - 1,
      expiresAt: now + 60000,
      scope: QA_INDEX_ARCHIVE_SCOPE,
    };
  const m = decryptAssembly(o);
  assert.deepEqual(
    m.inputs.map((i: any) => i.legacyProfile),
    ['QA_F1', 'QA_F2'],
  );
  assert.deepEqual(
    m.inputs.map((i: any) => i.rubric.ref),
    [a.manifest.rubricRef, b.manifest.rubricRef],
  );
  assert.notEqual(m.inputs[0].rubric.cipherDigest, m.inputs[1].rubric.cipherDigest);
  assert.ok(m.inputs.every((i: any) => i.rubric.rubricContentDigest === 'UNKNOWN_NOT_INDEXED'));
  const allowed = new Set(
    [a, b]
      .flatMap((f) =>
        [
          f.descriptor.indexRef,
          f.descriptor.manifestRef,
          f.descriptor.selectionRef,
          ...f.indexChunks,
          ...f.selectionChunks,
          ...f.eventRefs.slice(-2),
        ].map((r) => f.paths.get(r.ref.id)!),
      )
      .concat([
        join(o.runtimeRoot, 'manifest.bin'),
        ...m.chunks.map((c: any) => join(o.runtimeRoot, c.artifactId + '.bin')),
      ]),
  );
  const reads: string[] = [],
    old = fs.readFileSync;
  fs.readFileSync = ((p: any, ...args: any[]) => {
    reads.push(String(p));
    return (old as any)(p, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const cold = openQualityArchiveAssembly({
      ...o,
      readers,
      receipt,
      receiptDigest: grant.receiptDigest,
      admission: () => grant,
    });
    try {
      assert.ok(Object.isFrozen(cold));
      assert.deepEqual(Object.keys(cold).sort(), ['check', 'close', 'readVerifiedReceipt']);
      assert.deepEqual(cold.readVerifiedReceipt(), receipt);
      assert.equal(receipt.selectedRows, 67);
    } finally {
      cold.close();
    }
  } finally {
    fs.readFileSync = old;
    syncBuiltinESMExports();
    readers.forEach((r) => r.close());
  }
  assert.ok(reads.filter((p) => p.endsWith('.bin')).every((p) => allowed.has(p)));
  assert.ok(!reads.some((p) => p.includes('once') || p.includes('owner')));
});

test('receipt is required and externally pinned; absent/old/mismatched success claims cannot cold-open', async (t) => {
  for (const kind of [
    'absent',
    'incomplete',
    'old-version',
    'unpinned',
    'other-id',
    'reader',
    'purpose',
    'profile',
    'wrong-key',
    'truncated',
    'cipher',
    'GCM',
  ] as const)
    await t.test(kind, () => {
      const f = fixture({ count: 1 });
      try {
        if (kind === 'absent') f.cold.receipt = undefined as any;
        if (kind === 'incomplete') delete (f.receipt as any).totals;
        if (kind === 'old-version') (f.receipt as any).version = 'QaArchiveAssemblyReceipt/0.1';
        if (kind === 'unpinned') f.receipt.selectedRows = 0;
        if (kind === 'other-id') f.cold.assemblyId = 'other';
        if (kind === 'reader') f.cold.readerBuildDigest = hash('other');
        if (kind === 'purpose') f.cold.purposeDigest = hash('other');
        if (kind === 'profile') f.receipt.archiveProfileDigest = hash('other');
        if (kind === 'wrong-key') f.cold.key = Buffer.alloc(32, 1);
        if (['truncated', 'cipher', 'GCM'].includes(kind)) {
          const path = join(f.output.runtimeRoot, 'manifest.bin'),
            bytes = readFileSync(path);
          bytes[20] = bytes[20]! ^ 1;
          writeFileSync(path, kind === 'truncated' ? bytes.subarray(0, -1) : bytes);
          if (kind === 'GCM') {
            f.receipt.commitDigest = hash(bytes);
            f.repin();
          }
        }
        assert.throws(() => {
          const c = openQualityArchiveAssembly(f.cold);
          try {
            c.readVerifiedReceipt();
          } finally {
            c.close();
          }
        });
      } finally {
        f.reader.close();
      }
    });
});

test('authenticated but false manifest/chunks fail recomputation rather than trusting producer totals', async (t) => {
  for (const kind of [
    'manifest-digest',
    'profile',
    'input-order',
    'source',
    'writer-profile',
    'rubric-content',
    'rubric-ref',
    'totals',
    'missing-chunk',
    'duplicate-chunk',
    'chunk-count',
    'chunk-order',
    'chunk-index',
    'row',
    'measurement',
    'unexpected-body',
  ] as const)
    await t.test(kind, () => {
      const f = fixture(),
        m = decryptAssembly(f.output);
      try {
        if (kind === 'manifest-digest') {
          f.receipt.manifestDigest = hash('other');
          f.repin();
        } else {
          if (kind === 'profile') m.archiveProfileDigest = hash('unknown');
          if (kind === 'input-order') m.inputs[0].descriptorDigest = hash('other');
          if (kind === 'source') m.inputs[0].source.jobId = 'other';
          if (kind === 'writer-profile') m.inputs[0].sourceProfileDigest = QA_LEGACY_F1.profileDigest;
          if (kind === 'rubric-content') m.inputs[0].rubric.rubricContentDigest = hash('public output contract');
          if (kind === 'rubric-ref') m.inputs[0].rubric.ref.ref.digest = hash('other rubric');
          if (kind === 'totals') m.totals.train.fullTokens++;
          if (kind === 'missing-chunk') m.chunks.pop();
          if (kind === 'duplicate-chunk') m.chunks[1] = m.chunks[0];
          if (kind === 'chunk-count') m.chunks[0].rows = 31;
          if (kind === 'chunk-order') m.chunks.reverse();
          if (['chunk-index', 'row', 'measurement', 'unexpected-body'].includes(kind)) {
            const c = m.chunks[0],
              value = decryptAssembly(f.output, c.artifactId + '.bin', c.artifactId, c.kind);
            if (kind === 'chunk-index') value.index = 1;
            if (kind === 'row') value.rows[0].caseId = 'case-forged';
            if (kind === 'measurement') value.rows[0].measurement.fullTokens = '999';
            if (kind === 'unexpected-body') value.notes = 'SYNTHETIC forbidden field';
            Object.assign(c, seal(f.output, value, c.artifactId + '.bin', c.artifactId, c.kind));
          }
          reseal(f, m);
        }
        const c = openQualityArchiveAssembly(f.cold);
        try {
          assert.throws(c.readVerifiedReceipt);
          assert.throws(c.check, { code: 'CQA_ASSEMBLY_CLOSED' });
        } finally {
          c.close();
        }
      } finally {
        f.reader.close();
      }
    });
});

test('new current grant, all source retention, expiry, immutable grant identity and monotonic time remain mandatory', async (t) => {
  for (const kind of [
    'missing',
    'receipt',
    'purpose',
    'revoked',
    'read',
    'retain',
    'source',
    'source-retain',
    'parent',
    'expired',
    'future',
    'revision',
    'clock',
  ] as const)
    await t.test(kind, () => {
      const f = fixture({ count: 1 });
      let now = Date.now();
      const c = openQualityArchiveAssembly({ ...f.cold, now: () => now });
      try {
        if (kind === 'missing') f.cold.admission = () => undefined as any;
        if (kind === 'receipt') f.grant.receiptDigest = hash('other');
        if (kind === 'purpose') f.grant.purposeDigest = hash('other');
        if (kind === 'revoked') f.grant.status = 'REVOKED';
        if (kind === 'read') f.grant.readAllowed = false;
        if (kind === 'retain') f.grant.retainAllowed = false;
        if (kind === 'source') f.source.admission.sourceAllowed = false;
        if (kind === 'source-retain') f.source.admission.retainAllowed = false;
        if (kind === 'parent') f.source.admission.parentGrantIds = [];
        if (kind === 'expired') now = f.grant.expiresAt;
        if (kind === 'future') f.grant.validFrom = now + 1000;
        if (kind === 'revision') f.grant.revision++;
        if (kind === 'clock') now--;
        if (kind === 'missing')
          assert.throws(
            () => openQualityArchiveAssembly({ ...f.cold, key: new Uint8Array(0) }),
            (e) => (e as any).code !== 'CQA_ARCHIVE_KEY',
          );
        else {
          assert.throws(c.readVerifiedReceipt);
          f.grant.status = 'ACTIVE';
          assert.throws(c.check, { code: 'CQA_ASSEMBLY_CLOSED' });
        }
      } finally {
        c.close();
        f.reader.close();
      }
    });
});

test('mid-read grant withdrawal, source withdrawal and final file mutation refuse the result', async (t) => {
  for (const kind of ['grant', 'source', 'mutate-chunk', 'mutate-manifest'] as const)
    await t.test(kind, () => {
      const f = fixture(),
        m = decryptAssembly(f.output),
        c = openQualityArchiveAssembly(f.cold),
        old = fs.readFileSync;
      let triggered = false;
      fs.readFileSync = ((p: any, ...args: any[]) => {
        const bytes = (old as any)(p, ...args);
        if (!triggered && String(p) === join(f.output.runtimeRoot, m.chunks[0].artifactId + '.bin')) {
          triggered = true;
          if (kind === 'grant') f.grant.status = 'REVOKED';
          if (kind === 'source') f.source.admission.retainAllowed = false;
          if (kind.startsWith('mutate')) {
            const path = kind === 'mutate-chunk' ? String(p) : join(f.output.runtimeRoot, 'manifest.bin'),
              changed = readFileSync(path);
            changed[20] = changed[20]! ^ 1;
            writeFileSync(path, changed);
          }
        }
        return bytes;
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      try {
        assert.throws(c.readVerifiedReceipt);
        assert.equal(triggered, true);
        assert.throws(c.check, { code: 'CQA_ASSEMBLY_CLOSED' });
      } finally {
        fs.readFileSync = old;
        syncBuiltinESMExports();
        c.close();
        f.reader.close();
      }
    });
});

test('explicit reordered/different inputs and same-source overlapping old/new audits are rejected', () => {
  const a = archiveFixture({ count: 1, job: 'order-a' }),
    b = archiveFixture({ count: 1, job: 'order-b', profile: 'QA_F2' }),
    readers = [a, b].map((f) => openQualityIndexArchive(f.readerOptions)),
    o = a.output(readers),
    receipt = writeQualityArchiveAssembly(o),
    f = fixture({ count: 1 });
  try {
    const grant = { ...f.grant, receiptDigest: hash(canonical(receipt)) };
    const c = openQualityArchiveAssembly({
      ...o,
      readers: [...readers].reverse(),
      receipt,
      receiptDigest: grant.receiptDigest,
      admission: () => grant,
    });
    try {
      assert.throws(c.readVerifiedReceipt, { code: 'CQA_ASSEMBLY_BINDING' });
    } finally {
      c.close();
    }
    const different = openQualityArchiveAssembly({ ...f.cold, readers: [readers[0]!] });
    try {
      assert.throws(different.readVerifiedReceipt, { code: 'CQA_ASSEMBLY_BINDING' });
    } finally {
      different.close();
    }
    const old = archiveFixture({ count: 1, job: 'overlap', zero: true }),
      fresh = archiveFixture({ count: 1, job: 'overlap', profile: 'QA_F2' }),
      overlap = [old, fresh].map((f) => openQualityIndexArchive(f.readerOptions));
    try {
      assert.throws(() => writeQualityArchiveAssembly(old.output(overlap)), { code: 'CQA_INDEX_CONFLICT' });
    } finally {
      overlap.forEach((r) => r.close());
    }
  } finally {
    readers.forEach((r) => r.close());
    f.reader.close();
  }
});

test('zero selected rows and maximum eight by 192 cold-recompute exactly', () => {
  const zero = fixture({ count: 1, zero: true, profile: 'QA_F2' });
  try {
    const c = openQualityArchiveAssembly(zero.cold);
    try {
      assert.equal(c.readVerifiedReceipt().selectedRows, 0);
    } finally {
      c.close();
    }
  } finally {
    zero.reader.close();
  }
  const fixtures = Array.from({ length: 8 }, (_, i) =>
      archiveFixture({ job: 'cold-max-' + i, count: 192, profile: i % 2 ? 'QA_F2' : 'QA_F1' }),
    ),
    readers = fixtures.map((f) => openQualityIndexArchive(f.readerOptions)),
    o = fixtures[0]!.output(readers),
    receipt = writeQualityArchiveAssembly(o),
    now = Date.now(),
    grant: QaArchiveAssemblyReadGrant = {
      version: 'QaArchiveAssemblyReadGrant/0.1',
      grantId: 'cold-max',
      revision: 1,
      receiptDigest: hash(canonical(receipt)),
      purposeDigest: o.purposeDigest,
      status: 'ACTIVE',
      readAllowed: true,
      retainAllowed: true,
      validFrom: now - 1,
      expiresAt: now + 3600000,
      scope: QA_INDEX_ARCHIVE_SCOPE,
    };
  try {
    const c = openQualityArchiveAssembly({ ...o, receipt, receiptDigest: grant.receiptDigest, admission: () => grant });
    try {
      assert.deepEqual(c.readVerifiedReceipt(), receipt);
      assert.equal(receipt.selectedRows, 1536);
      assert.equal(receipt.totals.train.rows, 768);
      assert.equal(receipt.totals.dev.rows, 768);
    } finally {
      c.close();
    }
  } finally {
    readers.forEach((r) => r.close());
  }
});

test('cold cross-split recomputation retains rejected A-B-C bridge nodes', () => {
  const a = archiveFixture({
      job: 'cold-A',
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
      job: 'cold-B',
      count: 2,
      profile: 'QA_F2',
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
      job: 'cold-C',
      count: 2,
      profile: 'QA_F2',
      configure: (es) => {
        es.forEach((e) => {
          e.split = 'dev';
          e.familyId = 'family';
        });
        es[0]!.normalizedDigest = hash('BC');
      },
    }),
    readers = [a, b, c].map((f) => openQualityIndexArchive(f.readerOptions)),
    o = a.output(readers),
    receipt = writeQualityArchiveAssembly(o),
    now = Date.now(),
    grant: QaArchiveAssemblyReadGrant = {
      version: 'QaArchiveAssemblyReadGrant/0.1',
      grantId: 'cold-bridge',
      revision: 1,
      receiptDigest: hash(canonical(receipt)),
      purposeDigest: o.purposeDigest,
      status: 'ACTIVE',
      readAllowed: true,
      retainAllowed: true,
      validFrom: now - 1,
      expiresAt: now + 60000,
      scope: QA_INDEX_ARCHIVE_SCOPE,
    };
  try {
    assert.equal(receipt.selectedRows, 0);
    const cold = openQualityArchiveAssembly({
      ...o,
      receipt,
      receiptDigest: grant.receiptDigest,
      admission: () => grant,
    });
    try {
      assert.deepEqual(cold.readVerifiedReceipt(), receipt);
    } finally {
      cold.close();
    }
  } finally {
    readers.forEach((r) => r.close());
  }
});

test('cold paths reject hardlinks, aliases and missing final even when encrypted pending exists', async (t) => {
  for (const kind of ['hardlink', 'alias', 'pending-only', 'missing-chunk'] as const)
    await t.test(kind, () => {
      const f = fixture({ count: 1 });
      try {
        if (kind === 'hardlink') linkSync(join(f.output.runtimeRoot, 'manifest.bin'), join(f.source.base, 'alias.bin'));
        if (kind === 'alias') {
          const alias = join(f.source.base, 'alias');
          symlinkSync(f.output.runtimeRoot, alias, 'junction');
          f.cold.runtimeRoot = alias;
        }
        if (kind === 'pending-only')
          renameSync(join(f.output.runtimeRoot, 'manifest.bin'), join(f.output.runtimeRoot, 'orphan.bin'));
        if (kind === 'missing-chunk') {
          const m = decryptAssembly(f.output);
          renameSync(
            join(f.output.runtimeRoot, m.chunks[0].artifactId + '.bin'),
            join(f.output.runtimeRoot, 'orphan.bin'),
          );
        }
        assert.throws(() => {
          const c = openQualityArchiveAssembly(f.cold);
          try {
            c.readVerifiedReceipt();
          } finally {
            c.close();
          }
        });
      } finally {
        f.reader.close();
      }
    });
});

test('cold owns key and receipt; close/failure clear all owned and derived key bytes', () => {
  const f = fixture({ count: 1 }),
    old = crypto.hkdfSync,
    keys: Uint8Array[] = [],
    derived: ArrayBuffer[] = [];
  crypto.hkdfSync = ((...args: any[]) => {
    if (args[3] === 'qa-index-archive-assembly/0.2') keys.push(args[1]);
    const out = (old as any)(...args);
    derived.push(out);
    return out;
  }) as typeof crypto.hkdfSync;
  syncBuiltinESMExports();
  try {
    const c = openQualityArchiveAssembly(f.cold);
    f.cold.key.fill(0);
    f.receipt.selectedRows = 0;
    assert.equal(c.readVerifiedReceipt().selectedRows, 1);
    assert.ok(derived.every((d) => new Uint8Array(d).every((b) => b === 0)));
    c.close();
    assert.ok(keys.length > 0);
    assert.ok(keys.every((k) => k.every((b) => b === 0)));
    assert.throws(c.readVerifiedReceipt, { code: 'CQA_ASSEMBLY_CLOSED' });
    const g = fixture({ count: 1 }),
      q = openQualityArchiveAssembly(g.cold);
    try {
      q.readVerifiedReceipt();
      g.grant.status = 'REVOKED';
      assert.throws(q.readVerifiedReceipt);
      assert.ok(keys.every((k) => k.every((b) => b === 0)));
    } finally {
      q.close();
      g.reader.close();
    }
  } finally {
    crypto.hkdfSync = old;
    syncBuiltinESMExports();
    f.reader.close();
  }
});

test('last source callback cannot outlive or close the assembly grant before return', async (t) => {
  for (const kind of ['expiry', 'close', 'revoke', 'revision', 'clock-rollback'] as const)
    await t.test(kind, () => {
      const f = fixture({ count: 1 });
      f.reader.close();
      f.grant.validFrom = 0;
      f.grant.expiresAt = 100;
      let now = 99,
        calls = 0,
        triggerAt = 0,
        triggered = false;
      let cold: ReturnType<typeof openQualityArchiveAssembly> | undefined;
      const source = openQualityIndexArchive({
          ...f.source.readerOptions,
          admission: () => {
            calls++;
            if (triggerAt !== 0 && calls === triggerAt) {
              triggered = true;
              if (kind === 'expiry') now = 101;
              if (kind === 'close') cold!.close();
              if (kind === 'revoke') f.grant.status = 'REVOKED';
              if (kind === 'revision') f.grant.revision++;
              if (kind === 'clock-rollback') now = 98;
            }
            return f.source.admission;
          },
        }),
        old = crypto.hkdfSync,
        keys: Uint8Array[] = [],
        derived: ArrayBuffer[] = [];
      crypto.hkdfSync = ((...args: any[]) => {
        const out = (old as any)(...args);
        if (args[3] === 'qa-index-archive-assembly/0.2') {
          keys.push(args[1]);
          derived.push(out);
        }
        return out;
      }) as typeof crypto.hkdfSync;
      syncBuiltinESMExports();
      try {
        cold = openQualityArchiveAssembly({ ...f.cold, readers: [source], now: () => now });
        calls = 0;
        assert.deepEqual(cold.readVerifiedReceipt(), f.receipt);
        // Arm the last source callback of the next identical read, without relying
        // on an implementation-specific callback count or mutating frozen caps.
        triggerAt = calls;
        calls = 0;
        assert.ok(triggerAt > 0);
        assert.ok(keys.some((k) => k.some((b) => b !== 0)));
        assert.throws(cold.readVerifiedReceipt, {
          code: kind === 'close' ? 'CQA_ASSEMBLY_CLOSED' : 'CQA_ASSEMBLY_ADMISSION',
        });
        assert.equal(triggered, true);
        assert.equal(calls, triggerAt);
        assert.ok(keys.every((k) => k.every((b) => b === 0)));
        assert.ok(derived.every((d) => new Uint8Array(d).every((b) => b === 0)));
        now = 99;
        f.grant.status = 'ACTIVE';
        f.grant.revision = 1;
        assert.throws(cold.check, { code: 'CQA_ASSEMBLY_CLOSED' });
      } finally {
        crypto.hkdfSync = old;
        syncBuiltinESMExports();
        cold?.close();
        source.close();
      }
    });
});

test('last assembly admission callback is followed by fresh time and closed checks', async (t) => {
  for (const kind of ['expiry', 'close'] as const)
    await t.test(kind, () => {
      const f = fixture({ count: 1 });
      f.grant.validFrom = 0;
      f.grant.expiresAt = 100;
      let now = 99,
        calls = 0,
        triggerAt = 0,
        triggered = false;
      let cold: ReturnType<typeof openQualityArchiveAssembly> | undefined;
      try {
        cold = openQualityArchiveAssembly({
          ...f.cold,
          now: () => now,
          admission: () => {
            calls++;
            if (triggerAt !== 0 && calls === triggerAt) {
              triggered = true;
              if (kind === 'expiry') now = 101;
              else cold!.close();
            }
            return f.grant;
          },
        });
        calls = 0;
        assert.deepEqual(cold.readVerifiedReceipt(), f.receipt);
        triggerAt = calls;
        calls = 0;
        assert.ok(triggerAt > 0);
        assert.throws(cold.readVerifiedReceipt, {
          code: kind === 'close' ? 'CQA_ASSEMBLY_CLOSED' : 'CQA_ASSEMBLY_ADMISSION',
        });
        assert.equal(triggered, true);
        assert.equal(calls, triggerAt);
        now = 99;
        assert.throws(cold.check, { code: 'CQA_ASSEMBLY_CLOSED' });
      } finally {
        cold?.close();
        f.reader.close();
      }
    });
});

test('last source admission callback is followed by fresh time and closed checks', async (t) => {
  for (const kind of ['expiry', 'close'] as const)
    await t.test(kind, () => {
      const f = archiveFixture({ count: 1, profile: 'QA_F2' });
      f.admission.grant.validFrom = 0;
      f.admission.grant.expiresAt = 100;
      let now = 99,
        calls = 0,
        triggerAt = 0,
        triggered = false;
      let reader: ReturnType<typeof openQualityIndexArchive> | undefined;
      const old = crypto.hkdfSync,
        keys: Uint8Array[] = [],
        derived: ArrayBuffer[] = [];
      crypto.hkdfSync = ((...args: any[]) => {
        const out = (old as any)(...args);
        if (args[3] === 'wf1-train') {
          keys.push(args[1]);
          derived.push(out);
        }
        return out;
      }) as typeof crypto.hkdfSync;
      syncBuiltinESMExports();
      try {
        reader = openQualityIndexArchive({
          ...f.readerOptions,
          now: () => now,
          admission: () => {
            calls++;
            if (triggerAt !== 0 && calls === triggerAt) {
              triggered = true;
              if (kind === 'expiry') now = 101;
              else reader!.close();
            }
            return f.admission;
          },
        });
        calls = 0;
        assert.equal(reader.readVerifiedView().index.entries.length, 1);
        triggerAt = calls;
        calls = 0;
        assert.ok(triggerAt > 0);
        assert.ok(keys.some((k) => k.some((b) => b !== 0)));
        assert.throws(reader.readVerifiedView, {
          code: kind === 'close' ? 'CQA_ARCHIVE_CLOSED' : 'CQA_ARCHIVE_ADMISSION',
        });
        assert.equal(triggered, true);
        assert.equal(calls, triggerAt);
        assert.ok(keys.every((k) => k.every((b) => b === 0)));
        assert.ok(derived.every((d) => new Uint8Array(d).every((b) => b === 0)));
        now = 99;
        assert.throws(reader.check, { code: 'CQA_ARCHIVE_CLOSED' });
      } finally {
        crypto.hkdfSync = old;
        syncBuiltinESMExports();
        reader?.close();
      }
    });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeBlocks, decodeBlocks, MAX_CHAIN, MAX_PATCH } from '../src/incremental-codec.ts';
import type { BlockEncoding } from '../src/incremental-codec.ts';
import { directoryReader, freezeFrame, parseFrozenV3, reconstruct } from '../src/incremental-storage.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import type { AnchoredFault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { encodeVaultMarker, generateKeySet, INCREMENTAL_FORMAT, identityOf } from '../src/anchored-codec.ts';
import type { StorageProfile, VaultIdentity } from '../src/anchored-codec.ts';
import { sha } from '../src/durable-codec.ts';
import { inspectMemoryImage } from '../src/memory-image.ts';

const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'companion', relationshipId: 'test' };
const input = (key: string) => ({
  source: 'synthetic',
  eventKey: key,
  evidence: {
    speakerId: 'subject',
    speakerRole: 'subject' as const,
    mode: 'self_report' as const,
    selectedText: `Synthetic incremental event ${key}`,
    occurredAt: null,
  },
});
function fixture(
  t: TestContext,
  profile: StorageProfile | null = 'blocks-br4-v1',
  schemaVersion: 1 | 2 = 2,
  fault?: (p: AnchoredFault) => void,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aemc-incremental-'))),
    authority = LocalSqliteAuthority.create({
      directory: join(root, 'authority'),
      authorityId: 'synthetic-authority',
      custodyDomain: 'independent',
    });
  const config = {
    directory: join(root, 'vault'),
    vaultId: 'synthetic-vault',
    identity: 'synthetic',
    storageDomain: 'payload',
    keys: generateKeySet(),
    authority,
    schemaVersion,
    ...(profile ? { storageProfile: profile } : {}),
  };
  const options = { clock: { wall: () => 100, monotonic: () => 0 }, ...(fault ? { fault } : {}) },
    v = AnchoredVault.create(config, 4, options);
  t.after(() => {
    v.close();
    authority.close();
  });
  return { root, authority, config, options, v };
}
const decoded = (f: ReturnType<typeof fixture>) =>
  reconstruct(f.v.head, directoryReader(f.config.directory), f.config.keys, 4);
const sizes = (directory: string) =>
  Object.fromEntries(
    readdirSync(directory).map((name) => [
      name,
      { size: statSync(join(directory, name)).size, hash: sha(readFileSync(join(directory, name))) },
    ]),
  );

test('exact block roundtrips cover growth, truncation, partial blocks and zero extension', () => {
  const previous = randomBytes(8193);
  for (const length of [0, 1, 4095, 4096, 4097, 8193, 9000, 12288]) {
    const image = Buffer.alloc(length);
    image.set(previous.subarray(0, length));
    if (length) {
      const index = Math.min(length - 1, 20);
      image[index] = image[index]! ^ 1;
    }
    for (const profile of ['blocks-br4-v1', 'full-br4-v1'] as const) {
      const e = encodeBlocks(image, previous, profile);
      assert.deepEqual(decodeBlocks(e.descriptor, e.payload, previous), image);
    }
  }
  const image = Buffer.from(previous);
  image[33] = image[33]! ^ 1;
  const e = encodeBlocks(image, previous, 'blocks-br4-v1');
  assert.equal(e.descriptor.mode, 'xor');
  assert.throws(() => decodeBlocks(e.descriptor, e.payload, randomBytes(previous.length)), /INCREMENTAL_BASE/);
});
test('high entropy uses raw fallback and full candidate when delta overhead cannot win', () => {
  const image = randomBytes(32768),
    e = encodeBlocks(image, randomBytes(32768), 'blocks-br4-v1');
  assert.equal(e.descriptor.mode, 'base');
  assert.equal(e.descriptor.codec, 'raw');
  assert.deepEqual(decodeBlocks(e.descriptor, e.payload, null), image);
});
test('decoder refuses unknown codecs, extra descriptors, output bombs, trailing bytes and concatenated streams', () => {
  const image = Buffer.alloc(4096, 65),
    e = encodeBlocks(image, null, 'blocks-br4-v1');
  assert.equal(e.descriptor.codec, 'br4');
  assert.throws(
    () => decodeBlocks({ ...e.descriptor, codec: 'zstd' } as any, e.payload, null),
    /INCREMENTAL_DESCRIPTOR/,
  );
  assert.throws(() => decodeBlocks({ ...e.descriptor, extra: true } as any, e.payload, null), /INCREMENTAL_DESCRIPTOR/);
  assert.throws(
    () => decodeBlocks(e.descriptor, Buffer.concat([e.payload, Buffer.from('trailing')]), null),
    /INCREMENTAL_DECODE/,
  );
  assert.throws(() => decodeBlocks(e.descriptor, Buffer.concat([e.payload, e.payload]), null), /INCREMENTAL_DECODE/);
  const bomb = brotliCompressSync(Buffer.alloc(1 << 20));
  assert.throws(() => decodeBlocks({ ...e.descriptor, rawLength: 4096 }, bomb, null), /INCREMENTAL_DECODE/);
  assert.throws(
    () => decodeBlocks({ ...e.descriptor, rawLength: MAX_PATCH + 1 }, e.payload, null),
    /INCREMENTAL_DESCRIPTOR/,
  );
});
test('patch validation rejects ordering, duplicates, truncated tuples, omitted zero growth and wrong target hashes', () => {
  const old = Buffer.alloc(8192),
    image = Buffer.from(old);
  image[0] = 1;
  const tuple = (index: number, size = 4096) => {
    const b = Buffer.alloc(8 + size);
    b.writeUInt32BE(index);
    b.writeUInt32BE(size, 4);
    return b;
  };
  const check = (raw: Buffer, length = 8192) => {
    const d: BlockEncoding = {
      mode: 'replace',
      codec: 'raw',
      rawLength: raw.length,
      targetLength: length,
      targetHash: sha(Buffer.alloc(length)),
      baseHash: sha(old),
      blockSize: 4096,
    };
    return () => decodeBlocks(d, raw, old);
  };
  assert.throws(check(Buffer.concat([tuple(1), tuple(0)])), /INCREMENTAL_PATCH/);
  assert.throws(check(Buffer.concat([tuple(0), tuple(0)])), /INCREMENTAL_PATCH/);
  assert.throws(check(Buffer.alloc(7)), /INCREMENTAL_PATCH/);
  assert.throws(check(Buffer.alloc(0), 12288), /INCREMENTAL_PATCH/);
  const e = encodeBlocks(image, old, 'blocks-br4-v1');
  assert.throws(
    () => decodeBlocks({ ...e.descriptor, targetHash: '0'.repeat(64) }, e.payload, old),
    /INCREMENTAL_HASH/,
  );
});
test('v3 is explicit, ciphertext is written once and each persisted image roundtrips through the required chain', (t) => {
  const f = fixture(t),
    scope = f.v.store.ensureScope(who);
  for (let i = 0; i < 5; i++) {
    f.v.store.acceptEvent(scope, input(String(i)));
    const d = decoded(f);
    assert.ok(d.image.equals(f.v.store.snapshot()));
    assert.equal(inspectMemoryImage(d.image, 2).revocationHighWater, d.state.revocationHighWater);
    d.image.fill(0);
  }
  assert.equal(f.v.status.format, INCREMENTAL_FORMAT);
  const names = readdirSync(f.config.directory),
    stages = names.filter((n) => n.startsWith('stage-'));
  assert.equal(names.filter((n) => n.startsWith('checkpoint-')).length, 0);
  assert.equal(names.filter((n) => n.startsWith('blob-')).length, stages.length);
  for (const name of stages) {
    const bytes = readFileSync(join(f.config.directory, name)),
      s = parseFrozenV3(bytes);
    assert.ok(bytes.length < 8192);
    assert.ok(existsSync(join(f.config.directory, s.blob)));
    assert.equal('checkpoint' in s, false);
  }
  f.v.close();
  assert.throws(() => AnchoredVault.open({ ...f.config, storageProfile: undefined } as any, 4), /ANCHOR_IDENTITY/);
  assert.throws(() => AnchoredVault.open({ ...f.config, storageProfile: 'full-br4-v1' }, 4), /ANCHOR_IDENTITY/);
  assert.throws(
    () => AnchoredVault.open({ ...f.config, keys: { ...f.config.keys, ingressKey: randomBytes(32) } }, 4),
    /ANCHOR_INGRESS_KEY/,
  );
  const next = AnchoredVault.open(f.config, 4, f.options);
  t.after(() => next.close());
  assert.ok(next.store.diagnostics().integrity);
});
test('chain bases reset by frame 17 and forced-full remains an authenticated production profile', (t) => {
  for (const profile of ['blocks-br4-v1', 'full-br4-v1'] as const) {
    const f = fixture(t, profile),
      depths = [];
    for (let i = 0; i < 33; i++) {
      f.v.claim(`request-${i}`, 'payload');
      const d = decoded(f);
      depths.push(d.baseline.depth);
      assert.ok(d.baseline.depth <= MAX_CHAIN);
      assert.ok(d.image.equals(f.v.store.snapshot()));
      d.image.fill(0);
    }
    if (profile === 'full-br4-v1') assert.ok(depths.every((n) => n === 1));
    else {
      assert.ok(depths.includes(16));
      assert.equal(depths[15], 1);
    }
  }
});
test('backups are self-contained exact ciphertext chains; every missing or altered dependency is rejected', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.v.claim(`native-${i}`, 'payload');
  const backup = join(f.root, 'backup');
  f.v.exportBackup(backup);
  const manifest = JSON.parse(readFileSync(join(backup, 'current-state.json'), 'utf8'));
  assert.ok(manifest.files.length > 2);
  for (const file of manifest.files) {
    const path = join(backup, file.name),
      original = readFileSync(path);
    writeFileSync(path, Buffer.from('damaged'));
    assert.throws(
      () =>
        AnchoredVault.verifyBackup({
          backupDirectory: backup,
          authority: f.authority,
          keys: f.config.keys,
          maxCalls: 4,
        }),
      /ANCHOR_|INCREMENTAL_/,
    );
    writeFileSync(path, original);
    renameSync(path, path + '.preserved');
    assert.throws(() =>
      AnchoredVault.verifyBackup({ backupDirectory: backup, authority: f.authority, keys: f.config.keys, maxCalls: 4 }),
    );
    renameSync(path + '.preserved', path);
  }
  const receipt = AnchoredVault.verifyBackup({
    backupDirectory: backup,
    authority: f.authority,
    keys: f.config.keys,
    maxCalls: 4,
  });
  assert.deepEqual(receipt.head, f.v.head);
  f.v.claim('later', 'payload');
  assert.throws(
    () =>
      AnchoredVault.verifyBackup({ backupDirectory: backup, authority: f.authority, keys: f.config.keys, maxCalls: 4 }),
    /ANCHOR_FENCED/,
  );
});
for (const point of [
  'stage-written',
  'prepared',
  'checkpoint-published',
  'record-published',
  'finalized',
] as AnchoredFault[])
  test(`v3 crash ${point} preserves durable intent and reconciles frozen bytes`, (t) => {
    let armed = false;
    const f = fixture(t, 'blocks-br4-v1', 2, (p) => {
      if (armed && p === point) throw new Error('SYNTHETIC_FAULT');
    });
    f.v.claim('native', 'payload');
    const before = f.v.head;
    armed = true;
    assert.throws(() => f.v.reserve('native'));
    const row = f.authority.inspect(f.config.vaultId)!;
    f.v.close();
    if (point === 'stage-written') {
      assert.equal(row.status, 'ACTIVE');
      assert.deepEqual(row.head, before);
    } else if (point !== 'finalized') {
      assert.equal(row.status, 'PREPARED');
      assert.throws(() => AnchoredVault.open(f.config, 4), /ANCHOR_PENDING/);
      const pending = row.pending!,
        stage = parseFrozenV3(readFileSync(pending.stagePath)),
        blobPath = join(f.config.directory, stage.blob),
        blob = readFileSync(blobPath);
      writeFileSync(blobPath, Buffer.from('bad'));
      assert.throws(
        () =>
          AnchoredVault.reconcile({
            authority: f.authority,
            vaultId: f.config.vaultId,
            operationId: pending.operationId,
            keys: f.config.keys,
            maxCalls: 4,
          }),
        /ANCHOR_UNRESOLVED/,
      );
      writeFileSync(blobPath, blob);
      assert.equal(f.authority.inspect(f.config.vaultId)!.status, 'PREPARED');
      const request = {
        authority: f.authority,
        vaultId: f.config.vaultId,
        operationId: pending.operationId,
        keys: f.config.keys,
        maxCalls: 4,
      };
      assert.deepEqual(AnchoredVault.reconcile(request), AnchoredVault.reconcile(request));
    }
    const next = AnchoredVault.open(f.config, 4, { clock: f.options.clock });
    t.after(() => next.close());
    assert.equal(next.reserved, point === 'stage-written' ? 0 : 1);
    assert.throws(() => next.claim('native', 'payload'), /INTERACTION_TERMINATED/);
  });
test('compaction reads exact current state without boot, preserves source files and fences old handles', (t) => {
  const f = fixture(t),
    scope = f.v.store.ensureScope(who),
    handle = f.v.store.registerConsumer('retrieval', scope, 'retrieval-refs-v1');
  f.v.claim('native', 'payload');
  f.v.reserve('native');
  const image = f.v.store.snapshot(),
    source = sizes(f.config.directory),
    head = f.v.head,
    target = join(f.root, 'compact');
  const request = {
    authority: f.authority,
    vaultId: f.config.vaultId,
    keys: f.config.keys,
    maxCalls: 4,
    targetDirectory: target,
    storageDomain: 'payload',
    operationId: 'compact',
  };
  const receipt = AnchoredVault.compact(request);
  assert.deepEqual(AnchoredVault.compact(request), receipt);
  assert.deepEqual(receipt.oldHead, head);
  assert.equal(receipt.newHead.ownerEpoch, head.ownerEpoch + 1);
  const d = reconstruct(receipt.newHead, directoryReader(target), f.config.keys, 4);
  assert.equal(d.baseline.depth, 1);
  assert.ok(d.image.equals(image));
  assert.equal(d.state.safety.ingress[0]!.state, 'pending');
  assert.deepEqual(sizes(f.config.directory), source);
  assert.throws(() => f.v.store.readConsumer(handle), /ANCHOR_FENCED/);
  assert.throws(() => f.v.reserve('other'), /ANCHOR_FENCED/);
  f.v.close();
  assert.throws(() => AnchoredVault.open(f.config, 4), /ANCHOR_FENCED/);
  const next = AnchoredVault.open({ ...f.config, directory: target }, 4, f.options);
  t.after(() => next.close());
  assert.equal(next.reserved, 1);
  assert.equal(next.status.unknownRequests, 1);
  assert.throws(() => next.store.readConsumer(handle), /FANOUT_/);
});
test('explicit v2 storage upgrade preserves schema and safety; v3 restore, rekey and schema migration use new bases', (t) => {
  const f = fixture(t, null, 1);
  f.v.claim('native', 'payload');
  f.v.reserve('native');
  const target = join(f.root, 'v3');
  const receipt = AnchoredVault.upgradeStorage({
    authority: f.authority,
    vaultId: f.config.vaultId,
    keys: f.config.keys,
    maxCalls: 4,
    targetDirectory: target,
    storageDomain: 'payload',
    operationId: 'upgrade',
    storageProfile: 'blocks-br4-v1',
  });
  assert.equal(receipt.kind, 'storage-upgrade');
  assert.throws(() => f.v.status, /ANCHOR_FENCED/);
  f.v.close();
  let config = { ...f.config, directory: target, storageProfile: 'blocks-br4-v1' as const },
    v = AnchoredVault.open(config, 4, f.options);
  t.after(() => v.close());
  let backup = join(f.root, 'b1');
  v.exportBackup(backup);
  const restored = join(f.root, 'restored');
  AnchoredVault.restoreBackup({
    backupDirectory: backup,
    targetDirectory: restored,
    storageDomain: 'payload',
    authority: f.authority,
    keys: config.keys,
    maxCalls: 4,
    operationId: 'restore',
  });
  v.close();
  config = { ...config, directory: restored };
  v = AnchoredVault.open(config, 4, f.options);
  backup = join(f.root, 'b2');
  v.exportBackup(backup);
  const rekeyed = join(f.root, 'rekey'),
    newStorageDEK = randomBytes(32);
  const r = AnchoredVault.rekeyBackup({
    backupDirectory: backup,
    targetDirectory: rekeyed,
    storageDomain: 'payload',
    authority: f.authority,
    keys: config.keys,
    newStorageDEK,
    maxCalls: 4,
    operationId: 'rekey',
  });
  v.close();
  assert.throws(
    () => reconstruct(r.newHead, directoryReader(rekeyed), { ...config.keys, keyEpoch: 2 }, 4),
    /INCREMENTAL_CORRUPT/,
  );
  config = { ...config, directory: rekeyed, keys: { ...config.keys, keyEpoch: 2, storageDEK: newStorageDEK } };
  v = AnchoredVault.open(config, 4, f.options);
  assert.equal(v.reserved, 1);
  assert.throws(() => v.claim('native', 'payload'), /INTERACTION_TERMINATED/);
  backup = join(f.root, 'b3');
  v.exportBackup(backup);
  const migrated = join(f.root, 'schema2');
  AnchoredVault.migrateBackup({
    backupDirectory: backup,
    targetDirectory: migrated,
    storageDomain: 'payload',
    authority: f.authority,
    keys: config.keys,
    maxCalls: 4,
    operationId: 'schema',
    targetSchema: 2,
  });
  v.close();
  v = AnchoredVault.open({ ...config, directory: migrated, schemaVersion: 2 }, 4, f.options);
  assert.equal(v.store.diagnostics().schema, 2);
  assert.equal(v.reserved, 1);
});
for (const point of ['prepared', 'record-published', 'finalized'] as const)
  test(`actual child exit at ${point} leaves v3 chain recoverable`, (t) => {
    const f = fixture(t);
    f.v.claim('native', 'payload');
    f.v.close();
    const script = `import {AnchoredVault} from './src/anchored-vault.ts';import {LocalSqliteAuthority} from './src/local-sqlite-authority.ts';
    let chunks=[];for await(const c of process.stdin)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks).toString());
    const authority=LocalSqliteAuthority.open(data.authority),keys={...data.keys,storageDEK:Buffer.from(data.keys.storageDEK,'base64'),ingressKey:Buffer.from(data.keys.ingressKey,'base64')};
    let armed=false;const v=AnchoredVault.open({...data.config,authority,keys},4,{clock:{wall:()=>100,monotonic:()=>0},fault:p=>{if(armed&&p===data.point)process.exit(42);}});
    armed=true;v.claim('child-native','payload');`;
    // Opening conservatively terminalizes the old native request; the new child
    // claim is the mutation interrupted by real process death, without finally.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
      input: JSON.stringify({
        point,
        authority: {
          directory: f.authority.directory,
          authorityId: f.authority.authorityId,
          custodyDomain: f.authority.custodyDomain,
        },
        config: {
          directory: f.config.directory,
          vaultId: f.config.vaultId,
          identity: f.config.identity,
          storageDomain: f.config.storageDomain,
          schemaVersion: 2,
          storageProfile: 'blocks-br4-v1',
        },
        keys: {
          version: 2,
          keyEpoch: 1,
          storageDEK: Buffer.from(f.config.keys.storageDEK).toString('base64'),
          ingressKey: Buffer.from(f.config.keys.ingressKey).toString('base64'),
        },
      }),
    });
    assert.equal(result.status, 42, result.stderr);
    const row = f.authority.inspect(f.config.vaultId)!;
    if (point !== 'finalized') {
      assert.equal(row.status, 'PREPARED');
      const p = row.pending!;
      AnchoredVault.reconcile({
        authority: f.authority,
        vaultId: f.config.vaultId,
        operationId: p.operationId,
        keys: f.config.keys,
        maxCalls: 4,
      });
    } else assert.equal(row.status, 'ACTIVE');
    const next = AnchoredVault.open(f.config, 4, f.options);
    t.after(() => next.close());
    assert.throws(() => next.claim('child-native', 'payload'), /INTERACTION_TERMINATED/);
    assert.equal(next.status.unknownRequests, 2);
  });
test('pending compaction fences a live source and only reconciles its frozen new base', (t) => {
  const f = fixture(t);
  f.v.claim('one', 'payload');
  const before = sizes(f.config.directory),
    target = join(f.root, 'pending-compact');
  const request = {
    authority: f.authority,
    vaultId: f.config.vaultId,
    keys: f.config.keys,
    maxCalls: 4,
    targetDirectory: target,
    storageDomain: 'payload',
    operationId: 'compact-pending',
  };
  assert.throws(
    () =>
      AnchoredVault.compact({
        ...request,
        fault: (p) => {
          if (p === 'prepared') throw new Error('FAULT');
        },
      }),
    /FAULT/,
  );
  assert.equal(f.authority.inspect(f.config.vaultId)!.status, 'PREPARED');
  assert.throws(() => f.v.store.snapshot(), /ANCHOR_PENDING/);
  assert.deepEqual(sizes(f.config.directory), before);
  assert.throws(() => AnchoredVault.open({ ...f.config, directory: target }, 4), /ANCHOR_PENDING/);
  const receipt = AnchoredVault.reconcile({
    authority: f.authority,
    vaultId: f.config.vaultId,
    operationId: request.operationId,
    keys: f.config.keys,
    maxCalls: 4,
  });
  assert.equal(reconstruct(receipt.newHead, directoryReader(target), f.config.keys, 4).baseline.depth, 1);
  assert.throws(() => f.v.status, /ANCHOR_FENCED/);
});
test('v3 fanout maintenance preserves required policy and explicitly resets only selected laggards', (t) => {
  const f = fixture(t),
    scope = f.v.store.ensureScope(who),
    a = f.v.store.registerConsumer('required', scope, 'retrieval-refs-v1', true);
  f.v.store.acceptEvent(scope, input('later'));
  const target = join(f.root, 'maintained');
  const request = {
    authority: f.authority,
    vaultId: f.config.vaultId,
    keys: f.config.keys,
    maxCalls: 4,
    targetDirectory: target,
    storageDomain: 'payload',
    operationId: 'maintain',
    retainBatches: 0,
    resetConsumerIds: [] as string[],
  };
  assert.throws(() => AnchoredVault.maintainFanout(request), /FANOUT_RETENTION/);
  assert.equal(existsSync(target), false);
  const receipt = AnchoredVault.maintainFanout({ ...request, resetConsumerIds: [a.id] });
  assert.deepEqual(receipt.maintenance?.resetConsumerIds, [a.id]);
  f.v.close();
  const next = AnchoredVault.open({ ...f.config, directory: target }, 4, f.options);
  t.after(() => next.close());
  const current = next.store.scope(scope.id);
  const handle = next.store.resumeConsumer(a.id, current);
  assert.deepEqual(next.store.readConsumer(handle).refs, []);
  assert.equal(next.store.consumerStatus(a.id).required, true);
});
test('writer resets to a base when the cumulative patch decode budget would be exceeded', (t) => {
  const f = fixture(t),
    d = decoded(f),
    head = f.v.head;
  const frame = freezeFrame(
    identityOf(head),
    head.sequence + 1,
    'budget',
    d.image,
    d.state.safety,
    d.state.revocationHighWater,
    f.config.keys,
    head,
    null,
    { image: d.image, depth: 2, readBytes: 64 * 1024 * 1024, decodedBytes: 64 * 1024 * 1024 },
  );
  assert.equal(frame.baseline.depth, 1);
  assert.ok(frame.baseline.readBytes < 64 * 1024 * 1024);
});
test('v3 backup and pending stage limits reject oversized manifests before parsing', (t) => {
  const f = fixture(t),
    backup = join(f.root, 'backup');
  f.v.exportBackup(backup);
  const path = join(backup, 'current-state.json');
  writeFileSync(path, Buffer.alloc(65537, 32));
  assert.throws(
    () =>
      AnchoredVault.verifyBackup({ backupDirectory: backup, authority: f.authority, keys: f.config.keys, maxCalls: 4 }),
    /ANCHOR_FILE/,
  );
  assert.throws(() => parseFrozenV3(Buffer.from([0xff])), /INCREMENTAL_CORRUPT/);
});
test('pure RAM writer limits reject records, stages and UTF-8 markers that readers cannot reopen', () => {
  const root = resolve('/'),
    keys = generateKeySet(),
    identity: VaultIdentity = {
      format: INCREMENTAL_FORMAT,
      authorityId: 'authority',
      vaultId: 'vault',
      identity: 'synthetic',
      instanceId: 'instance',
      ownerEpoch: 1,
      keyEpoch: 1,
      directory: join(root, 'synthetic'),
      storageDomain: 'payload',
      storageProfile: 'blocks-br4-v1' as const,
    };
  const safety = {
    version: 1 as const,
    identity: 'synthetic',
    maxCalls: 4,
    reserved: 0,
    ingress: [],
    lastSourceRef: null,
    lastAcknowledgedDeliveryId: null,
    lastWall: 0,
  };
  const oversized = { ...identity, directory: root + ('a'.repeat(170) + sep).repeat(100) },
    old = { ...oversized, sequence: 1, digest: '0'.repeat(64) };
  assert.throws(() => encodeVaultMarker(oversized), /ANCHOR_LIMIT/);
  assert.throws(() => encodeVaultMarker({ ...identity, directory: root + '界'.repeat(3000) }), /ANCHOR_LIMIT/);
  assert.throws(
    () => freezeFrame(oversized, 2, 'long-record', Buffer.alloc(4096), safety, 0, keys, old, null, null),
    /INCREMENTAL_LIMIT/,
  );
  // A long operation ID is internal-only here: proves stage's independent
  // limit rather than relying on the external ID admission check.
  assert.throws(
    () =>
      freezeFrame(
        { ...identity, directory: root + 'a'.repeat(25000) },
        1,
        'x'.repeat(5000),
        Buffer.alloc(4096),
        safety,
        0,
        keys,
        null,
        null,
        null,
      ),
    /INCREMENTAL_LIMIT/,
  );
  assert.ok(encodeVaultMarker(identity).length < 8192);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { DurableMemory } from '../src/durable-memory.ts';
import type { DurableConfig, DurableHeadPin } from '../src/durable-memory.ts';
import { stageDurableRestore, verifyDurableBackup } from '../src/durable-backup.ts';
import type { BackupFault, BackupVerificationOptions, RestoreFault } from '../src/durable-backup.ts';
import { RESTORE_DIRECTORY_PREFIX, RESTORE_QUARANTINE } from '../src/durable-codec.ts';
import { MemoryStore } from '../src/store.ts';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const who = { tenantId: 'synthetic', subjectId: 'subject', personaId: 'test', relationshipId: 'private' };
const secret = 'SYNTHETIC_ONLY_MEMORY_PLAINTEXT_9729';
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-m2-backup-')));
  const config: DurableConfig = {
    directory: join(root, 'source'),
    identity: 'SYNTHETIC_BACKUP',
    keyBase64: randomBytes(32).toString('base64'),
  };
  mkdirSync(config.directory);
  const vault = new DurableMemory(config, 8);
  t.after(() => vault.close());
  const options = (expectedHead = vault.head): BackupVerificationOptions => ({ ...config, maxCalls: 8, expectedHead });
  return {
    root,
    config,
    vault,
    options,
    backup: join(root, 'backup'),
    target: join(root, `${RESTORE_DIRECTORY_PREFIX}synthetic`),
  };
}
function files(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, sha(readFileSync(join(directory, name)))]),
  );
}
function manifest(directory: string): any {
  return JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
}
function updateManifest(directory: string, change: (value: any) => void): void {
  const value = manifest(directory);
  change(value);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value));
}
function populate(vault: DurableMemory) {
  const scope = vault.store.ensureScope(who);
  const source = vault.store.acceptEvent(scope, {
    source: 'synthetic',
    eventKey: 'one',
    evidence: {
      speakerId: 'subject',
      speakerRole: 'subject',
      mode: 'self_report',
      selectedText: secret,
      occurredAt: null,
    },
  });
  const job = vault.store.beginJob(scope, [source]),
    lease = vault.store.claimLease(scope, job.id);
  vault.store.propose(scope, job.id, lease.token, {
    kind: 'claim',
    statement: secret,
    basis: 'self_report',
    validFrom: null,
    validTo: null,
  });
  vault.store.publish(scope, job.id, lease.token);
  vault.claim('request', 'synthetic-payload');
  vault.reserve('request');
  return { scope, source };
}

// Independent fixture codec only: all keys/images are synthetic and in RAM.
function decrypt(bytes: Uint8Array, keyBase64: string, purpose: string): any {
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(`companion-core-m2-v1:${purpose}`));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
}
function encrypt(value: unknown, keyBase64: string, purpose: string): Buffer {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  cipher.setAAD(Buffer.from(`companion-core-m2-v1:${purpose}`));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
}
function rewriteImage(directory: string, keyBase64: string, mutate: (db: DatabaseSync) => void): DurableHeadPin {
  const cp = decrypt(readFileSync(join(directory, 'checkpoint.bin')), keyBase64, 'checkpoint');
  const memory = new DatabaseSync(':memory:');
  try {
    memory.deserialize(Buffer.from(cp.image, 'base64'));
    mutate(memory);
    cp.image = Buffer.from(memory.serialize()).toString('base64');
  } finally {
    memory.close();
  }
  const checkpoint = encrypt(cp, keyBase64, 'checkpoint');
  writeFileSync(join(directory, 'checkpoint.bin'), checkpoint);
  const db = new DatabaseSync(':memory:');
  let pin: DurableHeadPin;
  try {
    db.deserialize(readFileSync(join(directory, 'authority.sqlite')));
    const row = db.prepare('SELECT sequence,sealed FROM entries ORDER BY sequence DESC LIMIT 1').get()!;
    const authority = decrypt(row.sealed as Uint8Array, keyBase64, 'authority');
    authority.sha256 = sha(checkpoint);
    const sealed = encrypt(authority, keyBase64, 'authority');
    db.prepare('UPDATE entries SET sealed=? WHERE sequence=?').run(sealed, row.sequence!);
    writeFileSync(join(directory, 'authority.sqlite'), db.serialize());
    pin = { ...manifest(directory).head, authoritySha256: sha(sealed) };
  } finally {
    db.close();
  }
  updateManifest(directory, (value) => {
    value.head = pin;
    for (const file of value.files) {
      const bytes = readFileSync(join(directory, file.name));
      file.sha256 = sha(bytes);
      file.bytes = bytes.length;
    }
  });
  return pin;
}

test('live owned export captures one exact head; verification and staged restore preserve quota/revocation without disk or RAM mutation', (t) => {
  const f = fixture(t),
    populated = populate(f.vault);
  f.vault.store.revoke(populated.scope, populated.source);
  const head = f.vault.head,
    before = files(f.config.directory),
    imageBefore = f.vault.store.snapshot(),
    status = f.vault.status;
  // A launcher-owned name is a directory here: export must neither open nor copy it.
  mkdirSync(join(f.config.directory, 'memory-key.dpapi'));
  const exported = f.vault.exportBackup(f.backup);
  assert.deepEqual(exported.head, head);
  assert.equal(exported.consumedRequests, 1);
  assert.equal(exported.revocationHighWater, 1);
  const packageBefore = files(f.backup);
  assert.deepEqual(Object.keys(packageBefore), ['authority.sqlite', 'checkpoint.bin', 'manifest.json']);
  assert.deepEqual(verifyDurableBackup(f.backup, f.options(head)), exported);
  assert.equal(stageDurableRestore(f.backup, f.target, f.options(head)).status, 'RESTORE_VERIFIED_NOT_ACTIVATED');
  assert.deepEqual(files(f.backup), packageBefore);
  assert.deepEqual(f.vault.head, head);
  assert.deepEqual(f.vault.store.snapshot(), imageBefore);
  assert.deepEqual(f.vault.status, status);
  for (const [name, hash] of Object.entries(before))
    assert.equal(sha(readFileSync(join(f.config.directory, name))), hash);
  for (const directory of [f.backup, f.target])
    for (const name of readdirSync(directory)) {
      const bytes = readFileSync(join(directory, name));
      assert.equal(bytes.includes(Buffer.from(secret)), false, name);
      assert.equal(bytes.includes(Buffer.from(f.config.keyBase64)), false, name);
    }
  const cpName = manifest(f.backup).checkpointName;
  assert.deepEqual(readFileSync(join(f.target, cpName)), readFileSync(join(f.backup, 'checkpoint.bin')));
  const cp = decrypt(readFileSync(join(f.target, cpName)), f.config.keyBase64, 'checkpoint');
  assert.equal(cp.safety.reserved, 1);
  assert.equal(cp.safety.ingress[0].state, 'pending'); // verifier did not rewrite to unknown
  const store = new MemoryStore(':memory:', { image: Buffer.from(cp.image, 'base64') });
  try {
    assert.equal(store.revocationHighWater(), 1);
    assert.equal(store.search(populated.scope, secret).length, 0);
  } finally {
    store.close();
  }
  const targetBefore = files(f.target);
  assert.throws(() => new DurableMemory({ ...f.config, directory: f.target }, 8), /DURABLE_RESTORE_QUARANTINED/);
  assert.deepEqual(files(f.target), targetBefore);
  assert.equal(existsSync(join(f.target, 'writer.sqlite')), false);
  f.vault.claim('still-healthy', 'payload');
  assert.equal(f.vault.reserved, 1);
});

test('pin accepts equal and later chain, refuses shorter prefix, fork, identity/format/version mismatch', (t) => {
  const f = fixture(t);
  f.vault.claim('request', 'payload');
  const prefix = f.vault.head;
  f.vault.reserve('request');
  const latest = f.vault.head;
  f.vault.exportBackup(f.backup);
  assert.deepEqual(verifyDurableBackup(f.backup, f.options(prefix)).head, latest);
  assert.throws(
    () => verifyDurableBackup(f.backup, f.options({ ...latest, sequence: latest.sequence + 1 })),
    /DURABLE_HEAD_ROLLBACK/,
  );
  assert.throws(
    () => verifyDurableBackup(f.backup, f.options({ ...latest, authoritySha256: '0'.repeat(64) })),
    /DURABLE_HEAD_MISMATCH/,
  );
  for (const pin of [
    { ...latest, format: 'future' },
    { ...latest, version: 2 },
    { ...latest, sequence: 0 },
    { ...latest, authoritySha256: 'g'.repeat(64) },
  ]) {
    assert.throws(() => verifyDurableBackup(f.backup, f.options(pin as DurableHeadPin)), /DURABLE_HEAD_PIN_INVALID/);
  }
  assert.throws(
    () => verifyDurableBackup(f.backup, f.options({ ...latest, identity: 'other' })),
    /DURABLE_IDENTITY_MISMATCH/,
  );
  assert.throws(
    () => verifyDurableBackup(f.backup, { ...f.options(), expectedHead: undefined } as any),
    /DURABLE_HEAD_PIN_INVALID/,
  );
  f.vault.close();
  const equal = new DurableMemory(f.config, 8, { expectedHead: latest });
  equal.close();
  const later = new DurableMemory(f.config, 8, { expectedHead: prefix });
  later.close();
  const db = new DatabaseSync(join(f.config.directory, 'authority.sqlite'));
  db.prepare('DELETE FROM entries WHERE sequence>?').run(prefix.sequence);
  db.close();
  const before = files(f.config.directory);
  assert.throws(() => new DurableMemory(f.config, 8, { expectedHead: latest }), /DURABLE_HEAD_ROLLBACK/);
  assert.deepEqual(files(f.config.directory), before); // no recovery checkpoint or quota refund on pinned refusal
});

test('two independently valid continuations of a copied prefix cannot satisfy the other branch pin', (t) => {
  const f = fixture(t),
    ancestor = f.vault.head;
  f.vault.close();
  const branchDirectory = join(f.root, 'synthetic-branch');
  cpSync(f.config.directory, branchDirectory, { recursive: true });
  const a = new DurableMemory(f.config, 8),
    b = new DurableMemory({ ...f.config, directory: branchDirectory }, 8);
  try {
    assert.equal(a.head.sequence, b.head.sequence);
    assert.notEqual(a.head.authoritySha256, b.head.authoritySha256);
    a.exportBackup(f.backup);
    assert.deepEqual(verifyDurableBackup(f.backup, f.options(ancestor)).head, a.head);
    assert.throws(() => verifyDurableBackup(f.backup, f.options(b.head)), /DURABLE_HEAD_MISMATCH/);
    b.claim('later-on-wrong-branch', 'payload');
    b.exportBackup(join(f.root, 'branch-backup'));
    assert.throws(() => verifyDurableBackup(join(f.root, 'branch-backup'), f.options(a.head)), /DURABLE_HEAD_MISMATCH/);
  } finally {
    a.close();
    b.close();
  }
});

test('an older trusted pin is only a lower bound, while a newer pin rejects an otherwise valid older backup', (t) => {
  const f = fixture(t),
    oldPin = f.vault.head;
  f.vault.exportBackup(f.backup);
  f.vault.claim('spent-later', 'synthetic');
  f.vault.reserve('spent-later');
  const latest = f.vault.head;
  assert.equal(verifyDurableBackup(f.backup, f.options(oldPin)).consumedRequests, 0);
  assert.throws(() => stageDurableRestore(f.backup, f.target, f.options(latest)), /DURABLE_HEAD_ROLLBACK/);
  assert.equal(existsSync(f.target), false);
  assert.equal(f.vault.reserved, 1);
});

for (const kind of ['key', 'identity', 'budget'] as const)
  test(`backup rejects wrong ${kind} and creates no restore target`, (t) => {
    const f = fixture(t);
    f.vault.exportBackup(f.backup);
    const options = f.options();
    if (kind === 'key') options.keyBase64 = randomBytes(32).toString('base64');
    if (kind === 'identity') {
      options.identity = 'wrong';
      options.expectedHead = { ...options.expectedHead, identity: 'wrong' };
    }
    if (kind === 'budget') options.maxCalls = 7;
    assert.throws(
      () => stageDurableRestore(f.backup, f.target, options),
      /DURABLE_(CORRUPT|IDENTITY_MISMATCH|BUDGET_MISMATCH)/,
    );
    assert.equal(existsSync(f.target), false);
    assert.equal(f.vault.reserved, 0);
  });

for (const fault of ['after-authority', 'after-checkpoint', 'before-complete'] as BackupFault[])
  test(`export ${fault} fault retains rejected partial and leaves source usable`, (t) => {
    const f = fixture(t),
      head = f.vault.head,
      sourceBefore = files(f.config.directory);
    assert.throws(
      () =>
        f.vault.exportBackup(f.backup, {
          fault(point) {
            if (point === fault) throw new Error('SYNTHETIC_FAILURE');
          },
        }),
      /DURABLE_BACKUP_IO/,
    );
    assert.equal(existsSync(join(f.backup, 'manifest.json')), false);
    assert.throws(() => verifyDurableBackup(f.backup, f.options(head)), /DURABLE_BACKUP_INCOMPLETE/);
    assert.deepEqual(files(f.config.directory), sourceBefore);
    assert.deepEqual(f.vault.head, head);
    f.vault.claim('after-failed-export', 'synthetic');
    assert.equal(f.vault.head.sequence, head.sequence + 1);
  });

for (const fault of [
  'after-directory-create',
  'after-quarantine',
  'after-authority',
  'after-checkpoint',
  'before-complete',
] as RestoreFault[])
  test(`restore ${fault} fault leaves a quarantine that cannot boot`, (t) => {
    const f = fixture(t);
    f.vault.exportBackup(f.backup);
    const before = files(f.backup);
    assert.throws(
      () =>
        stageDurableRestore(f.backup, f.target, f.options(), {
          fault(point) {
            if (point === fault) throw new Error('SYNTHETIC_FAILURE');
          },
        }),
      /DURABLE_BACKUP_IO/,
    );
    assert.equal(existsSync(join(f.target, RESTORE_QUARANTINE)), fault !== 'after-directory-create');
    assert.equal(existsSync(join(f.target, 'restore-verified.json')), false);
    assert.throws(() => new DurableMemory({ ...f.config, directory: f.target }, 8), /DURABLE_RESTORE_QUARANTINED/);
    assert.deepEqual(files(f.backup), before);
    assert.equal(f.vault.reserved, 0);
  });

test('export blocks reentrant source mutations/close and snapshots with serialize rather than copying live authority', (t) => {
  const f = fixture(t),
    original = DatabaseSync.prototype.serialize,
    head = f.vault.head;
  let serializations = 0,
    hooks = 0;
  DatabaseSync.prototype.serialize = function () {
    serializations++;
    return original.call(this);
  };
  try {
    f.vault.exportBackup(f.backup, {
      fault() {
        hooks++;
        assert.throws(() => f.vault.claim('reentrant', 'p'), /DURABLE_SNAPSHOT_BUSY/);
        assert.throws(() => f.vault.store.ensureScope(who), /DURABLE_SNAPSHOT_BUSY/);
        assert.throws(() => f.vault.store.close(), /DURABLE_SNAPSHOT_BUSY/);
        assert.throws(() => f.vault.close(), /DURABLE_SNAPSHOT_BUSY/);
      },
    });
  } finally {
    DatabaseSync.prototype.serialize = original;
  }
  assert.equal(serializations, 1);
  assert.equal(hooks, 3);
  assert.deepEqual(f.vault.head, head);
  f.vault.store.ensureScope(who);
  assert.equal(f.vault.store.diagnostics().integrity, true);
});

test('completion fsync failure never publishes an accepted manifest or poisons source', (t) => {
  const f = fixture(t),
    head = f.vault.head,
    original = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (fd) => {
    if (++calls === 3) throw new Error('SYNTHETIC_FSYNC_FAILURE');
    original(fd);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.vault.exportBackup(f.backup), /DURABLE_BACKUP_IO/);
  } finally {
    fs.fsyncSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(calls, 3);
  assert.equal(existsSync(join(f.backup, 'manifest.json')), false);
  assert.equal(existsSync(join(f.backup, 'manifest.json.pending')), true);
  assert.throws(() => verifyDurableBackup(f.backup, f.options(head)), /DURABLE_BACKUP_INCOMPLETE/);
  assert.deepEqual(f.vault.head, head);
  f.vault.claim('still-usable', 'payload');
});

test('serialize failure leaves no package and a healthy writer can continue; closed/poisoned writers cannot export', (t) => {
  const f = fixture(t),
    original = DatabaseSync.prototype.serialize;
  DatabaseSync.prototype.serialize = function () {
    throw new Error('SYNTHETIC_SERIALIZE_FAILURE');
  };
  try {
    assert.throws(() => f.vault.exportBackup(f.backup), /DURABLE_BACKUP_IO/);
  } finally {
    DatabaseSync.prototype.serialize = original;
  }
  assert.equal(existsSync(f.backup), false);
  f.vault.claim('continues', 'p');
  f.vault.close();
  assert.throws(() => f.vault.exportBackup(f.backup), /DURABLE_UNAVAILABLE/);
  const badDirectory = join(f.root, 'synthetic-poison');
  mkdirSync(badDirectory);
  let armed = false;
  const poisoned = new DurableMemory({ ...f.config, directory: badDirectory }, 8, {
    fault() {
      if (armed) throw new Error('SYNTHETIC_WRITE_FAILURE');
    },
  });
  try {
    armed = true;
    assert.throws(() => poisoned.claim('bad-write', 'p'), /DURABLE_WRITE_FAILED/);
    assert.throws(() => poisoned.exportBackup(f.backup), /DURABLE_UNAVAILABLE/);
  } finally {
    poisoned.close();
  }
});

for (const defect of [
  'missing-manifest',
  'missing-checkpoint',
  'extra-file',
  'unknown-version',
  'traversal',
  'oversize-manifest',
  'oversize-file',
  'bad-hash',
  'checkpoint-hash',
  'unknown-field',
  'manifest-head',
  'bad-authority-aead',
  'chain-gap',
] as const) {
  test(`bounded complete package rejects ${defect}`, (t) => {
    const f = fixture(t);
    f.vault.claim('one', 'one');
    f.vault.claim('two', 'two');
    f.vault.exportBackup(f.backup);
    const opts = f.options();
    if (defect === 'missing-manifest') renameSync(join(f.backup, 'manifest.json'), join(f.root, 'saved-manifest'));
    if (defect === 'missing-checkpoint') renameSync(join(f.backup, 'checkpoint.bin'), join(f.root, 'saved-checkpoint'));
    if (defect === 'extra-file') writeFileSync(join(f.backup, 'unexpected'), 'synthetic');
    if (defect === 'unknown-version')
      updateManifest(f.backup, (m) => {
        m.version = 2;
      });
    if (defect === 'traversal')
      updateManifest(f.backup, (m) => {
        m.files[1].name = '../outside';
      });
    if (defect === 'unknown-field')
      updateManifest(f.backup, (m) => {
        m.allowFallback = true;
      });
    if (defect === 'oversize-manifest') truncateSync(join(f.backup, 'manifest.json'), 16 * 1024 + 1);
    if (defect === 'oversize-file') truncateSync(join(f.backup, 'authority.sqlite'), 64 * 1024 * 1024 + 1);
    if (defect === 'bad-hash')
      updateManifest(f.backup, (m) => {
        m.files[0].sha256 = '0'.repeat(64);
      });
    if (defect === 'manifest-head')
      updateManifest(f.backup, (m) => {
        m.head.authoritySha256 = '0'.repeat(64);
      });
    if (defect === 'checkpoint-hash') {
      const bytes = readFileSync(join(f.backup, 'checkpoint.bin'));
      bytes[35] = bytes[35]! ^ 1;
      writeFileSync(join(f.backup, 'checkpoint.bin'), bytes);
      updateManifest(f.backup, (m) => {
        m.files[1].sha256 = sha(bytes);
      });
    }
    if (defect === 'bad-authority-aead' || defect === 'chain-gap') {
      const db = new DatabaseSync(':memory:');
      try {
        db.deserialize(readFileSync(join(f.backup, 'authority.sqlite')));
        if (defect === 'chain-gap') db.exec('DELETE FROM entries WHERE sequence=2');
        else {
          const row = db.prepare('SELECT sequence,sealed FROM entries ORDER BY sequence DESC LIMIT 1').get()!;
          const sealed = Buffer.from(row.sealed as Uint8Array);
          sealed[30] = sealed[30]! ^ 1;
          db.prepare('UPDATE entries SET sealed=? WHERE sequence=?').run(sealed, row.sequence!);
          opts.expectedHead.authoritySha256 = sha(sealed);
          updateManifest(f.backup, (m) => {
            m.head = opts.expectedHead;
          });
        }
        const bytes = db.serialize();
        writeFileSync(join(f.backup, 'authority.sqlite'), bytes);
        updateManifest(f.backup, (m) => {
          m.files[0].sha256 = sha(bytes);
          m.files[0].bytes = bytes.length;
        });
      } finally {
        db.close();
      }
    }
    assert.throws(() => stageDurableRestore(f.backup, f.target, opts), /DURABLE_/);
    assert.equal(existsSync(f.target), false);
    f.vault.claim('healthy-after-refusal', 'p');
  });
}

for (const defect of ['schema-version', 'schema-hash', 'foreign-key', 'fts-index'] as const)
  test(`authenticated checkpoint still requires valid ${defect}`, (t) => {
    const f = fixture(t);
    populate(f.vault);
    f.vault.exportBackup(f.backup);
    const pin = rewriteImage(f.backup, f.config.keyBase64, (db) => {
      if (defect === 'schema-version') db.exec('PRAGMA user_version=2');
      if (defect === 'schema-hash') db.exec("UPDATE meta SET value='wrong' WHERE key='schema_hash'");
      if (defect === 'foreign-key') {
        db.exec('PRAGMA foreign_keys=OFF');
        db.exec("UPDATE nodes SET scope_id='absent'");
      }
      if (defect === 'fts-index') {
        db.enableDefensive(false);
        assert.ok(db.prepare("UPDATE memory_fts_data SET block=X'00' WHERE id>10").run().changes);
      }
    });
    assert.throws(() => verifyDurableBackup(f.backup, f.options(pin)), /UNSUPPORTED_SCHEMA|SCHEMA_MISMATCH|DURABLE_/);
  });

test('new leaf requirements reject existing targets, source descendants and symbolic-link ancestors', (t) => {
  const f = fixture(t);
  f.vault.exportBackup(f.backup);
  assert.throws(() => f.vault.exportBackup(f.backup), /DURABLE_TARGET_EXISTS/);
  assert.throws(() => f.vault.exportBackup(join(f.config.directory, 'inside')), /DURABLE_BACKUP_PATH/);
  assert.throws(() => f.vault.exportBackup(join(f.config.directory, '..inside')), /DURABLE_BACKUP_PATH/);
  const packageBefore = files(f.backup);
  assert.throws(
    () => stageDurableRestore(f.backup, join(f.backup, `${RESTORE_DIRECTORY_PREFIX}inside`), f.options()),
    /DURABLE_BACKUP_PATH/,
  );
  assert.throws(
    () => stageDurableRestore(f.backup, join(f.root, 'ordinary-name'), f.options()),
    /DURABLE_RESTORE_NAME_REQUIRED/,
  );
  assert.deepEqual(files(f.backup), packageBefore);
  mkdirSync(f.target);
  writeFileSync(join(f.target, 'preserve'), 'synthetic');
  const before = files(f.target);
  assert.throws(() => stageDurableRestore(f.backup, f.target, f.options()), /DURABLE_TARGET_EXISTS/);
  assert.deepEqual(files(f.target), before);
  const link = join(f.root, 'link');
  symlinkSync(f.backup, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyDurableBackup(link, f.options()), /DURABLE_BACKUP_PATH/);
  assert.throws(() => stageDurableRestore(f.backup, link, f.options()), /DURABLE_RESTORE_NAME_REQUIRED/);
  assert.throws(() => f.vault.exportBackup(join(link, 'child')), /DURABLE_BACKUP_PATH/);
  renameSync(join(f.backup, 'checkpoint.bin'), join(f.root, 'saved-checkpoint'));
  symlinkSync(f.target, join(f.backup, 'checkpoint.bin'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyDurableBackup(f.backup, f.options()), /DURABLE_BACKUP_PATH/);
});

test('process exit immediately after restore mkdir leaves an empty reserved directory that cannot initialize', (t) => {
  const f = fixture(t);
  f.vault.exportBackup(f.backup);
  const moduleUrl = new URL('../src/durable-backup.ts', import.meta.url).href;
  const script = `import {stageDurableRestore} from ${JSON.stringify(moduleUrl)};let input='';for await(const part of process.stdin)input+=part;const v=JSON.parse(input);stageDurableRestore(v.directory,v.target,v.options,{fault(point){if(point==='after-directory-create')process.exit(17);}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
    input: JSON.stringify({ directory: f.backup, target: f.target, options: f.options() }),
  });
  assert.equal(child.status, 17, child.stderr);
  assert.deepEqual(readdirSync(f.target), []);
  assert.throws(() => new DurableMemory({ ...f.config, directory: f.target }, 8), /DURABLE_RESTORE_QUARANTINED/);
  assert.deepEqual(readdirSync(f.target), []);
  assert.equal(f.vault.reserved, 0);
});

test('new process independently verifies encrypted package using only stdin credentials/pin and emits safe metadata', (t) => {
  const f = fixture(t);
  populate(f.vault);
  f.vault.exportBackup(f.backup);
  const before = files(f.backup);
  const moduleUrl = new URL('../src/durable-backup.ts', import.meta.url).href;
  const script = `import {verifyDurableBackup} from ${JSON.stringify(moduleUrl)};let input='';for await(const part of process.stdin)input+=part;const v=JSON.parse(input);console.log(JSON.stringify(verifyDurableBackup(v.directory,v.options)));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
    input: JSON.stringify({ directory: f.backup, options: f.options() }),
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.consumedRequests, 1);
  assert.deepEqual(result.head, f.vault.head);
  assert.equal(child.stdout.includes(f.config.keyBase64), false);
  assert.equal(child.stdout.includes(secret), false);
  assert.deepEqual(files(f.backup), before);
});

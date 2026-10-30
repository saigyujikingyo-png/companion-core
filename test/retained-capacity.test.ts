import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, {
  Dir,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  linkSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inspectRetainedRoots } from '../src/retained-capacity.ts';
import { CAPACITY_DIRECTORY_ENTRY_LIMIT } from '../src/capacity-types.ts';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'retained-capacity-')));
  return {
    root,
    leaf: (name: string) => {
      const path = join(root, name);
      mkdirSync(path);
      return path;
    },
  };
}
function files(path: string) {
  return readdirSync(path)
    .sort()
    .map((name) => ({ name, bytes: readFileSync(join(path, name)) }));
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
}

test('retained metadata counts explicit leaves in order without reading file content or mutating bytes', () => {
  const f = fixture(),
    a = f.leaf('a'),
    b = f.leaf('b');
  writeFileSync(join(a, 'one'), 'synthetic');
  writeFileSync(join(a, 'two'), 'other');
  const before = files(a),
    read = fs.readFileSync;
  let contentReads = 0;
  try {
    fs.readFileSync = (..._args: unknown[]) => {
      contentReads++;
      throw Error('CONTENT_READ');
    };
    syncBuiltinESMExports();
    const report = inspectRetainedRoots({ roots: [b, a] });
    assert.deepEqual(report, {
      version: 1,
      entryLimit: CAPACITY_DIRECTORY_ENTRY_LIMIT,
      entriesObserved: 2,
      observedBytes: 14,
      roots: [
        { root: b, canonicalRoot: b, entriesObserved: 0, observedBytes: 0, status: 'EOF', reason: null },
        { root: a, canonicalRoot: a, entriesObserved: 2, observedBytes: 14, status: 'EOF', reason: null },
      ],
    });
    frozen(report);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  } finally {
    fs.readFileSync = read;
    syncBuiltinESMExports();
  }
  assert.equal(contentReads, 0);
  assert.deepEqual(files(a), before);
});

test('one common entry budget conservatively truncates at equality and leaves later roots unscanned', () => {
  const f = fixture(),
    a = f.leaf('a'),
    b = f.leaf('b');
  writeFileSync(join(a, 'one'), 'abc');
  writeFileSync(join(b, 'two'), 'defgh');
  const read = Dir.prototype.readSync;
  let reads = 0;
  try {
    Dir.prototype.readSync = function () {
      reads++;
      return read.call(this);
    };
    const report = inspectRetainedRoots({ roots: [a, b], entryLimit: 1 });
    assert.equal(reads, 1);
    assert.equal(report.entriesObserved, 1);
    assert.equal(report.observedBytes, 3);
    assert.equal(report.roots[0]!.status, 'TRUNCATED');
    assert.equal(report.roots[0]!.reason, 'ENTRY_LIMIT');
    assert.equal(report.roots[1]!.status, 'NOT_SCANNED');
    assert.equal(report.roots[1]!.canonicalRoot, b);
  } finally {
    Dir.prototype.readSync = read;
  }
  const report = inspectRetainedRoots({ roots: [a, b], entryLimit: 2 });
  assert.deepEqual(
    report.roots.map((r) => r.status),
    ['EOF', 'TRUNCATED'],
  );
  assert.equal(report.entriesObserved, 2);
  assert.equal(report.observedBytes, 8);
});

test('eight explicit roots and the maximum budget are accepted and caller array changes cannot redirect a scan', () => {
  const f = fixture(),
    roots = Array.from({ length: 8 }, (_, i) => f.leaf(String(i))),
    original = [...roots],
    open = fs.opendirSync;
  try {
    fs.opendirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      roots.fill(join(f.root, 'missing'));
      return Reflect.apply(open, fs, [path, ...args]);
    }) as typeof fs.opendirSync;
    syncBuiltinESMExports();
    const report = inspectRetainedRoots({ roots, entryLimit: CAPACITY_DIRECTORY_ENTRY_LIMIT });
    assert.deepEqual(
      report.roots.map((root) => root.canonicalRoot),
      original,
    );
    assert.ok(report.roots.every((root) => root.status === 'EOF'));
  } finally {
    fs.opendirSync = open;
    syncBuiltinESMExports();
  }
});

test('invalid requests reject before filesystem I/O and never invoke getters, coercion or proxy traps', () => {
  const f = fixture(),
    root = f.leaf('root');
  let invoked = 0,
    io = 0,
    oversizedEnumerations = 0;
  const trap = () => {
    invoked++;
    throw Error('CALLER_CODE');
  };
  const accessor = Object.defineProperty([root], '0', { get: trap });
  const custom = [root];
  Object.setPrototypeOf(custom, Object.create(Array.prototype));
  const symbol = [root];
  Object.defineProperty(symbol, Symbol('extra'), { value: 1 });
  const oversized = Array(9),
    descriptors = Object.getOwnPropertyDescriptors,
    lstat = fs.lstatSync,
    open = fs.opendirSync;
  const bad: unknown[] = [
    null,
    {},
    [],
    { roots: [] },
    { roots: Array(1) },
    { roots: custom },
    { roots: symbol },
    { roots: [new String(root)] },
    { roots: [{ toString: trap }] },
    { roots: accessor },
    { roots: new Proxy([root], { get: trap, ownKeys: trap, getPrototypeOf: trap }) },
    new Proxy({ roots: [root] }, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    Object.defineProperty({}, 'roots', { get: trap }),
    Object.defineProperty({ roots: [root] }, 'entryLimit', { get: trap }),
    { roots: [root], extra: true },
    { roots: [root], keys: {} },
    { roots: oversized },
    { roots: ['relative'] },
    { roots: [''] },
    { roots: [root + '\0'] },
    { roots: [root + 'x'.repeat(4096)] },
    { roots: [root + '/../root'] },
    { roots: [root + '/..'] },
    ...(process.platform === 'win32'
      ? [{ roots: [root + '\\..\\root'] }, { roots: [root + '\\..'] }, { roots: [root + '/..\\root'] }]
      : []),
    ...[0, -1, 1.5, NaN, Infinity, CAPACITY_DIRECTORY_ENTRY_LIMIT + 1, null, '1'].map((entryLimit) => ({
      roots: [root],
      entryLimit,
    })),
  ];
  try {
    Object.getOwnPropertyDescriptors = function (value) {
      if (value === oversized) oversizedEnumerations++;
      return descriptors(value);
    };
    Object.defineProperty(fs, 'lstatSync', {
      value: (..._args: unknown[]) => {
        io++;
        throw Error('FS_READ');
      },
    });
    fs.opendirSync = ((..._args: unknown[]) => {
      io++;
      throw Error('FS_READ');
    }) as typeof fs.opendirSync;
    syncBuiltinESMExports();
    for (const request of bad) assert.throws(() => inspectRetainedRoots(request as any), /INVALID_INPUT|ANCHOR_PATH/);
  } finally {
    Object.getOwnPropertyDescriptors = descriptors;
    Object.defineProperty(fs, 'lstatSync', { value: lstat });
    fs.opendirSync = open;
    syncBuiltinESMExports();
  }
  assert.equal(invoked, 0);
  assert.equal(io, 0);
  assert.equal(oversizedEnumerations, 0);
  assert.equal(
    inspectRetainedRoots(Object.assign(Object.create(null), { roots: Object.freeze([root]) })).roots[0]!.status,
    'EOF',
  );
});

test('all roots are validated before enumeration, including normalized overlap and canonical aliases', () => {
  const f = fixture(),
    a = f.leaf('a'),
    b = f.leaf('b'),
    child = join(a, 'child');
  mkdirSync(child);
  const read = Dir.prototype.readSync;
  let reads = 0;
  try {
    Dir.prototype.readSync = function () {
      reads++;
      return read.call(this);
    };
    for (const roots of [
      [a, a],
      [a, a + sep + '.'],
      [a, child],
      [child, a],
      [join(f.root, 'missing'), join(f.root, 'missing', 'child')],
    ]) {
      assert.throws(() => inspectRetainedRoots({ roots }), /ANCHOR_CUSTODY_OVERLAP/);
    }
    if (process.platform === 'win32')
      assert.throws(() => inspectRetainedRoots({ roots: [a, a.toUpperCase()] }), /ANCHOR_CUSTODY_OVERLAP/);
    const alias = join(f.root, 'alias');
    symlinkSync(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => inspectRetainedRoots({ roots: [b, alias] }), /ANCHOR_PATH/);
    assert.throws(() => inspectRetainedRoots({ roots: [join(alias, 'child')] }), /ANCHOR_PATH/);
    assert.equal(reads, 0);
  } finally {
    Dir.prototype.readSync = read;
  }
});

test('hard links are counted per path as logical bytes, not physical unique allocation', () => {
  const f = fixture(),
    a = f.leaf('a'),
    b = f.leaf('b');
  writeFileSync(join(a, 'original'), 'abcdef');
  linkSync(join(a, 'original'), join(b, 'alias'));
  const report = inspectRetainedRoots({ roots: [a, b] });
  assert.equal(report.entriesObserved, 2);
  assert.equal(report.observedBytes, 12);
  assert.deepEqual(
    report.roots.map((r) => r.status),
    ['EOF', 'EOF'],
  );
});

test('raw linked parent traversal is refused before any filesystem I/O or enumeration', () => {
  const f = fixture(),
    safe = f.leaf('safe'),
    elsewhere = f.leaf('elsewhere'),
    target = join(elsewhere, 'nested');
  mkdirSync(target);
  mkdirSync(join(safe, 'leaf'));
  mkdirSync(join(elsewhere, 'leaf'));
  writeFileSync(join(safe, 'leaf', 'file'), 'abc');
  writeFileSync(join(elsewhere, 'leaf', 'file'), 'elsewhere');
  const alias = join(safe, 'alias');
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  // Do not use join here: the original linked component must reach the API.
  const raw = alias + sep + '..' + sep + 'leaf',
    stat = fs.lstatSync,
    read = Dir.prototype.readSync;
  let stats = 0,
    reads = 0;
  try {
    Object.defineProperty(fs, 'lstatSync', {
      value: (...args: unknown[]) => {
        stats++;
        return Reflect.apply(stat, fs, args);
      },
    });
    syncBuiltinESMExports();
    Dir.prototype.readSync = function () {
      reads++;
      return read.call(this);
    };
    assert.throws(() => inspectRetainedRoots({ roots: [raw] }), /ANCHOR_PATH/);
    assert.equal(stats, 0);
    assert.equal(reads, 0);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: stat });
    Dir.prototype.readSync = read;
    syncBuiltinESMExports();
  }
});

test('missing roots stay UNKNOWN while known empty roots reach EOF; no inferred directory is created', () => {
  const f = fixture(),
    a = f.leaf('empty'),
    missing = join(f.root, 'absent'),
    before = readdirSync(f.root);
  const report = inspectRetainedRoots({ roots: [missing, a] });
  assert.deepEqual(report.roots[0], {
    root: missing,
    canonicalRoot: null,
    entriesObserved: 0,
    observedBytes: 0,
    status: 'UNKNOWN',
    reason: 'ROOT_UNAVAILABLE',
  });
  assert.equal(report.roots[1]!.status, 'EOF');
  assert.deepEqual(readdirSync(f.root), before);
});

test('nested directories and junction entries consume one slot, are never followed and retain prior observations', () => {
  for (const link of [false, true]) {
    const f = fixture(),
      a = f.leaf('a'),
      b = f.leaf('b');
    writeFileSync(join(b, 'hidden'), 'not counted');
    if (link) symlinkSync(b, join(a, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    else mkdirSync(join(a, 'nested'));
    const report = inspectRetainedRoots({ roots: [a, b], entryLimit: 1 });
    assert.equal(report.entriesObserved, 1);
    assert.equal(report.observedBytes, 0);
    assert.equal(report.roots[0]!.status, 'UNKNOWN');
    assert.equal(report.roots[0]!.reason, 'UNSAFE_ENTRY');
    assert.equal(report.roots[1]!.status, 'NOT_SCANNED');
  }
});

test('an entry stat error retains partial bytes and never retries the failed entry', () => {
  const f = fixture(),
    a = f.leaf('a');
  for (const name of ['one', 'two', 'three']) writeFileSync(join(a, name), 'abc');
  const stat = fs.lstatSync,
    read = Dir.prototype.readSync;
  let count = 0,
    target = '',
    attempts = 0;
  try {
    Dir.prototype.readSync = function () {
      const entry = read.call(this);
      if (this.path === a && entry && ++count === 2) target = join(a, entry.name);
      return entry;
    };
    Object.defineProperty(fs, 'lstatSync', {
      value: (path: fs.PathLike, ...args: unknown[]) => {
        if (path === target) {
          attempts++;
          throw Object.assign(Error('gone'), { code: 'ENOENT' });
        }
        return Reflect.apply(stat, fs, [path, ...args]);
      },
    });
    syncBuiltinESMExports();
    const report = inspectRetainedRoots({ roots: [a] });
    assert.equal(report.entriesObserved, 2);
    assert.equal(report.observedBytes, 3);
    assert.equal(report.roots[0]!.status, 'UNKNOWN');
    assert.equal(report.roots[0]!.reason, 'ENTRY_UNAVAILABLE');
    assert.equal(attempts, 1);
  } finally {
    Object.defineProperty(fs, 'lstatSync', { value: stat });
    Dir.prototype.readSync = read;
    syncBuiltinESMExports();
  }
});

test('observed root additions or replacement during enumeration remain UNKNOWN with actual partial bytes', () => {
  for (const replacement of [false, true]) {
    const f = fixture(),
      a = f.leaf('a');
    writeFileSync(join(a, 'one'), 'abc');
    writeFileSync(join(a, 'two'), 'def');
    const read = Dir.prototype.readSync;
    let count = 0;
    try {
      Dir.prototype.readSync = function () {
        const entry = read.call(this);
        if (this.path === a && ++count === 2) {
          if (replacement) {
            renameSync(a, a + '-retained');
            mkdirSync(a);
          } else {
            writeFileSync(join(a, 'new'), 'new');
            // NTFS may defer a directory timestamp update; make the detectable
            // metadata change explicit, without claiming all additions are visible.
            utimesSync(a, new Date(1000), new Date(1000));
          }
        }
        return entry;
      };
      const report = inspectRetainedRoots({ roots: [a] });
      assert.equal(report.entriesObserved, 2);
      assert.equal(report.observedBytes, 3);
      assert.equal(report.roots[0]!.status, 'UNKNOWN');
      assert.equal(report.roots[0]!.reason, 'ROOT_CHANGED');
    } finally {
      Dir.prototype.readSync = read;
    }
  }
});

test('a validated root disappearing before open is UNKNOWN, not empty EOF', () => {
  const f = fixture(),
    a = f.leaf('a'),
    open = fs.opendirSync;
  let attempts = 0;
  try {
    fs.opendirSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (path === a) {
        attempts++;
        renameSync(a, a + '-retained');
      }
      return Reflect.apply(open, fs, [path, ...args]);
    }) as typeof fs.opendirSync;
    syncBuiltinESMExports();
    const report = inspectRetainedRoots({ roots: [a] });
    assert.equal(report.roots[0]!.status, 'UNKNOWN');
    assert.equal(report.roots[0]!.reason, 'ROOT_UNAVAILABLE');
    assert.equal(attempts, 1);
  } finally {
    fs.opendirSync = open;
    syncBuiltinESMExports();
  }
});

test('real synthetic compact and rekey leave old roots observable without changing Safety, revocation, heads or bytes', (t) => {
  const f = fixture(),
    authority = LocalSqliteAuthority.create({
      directory: join(f.root, 'authority'),
      authorityId: 'synthetic',
      custodyDomain: 'authority',
    }),
    keys = generateKeySet();
  t.after(() => authority.close());
  const config = {
    directory: join(f.root, 'original'),
    vaultId: 'vault',
    identity: 'synthetic',
    storageDomain: 'payload',
    authority,
    keys,
    storageProfile: 'blocks-br4-v1' as const,
    schemaVersion: 2 as const,
  };
  const v = AnchoredVault.create(config, 4, { clock: { wall: () => 100, monotonic: () => 0 } });
  t.after(() => v.close());
  const scope = v.store.ensureScope({
    tenantId: 'synthetic',
    subjectId: 'subject',
    personaId: 'companion',
    relationshipId: 'test',
  });
  const source = v.store.acceptEvent(scope, {
    source: 'synthetic',
    eventKey: 'one',
    evidence: {
      speakerId: 'subject',
      speakerRole: 'subject',
      mode: 'self_report',
      selectedText: 'SYNTHETIC',
      occurredAt: null,
    },
  });
  v.store.revoke(scope, source);
  v.claim('unknown', 'payload');
  v.reserve('unknown');
  v.terminal('unknown', 'unknown');
  v.close();
  const original = files(config.directory),
    request = { authority, vaultId: 'vault', keys, maxCalls: 4 },
    before = AnchoredVault.inspectCapacity(request);
  const compact = join(f.root, 'compact');
  AnchoredVault.compact({ ...request, targetDirectory: compact, storageDomain: 'payload', operationId: 'compact' });
  const live = AnchoredVault.open({ ...config, directory: compact }, 4, {
    clock: { wall: () => 100, monotonic: () => 0 },
  });
  t.after(() => live.close());
  const backup = join(f.root, 'backup');
  live.exportBackup(backup);
  live.close();
  const newStorageDEK = randomBytes(32),
    target = join(f.root, 'rekey');
  AnchoredVault.rekeyBackup({
    authority,
    backupDirectory: backup,
    targetDirectory: target,
    storageDomain: 'payload',
    keys,
    newStorageDEK,
    maxCalls: 4,
    operationId: 'rekey',
  });
  const currentRequest = { ...request, keys: { ...keys, keyEpoch: 2, storageDEK: newStorageDEK } },
    current = AnchoredVault.inspectCapacity(currentRequest);
  assert.equal(current.image!.revocationHighWater, 1);
  assert.equal(current.safety!.unknownCount, 1);
  assert.equal(current.safety!.reserved, 1);
  assert.deepEqual(current.safety, before.safety);
  assert.equal(current.generation!.otherGenerationsAndBackups, 'unmeasured');
  const roots = [config.directory, compact, backup],
    old = roots.map(files),
    head = authority.inspect('vault'),
    authorityFiles = files(authority.directory),
    currentFiles = files(target);
  const report = inspectRetainedRoots({ roots });
  assert.deepEqual(
    report.roots.map((r) => r.status),
    ['EOF', 'EOF', 'EOF'],
  );
  assert.equal(
    report.observedBytes,
    old.flat().reduce((n, file) => n + file.bytes.length, 0),
  );
  assert.deepEqual(roots.map(files), old);
  assert.deepEqual(files(config.directory), original);
  assert.deepEqual(files(target), currentFiles);
  assert.deepEqual(authority.inspect('vault'), head);
  assert.deepEqual(files(authority.directory), authorityFiles);
  assert.deepEqual(AnchoredVault.inspectCapacity(currentRequest), current);
  assert.throws(() => AnchoredVault.open(config, 4), /ANCHOR_FENCED|ANCHOR_IDENTITY/);
});

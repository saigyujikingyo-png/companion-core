import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnchoredVault } from '../src/anchored-vault.ts';
import { LocalSqliteAuthority } from '../src/local-sqlite-authority.ts';
import { generateKeySet } from '../src/anchored-codec.ts';
import { COLD_SAFETY_PROFILE } from '../src/safety-format.ts';
import { configureSafetyRuntime } from '../src/safety-segment.ts';

test('real cold runtime capability and public archive/reopen/backup/restore round-trip', (t) => {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    configureSafetyRuntime(db);
    console.log(
      'IF10_COLD_RUNTIME',
      JSON.stringify({
        node: process.version,
        sqlite: db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS source').get(),
        temp: db.prepare('PRAGMA temp_store').get(),
        journal: db.prepare('PRAGMA journal_mode').get(),
        spill: db.prepare('PRAGMA cache_spill').get(),
        databases: db.prepare('PRAGMA database_list').all(),
      }),
    );
  } finally {
    db.close();
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'if10-runtime-'))),
    authority = LocalSqliteAuthority.create({
      directory: join(root, 'authority'),
      authorityId: 'a',
      custodyDomain: 'independent',
    }),
    keys = generateKeySet(),
    clock = { wall: () => 100, monotonic: () => 0 };
  t.after(() => authority.close());
  let config = {
      directory: join(root, 'initial'),
      vaultId: 'v',
      identity: 'synthetic',
      storageDomain: 'payload',
      storageProfile: COLD_SAFETY_PROFILE,
      authority,
      keys,
    },
    v = AnchoredVault.create(config, 4, { clock });
  t.after(() => v.close());
  v.claim('old', 'p');
  v.reserve('old');
  v.terminal('old', 'unknown');
  const request = (name: string) => ({
    authority,
    keys,
    vaultId: 'v',
    maxCalls: 4,
    targetDirectory: join(root, name),
    storageDomain: 'payload',
    operationId: name,
  });
  const a = AnchoredVault.archiveTerminalSafety(request('archive'));
  v.close();
  config = { ...config, directory: a.newHead.directory };
  v = AnchoredVault.open(config, 4, { clock });
  assert.throws(() => v.claim('old', 'p'), /INTERACTION_TERMINATED/);
  v.claim('new', 'p');
  v.reserve('new');
  const backup = join(root, 'backup');
  v.exportBackup(backup);
  AnchoredVault.verifyBackup({ authority, keys, maxCalls: 4, backupDirectory: backup });
  const restore = AnchoredVault.restoreBackup({ ...request('restore'), backupDirectory: backup });
  v.close();
  config = { ...config, directory: restore.newHead.directory };
  v = AnchoredVault.open(config, 4, { clock });
  assert.equal(v.reserved, 2);
  assert.equal(v.status.unknownRequests, 2);
  assert.equal(v.status.coldIngressCount, 1);
});

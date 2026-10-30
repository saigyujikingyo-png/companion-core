import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { OfflineStdioClient } from './fixtures/offline-stdio-client.ts';

const deadlines = { boot: 50, submit: 30, other: 30, exit: 30, cleanup: 30 };
function fake(autoClose = true) {
  let kills = 0;
  const emitter = new EventEmitter(),
    stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const close = (code: number | null = 0, signal: string | null = null) => emitter.emit('close', code, signal);
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill() {
      kills++;
      if (autoClose) queueMicrotask(() => close(null, 'SIGTERM'));
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  const requests: Array<{ id: string; command: string }> = [];
  stdin.on('data', (chunk) => requests.push(JSON.parse(chunk.toString('utf8'))));
  return {
    child,
    stdin,
    stdout,
    stderr,
    requests,
    close,
    kills: () => kills,
    reply: (id: string, result: unknown = {}) => stdout.write(JSON.stringify({ id, ok: true, result }) + '\n'),
  };
}

test('offline client settles a reply once and rejects sends after a clean stop', async () => {
  const f = fake(),
    client = new OfflineStdioClient(f.child, deadlines),
    request = client.send('status');
  f.reply(f.requests[0]!.id, { status: 'ok' });
  assert.equal((await request).ok, true);
  f.reply(f.requests[0]!.id);
  assert.equal(client.pendingCount, 0);
  assert.equal(client.diagnostics.filter((row) => row.event === 'reply').length, 1);
  const stopped = client.stop();
  f.reply(f.requests[1]!.id, { status: 'closed' });
  f.close();
  await stopped;
  await assert.rejects(client.send('status'), /OFFLINE_CLIENT_TERMINAL/);
  assert.equal(f.kills(), 0);
});

test('no response times out, clears all pending work, kills once, and a late reply cannot revive the client', async () => {
  const f = fake(),
    client = new OfflineStdioClient(f.child, deadlines);
  const one = client.send('submit'),
    two = client.send('status');
  const settled = Promise.allSettled([one, two]);
  const results = await settled;
  assert.ok(
    results.every((result) => result.status === 'rejected' && /OFFLINE_COMMAND_TIMEOUT/.test(result.reason.message)),
  );
  assert.equal(client.pendingCount, 0);
  assert.equal(f.kills(), 1);
  f.reply(f.requests[0]!.id, { text: 'SYNTHETIC_PRIVATE_BODY' });
  await assert.rejects(client.send('status'), /OFFLINE_CLIENT_TERMINAL/);
  await client.force();
  assert.equal(f.kills(), 1);
  assert.doesNotMatch(JSON.stringify(client.diagnostics), /SYNTHETIC_PRIVATE_BODY/);
  assert.ok(client.diagnostics.some((row) => row.event === 'discarded-output-after-failure'));
});

test('child close rejects pending RPCs immediately and does not wait for their watchdog', async () => {
  const f = fake(),
    client = new OfflineStdioClient(f.child, deadlines),
    pending = client.send('boot');
  f.close(7);
  await assert.rejects(pending, /OFFLINE_CHILD_CLOSED/);
  assert.equal(client.pendingCount, 0);
  assert.equal(f.kills(), 0);
  await client.force();
});

for (const event of ['child', 'stdin', 'stdout'] as const)
  test(`${event} errors terminate pending work without logging exception text`, async () => {
    const f = fake(),
      client = new OfflineStdioClient(f.child, deadlines),
      pending = client.send('status');
    (event === 'child' ? f.child : event === 'stdin' ? f.stdin : f.stdout).emit(
      'error',
      new Error('SYNTHETIC_PRIVATE_ERROR'),
    );
    await assert.rejects(pending, /OFFLINE_(CHILD|STDIN|STDOUT)_ERROR/);
    assert.equal(client.pendingCount, 0);
    await client.force();
    assert.doesNotMatch(JSON.stringify(client.diagnostics), /SYNTHETIC_PRIVATE_ERROR/);
  });

for (const malformed of ['{"SYNTHETIC_PRIVATE_BODY":\n', '[]\n', '{"id":"bad","ok":"true"}\n'])
  test('malformed output is a bounded terminal parse failure', async () => {
    const f = fake(),
      client = new OfflineStdioClient(f.child, deadlines),
      pending = client.send('status');
    f.stdout.write(malformed);
    await assert.rejects(pending, /OFFLINE_INVALID_FRAME/);
    assert.equal(client.pendingCount, 0);
    await client.force();
    assert.doesNotMatch(JSON.stringify(client.diagnostics), /SYNTHETIC_PRIVATE_BODY/);
  });

test('a child that never closes has separately bounded exit and cleanup failures', async () => {
  const f = fake(false),
    client = new OfflineStdioClient(f.child, deadlines),
    stopping = client.stop();
  f.reply(f.requests[0]!.id, { status: 'closed' });
  await assert.rejects(stopping, /OFFLINE_EXIT_TIMEOUT/);
  assert.equal(f.kills(), 1);
  await assert.rejects(client.force(), /OFFLINE_CLEANUP_TIMEOUT/);
  assert.equal(client.pendingCount, 0);
  f.close(null, 'SIGTERM');
});

test('partial or oversized output cannot be accepted as a graceful stop', async () => {
  const f = fake(),
    client = new OfflineStdioClient(f.child, deadlines),
    stopping = client.stop();
  f.reply(f.requests[0]!.id, { status: 'closed' });
  f.stdout.write('{');
  f.close();
  await assert.rejects(stopping, /OFFLINE_TRUNCATED_OUTPUT/);
  const g = fake(),
    other = new OfflineStdioClient(g.child, deadlines),
    pending = other.send('status');
  g.stdout.write('x'.repeat(262_145));
  await assert.rejects(pending, /OFFLINE_OUTPUT_LIMIT/);
  await other.force();
});

test('partial frames and split multibyte UTF-8 preserve the exact response text', async () => {
  const f = fake(),
    client = new OfflineStdioClient(f.child, deadlines),
    pending = client.send('status');
  const text = 'SYNTHETIC 中文🙂',
    line = Buffer.from(JSON.stringify({ id: f.requests[0]!.id, ok: true, result: { text } }) + '\n');
  const chinese = line.indexOf(Buffer.from('中')),
    emoji = line.indexOf(Buffer.from('🙂'));
  for (const [start, end] of [
    [0, chinese + 1],
    [chinese + 1, emoji + 2],
    [emoji + 2, line.length - 1],
    [line.length - 1, line.length],
  ])
    f.stdout.write(line.subarray(start, end));
  assert.equal((await pending).result.text, text);
  assert.equal(client.pendingCount, 0);
  await client.force();
});

for (const mode of ['throw', 'callback'] as const)
  test(`stdin write ${mode} failure settles all pending RPCs and has no raw error diagnostics`, async () => {
    const f = fake(),
      client = new OfflineStdioClient(f.child, deadlines),
      one = client.send('status');
    if (mode === 'throw')
      f.stdin.write = (() => {
        throw Error('SYNTHETIC_PRIVATE_WRITE');
      }) as typeof f.stdin.write;
    else
      f.stdin.write = ((_chunk: unknown, callback: (error: Error) => void) => {
        callback(Error('SYNTHETIC_PRIVATE_WRITE'));
        return true;
      }) as typeof f.stdin.write;
    const two = client.send('submit'),
      results = await Promise.allSettled([one, two]);
    assert.ok(
      results.every((result) => result.status === 'rejected' && result.reason.message === 'OFFLINE_WRITE_ERROR'),
    );
    assert.equal(client.pendingCount, 0);
    await client.force();
    assert.equal(f.kills(), 1);
    assert.doesNotMatch(JSON.stringify(client.diagnostics), /SYNTHETIC_PRIVATE_WRITE/);
  });

test('concurrent repeated force settles pending work before waiting for close and never kills twice', async () => {
  const f = fake(false),
    client = new OfflineStdioClient(f.child, deadlines),
    pending = client.send('submit');
  const rejection = assert.rejects(pending, /OFFLINE_FORCED_CLEANUP/),
    first = client.force(),
    second = client.force();
  assert.equal(client.pendingCount, 0);
  assert.equal(f.kills(), 1);
  f.close(null, 'SIGTERM');
  await Promise.all([rejection, first, second]);
  await client.force();
  assert.equal(f.kills(), 1);
  await assert.rejects(client.send('status'), /OFFLINE_CLIENT_TERMINAL/);
});

test('cleanup uncertainty is recorded separately from the original command timeout', async () => {
  const f = fake(false),
    client = new OfflineStdioClient(f.child, deadlines);
  await assert.rejects(client.send('submit'), /OFFLINE_COMMAND_TIMEOUT:submit/);
  await assert.rejects(client.force(), /OFFLINE_CLEANUP_TIMEOUT/);
  assert.ok(client.diagnostics.some((row) => row.event === 'OFFLINE_COMMAND_TIMEOUT:submit'));
  assert.ok(client.diagnostics.some((row) => row.event === 'OFFLINE_CLEANUP_TIMEOUT'));
  assert.equal(client.pendingCount, 0);
  assert.equal(f.kills(), 1);
  f.close(null, 'SIGTERM');
});

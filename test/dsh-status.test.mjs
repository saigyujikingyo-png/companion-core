import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { renderStatusClient } from '../integrations/dsh-session-status/build.mjs';

const sid = 'cc3b37e9-4c26-400e-ace0-7995a9785b76';
// Fixtures follow installed rc.3 api-remotes/client.js1211-1233; they are not host calls.
const catalog = { ok: true, value: [{ name: 'companion-status', description: 'Report Companion state' }] };
const success = {
  ok: true,
  value: {
    commandId: 'synthetic-command-7',
    result: { kind: 'success', text: 'Companion: baseline; paused=true; available=false; calls=0/32.' },
  },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function setup(list = async () => catalog, execute = async () => success) {
  let entry, module;
  const calls = [],
    instances = [],
    timers = new Map(),
    effects = [];
  let timerId = 0,
    clock = 0;
  let current;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const x = current,
        i = x.index++;
      if (!(i in x.values)) x.values[i] = initial;
      return [
        x.values[i],
        (v) => {
          x.writes++;
          x.values[i] = v;
        },
      ];
    },
    useRef(initial) {
      const x = current,
        i = x.index++;
      return (x.values[i] ??= { current: initial });
    },
    useEffect(fn) {
      const x = current,
        i = x.index++;
      if (!(i in x.values)) x.values[i] = fn();
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const x = current,
        i = x.index++;
      if (!(i in x.values))
        x.values[i] = subscribe(() => {
          x.notices++;
        });
      return getSnapshot();
    },
  };
  vm.runInNewContext(await renderStatusClient(sid), {
    performance: { now: () => clock },
    setTimeout: (fn, ms) => {
      assert.ok(ms >= 0 && ms <= 10000);
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    window: {
      __ModuleLoader__: {
        load: (d) => {
          module = d.factory((name) => {
            assert.equal(name, 'react');
            return react;
          });
        },
      },
    },
  });
  const ctx = {
    effect: (fn) => effects.push(fn()),
    slots: {
      inject: (name, fn) => fn(),
      register: (definition, component) => {
        entry = { definition, component };
      },
    },
    remote: {
      commands: {
        list: async (target) => {
          calls.push(['list', target]);
          return list(target);
        },
        execute: async (...args) => {
          calls.push(['execute', ...args]);
          return execute(...args);
        },
      },
    },
  };
  module.apply(ctx);
  const instance = () => {
    const x = {
      index: 0,
      values: [],
      writes: 0,
      notices: 0,
      render() {
        current = x;
        x.index = 0;
        return entry.component({ sessionId: 'other-row' });
      },
      unmount() {
        for (const v of x.values) if (typeof v === 'function') v();
      },
    };
    instances.push(x);
    x.render();
    return x;
  };
  return {
    entry,
    module,
    ctx,
    calls,
    instance,
    timers,
    advance(ms) {
      clock += ms;
    },
    expire() {
      clock += 10000;
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    dispose() {
      for (const fn of effects) fn();
    },
  };
}
function button(x) {
  return x.render().children[0];
}
function click(x, trusted = true) {
  const e = {
    nativeEvent: { isTrusted: trusted },
    prevented: 0,
    stopped: 0,
    preventDefault() {
      this.prevented++;
    },
    stopPropagation() {
      this.stopped++;
    },
  };
  button(x).props.onClick(e);
  return e;
}
function text(x) {
  const walk = (v) =>
    v === null || v === undefined
      ? ''
      : typeof v === 'string'
        ? v
        : Array.isArray(v)
          ? v.map(walk).join('\n')
          : walk(v.children);
  return walk(x.render());
}

test('status client source matches actual Opus receipt and only appends list entry', async () => {
  const code = await readFile(
    new URL('../integrations/dsh-session-status/src/client.opus.js', import.meta.url),
    'utf8',
  );
  assert.equal(
    createHash('sha256').update(code.replace(/\r\n/g, '\n')).digest('hex'),
    '34a9523bff9b300b106f9d8642821db23fad70e6eaefa74ec95eb80cd3ee67c0',
  );
  const h = await setup();
  assert.equal(h.entry.definition.name, 'sidebar.workspaces.session.menu.item');
  assert.deepEqual([...h.module.inject], ['slots', 'remote', 'remote.commands']);
  h.instance();
  assert.equal(h.calls.length, 0);
});
test('untrusted click never calls remote', async () => {
  const h = await setup(),
    x = h.instance();
  click(x, false);
  await settle();
  assert.equal(h.calls.length, 0);
});
test('trusted status uses exact owned target and displays actual settlement as text', async () => {
  const h = await setup(),
    x = h.instance(),
    e = click(x);
  await settle();
  assert.equal(e.prevented, 1);
  assert.equal(e.stopped, 1);
  assert.equal(h.calls[0][0], 'list');
  assert.equal(h.calls[0][1], sid);
  assert.equal(h.calls[1][0], 'execute');
  assert.equal(h.calls[1][1], sid);
  assert.equal(h.calls[1][2], '/companion-status');
  assert.equal(h.calls[1][3].length, 0);
  assert.ok(text(x).includes(success.value.result.text));
  assert.ok(text(x).includes('targetSID: ' + sid));
  assert.ok(text(x).includes('commandId: synthetic-command-7'));
});
test('unknown catalog does not execute or submit fallback', async () => {
  const h = await setup(async () => ({ ok: true, value: [{ name: 'other-command', description: 'unrelated' }] })),
    x = h.instance();
  click(x);
  await settle();
  assert.equal(h.calls.length, 1);
  assert.ok(text(x).includes('控制不可用'));
});
test('schema-valid unmatched or handler error replies cannot be shown as success', async () => {
  for (const value of [
    { ok: false, error: { code: 'unavailable', message: 'not displayed', details: {} } },
    { ok: true, value: undefined },
    { ok: true, value: { commandId: 'x', result: { kind: 'error', text: 'not displayed' } } },
  ]) {
    const h = await setup(undefined, async () => value),
      x = h.instance();
    click(x);
    await settle();
    assert.ok(text(x).includes('控制不可用'));
    assert.ok(!text(x).includes('not displayed'));
  }
});
test('malformed replies and oversized text fail closed', async () => {
  for (const value of [
    { ok: true, value: {} },
    { ok: true, value: { commandId: 3, result: { kind: 'success', text: 'bad' } } },
    { ok: true, value: { commandId: 'x', result: { kind: 'success', text: 'x'.repeat(1025) } } },
  ]) {
    const h = await setup(undefined, async () => value),
      x = h.instance();
    click(x);
    await settle();
    assert.ok(text(x).includes('控制不可用'));
  }
});
test('list rejection stays fixed failure without execute or error text', async () => {
  const h = await setup(async () => {
      throw new Error('private diagnostic must not display');
    }),
    x = h.instance();
  click(x);
  await settle();
  assert.equal(h.calls.length, 1);
  assert.ok(text(x).includes('控制不可用'));
  assert.ok(!text(x).includes('private diagnostic'));
});
test('one shared synchronous lock blocks double clicks and other menu instances', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(async () => {
      await gate;
      return catalog;
    }),
    x = h.instance(),
    y = h.instance();
  click(x);
  click(x);
  click(y);
  await settle();
  assert.equal(h.calls.length, 1);
  release();
  await settle();
  assert.equal(h.calls.length, 2);
  click(y);
  await settle();
  assert.equal(h.calls.length, 4);
});
test('unmount while pending never writes late component state', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(async () => {
      await gate;
      return catalog;
    }),
    x = h.instance();
  click(x);
  await settle();
  const before = x.writes;
  x.unmount();
  assert.equal(h.timers.size, 0);
  release();
  await settle();
  assert.equal(x.writes, before);
  assert.equal(h.calls.filter((x) => x[0] === 'execute').length, 0);
});
test('list timeout ends local waiting, keeps raw lock visible and suppresses late execute', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(async () => {
      await gate;
      return catalog;
    }),
    x = h.instance();
  click(x);
  await settle();
  h.expire();
  assert.ok(text(x).includes('查询超时，结果未知'));
  const y = h.instance();
  assert.equal(button(y).props.disabled, true);
  assert.ok(text(y).includes('结果未知'));
  click(y);
  assert.equal(h.calls.length, 1);
  release();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(button(y).props.disabled, false);
  click(y);
  await settle();
  assert.equal(h.calls.length, 3);
});
test('execute timeout never sends remote cancellation or accepts a late success', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(undefined, async (...args) => {
      assert.equal(args.length, 3);
      await gate;
      return success;
    }),
    x = h.instance();
  click(x);
  await settle();
  h.expire();
  assert.ok(text(x).includes('查询超时，结果未知'));
  const count = h.calls.length;
  click(x);
  assert.equal(h.calls.length, count);
  release();
  await settle();
  assert.ok(!text(x).includes('commandId:'));
  assert.equal(button(x).props.disabled, false);
});
test('unrelated instance unmount cannot cancel operation; plugin dispose suppresses late execute', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(async () => {
      await gate;
      return catalog;
    }),
    x = h.instance(),
    y = h.instance();
  click(x);
  await settle();
  y.unmount();
  assert.equal(button(x).props.disabled, true);
  h.dispose();
  assert.equal(h.timers.size, 0);
  release();
  await settle();
  assert.equal(h.calls.filter((x) => x[0] === 'execute').length, 0);
  click(x);
  await settle();
  assert.equal(h.calls.length, 1);
});
test('completion clears deadline and stale expired timer cannot invalidate newer operation', async () => {
  const h = await setup(),
    x = h.instance();
  click(x);
  const old = [...h.timers.values()][0];
  await settle();
  assert.equal(h.timers.size, 0);
  assert.ok(text(x).includes('commandId:'));
  click(x);
  old();
  await settle();
  assert.ok(text(x).includes('commandId:'));
  assert.equal(h.calls.length, 4);
});
test('absolute clock expiry without timer dispatch blocks late list execution', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(async () => {
      await gate;
      return catalog;
    }),
    x = h.instance();
  click(x);
  await settle();
  h.advance(10001);
  release();
  await settle();
  assert.equal(h.calls.filter((x) => x[0] === 'execute').length, 0);
  assert.ok(text(x).includes('查询超时，结果未知'));
  assert.equal(h.timers.size, 0);
});
test('exact absolute deadline rejects late execute result without firing timer', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(undefined, async () => {
      await gate;
      return success;
    }),
    x = h.instance();
  click(x);
  await settle();
  h.advance(10000);
  release();
  await settle();
  assert.ok(text(x).includes('查询超时，结果未知'));
  assert.ok(!text(x).includes('commandId:'));
  assert.equal(h.timers.size, 0);
});
test('absolute expiry before initial microtask starts no RPC', async () => {
  const h = await setup(),
    x = h.instance();
  click(x);
  h.advance(10001);
  await settle();
  assert.equal(h.calls.length, 0);
  assert.ok(text(x).includes('查询超时，结果未知'));
});
test('deadline is rechecked before publishing otherwise-valid final result', async () => {
  let h;
  const result = {
    kind: 'success',
    get text() {
      h.advance(10001);
      return 'must not publish this late text';
    },
  };
  h = await setup(undefined, async () => ({ ok: true, value: { commandId: 'late', result } }));
  const x = h.instance();
  click(x);
  await settle();
  assert.ok(text(x).includes('查询超时，结果未知'));
  assert.ok(!text(x).includes('must not publish'));
});
test('invalid target cannot build, and package requires official remote module', async () => {
  await assert.rejects(() => renderStatusClient('not-an-owned-session'));
  const p = JSON.parse(
    await readFile(new URL('../integrations/dsh-session-status/package.json', import.meta.url), 'utf8'),
  );
  assert.ok(p.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'));
});

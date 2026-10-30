import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderClient } from '../integrations/dsh-session-opener/build.mjs';

const owned = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
async function fixture() {
  let module, registration, Component;
  const opened = [],
    closed = [],
    requires = [];
  runInNewContext(await renderClient(owned), {
    window: {
      __ModuleLoader__: {
        load(value) {
          module = value;
        },
      },
    },
  });
  assert.equal(module.id, '@companion/dsh-session-opener');
  const exports = module.factory((name) => {
    requires.push(name);
    assert.equal(name, 'react');
    return { createElement: (type, props, ...children) => ({ type, props, children }) };
  });
  const ctx = {
    uiWorkspace: { openSession: (id) => opened.push(id) },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'sidebar.workspaces.session.menu.item');
        return callback();
      },
      register(options, component) {
        registration = options;
        Component = component;
        return () => {};
      },
    },
  };
  exports.apply(ctx);
  const props = {
    ...registration.inject(),
    sessionId: other,
    displayTitle: 'other row must not be used',
    useMenuOpenState: () => [true, (value) => closed.push(value)],
  };
  const element = Component(props);
  return { module, exports, registration, element, opened, closed, requires };
}

test('actual Opus source packages into the official lazy-CJS baseline without automatic navigation', async () => {
  const f = await fixture();
  assert.deepEqual([...f.exports.inject], ['slots', 'uiWorkspace']);
  assert.deepEqual(f.requires, ['react']);
  assert.equal(f.element.type, 'button');
  assert.equal(f.element.props.role, 'menuitem');
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.closed, []);
});
test('trusted user menu click opens only the compiled owned SID, ignoring menu row identity', async () => {
  const f = await fixture();
  f.element.props.onClick({ nativeEvent: { isTrusted: true } });
  assert.deepEqual(f.opened, [owned]);
  assert.deepEqual(f.closed, [false]);
  assert.notEqual(f.opened[0], other);
});
test('programmatic/untrusted clicks cannot navigate', async () => {
  const f = await fixture();
  f.element.props.onClick({ nativeEvent: { isTrusted: false } });
  f.element.props.onClick({});
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.closed, []);
});
test('opener appends a list action and never occupies shell.bottom or registers a session input path', async () => {
  const f = await fixture();
  assert.equal(f.registration.name, 'sidebar.workspaces.session.menu.item');
  assert.equal(f.registration.id, 'companion.open-core-session');
  assert.equal(f.registration.order, 500);
  assert.deepEqual(Object.keys(f.registration).sort(), ['id', 'inject', 'name', 'order']);
});
test('invalid target data is rejected before any browser code is emitted', async () => {
  for (const id of ['', other + '/../../x', 'dsh://open', 'not-a-session'])
    await assert.rejects(renderClient(id), /INVALID_OWNED_SESSION_ID/);
});

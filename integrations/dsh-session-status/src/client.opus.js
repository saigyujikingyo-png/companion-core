import { createElement as h, useState, useRef, useEffect, useSyncExternalStore } from 'react';

export const inject = ['slots', 'remote', 'remote.commands'];

const SLOT = 'sidebar.workspaces.session.menu.item';
const ITEM_ID = 'companion.session-status';
const LABEL = 'Companion Core 状态';
const COMMAND_NAME = 'companion-status';
const COMMAND_INVOCATION = '/companion-status';
const UNAVAILABLE = '控制不可用';
const TIMED_OUT = '查询超时，结果未知';
const UNSETTLED = '查询未结束，结果未知';
const DEADLINE_MS = 10000;
const MAX_TEXT = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const now = () => performance.now();

export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config.sessionId : undefined;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return;
  const SID = raw;

  // Shared store across all instances of this menu item.
  // phase: 'idle' | 'pending' (live owned op) | 'unknown' (invalidated, raw still unsettled)
  let snap = { phase: 'idle' };
  let current = null; // the single raw operation holding the lock
  let seq = 0;
  let disposed = false;
  const listeners = new Set();

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const getSnapshot = () => snap;
  function setPhase(phase) {
    if (snap.phase === phase) return;
    snap = { phase };
    for (const fn of Array.from(listeners)) fn();
  }

  function clearTimer(op) {
    if (op.timer !== null) {
      clearTimeout(op.timer);
      op.timer = null;
    }
  }

  // Ends local waiting only. Never cancels or signals the remote RPC.
  function invalidate(op, reason) {
    if (!op.live) return;
    op.live = false;
    clearTimer(op);
    const cb = op.onResult;
    op.onResult = null;
    if (current === op) setPhase('unknown');
    if (reason === 'timeout' && cb) cb({ kind: 'timeout' });
  }

  // Synchronous validity gate. The monotonic clock, not the timer, is the source of truth.
  function valid(op) {
    if (!op.live) return false;
    if (disposed || current !== op) {
      invalidate(op, 'dispose');
      return false;
    }
    if (now() >= op.deadline) {
      invalidate(op, 'timeout');
      return false;
    }
    return true;
  }

  // Wakes local UI at the fixed deadline; re-arms only remaining time if it fires early.
  function arm(op) {
    const remaining = op.deadline - now();
    op.timer = setTimeout(() => {
      op.timer = null;
      if (valid(op)) arm(op);
    }, Math.max(0, Math.ceil(remaining)));
  }

  async function run(op) {
    if (!valid(op)) return null; // unmounted/disposed/expired before start: no list
    const listed = await ctx.remote.commands.list(SID);
    if (!valid(op)) return null; // invalidated or expired: must not execute
    if (!listed || listed.ok !== true || !Array.isArray(listed.value)) return null;
    const found = listed.value.some(
      (c) => c && typeof c === 'object' && c.name === COMMAND_NAME
    );
    if (!found) return null;

    if (!valid(op)) return null; // immediately before execute
    const res = await ctx.remote.commands.execute(SID, COMMAND_INVOCATION, []);
    if (!valid(op)) return null; // late result discarded
    if (!res || res.ok !== true) return null;
    const value = res.value;
    if (!value || typeof value !== 'object' || typeof value.commandId !== 'string') return null;
    const result = value.result;
    if (!result || typeof result !== 'object' || result.kind !== 'success') return null;
    if (typeof result.text !== 'string' || result.text.length > MAX_TEXT) return null;
    return { commandId: value.commandId, text: result.text };
  }

  function start(onResult) {
    if (disposed || current) return null;
    const op = { id: ++seq, live: true, timer: null, onResult, deadline: now() + DEADLINE_MS };
    current = op;
    setPhase('pending');
    arm(op);

    Promise.resolve()
      .then(() => run(op))
      .then(
        (r) => (r ? { kind: 'ok', ...r } : { kind: 'unavailable' }),
        () => ({ kind: 'unavailable' })
      )
      .then((outcome) => {
        clearTimer(op);
        if (valid(op)) {
          op.live = false;
          const cb = op.onResult;
          op.onResult = null;
          if (cb) cb(outcome);
        }
        // Release the raw lock only when this exact raw operation settled.
        if (current === op) {
          current = null;
          setPhase('idle');
        }
      });
    return op;
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true;
      if (current) invalidate(current, 'dispose');
    });
  }

  function CompanionStatusItem() {
    const { phase } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [result, setResult] = useState(null);
    const ownedRef = useRef(null);

    useEffect(
      () => () => {
        const op = ownedRef.current;
        ownedRef.current = null;
        if (op) invalidate(op, 'unmount'); // only the owner invalidates its own op
      },
      []
    );

    const onClick = (event) => {
      if (!event || !event.nativeEvent || event.nativeEvent.isTrusted !== true) return;
      event.preventDefault();
      event.stopPropagation();
      if (current || disposed) return;
      let op = null;
      op = start((outcome) => {
        if (ownedRef.current !== op) return;
        ownedRef.current = null;
        setResult(outcome);
      });
      if (!op) return;
      ownedRef.current = op;
      setResult(null);
    };

    const lines = [];
    const sidLine = h('div', { key: 's' }, 'targetSID: ' + SID);
    if (phase === 'pending') {
      lines.push(h('div', { key: 'p' }, '…'));
    } else if (result && result.kind === 'ok') {
      lines.push(h('div', { key: 't', style: { whiteSpace: 'pre-wrap' } }, result.text));
      lines.push(sidLine);
      lines.push(h('div', { key: 'c' }, 'commandId: ' + result.commandId));
    } else if (result && result.kind === 'timeout') {
      lines.push(h('div', { key: 'o' }, TIMED_OUT));
      lines.push(sidLine);
    } else if (result && result.kind === 'unavailable') {
      lines.push(h('div', { key: 'u' }, UNAVAILABLE));
      lines.push(sidLine);
    } else if (phase === 'unknown') {
      lines.push(h('div', { key: 'k' }, UNSETTLED));
      lines.push(sidLine);
    }

    const busy = phase !== 'idle';
    return h(
      'div',
      { role: 'none' },
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: busy,
          'aria-busy': busy ? 'true' : 'false',
          onClick,
        },
        LABEL
      ),
      lines.length ? h('div', { role: 'status' }, lines) : null
    );
  }

  ctx.slots.inject(SLOT, () =>
    ctx.slots.register(
      {
        name: SLOT,
        id: ITEM_ID,
        order: 501,
        inject: () => ({}),
      },
      CompanionStatusItem
    )
  );
}

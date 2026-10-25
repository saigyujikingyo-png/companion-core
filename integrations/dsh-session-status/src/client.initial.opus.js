import { createElement as h, useState, useRef, useEffect } from 'react';

export const inject = ['slots', 'remote', 'remote.commands'];

const SLOT = 'sidebar.workspaces.session.menu.item';
const ITEM_ID = 'companion.session-status';
const LABEL = 'Companion Core 状态';
const COMMAND_NAME = 'companion-status';
const COMMAND_INVOCATION = '/companion-status';
const UNAVAILABLE = '控制不可用';
const MAX_TEXT = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config.sessionId : undefined;
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return;
  const SID = raw;

  // Shared synchronous lock across all rendered instances of this item.
  let busy = false;

  async function queryStatus() {
    const listed = await ctx.remote.commands.list(SID);
    if (!listed || listed.ok !== true || !Array.isArray(listed.value)) return null;
    const found = listed.value.some(
      (c) => c && typeof c === 'object' && c.name === COMMAND_NAME
    );
    if (!found) return null;

    const res = await ctx.remote.commands.execute(SID, COMMAND_INVOCATION, []);
    if (!res || res.ok !== true) return null;
    const value = res.value;
    if (!value || typeof value !== 'object' || typeof value.commandId !== 'string') return null;
    const result = value.result;
    if (!result || typeof result !== 'object' || result.kind !== 'success') return null;
    if (typeof result.text !== 'string' || result.text.length > MAX_TEXT) return null;
    return { commandId: value.commandId, text: result.text };
  }

  function CompanionStatusItem() {
    const [pending, setPending] = useState(false);
    const [status, setStatus] = useState(null);
    const mountedRef = useRef(true);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    const onClick = (event) => {
      if (!event || !event.nativeEvent || event.nativeEvent.isTrusted !== true) return;
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      busy = true;
      setPending(true);
      setStatus(null);

      let outcome = null;
      queryStatus()
        .then(
          (r) => {
            outcome = r;
          },
          () => {
            outcome = null;
          }
        )
        .finally(() => {
          busy = false;
          if (!mountedRef.current) return;
          setPending(false);
          setStatus(outcome ? { ok: true, ...outcome } : { ok: false });
        });
    };

    const lines = [];
    if (pending) {
      lines.push(h('div', { key: 'p' }, '…'));
    } else if (status) {
      if (status.ok) {
        lines.push(h('div', { key: 't', style: { whiteSpace: 'pre-wrap' } }, status.text));
        lines.push(h('div', { key: 's' }, 'targetSID: ' + SID));
        lines.push(h('div', { key: 'c' }, 'commandId: ' + status.commandId));
      } else {
        lines.push(h('div', { key: 'u' }, UNAVAILABLE));
        lines.push(h('div', { key: 's' }, 'targetSID: ' + SID));
      }
    }

    return h(
      'div',
      { role: 'none' },
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: pending,
          'aria-busy': pending ? 'true' : 'false',
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

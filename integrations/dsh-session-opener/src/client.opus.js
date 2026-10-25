import { createElement as h } from 'react'

const SLOT = 'sidebar.workspaces.session.menu.item'
const LABEL = '打开 Companion Core 会话'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Row identity (sessionId/displayTitle) is deliberately ignored: the target is the configured Session.
function OpenCompanionRow({ useMenuOpenState, openCompanion }) {
  const [, setMenuOpen] = useMenuOpenState()
  return h('button', {
    type: 'button',
    role: 'menuitem',
    onClick: (event) => {
      if (event.nativeEvent?.isTrusted !== true) return
      setMenuOpen(false)
      openCompanion()
    },
  }, LABEL)
}

export const inject = ['slots', 'uiWorkspace']

export function apply(ctx, config) {
  const sessionId = config?.sessionId
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) {
    console.warn('[companion-session-opener] config.sessionId missing or not a UUID; nothing registered')
    return
  }
  ctx.slots.inject(SLOT, () => ctx.slots.register({
    name: SLOT,
    id: 'companion.open-core-session',
    order: 500,
    inject: () => ({ openCompanion: () => ctx.uiWorkspace.openSession(sessionId) }),
  }, OpenCompanionRow))
}

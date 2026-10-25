import type { Receipt } from './contracts.ts';
import type { HostBinding, HostMemoryService } from './host.ts';
import { publicError } from './host.ts';

/** Structural SDK surface only: this module does not import/start a host. */
export type DshEventContext = {
  on(name: 'session/event', callback: (session: { id: string }, event: unknown) => void): () => void;
};
export function mountDshHost(ctx: DshEventContext, service: HostMemoryService, binding: HostBinding,
  options: { sessionId: string; onReceipt: (receipt: Receipt) => void; onError: (error: ReturnType<typeof publicError>) => void }): () => void {
  let mounted = true;
  const off = ctx.on('session/event', (session, event) => {
    if (!mounted || session.id !== options.sessionId || typeof event !== 'object' || event === null) return;
    const e = event as Record<string, unknown>;
    if (e.type !== 'user/message' || e.surfaceOp !== 'append') return;
    // The adapter projects only documented fields out of the in-process event.
    // Promise boundary also contains malformed/cyclic in-process host payloads.
    void Promise.resolve().then(() => {
      if (!mounted) return;
      const raw = JSON.stringify({ version:1, operation:'extract_memory', event:{ sessionId:session.id,
        event:{ type:e.type, seq:e.seq, time:e.time, data:e.data, surfaceOp:e.surfaceOp } } });
      return service.extract(binding, raw);
    }).then(receipt => { if (mounted && receipt) options.onReceipt(receipt); },
      error => { if (mounted) options.onError(publicError(error)); }).catch(() => { /* host callback failure stays local */ });
  });
  return () => { if (!mounted) return; mounted = false; try { off(); } finally { service.unbind(binding); } };
}

export type CodexEventContext = {
  onNotification(callback: (notification: unknown) => void): () => void;
};
/** Mount only a trusted, explicitly selected thread. This does not authenticate a
 * remote peer, approve tools, or turn assistant output into a user's statement. */
export function mountCodexHost(ctx: CodexEventContext, service: HostMemoryService, binding: HostBinding,
  options: { threadId: string; onReceipt: (receipt: Receipt) => void; onError: (error: ReturnType<typeof publicError>) => void }): () => void {
  let mounted = true;
  const off = ctx.onNotification(notification => {
    if (!mounted || typeof notification !== 'object' || notification === null) return;
    const n = notification as Record<string, unknown>;
    if (n.method !== 'item/completed' || typeof n.params !== 'object' || n.params === null) return;
    const p = n.params as Record<string, unknown>;
    if (p.threadId !== options.threadId || typeof p.item !== 'object' || p.item === null) return;
    const item = p.item as Record<string, unknown>;
    if (item.type !== 'userMessage') return;
    void Promise.resolve().then(() => {
      if (!mounted) return;
      // Transport-only metadata is projected, not trusted as core identity.
      return service.extract(binding, JSON.stringify({ version:1, operation:'extract_memory', event:{
        method:'item/completed', params:{ threadId:p.threadId, turnId:p.turnId, completedAtMs:p.completedAtMs,
          item:{ type:item.type, id:item.id, content:item.content, ...(item.clientId === undefined ? {} : { clientId:item.clientId }) } }
      } }));
    }).then(receipt => { if (mounted && receipt) options.onReceipt(receipt); },
      error => { if (mounted) options.onError(publicError(error)); }).catch(() => { /* callback failures stay local */ });
  });
  return () => { if (!mounted) return; mounted = false; try { off(); } finally { service.unbind(binding); } };
}

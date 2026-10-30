import { fail, text } from './validation.ts';

export type CompanionPermissionSource = 'trusted-stdio' | 'dsh-command';
export type CompanionWindow = Readonly<{
  id: string;
  source: CompanionPermissionSource;
  generation: number;
  expiresAt: number;
}>;
/** Authorization only: no observed presence, model, memory, reward or timer. */
export class CompanionWindowPolicy {
  #window: CompanionWindow | null = null;
  #generation = 0;
  #seen = new Set<string>();
  grant(id: string, durationMs: number, source: CompanionPermissionSource, now: number): CompanionWindow {
    text(id, 128);
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs < 1000 ||
      durationMs > 300000 ||
      durationMs % 1000 !== 0 ||
      !['trusted-stdio', 'dsh-command'].includes(source) ||
      !Number.isFinite(now) ||
      now < 0
    )
      fail('INVALID_COMPANION_WINDOW');
    if (this.#seen.has(id)) fail('COMPANION_WINDOW_ID_REUSED');
    if (this.current(now)) fail('COMPANION_WINDOW_ACTIVE');
    if (this.#seen.size >= 128) fail('COMPANION_WINDOW_CAPACITY');
    this.#seen.add(id);
    this.#window = Object.freeze({ id, source, generation: ++this.#generation, expiresAt: now + durationMs });
    return this.#window;
  }
  clear(): void {
    this.#window = null;
    this.#generation++;
  }
  current(now: number): CompanionWindow | null {
    return this.#window && now < this.#window.expiresAt ? this.#window : null;
  }
  status(now: number) {
    const window = this.current(now);
    return {
      active: window !== null,
      source: window?.source ?? null,
      remainingMs: window ? Math.max(0, window.expiresAt - now) : 0,
      expiresAtMonotonicMs: window?.expiresAt ?? null,
      generation: window?.generation ?? null,
    };
  }
}

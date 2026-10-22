export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * Countdown based on an absolute deadline, so throttled or suspended tabs cannot gain time:
 * remaining time is always recomputed from the clock, never from accumulated ticks.
 */
export class RoundTimer {
  private deadline: number | null = null;
  private handle: unknown = null;
  private started = false;
  private finished = false;

  constructor(
    private readonly limitMs: number | null,
    private readonly onTick: (remainingMs: number | null) => void,
    private readonly onExpire: () => void,
    private readonly clock: Clock = systemClock,
    private readonly tickMs = 200,
  ) {}

  get isStarted(): boolean {
    return this.started;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Idempotent: calling start again never resets the deadline. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.limitMs === null) {
      this.onTick(null);
      return;
    }
    this.deadline = this.clock.now() + this.limitMs;
    this.handle = this.clock.setInterval(() => this.check(), this.tickMs);
    this.check();
  }

  remainingMs(): number | null {
    if (this.limitMs === null) return null;
    if (this.deadline === null) return this.limitMs;
    return Math.max(0, this.deadline - this.clock.now());
  }

  /** Re-evaluates the deadline; call on visibilitychange to react immediately after suspension. */
  check(): void {
    if (!this.started || this.finished || this.deadline === null) return;
    const remaining = this.remainingMs() ?? 0;
    this.onTick(remaining);
    if (remaining <= 0) {
      this.finish();
      this.onExpire();
    }
  }

  stop(): void {
    this.finish();
  }

  private finish(): void {
    this.finished = true;
    if (this.handle !== null) {
      this.clock.clearInterval(this.handle);
      this.handle = null;
    }
  }
}

export function formatClock(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

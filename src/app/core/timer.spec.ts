import { Clock, RoundTimer, formatClock } from './timer';

class FakeClock implements Clock {
  t = 1_000_000;
  private fns = new Map<number, () => void>();
  private nextHandle = 1;
  now = () => this.t;
  setInterval(fn: () => void): unknown {
    const h = this.nextHandle++;
    this.fns.set(h, fn);
    return h;
  }
  clearInterval(h: unknown): void {
    this.fns.delete(h as number);
  }
  get activeIntervals(): number {
    return this.fns.size;
  }
  /** Advances time and fires each interval callback once (like a throttled background tab). */
  advance(ms: number): void {
    this.t += ms;
    for (const fn of [...this.fns.values()]) fn();
  }
}

describe('RoundTimer', () => {
  let clock: FakeClock;
  let ticks: (number | null)[];
  let expired: number;
  const make = (limitMs: number | null) =>
    new RoundTimer(
      limitMs,
      (ms) => ticks.push(ms),
      () => expired++,
      clock,
      200,
    );

  beforeEach(() => {
    clock = new FakeClock();
    ticks = [];
    expired = 0;
  });

  it('counts down from the limit', () => {
    const t = make(30_000);
    expect(t.remainingMs()).toBe(30_000);
    t.start();
    clock.advance(1000);
    expect(t.remainingMs()).toBe(29_000);
    clock.advance(9000);
    expect(t.remainingMs()).toBe(20_000);
    expect(ticks.at(-1)).toBe(20_000);
    expect(expired).toBe(0);
  });

  it('expires exactly once at the deadline', () => {
    const t = make(5000);
    t.start();
    clock.advance(4999);
    expect(expired).toBe(0);
    clock.advance(1);
    expect(expired).toBe(1);
    clock.advance(1000);
    t.check();
    expect(expired).toBe(1);
    expect(clock.activeIntervals).toBe(0);
  });

  it('does not expire after being stopped (guess submitted)', () => {
    const t = make(5000);
    t.start();
    clock.advance(1000);
    t.stop();
    clock.advance(10_000);
    t.check();
    expect(expired).toBe(0);
  });

  it('does not restart when start() is called again', () => {
    const t = make(10_000);
    t.start();
    clock.advance(6000);
    t.start();
    expect(t.remainingMs()).toBe(4000);
  });

  it('gives no extra time after tab suspension', () => {
    const t = make(30_000);
    t.start();
    clock.advance(5000);
    // Suspended for a long time: no interval ticks fire until the tab wakes up.
    clock.t += 60_000;
    t.check();
    expect(t.remainingMs()).toBe(0);
    expect(expired).toBe(1);
  });

  it('supports unlimited time', () => {
    const t = make(null);
    t.start();
    expect(t.remainingMs()).toBeNull();
    clock.advance(10 * 60_000);
    t.check();
    expect(expired).toBe(0);
    expect(clock.activeIntervals).toBe(0);
    expect(ticks).toEqual([null]);
  });
});

describe('formatClock', () => {
  it('formats minutes and seconds', () => {
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(400)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
  });
});

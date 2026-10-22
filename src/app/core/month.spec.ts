import { isMonthKey, monthKeyFor, nextResetDate } from './month';

const PT = 'America/Los_Angeles';

describe('month helpers', () => {
  it('computes the month in the billing time zone', () => {
    // 2026-11-01 05:00 UTC is still Oct 31 in Los Angeles.
    expect(monthKeyFor(new Date('2026-11-01T05:00:00Z'), PT)).toBe('2026-10');
    expect(monthKeyFor(new Date('2026-11-01T08:00:00Z'), PT)).toBe('2026-11');
    expect(monthKeyFor(new Date('2026-11-01T05:00:00Z'), 'UTC')).toBe('2026-11');
  });

  it('finds the next reset instant (midnight Pacific)', () => {
    const reset = nextResetDate(new Date('2026-10-22T12:00:00Z'), PT);
    // Nov 1 2026 00:00 PDT = 07:00 UTC.
    expect(reset.toISOString()).toBe('2026-11-01T07:00:00.000Z');
    const dec = nextResetDate(new Date('2026-12-15T12:00:00Z'), PT);
    // Jan 1 2027 00:00 PST = 08:00 UTC.
    expect(dec.toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });

  it('validates month keys', () => {
    expect(isMonthKey('2026-10')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey(202610)).toBe(false);
  });
});

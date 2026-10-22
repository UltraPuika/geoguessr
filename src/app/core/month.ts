/** 'YYYY-MM' for the given instant in the given IANA time zone. */
export function monthKeyFor(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) throw new Error('Unable to compute month key');
  return `${year}-${month}`;
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** First instant at which `monthKeyFor` returns the next month in the given zone. */
export function nextResetDate(now: Date, timeZone: string): Date {
  const target = nextMonthKey(monthKeyFor(now, timeZone));
  const [y, m] = target.split('-').map(Number);
  // Zone offsets lie within UTC-14..UTC+14; search hourly then refine by minute.
  let t = Date.UTC(y, m - 1, 1, 0, 0) - 15 * 3600_000;
  while (monthKeyFor(new Date(t), timeZone) !== target) t += 3600_000;
  t -= 3600_000;
  while (monthKeyFor(new Date(t), timeZone) !== target) t += 60_000;
  return new Date(t);
}

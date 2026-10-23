import { isMonthKey } from './month';

export type ReservationKind = 'viewer-init' | 'location-change' | 'map-load';

export interface UsageMetaRecord {
  type: 'meta';
  /** 'meta' for Street View; prefixed (e.g. 'maps:meta') for other counters. */
  key: string;
  schema: 1;
  createdAt: string;
  /** Latest month that has been recorded; used to detect missing records and clock rollback. */
  latestMonthKey: string;
}

export interface PendingReservation {
  id: string;
  kind: ReservationKind;
  createdAt: string;
}

export interface UsageMonthRecord {
  type: 'month';
  key: string;
  /** Total units counted against the limit (pending + confirmed + failed + manual). */
  counted: number;
  confirmed: number;
  /** Loads that did not confirm success; kept counted because they may still be billed. */
  failed: number;
  /** Reservations released because no request could have reached Google. */
  released: number;
  manual: number;
  pending: PendingReservation[];
  updatedAt: string;
  checksum: string;
}

export type UsageState = 'ok' | 'corrupted' | 'clock-anomaly' | 'unavailable';
export type WarningLevel = 0 | 80 | 90 | 100;

export interface UsageStatus {
  state: UsageState;
  message: string | null;
  monthKey: string;
  counted: number;
  confirmed: number;
  failed: number;
  pending: number;
  limit: number;
  remaining: number;
  percent: number;
  warningLevel: WarningLevel;
  nextReset: Date;
  blocked: boolean;
}

export type ReserveOutcome =
  | { ok: true; reservation: Reservation; status: UsageStatus }
  | { ok: false; status: UsageStatus };

export interface Reservation {
  id: string;
  monthKey: string;
  kind: ReservationKind;
}

/** FNV-1a; detects accidental corruption, not deliberate tampering. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function checksumOf(r: Omit<UsageMonthRecord, 'checksum' | 'updatedAt' | 'type'>): string {
  const ids = r.pending.map((p) => p.id).join(',');
  return fnv1a(`${r.key}|${r.counted}|${r.confirmed}|${r.failed}|${r.released}|${r.manual}|${ids}`);
}

export function sealMonth(r: Omit<UsageMonthRecord, 'checksum' | 'type'>): UsageMonthRecord {
  return { ...r, type: 'month', checksum: checksumOf(r) };
}

export function emptyMonth(key: string, now: Date): UsageMonthRecord {
  return sealMonth({
    key,
    counted: 0,
    confirmed: 0,
    failed: 0,
    released: 0,
    manual: 0,
    pending: [],
    updatedAt: now.toISOString(),
  });
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function isValidMeta(v: unknown, expectedKey = 'meta'): v is UsageMetaRecord {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return m['type'] === 'meta' && m['key'] === expectedKey && m['schema'] === 1 && isMonthKey(m['latestMonthKey']);
}

export function isValidMonth(v: unknown, expectedKey: string): v is UsageMonthRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r['type'] !== 'month' || r['key'] !== expectedKey) return false;
  const counts = ['counted', 'confirmed', 'failed', 'released', 'manual'].map((k) => r[k]);
  if (!counts.every(isCount)) return false;
  if (!Array.isArray(r['pending'])) return false;
  const pending = r['pending'] as unknown[];
  if (!pending.every((p) => typeof p === 'object' && p !== null && typeof (p as PendingReservation).id === 'string')) {
    return false;
  }
  const rec = v as UsageMonthRecord;
  if (rec.counted < rec.confirmed + rec.failed + rec.manual + rec.pending.length) return false;
  return rec.checksum === checksumOf(rec);
}

export function warningLevelFor(counted: number, limit: number, thresholds: readonly number[]): WarningLevel {
  const ratio = limit > 0 ? counted / limit : 1;
  let level: WarningLevel = 0;
  for (const t of thresholds) {
    if (ratio >= t) level = Math.round(t * 100) as WarningLevel;
  }
  return level;
}

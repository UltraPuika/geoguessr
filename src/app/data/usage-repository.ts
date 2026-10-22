import { IDBPTransaction } from 'idb';
import { USAGE_CONFIG } from '../config/usage-config';
import { createId } from '../core/id';
import { monthKeyFor, nextResetDate } from '../core/month';
import {
  ReservationKind,
  Reservation,
  ReserveOutcome,
  UsageMetaRecord,
  UsageMonthRecord,
  UsageState,
  UsageStatus,
  emptyMonth,
  isValidMeta,
  isValidMonth,
  sealMonth,
  warningLevelFor,
} from '../core/usage-ledger';
import { AppDB, AppDatabase, describeStorageError } from './db';

export type DbProvider = () => Promise<AppDatabase>;

export interface UsageLimits {
  monthlyLimit: number;
  warningThresholds: readonly number[];
  billingTimeZone: string;
}

type LedgerTx = IDBPTransaction<AppDB, ('usage' | 'maps' | 'games')[], 'readwrite'>;

type LoadResult =
  | { kind: 'ok'; month: UsageMonthRecord }
  | { kind: 'corrupted' | 'clock-anomaly'; message: string; monthKey: string };

export type SettleOutcome = 'confirmed' | 'failed' | 'released';

/**
 * Monthly Street View usage ledger in IndexedDB.
 *
 * Every check-and-reserve runs inside a single readwrite transaction. IndexedDB serialises
 * overlapping readwrite transactions on the same store (also across tabs), so concurrent
 * reservations cannot oversubscribe the limit.
 */
export class UsageRepository {
  constructor(
    private readonly db: DbProvider,
    private readonly limits: UsageLimits = USAGE_CONFIG,
    private readonly newId: () => string = createId,
  ) {}

  async getStatus(now: Date = new Date()): Promise<UsageStatus> {
    try {
      const tx = await this.ledgerTx();
      const result = await this.load(tx, now);
      await tx.done;
      return this.toStatus(result, now);
    } catch (err) {
      return this.unavailable(now, err);
    }
  }

  async reserve(kind: ReservationKind, now: Date = new Date()): Promise<ReserveOutcome> {
    try {
      const tx = await this.ledgerTx();
      const result = await this.load(tx, now);
      if (result.kind !== 'ok') {
        await tx.done;
        return { ok: false, status: this.toStatus(result, now) };
      }
      const month = result.month;
      if (month.counted + 1 > this.limits.monthlyLimit) {
        await tx.done;
        return { ok: false, status: this.toStatus(result, now) };
      }
      const id = this.newId();
      const updated = sealMonth({
        ...month,
        counted: month.counted + 1,
        pending: [...month.pending, { id, kind, createdAt: now.toISOString() }],
        updatedAt: now.toISOString(),
      });
      await tx.objectStore('usage').put(updated);
      await tx.done;
      return {
        ok: true,
        reservation: { id, monthKey: month.key, kind },
        status: this.toStatus({ kind: 'ok', month: updated }, now),
      };
    } catch (err) {
      return { ok: false, status: this.unavailable(now, err) };
    }
  }

  /**
   * Resolves a pending reservation. Only 'released' gives the unit back, and only for
   * failures where no request could have reached Google (e.g. the API script never loaded).
   */
  async settle(reservation: Reservation, outcome: SettleOutcome, now: Date = new Date()): Promise<void> {
    const db = await this.db();
    const tx = db.transaction('usage', 'readwrite');
    const store = tx.objectStore('usage');
    const rec = await store.get(reservation.monthKey);
    if (!isValidMonth(rec, reservation.monthKey)) {
      await tx.done;
      return;
    }
    const idx = rec.pending.findIndex((p) => p.id === reservation.id);
    if (idx === -1) {
      await tx.done;
      return;
    }
    const pending = rec.pending.filter((_, i) => i !== idx);
    const updated = sealMonth({
      ...rec,
      pending,
      confirmed: rec.confirmed + (outcome === 'confirmed' ? 1 : 0),
      failed: rec.failed + (outcome === 'failed' ? 1 : 0),
      released: rec.released + (outcome === 'released' ? 1 : 0),
      counted: rec.counted - (outcome === 'released' ? 1 : 0),
      updatedAt: now.toISOString(),
    });
    await store.put(updated);
    await tx.done;
  }

  /** Increase-only adjustment, e.g. to match usage seen in the Google Cloud console. */
  async addManualUsage(units: number, now: Date = new Date()): Promise<UsageStatus> {
    if (!Number.isInteger(units) || units <= 0) throw new Error('Units must be a positive whole number.');
    const tx = await this.ledgerTx();
    const result = await this.load(tx, now);
    if (result.kind !== 'ok') {
      await tx.done;
      return this.toStatus(result, now);
    }
    const updated = sealMonth({
      ...result.month,
      counted: result.month.counted + units,
      manual: result.month.manual + units,
      updatedAt: now.toISOString(),
    });
    await tx.objectStore('usage').put(updated);
    await tx.done;
    return this.toStatus({ kind: 'ok', month: updated }, now);
  }

  /**
   * Rebuilds unreadable tracking data assuming the worst case: the current month is
   * marked as fully used, so Street View stays blocked until the next reset.
   */
  async repairConservatively(now: Date = new Date()): Promise<UsageStatus> {
    const key = monthKeyFor(now, this.limits.billingTimeZone);
    const tx = await this.ledgerTx();
    const store = tx.objectStore('usage');
    const existing = (await store.get(key)) as Partial<UsageMonthRecord> | undefined;
    const prevCount = typeof existing?.counted === 'number' && Number.isFinite(existing.counted) ? existing.counted : 0;
    const counted = Math.max(this.limits.monthlyLimit, Math.ceil(prevCount));
    const meta: UsageMetaRecord = {
      type: 'meta',
      key: 'meta',
      schema: 1,
      createdAt: now.toISOString(),
      latestMonthKey: key,
    };
    const month = sealMonth({
      key,
      counted,
      confirmed: 0,
      failed: 0,
      released: 0,
      manual: counted,
      pending: [],
      updatedAt: now.toISOString(),
    });
    await store.put(meta);
    await store.put(month);
    await tx.done;
    return this.toStatus({ kind: 'ok', month }, now);
  }

  async history(): Promise<UsageMonthRecord[]> {
    const db = await this.db();
    const all = await db.getAll('usage');
    return all
      .filter((r): r is UsageMonthRecord => r.type === 'month')
      .sort((a, b) => b.key.localeCompare(a.key));
  }

  private async ledgerTx(): Promise<LedgerTx> {
    const db = await this.db();
    return db.transaction(['usage', 'maps', 'games'], 'readwrite');
  }

  private async load(tx: LedgerTx, now: Date): Promise<LoadResult> {
    const key = monthKeyFor(now, this.limits.billingTimeZone);
    const store = tx.objectStore('usage');
    const meta = await store.get('meta');

    if (meta === undefined) {
      if ((await store.count()) > 0) {
        return { kind: 'corrupted', message: 'Usage tracking metadata is missing.', monthKey: key };
      }
      const otherData = (await tx.objectStore('maps').count()) + (await tx.objectStore('games').count());
      if (otherData > 0) {
        return {
          kind: 'corrupted',
          message: 'Usage records are missing although other app data exists.',
          monthKey: key,
        };
      }
      const newMeta: UsageMetaRecord = {
        type: 'meta',
        key: 'meta',
        schema: 1,
        createdAt: now.toISOString(),
        latestMonthKey: key,
      };
      const month = emptyMonth(key, now);
      await store.put(newMeta);
      await store.put(month);
      return { kind: 'ok', month };
    }

    if (!isValidMeta(meta)) {
      return { kind: 'corrupted', message: 'Usage tracking metadata is unreadable.', monthKey: key };
    }
    if (key < meta.latestMonthKey) {
      return {
        kind: 'clock-anomaly',
        message: `The device clock is earlier than the latest recorded usage month (${meta.latestMonthKey}).`,
        monthKey: key,
      };
    }

    const rec = await store.get(key);
    if (rec === undefined) {
      if (key === meta.latestMonthKey) {
        return { kind: 'corrupted', message: "This month's usage record is missing.", monthKey: key };
      }
      // A new calendar month: start a fresh record; earlier months are kept untouched.
      const month = emptyMonth(key, now);
      await store.put(month);
      await store.put({ ...meta, latestMonthKey: key });
      return { kind: 'ok', month };
    }
    if (!isValidMonth(rec, key)) {
      return { kind: 'corrupted', message: "This month's usage record failed its integrity check.", monthKey: key };
    }
    return { kind: 'ok', month: rec };
  }

  private toStatus(result: LoadResult, now: Date): UsageStatus {
    const limit = this.limits.monthlyLimit;
    const nextReset = nextResetDate(now, this.limits.billingTimeZone);
    if (result.kind !== 'ok') {
      return this.blockedStatus(result.kind, result.message, result.monthKey, nextReset);
    }
    const m = result.month;
    return {
      state: 'ok',
      message: null,
      monthKey: m.key,
      counted: m.counted,
      confirmed: m.confirmed,
      failed: m.failed,
      pending: m.pending.length,
      limit,
      remaining: Math.max(0, limit - m.counted),
      percent: limit > 0 ? Math.min(100, (m.counted / limit) * 100) : 100,
      warningLevel: warningLevelFor(m.counted, limit, this.limits.warningThresholds),
      nextReset,
      blocked: m.counted >= limit,
    };
  }

  private unavailable(now: Date, err: unknown): UsageStatus {
    return this.blockedStatus(
      'unavailable',
      `Usage tracking is unavailable: ${describeStorageError(err)}`,
      monthKeyFor(now, this.limits.billingTimeZone),
      nextResetDate(now, this.limits.billingTimeZone),
    );
  }

  private blockedStatus(state: UsageState, message: string, monthKey: string, nextReset: Date): UsageStatus {
    return {
      state,
      message,
      monthKey,
      counted: 0,
      confirmed: 0,
      failed: 0,
      pending: 0,
      limit: this.limits.monthlyLimit,
      remaining: 0,
      percent: 100,
      warningLevel: 100,
      nextReset,
      blocked: true,
    };
  }
}

import { dbHarness } from '../../testing/db-harness';
import { UsageMonthRecord } from '../core/usage-ledger';
import { MapRepository } from './map-repository';
import { UsageLimits, UsageRepository } from './usage-repository';

const limits = (monthlyLimit: number): UsageLimits => ({
  monthlyLimit,
  warningThresholds: [0.8, 0.9, 1],
  billingTimeZone: 'America/Los_Angeles',
});

const OCT = new Date('2026-10-15T12:00:00Z');
const OCT_LATE = new Date('2026-10-31T20:00:00Z');
const NOV = new Date('2026-11-02T12:00:00Z');

describe('UsageRepository (application accounting, not Google billing)', () => {
  it('persists the counter across restarts', async () => {
    const h = dbHarness();
    const repo = new UsageRepository(h.provider, limits(10));
    const r1 = await repo.reserve('viewer-init', OCT);
    expect(r1.ok).toBe(true);
    if (r1.ok) await repo.settle(r1.reservation, 'confirmed', OCT);
    await repo.reserve('location-change', OCT);
    await h.restart();

    const status = await new UsageRepository(h.provider, limits(10)).getStatus(OCT);
    expect(status).toMatchObject({ state: 'ok', counted: 2, confirmed: 1, pending: 1, remaining: 8 });
  });

  it('resets only when the calendar month changes, keeping old months', async () => {
    const h = dbHarness();
    const repo = new UsageRepository(h.provider, limits(10));
    await repo.reserve('viewer-init', OCT);
    await repo.reserve('viewer-init', OCT);
    expect((await repo.getStatus(OCT_LATE)).counted).toBe(2);

    const nov = await repo.getStatus(NOV);
    expect(nov).toMatchObject({ state: 'ok', monthKey: '2026-11', counted: 0 });
    const history = await repo.history();
    expect(history.find((m) => m.key === '2026-10')?.counted).toBe(2);
  });

  it('uses the Pacific billing month at the boundary', async () => {
    const repo = new UsageRepository(dbHarness().provider, limits(10));
    await repo.reserve('viewer-init', new Date('2026-10-20T00:00:00Z'));
    // 2026-11-01 05:00 UTC is still October in Pacific time: no reset yet.
    expect((await repo.getStatus(new Date('2026-11-01T05:00:00Z'))).counted).toBe(1);
  });

  it('blocks reservations once the limit is reached', async () => {
    const repo = new UsageRepository(dbHarness().provider, limits(3));
    for (let i = 0; i < 3; i++) expect((await repo.reserve('viewer-init', OCT)).ok).toBe(true);
    const out = await repo.reserve('viewer-init', OCT);
    expect(out.ok).toBe(false);
    expect(out.status).toMatchObject({ blocked: true, counted: 3, remaining: 0, warningLevel: 100 });
  });

  it('cannot be oversubscribed by concurrent reservations', async () => {
    const h = dbHarness();
    const a = new UsageRepository(h.provider, limits(5));
    const b = new UsageRepository(h.provider, limits(5));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).reserve('viewer-init', OCT)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect((await a.getStatus(OCT)).counted).toBe(5);
  });

  it('reports warning levels at 80, 90 and 100 percent', async () => {
    const repo = new UsageRepository(dbHarness().provider, limits(10));
    const levels: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await repo.reserve('viewer-init', OCT);
      levels.push(r.status.warningLevel);
    }
    expect(levels).toEqual([0, 0, 0, 0, 0, 0, 0, 80, 90, 100]);
  });

  it('keeps failed loads counted and only releases explicitly', async () => {
    const repo = new UsageRepository(dbHarness().provider, limits(10));
    const a = await repo.reserve('viewer-init', OCT);
    const b = await repo.reserve('viewer-init', OCT);
    if (!a.ok || !b.ok) throw new Error('unexpected');
    await repo.settle(a.reservation, 'failed', OCT);
    await repo.settle(b.reservation, 'released', OCT);
    await repo.settle(b.reservation, 'released', OCT); // idempotent
    expect(await repo.getStatus(OCT)).toMatchObject({ counted: 1, failed: 1, pending: 0 });
  });

  it('blocks when the current month record is missing', async () => {
    const h = dbHarness();
    const repo = new UsageRepository(h.provider, limits(10));
    await repo.reserve('viewer-init', OCT);
    const db = await h.provider();
    await db.delete('usage', '2026-10');
    const status = await repo.getStatus(OCT);
    expect(status).toMatchObject({ state: 'corrupted', blocked: true });
    expect((await repo.reserve('viewer-init', OCT)).ok).toBe(false);
  });

  it('blocks when the record has been tampered with or corrupted', async () => {
    const h = dbHarness();
    const repo = new UsageRepository(h.provider, limits(10));
    await repo.reserve('viewer-init', OCT);
    const db = await h.provider();
    const rec = (await db.get('usage', '2026-10')) as UsageMonthRecord;
    await db.put('usage', { ...rec, counted: 0 });
    expect((await repo.getStatus(OCT)).state).toBe('corrupted');
    await db.put('usage', { ...rec, counted: 'lots' } as never);
    expect((await repo.reserve('viewer-init', OCT)).ok).toBe(false);
  });

  it('blocks when the metadata is missing but other app data exists', async () => {
    const h = dbHarness();
    await new MapRepository(h.provider).createMap('existing');
    const status = await new UsageRepository(h.provider, limits(10)).getStatus(OCT);
    expect(status.state).toBe('corrupted');
  });

  it('blocks when the clock moves back before the latest recorded month', async () => {
    const repo = new UsageRepository(dbHarness().provider, limits(10));
    await repo.getStatus(NOV);
    expect((await repo.getStatus(OCT)).state).toBe('clock-anomaly');
  });

  it('repairs conservatively by treating the month as fully used', async () => {
    const h = dbHarness();
    const repo = new UsageRepository(h.provider, limits(10));
    await repo.reserve('viewer-init', OCT);
    await (await h.provider()).delete('usage', 'meta');
    expect((await repo.getStatus(OCT)).state).toBe('corrupted');
    const repaired = await repo.repairConservatively(OCT);
    expect(repaired).toMatchObject({ state: 'ok', counted: 10, blocked: true });
    expect((await repo.reserve('viewer-init', OCT)).ok).toBe(false);
    expect((await repo.getStatus(NOV)).blocked).toBe(false);
  });

  it('only allows increasing the counter manually', async () => {
    const repo = new UsageRepository(dbHarness().provider, limits(10));
    await repo.getStatus(OCT);
    expect((await repo.addManualUsage(4, OCT)).counted).toBe(4);
    await expect(repo.addManualUsage(-2, OCT)).rejects.toThrow();
  });

  it('keeps map management working after the hard stop', async () => {
    const h = dbHarness();
    const usage = new UsageRepository(h.provider, limits(1));
    await usage.reserve('viewer-init', OCT);
    expect((await usage.reserve('viewer-init', OCT)).ok).toBe(false);

    const maps = new MapRepository(h.provider);
    const m = await maps.createMap('After limit');
    const loc = await maps.addLocation(m.id, {
      lat: 1,
      lng: 2,
      name: '',
      notes: '',
      panoId: null,
      heading: 0,
      pitch: 0,
      zoom: 1,
      coverage: 'unknown',
      coverageCheckedAt: null,
    });
    await maps.updateLocation({ ...loc, name: 'edited' });
    const exported = await maps.exportMaps();
    expect(exported.maps[0].locations[0].name).toBe('edited');
    await maps.deleteMap(m.id);
    expect(await maps.listMaps()).toHaveLength(0);
    expect((await usage.getStatus(OCT)).state).toBe('ok');
  });
});

import { dbHarness } from '../../testing/db-harness';
import { MAP_LOAD_CONFIG } from '../config/usage-config';
import { MapRepository } from '../data/map-repository';
import { UsageRepository } from '../data/usage-repository';
import { MapFactory, ReusableMapLoader } from './reusable-map-loader';
import { UsageGate } from './street-view-controller';

const OCT = new Date('2026-10-15T12:00:00Z');

function counters(mapLimit = 3) {
  const h = dbHarness();
  const streetView = new UsageRepository(h.provider, {
    monthlyLimit: 10,
    warningThresholds: [1],
    billingTimeZone: 'America/Los_Angeles',
  });
  const maps = new UsageRepository(h.provider, { ...MAP_LOAD_CONFIG, monthlyLimit: mapLimit });
  const gate: UsageGate = { reserve: (k) => maps.reserve(k, OCT), settle: (r, o) => maps.settle(r, o, OCT) };
  return { h, streetView, maps, gate };
}

class FakeFactory implements MapFactory<{ id: number }> {
  created = 0;
  loaded = true;
  throwOnCreate = false;
  create() {
    if (this.throwOnCreate) throw new Error('no google');
    return { id: ++this.created };
  }
  async waitLoaded() {
    return this.loaded;
  }
}

describe('Google map-load counter', () => {
  it('is independent from the Street View counter', async () => {
    const { streetView, maps } = counters();
    await streetView.reserve('viewer-init', OCT);
    await maps.reserve('map-load', OCT);
    await maps.reserve('map-load', OCT);
    expect((await streetView.getStatus(OCT)).counted).toBe(1);
    expect((await maps.getStatus(OCT)).counted).toBe(2);
    expect((await streetView.history()).map((m) => m.key)).toEqual(['2026-10']);
    expect((await maps.history()).map((m) => m.key)).toEqual(['2026-10']);
  });

  it('starts cleanly for existing users who already have maps', async () => {
    const { h, streetView, maps } = counters();
    await streetView.getStatus(OCT);
    await new MapRepository(h.provider).createMap('existing');
    expect((await maps.getStatus(OCT)).state).toBe('ok');
    expect((await streetView.getStatus(OCT)).state).toBe('ok');
  });
});

describe('ReusableMapLoader', () => {
  it('reserves one unit for the first map and reuses it afterwards', async () => {
    const { maps, gate } = counters();
    const factory = new FakeFactory();
    const loader = new ReusableMapLoader(factory, gate);
    const a = await loader.acquire();
    const b = await loader.acquire();
    expect(a).toMatchObject({ kind: 'ok', consumedUnit: true });
    expect(b).toMatchObject({ kind: 'ok', consumedUnit: false });
    expect(factory.created).toBe(1);
    expect(await maps.getStatus(OCT)).toMatchObject({ counted: 1, confirmed: 1 });
  });

  it('does not create two maps for concurrent requests', async () => {
    const { maps, gate } = counters();
    const factory = new FakeFactory();
    const loader = new ReusableMapLoader(factory, gate);
    await Promise.all([loader.acquire(), loader.acquire(), loader.acquire()]);
    expect(factory.created).toBe(1);
    expect((await maps.getStatus(OCT)).counted).toBe(1);
  });

  it('refuses to create a map when the allowance is used up (caller falls back)', async () => {
    const { maps, gate } = counters(1);
    await maps.reserve('map-load', OCT);
    const factory = new FakeFactory();
    const r = await new ReusableMapLoader(factory, gate).acquire();
    expect(r.kind).toBe('blocked');
    expect(factory.created).toBe(0);
  });

  it('releases the unit if the map cannot be constructed', async () => {
    const { maps, gate } = counters();
    const factory = new FakeFactory();
    factory.throwOnCreate = true;
    const r = await new ReusableMapLoader(factory, gate).acquire();
    expect(r.kind).toBe('error');
    expect((await maps.getStatus(OCT)).counted).toBe(0);
  });

  it('keeps the unit counted when loading does not confirm', async () => {
    const { maps, gate } = counters();
    const factory = new FakeFactory();
    factory.loaded = false;
    await new ReusableMapLoader(factory, gate).acquire();
    expect(await maps.getStatus(OCT)).toMatchObject({ counted: 1, failed: 1 });
  });
});

import { dbHarness } from '../../testing/db-harness';
import { UsageRepository } from '../data/usage-repository';
import {
  ControllerOptions,
  FoundPanorama,
  PanoramaLike,
  Pov,
  StreetViewBackend,
  StreetViewController,
  UsageGate,
  ViewTarget,
  isKeyBlocked,
  panoramaOptionsFor,
  restrictionsFor,
} from './street-view-controller';

type Handler = () => void;

class FakePanorama implements PanoramaLike {
  options: google.maps.StreetViewPanoramaOptions;
  pano: string;
  pov: Pov;
  zoom: number;
  status = 'OK';
  nextStatus = 'OK';
  private handlers = new Map<string, Set<Handler>>();

  constructor(opts: google.maps.StreetViewPanoramaOptions) {
    this.options = { ...opts };
    this.pano = opts.pano ?? '';
    this.pov = { ...(opts.pov as Pov) };
    this.zoom = opts.zoom ?? 1;
    this.status = 'LOADING';
    queueMicrotask(() => this.load());
  }

  private load(): void {
    this.status = this.nextStatus;
    this.emit('status_changed');
  }
  setOptions(o: google.maps.StreetViewPanoramaOptions): void {
    Object.assign(this.options, o);
  }
  setPano(p: string): void {
    this.pano = p;
    this.status = 'LOADING';
    this.emit('pano_changed');
    queueMicrotask(() => this.load());
  }
  setPov(p: Pov): void {
    this.pov = { ...p };
    this.emit('pov_changed');
  }
  setZoom(z: number): void {
    this.zoom = z;
    this.emit('zoom_changed');
  }
  setVisible(): void {}
  getPano = () => this.pano;
  getPov = () => ({ ...this.pov });
  getZoom = () => this.zoom;
  getPosition = () => ({ lat: () => 1, lng: () => 2 });
  getStatus = () => this.status;
  addListener(event: string, h: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(h);
    return { remove: () => this.handlers.get(event)!.delete(h) };
  }
  emit(event: string): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h();
  }

  /** Simulates the user (or a built-in control) changing state, as the real viewer would. */
  userMove(pano: string): void {
    this.pano = pano;
    this.emit('pano_changed');
  }
  userPan(pov: Pov): void {
    this.pov = pov;
    this.emit('pov_changed');
  }
  userZoom(z: number): void {
    this.zoom = z;
    this.emit('zoom_changed');
  }
}

class FakeBackend implements StreetViewBackend {
  created: FakePanorama[] = [];
  noImagery = new Set<string>();
  throwOnCreate = false;
  metadataLookups = 0;

  createPanorama(_host: HTMLElement, opts: google.maps.StreetViewPanoramaOptions): PanoramaLike {
    if (this.throwOnCreate) throw new Error('google is not defined');
    const p = new FakePanorama(opts);
    this.created.push(p);
    return p;
  }
  async findByLocation(t: { lat: number; lng: number }): Promise<FoundPanorama | null> {
    this.metadataLookups++;
    const id = `pano_${t.lat}_${t.lng}`;
    return this.noImagery.has(id) ? null : { panoId: id, lat: t.lat, lng: t.lng, description: '', date: null };
  }
  async findByPanoId(panoId: string): Promise<FoundPanorama | null> {
    this.metadataLookups++;
    return panoId.startsWith('expired') ? null : { panoId, lat: 0, lng: 0, description: '', date: null };
  }
  get pano(): FakePanorama {
    return this.created[0];
  }
}

const OCT = new Date('2026-10-15T12:00:00Z');

function gateFor(repo: UsageRepository): UsageGate {
  return {
    reserve: (kind) => repo.reserve(kind, OCT),
    settle: (r, o) => repo.settle(r, o, OCT),
  };
}

function setup(opts: Partial<ControllerOptions> = {}, limit = 100) {
  const repo = new UsageRepository(dbHarness().provider, {
    monthlyLimit: limit,
    warningThresholds: [0.8, 0.9, 1],
    billingTimeZone: 'America/Los_Angeles',
  });
  const backend = new FakeBackend();
  const controller = new StreetViewController(backend, gateFor(repo), {
    countProgrammaticLocationChanges: true,
    loadTimeoutMs: 500,
    searchRadiusMeters: 50,
    ...opts,
  });
  document.body.appendChild(controller.host);
  const counted = async () => (await repo.getStatus(OCT)).counted;
  return { repo, backend, controller, counted };
}

const target = (lat: number, lng: number, extra: Partial<ViewTarget> = {}): ViewTarget => ({
  lat,
  lng,
  panoId: null,
  heading: 30,
  pitch: 5,
  zoom: 1,
  ...extra,
});

describe('mode restrictions', () => {
  it('defines the intended permissions per mode', () => {
    expect(restrictionsFor('moving')).toEqual({ allowMove: true, allowPan: true, allowZoom: true });
    expect(restrictionsFor('no-move')).toEqual({ allowMove: false, allowPan: true, allowZoom: true });
    expect(restrictionsFor('nmpz')).toEqual({ allowMove: false, allowPan: false, allowZoom: false });
  });

  it('Moving enables navigation controls but hides location hints', () => {
    const o = panoramaOptionsFor('moving');
    expect(o).toMatchObject({ linksControl: true, clickToGo: true, panControl: true, zoomControl: true, scrollwheel: true });
    expect(o).toMatchObject({ addressControl: false, showRoadLabels: false, imageDateControl: false });
  });

  it('No Moving disables every way to move but keeps pan and zoom', () => {
    const o = panoramaOptionsFor('no-move');
    expect(o).toMatchObject({ linksControl: false, clickToGo: false, disableDoubleClickZoom: true });
    expect(o).toMatchObject({ panControl: true, zoomControl: true, scrollwheel: true });
  });

  it('NMPZ disables movement, panning and zooming controls', () => {
    const o = panoramaOptionsFor('nmpz');
    expect(o).toMatchObject({
      disableDefaultUI: true,
      linksControl: false,
      clickToGo: false,
      panControl: false,
      zoomControl: false,
      scrollwheel: false,
      disableDoubleClickZoom: true,
      motionTracking: false,
      motionTrackingControl: false,
      fullscreenControl: false,
    });
  });

  it('blocks keyboard shortcuts according to the mode', () => {
    expect(isKeyBlocked('moving', 'ArrowUp')).toBe(false);
    expect(isKeyBlocked('no-move', 'ArrowUp')).toBe(true);
    expect(isKeyBlocked('no-move', 'w')).toBe(true);
    expect(isKeyBlocked('no-move', 'ArrowLeft')).toBe(false);
    expect(isKeyBlocked('no-move', '+')).toBe(false);
    expect(isKeyBlocked('nmpz', 'ArrowLeft')).toBe(true);
    expect(isKeyBlocked('nmpz', '+')).toBe(true);
    expect(isKeyBlocked('nmpz', 'x')).toBe(true);
  });
});

describe('StreetViewController mode guards', () => {
  it('Moving: user navigation is allowed and not reverted', async () => {
    const { backend, controller } = setup();
    await controller.show(target(1, 1), 'moving');
    backend.pano.userMove('elsewhere');
    backend.pano.userPan({ heading: 200, pitch: 10 });
    expect(backend.pano.pano).toBe('elsewhere');
    expect(backend.pano.pov.heading).toBe(200);
  });

  it('No Moving: movement is reverted, panning and zooming are allowed', async () => {
    const { backend, controller } = setup();
    await controller.show(target(1, 1), 'no-move');
    backend.pano.userMove('neighbour');
    expect(backend.pano.pano).toBe('pano_1_1');
    backend.pano.userPan({ heading: 120, pitch: -10 });
    backend.pano.userZoom(3);
    expect(backend.pano.pov).toEqual({ heading: 120, pitch: -10 });
    expect(backend.pano.zoom).toBe(3);
  });

  it('NMPZ: movement, rotation, tilt and zoom are all reverted', async () => {
    const { backend, controller } = setup();
    await controller.show(target(1, 1, { heading: 45, pitch: 3, zoom: 2 }), 'nmpz');
    backend.pano.userMove('neighbour');
    backend.pano.userPan({ heading: 90, pitch: 0 });
    backend.pano.userPan({ heading: 45, pitch: 40 });
    backend.pano.userZoom(4);
    expect(backend.pano.pano).toBe('pano_1_1');
    expect(backend.pano.pov).toEqual({ heading: 45, pitch: 3 });
    expect(backend.pano.zoom).toBe(2);
    expect(controller.host.inert).toBe(true);
  });

  it('NMPZ: keyboard events inside the viewer are swallowed', async () => {
    const { controller } = setup();
    await controller.show(target(1, 1), 'nmpz');
    const inner = document.createElement('div');
    inner.tabIndex = 0;
    controller.host.appendChild(inner);
    const seen: string[] = [];
    inner.addEventListener('keydown', (e) => seen.push(e.key));
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(seen).toEqual([]);
  });

  it('No Moving: arrow-up (move forward) is swallowed but arrow-left (pan) is not', async () => {
    const { controller } = setup();
    await controller.show(target(1, 1), 'no-move');
    const inner = document.createElement('div');
    controller.host.appendChild(inner);
    const seen: string[] = [];
    inner.addEventListener('keydown', (e) => seen.push(e.key));
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(seen).toEqual(['ArrowLeft']);
  });

  it('switching modes between rounds updates options without a new viewer', async () => {
    const { backend, controller } = setup();
    await controller.show(target(1, 1), 'moving');
    await controller.show(target(2, 2), 'nmpz');
    expect(backend.created).toHaveLength(1);
    expect(backend.pano.options.linksControl).toBe(false);
    expect(backend.pano.options.panControl).toBe(false);
  });
});

describe('StreetViewController usage accounting', () => {
  it('reserves exactly one unit for the first viewer initialization', async () => {
    const { controller, counted, repo } = setup();
    const r = await controller.show(target(1, 1), 'moving');
    expect(r.kind).toBe('ok');
    expect(await counted()).toBe(1);
    expect((await repo.getStatus(OCT)).confirmed).toBe(1);
  });

  it('panning, tilting, zooming and walking never reserve units', async () => {
    const { backend, controller, counted } = setup();
    await controller.show(target(1, 1), 'moving');
    for (let i = 0; i < 20; i++) {
      backend.pano.userPan({ heading: i * 10, pitch: i });
      backend.pano.userZoom(i % 4);
      backend.pano.userMove(`walk_${i}`);
    }
    controller.returnToStart();
    expect(await counted()).toBe(1);
    expect(backend.created).toHaveLength(1);
  });

  it('reuses the viewer: showing the same location again costs nothing', async () => {
    const { backend, controller, counted } = setup();
    await controller.show(target(1, 1), 'moving');
    await controller.show(target(1, 1), 'nmpz');
    await controller.show(target(1, 1), 'no-move');
    expect(backend.created).toHaveLength(1);
    expect(await counted()).toBe(1);
  });

  it('conservative mode reserves one unit per programmatic location change', async () => {
    const { backend, controller, counted, repo } = setup({ countProgrammaticLocationChanges: true });
    await controller.show(target(1, 1), 'moving');
    await controller.show(target(2, 2), 'moving');
    await controller.show(target(3, 3), 'moving');
    expect(backend.created).toHaveLength(1);
    expect(await counted()).toBe(3);
    expect((await repo.getStatus(OCT)).confirmed).toBe(3);
  });

  it('with location changes not counted, a reused viewer consumes no reservation', async () => {
    const { backend, controller, counted } = setup({ countProgrammaticLocationChanges: false });
    await controller.show(target(1, 1), 'moving');
    await controller.show(target(2, 2), 'moving');
    await controller.show(target(3, 3), 'nmpz');
    expect(backend.created).toHaveLength(1);
    expect(await counted()).toBe(1);
  });

  it('does not create a viewer once the limit is reached', async () => {
    const { backend, controller, repo } = setup({}, 2);
    await repo.reserve('viewer-init', OCT);
    await repo.reserve('viewer-init', OCT);
    const r = await controller.show(target(1, 1), 'moving');
    expect(r.kind).toBe('blocked');
    expect(backend.created).toHaveLength(0);
    expect(backend.metadataLookups).toBe(0);
  });

  it('does not create a viewer when usage data is corrupted', async () => {
    const h = dbHarness();
    const repo = new UsageRepository(h.provider, {
      monthlyLimit: 100,
      warningThresholds: [1],
      billingTimeZone: 'America/Los_Angeles',
    });
    await repo.getStatus(OCT);
    await (await h.provider()).put('usage', { key: '2026-10', type: 'month', garbage: true } as never);
    const backend = new FakeBackend();
    const controller = new StreetViewController(backend, gateFor(repo), {
      countProgrammaticLocationChanges: true,
      loadTimeoutMs: 500,
      searchRadiusMeters: 50,
    });
    const r = await controller.show(target(1, 1), 'moving');
    expect(r.kind).toBe('blocked');
    expect(backend.created).toHaveLength(0);
  });

  it('blocks a location change at the limit while keeping the current view', async () => {
    const { backend, controller } = setup({}, 1);
    await controller.show(target(1, 1), 'moving');
    const r = await controller.show(target(2, 2), 'moving');
    expect(r.kind).toBe('blocked');
    expect(backend.pano.pano).toBe('pano_1_1');
  });

  it('releases the unit when there is no imagery (no panorama request made)', async () => {
    const { backend, controller, counted } = setup();
    backend.noImagery.add('pano_5_5');
    const r = await controller.show(target(5, 5), 'moving');
    expect(r.kind).toBe('no-imagery');
    expect(backend.created).toHaveLength(0);
    expect(await counted()).toBe(0);
  });

  it('keeps the unit counted when the panorama itself fails to load', async () => {
    const { backend, controller, counted, repo } = setup();
    await controller.show(target(1, 1), 'moving');
    backend.pano.nextStatus = 'UNKNOWN_ERROR';
    const r = await controller.show(target(2, 2), 'moving');
    expect(r.kind).toBe('error');
    expect(await counted()).toBe(2);
    expect((await repo.getStatus(OCT)).failed).toBe(1);
  });

  it('releases the unit when the viewer cannot even be constructed', async () => {
    const { backend, controller, counted } = setup();
    backend.throwOnCreate = true;
    const r = await controller.show(target(1, 1), 'moving');
    expect(r.kind).toBe('error');
    expect(await counted()).toBe(0);
  });

  it('falls back to coordinates when a stored pano ID has expired', async () => {
    const { backend, controller } = setup();
    const r = await controller.show(target(7, 8, { panoId: 'expired-123' }), 'moving');
    expect(r.kind).toBe('ok');
    expect(backend.pano.pano).toBe('pano_7_8');
  });

  it('serialises overlapping show() calls so they cannot double-create viewers', async () => {
    const { backend, controller, counted } = setup({ countProgrammaticLocationChanges: false });
    await Promise.all([controller.show(target(1, 1), 'moving'), controller.show(target(2, 2), 'moving')]);
    expect(backend.created).toHaveLength(1);
    expect(await counted()).toBe(1);
  });
});

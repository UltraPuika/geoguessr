import { GameMode, LatLng } from './models';
import { Reservation, ReservationKind, ReserveOutcome, UsageStatus } from './usage-ledger';

export type ViewerMode = GameMode | 'editor';

export interface ModeRestrictions {
  allowMove: boolean;
  allowPan: boolean;
  allowZoom: boolean;
}

export function restrictionsFor(mode: ViewerMode): ModeRestrictions {
  switch (mode) {
    case 'moving':
    case 'editor':
      return { allowMove: true, allowPan: true, allowZoom: true };
    case 'no-move':
      return { allowMove: false, allowPan: true, allowZoom: true };
    case 'nmpz':
      return { allowMove: false, allowPan: false, allowZoom: false };
  }
}

/** Panorama options for a mode. Gameplay modes hide anything that reveals the location. */
export function panoramaOptionsFor(mode: ViewerMode): google.maps.StreetViewPanoramaOptions {
  const r = restrictionsFor(mode);
  const reveal = mode === 'editor';
  return {
    disableDefaultUI: !r.allowPan && !r.allowZoom && !r.allowMove,
    addressControl: reveal,
    showRoadLabels: reveal,
    imageDateControl: reveal,
    enableCloseButton: false,
    fullscreenControl: r.allowPan,
    motionTracking: false,
    motionTrackingControl: false,
    linksControl: r.allowMove,
    clickToGo: r.allowMove,
    // Double-click jumps forward in Street View, so it is disabled whenever moving is.
    disableDoubleClickZoom: !r.allowMove || !r.allowZoom,
    panControl: r.allowPan,
    zoomControl: r.allowZoom,
    scrollwheel: r.allowZoom,
  };
}

const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S']);
const PAN_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D', 'PageUp', 'PageDown', 'Home', 'End']);
const ZOOM_KEYS = new Set(['+', '-', '=', '_', 'Add', 'Subtract']);

/** Whether a keyboard event inside the panorama must be swallowed for the mode. */
export function isKeyBlocked(mode: ViewerMode, key: string): boolean {
  const r = restrictionsFor(mode);
  if (!r.allowMove && MOVE_KEYS.has(key)) return true;
  if (!r.allowPan && PAN_KEYS.has(key)) return true;
  if (!r.allowZoom && ZOOM_KEYS.has(key)) return true;
  if (!r.allowPan && !r.allowZoom && !r.allowMove && key !== 'Tab') return true;
  return false;
}

export interface Pov {
  heading: number;
  pitch: number;
}

/** Subset of google.maps.StreetViewPanorama used here, so tests can supply a fake. */
export interface PanoramaLike {
  setOptions(options: google.maps.StreetViewPanoramaOptions): void;
  setPano(pano: string): void;
  setPov(pov: Pov): void;
  setZoom(zoom: number): void;
  setVisible(visible: boolean): void;
  getPano(): string;
  getPov(): Pov;
  getZoom(): number;
  getPosition(): { lat(): number; lng(): number } | null | undefined;
  getStatus(): string;
  addListener(event: string, handler: () => void): { remove(): void };
}

export interface FoundPanorama {
  panoId: string;
  lat: number;
  lng: number;
  description: string;
  date: string | null;
}

export interface StreetViewBackend {
  createPanorama(host: HTMLElement, options: google.maps.StreetViewPanoramaOptions): PanoramaLike;
  /** Metadata lookups via StreetViewService (documented as not billed). */
  findByLocation(target: LatLng, radiusMeters: number): Promise<FoundPanorama | null>;
  findByPanoId(panoId: string): Promise<FoundPanorama | null>;
}

export interface UsageGate {
  reserve(kind: ReservationKind): Promise<ReserveOutcome>;
  settle(reservation: Reservation, outcome: 'confirmed' | 'failed' | 'released'): Promise<void>;
}

export interface ViewTarget {
  lat: number;
  lng: number;
  panoId: string | null;
  heading: number;
  pitch: number;
  zoom: number;
}

export interface CurrentView {
  panoId: string;
  lat: number;
  lng: number;
  heading: number;
  pitch: number;
  zoom: number;
}

export type ShowResult =
  | { kind: 'ok'; panoId: string; position: LatLng; consumedUnit: boolean }
  | { kind: 'blocked'; status: UsageStatus }
  | { kind: 'no-imagery' }
  | { kind: 'error'; message: string };

export interface ControllerOptions {
  countProgrammaticLocationChanges: boolean;
  loadTimeoutMs: number;
  searchRadiusMeters: number;
}

function targetKey(t: ViewTarget): string {
  return t.panoId ? `pano:${t.panoId}` : `ll:${t.lat.toFixed(6)},${t.lng.toFixed(6)}`;
}

const ANGLE_EPSILON = 0.01;

/**
 * Owns the single StreetViewPanorama for the whole page session.
 *
 * - The viewer is constructed at most once (one reserved unit) and then reused.
 * - Optionally, each programmatic switch to a *different* location reserves one more unit.
 * - Panning, zooming and user navigation never reserve units.
 * - Mode guards revert any movement/POV/zoom change the mode does not allow, in addition
 *   to disabling the corresponding controls.
 */
export class StreetViewController {
  readonly host: HTMLElement;
  private pano: PanoramaLike | null = null;
  private loadedKey: string | null = null;
  private lock: { pano: string; pov: Pov; zoom: number } | null = null;
  private mode: ViewerMode = 'editor';
  private reverting = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly keyGuard = (e: KeyboardEvent) => this.onKey(e);
  private readonly win: Window | null;
  private readonly povListeners = new Set<(pov: Pov) => void>();

  constructor(
    private readonly backend: StreetViewBackend,
    private readonly gate: UsageGate,
    private readonly options: ControllerOptions,
    doc: Document = document,
  ) {
    this.host = doc.createElement('div');
    this.host.className = 'sv-host';
    this.win = doc.defaultView;
    this.win?.addEventListener('keydown', this.keyGuard, true);
    this.win?.addEventListener('keyup', this.keyGuard, true);
  }

  get hasViewer(): boolean {
    return this.pano !== null;
  }

  get currentMode(): ViewerMode {
    return this.mode;
  }

  /** Serialised so overlapping calls cannot double-reserve or interleave. */
  show(target: ViewTarget, mode: ViewerMode): Promise<ShowResult> {
    const run = this.queue.then(() => this.doShow(target, mode));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Would showing this target reserve a unit? */
  wouldConsume(target: ViewTarget): boolean {
    return !this.pano || (this.options.countProgrammaticLocationChanges && targetKey(target) !== this.loadedKey);
  }

  setMode(mode: ViewerMode): void {
    this.mode = mode;
    this.host.inert = mode === 'nmpz';
    this.pano?.setOptions(panoramaOptionsFor(mode));
  }

  /** Returns to the round's starting viewpoint (user navigation; never reserves). */
  returnToStart(): void {
    if (!this.pano || !this.lock) return;
    this.reverting = true;
    try {
      if (this.pano.getPano() !== this.lock.pano) this.pano.setPano(this.lock.pano);
      this.pano.setPov(this.lock.pov);
      this.pano.setZoom(this.lock.zoom);
    } finally {
      this.reverting = false;
    }
  }

  /** Subscribes to camera changes (for a compass). Returns an unsubscribe function. */
  onPovChange(fn: (pov: Pov) => void): () => void {
    this.povListeners.add(fn);
    return () => this.povListeners.delete(fn);
  }

  private emitPov(): void {
    if (!this.pano) return;
    const pov = this.pano.getPov();
    for (const fn of this.povListeners) fn(pov);
  }

  currentView(): CurrentView | null {
    if (!this.pano || this.pano.getStatus() !== 'OK') return null;
    const pos = this.pano.getPosition();
    if (!pos) return null;
    const pov = this.pano.getPov();
    return {
      panoId: this.pano.getPano(),
      lat: pos.lat(),
      lng: pos.lng(),
      heading: pov.heading,
      pitch: pov.pitch,
      zoom: this.pano.getZoom(),
    };
  }

  dispose(): void {
    this.win?.removeEventListener('keydown', this.keyGuard, true);
    this.win?.removeEventListener('keyup', this.keyGuard, true);
  }

  private async doShow(target: ViewTarget, mode: ViewerMode): Promise<ShowResult> {
    const key = targetKey(target);
    const creating = this.pano === null;
    const consume = this.wouldConsume(target);
    let reservation: Reservation | null = null;
    if (consume) {
      const out = await this.gate.reserve(creating ? 'viewer-init' : 'location-change');
      if (!out.ok) return { kind: 'blocked', status: out.status };
      reservation = out.reservation;
    }

    let requestIssued = false;
    try {
      let found: FoundPanorama | null = null;
      if (target.panoId) found = await this.backend.findByPanoId(target.panoId);
      // Pano IDs can expire; fall back to the stored coordinates.
      if (!found) found = await this.backend.findByLocation(target, this.options.searchRadiusMeters);
      if (!found) {
        if (reservation) await this.gate.settle(reservation, 'released');
        return { kind: 'no-imagery' };
      }

      const pov = { heading: target.heading, pitch: target.pitch };
      this.lock = null;
      this.mode = mode;
      this.host.inert = mode === 'nmpz';
      const opts = panoramaOptionsFor(mode);

      let status: string;
      if (!this.pano) {
        this.pano = this.backend.createPanorama(this.host, { ...opts, pano: found.panoId, pov, zoom: target.zoom, visible: true });
        // Only a successfully constructed viewer can have contacted Google.
        requestIssued = true;
        this.installGuards(this.pano);
        status = await this.waitForStatus(this.pano, found.panoId, true);
      } else {
        const pano = this.pano;
        pano.setOptions(opts);
        const waiting = this.waitForStatus(pano, found.panoId, false);
        requestIssued = true;
        this.reverting = true;
        try {
          if (pano.getPano() !== found.panoId) pano.setPano(found.panoId);
          pano.setPov(pov);
          pano.setZoom(target.zoom);
          pano.setVisible(true);
        } finally {
          this.reverting = false;
        }
        status = await waiting;
      }

      if (status !== 'OK') {
        if (reservation) await this.gate.settle(reservation, 'failed');
        this.loadedKey = null;
        return status === 'ZERO_RESULTS'
          ? { kind: 'no-imagery' }
          : { kind: 'error', message: `Street View failed to load (${status}).` };
      }

      this.loadedKey = key;
      this.lock = { pano: found.panoId, pov, zoom: target.zoom };
      this.emitPov();
      if (reservation) await this.gate.settle(reservation, 'confirmed');
      return { kind: 'ok', panoId: found.panoId, position: { lat: found.lat, lng: found.lng }, consumedUnit: consume };
    } catch (err) {
      // Before any panorama request, nothing can have been billed; afterwards stay conservative.
      if (reservation) await this.gate.settle(reservation, requestIssued ? 'failed' : 'released');
      return { kind: 'error', message: err instanceof Error ? err.message : 'Street View failed to load.' };
    }
  }

  private waitForStatus(pano: PanoramaLike, panoId: string, creating: boolean): Promise<string> {
    if (!creating && pano.getPano() === panoId && pano.getStatus() === 'OK') return Promise.resolve('OK');
    return new Promise((resolve) => {
      let done = false;
      const finish = (s: string) => {
        if (done) return;
        done = true;
        listener.remove();
        clearTimeout(timer);
        resolve(s);
      };
      const listener = pano.addListener('status_changed', () => finish(pano.getStatus()));
      const timer = setTimeout(() => finish('TIMEOUT'), this.options.loadTimeoutMs);
    });
  }

  private installGuards(pano: PanoramaLike): void {
    pano.addListener('pov_changed', () => this.emitPov());
    pano.addListener('pano_changed', () => {
      if (this.reverting || !this.lock || restrictionsFor(this.mode).allowMove) return;
      if (pano.getPano() !== this.lock.pano) this.revert(() => pano.setPano(this.lock!.pano));
    });
    pano.addListener('pov_changed', () => {
      if (this.reverting || !this.lock || restrictionsFor(this.mode).allowPan) return;
      const pov = pano.getPov();
      if (
        Math.abs(pov.heading - this.lock.pov.heading) > ANGLE_EPSILON ||
        Math.abs(pov.pitch - this.lock.pov.pitch) > ANGLE_EPSILON
      ) {
        this.revert(() => pano.setPov(this.lock!.pov));
      }
    });
    pano.addListener('zoom_changed', () => {
      if (this.reverting || !this.lock || restrictionsFor(this.mode).allowZoom) return;
      if (Math.abs(pano.getZoom() - this.lock.zoom) > ANGLE_EPSILON) this.revert(() => pano.setZoom(this.lock!.zoom));
    });
  }

  private revert(fn: () => void): void {
    this.reverting = true;
    try {
      fn();
    } finally {
      this.reverting = false;
    }
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as Node | null;
    if (!target || !this.host.contains(target)) return;
    if (isKeyBlocked(this.mode, e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
}

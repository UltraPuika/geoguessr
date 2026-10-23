import { UsageStatus } from './usage-ledger';
import { UsageGate } from './street-view-controller';

export interface MapFactory<M> {
  create(host: HTMLElement): M;
  /** Resolves true once the map reports it has loaded, false on timeout. */
  waitLoaded(map: M): Promise<boolean>;
}

export type AcquireResult<M> =
  | { kind: 'ok'; map: M; consumedUnit: boolean }
  | { kind: 'blocked'; status: UsageStatus }
  | { kind: 'error'; message: string };

/**
 * Creates one billable map per page session (one reserved unit) and hands the same
 * instance to every caller afterwards. Pan/zoom/clicks never touch the counter.
 */
export class ReusableMapLoader<M> {
  readonly host: HTMLElement;
  private map: M | null = null;
  private pending: Promise<AcquireResult<M>> | null = null;

  constructor(
    private readonly factory: MapFactory<M>,
    private readonly gate: UsageGate,
    doc: Document = document,
  ) {
    this.host = doc.createElement('div');
    this.host.className = 'gmap-host';
  }

  get hasMap(): boolean {
    return this.map !== null;
  }

  acquire(): Promise<AcquireResult<M>> {
    if (this.map) return Promise.resolve({ kind: 'ok', map: this.map, consumedUnit: false });
    this.pending ??= this.create().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async create(): Promise<AcquireResult<M>> {
    const out = await this.gate.reserve('map-load');
    if (!out.ok) return { kind: 'blocked', status: out.status };
    let map: M;
    try {
      map = this.factory.create(this.host);
    } catch (err) {
      // Never constructed, so nothing can have been billed.
      await this.gate.settle(out.reservation, 'released');
      return { kind: 'error', message: err instanceof Error ? err.message : 'Map could not be created.' };
    }
    this.map = map;
    const loaded = await this.factory.waitLoaded(map);
    await this.gate.settle(out.reservation, loaded ? 'confirmed' : 'failed');
    return { kind: 'ok', map, consumedUnit: true };
  }
}

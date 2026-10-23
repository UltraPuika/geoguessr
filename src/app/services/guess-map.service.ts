import { Injectable, inject, signal } from '@angular/core';
import { MAP_LOAD_CONFIG } from '../config/usage-config';
import { ReusableMapLoader } from '../core/reusable-map-loader';
import { UsageGate } from '../core/street-view-controller';
import { Reservation, ReservationKind, ReserveOutcome, UsageStatus } from '../core/usage-ledger';
import { GoogleGuessMap, GoogleMapsLibs, GuessMapView, LeafletGuessMap } from '../shared/guess-map';
import { DatabaseService } from './database.service';
import { GoogleMapsLoaderService } from './google-maps-loader.service';

/** Monthly counter for Google guess-map loads (separate from Street View). */
@Injectable({ providedIn: 'root' })
export class MapUsageService implements UsageGate {
  private readonly repo = inject(DatabaseService).mapUsage;
  readonly status = signal<UsageStatus | null>(null);
  readonly config = MAP_LOAD_CONFIG;

  async refresh(): Promise<UsageStatus> {
    const s = await this.repo.getStatus();
    this.status.set(s);
    return s;
  }

  async reserve(kind: ReservationKind): Promise<ReserveOutcome> {
    const out = await this.repo.reserve(kind);
    this.status.set(out.status);
    return out;
  }

  async settle(reservation: Reservation, outcome: 'confirmed' | 'failed' | 'released'): Promise<void> {
    try {
      await this.repo.settle(reservation, outcome);
    } finally {
      await this.refresh();
    }
  }

  async repair(): Promise<void> {
    this.status.set(await this.repo.repairConservatively());
  }

  history() {
    return this.repo.history();
  }
}

/**
 * Provides the guess map: the session's single Google map while the monthly map-load
 * allowance lasts, otherwise the free Leaflet map.
 */
@Injectable({ providedIn: 'root' })
export class GuessMapService {
  private readonly loader = inject(GoogleMapsLoaderService);
  private readonly usage = inject(MapUsageService);
  private mapLoader: ReusableMapLoader<google.maps.Map> | null = null;
  private libs: GoogleMapsLibs | null = null;
  private parking: HTMLElement | null = null;

  /** Why the last game fell back to the free map, if it did. */
  readonly fallbackReason = signal<string | null>(null);

  async create(el: HTMLElement): Promise<GuessMapView> {
    let reason = 'No Google Maps API key is configured.';
    if (this.loader.hasKey && !this.loader.authFailed()) {
      try {
        const loader = await this.ensureLoader();
        el.appendChild(loader.host);
        const r = await loader.acquire();
        if (r.kind === 'ok') {
          this.fallbackReason.set(null);
          return new GoogleGuessMap(r.map, this.libs!, () => this.park(loader.host));
        }
        if (!loader.hasMap) loader.host.remove();
        reason =
          r.kind === 'blocked'
            ? (r.status.message ?? 'Monthly Google map allowance used up.')
            : r.message;
      } catch (err) {
        reason = err instanceof Error ? err.message : 'Google Maps could not be loaded.';
      }
    }
    this.fallbackReason.set(reason);
    return new LeafletGuessMap(el);
  }

  private async ensureLoader(): Promise<ReusableMapLoader<google.maps.Map>> {
    if (this.mapLoader) return this.mapLoader;
    const { maps, marker, core } = await this.loader.loadMapLibraries();
    this.libs = {
      Marker: marker.Marker,
      Polyline: maps.Polyline,
      LatLngBounds: core.LatLngBounds,
      SymbolPath: core.SymbolPath,
    };
    this.mapLoader = new ReusableMapLoader<google.maps.Map>(
      {
        create: (host) =>
          new maps.Map(host, {
            center: { lat: 20, lng: 0 },
            zoom: 2,
            minZoom: 1,
            // The pegman would open a billable (and answer-revealing) Street View.
            streetViewControl: false,
            mapTypeControl: false,
            fullscreenControl: false,
            clickableIcons: false,
            gestureHandling: 'greedy',
            draggableCursor: 'crosshair',
          }),
        waitLoaded: (map) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              l.remove();
              resolve(false);
            }, MAP_LOAD_CONFIG.loadTimeoutMs);
            const l = map.addListener('tilesloaded', () => {
              clearTimeout(timer);
              l.remove();
              resolve(true);
            });
          }),
      },
      this.usage,
    );
    return this.mapLoader;
  }

  private park(host: HTMLElement): void {
    if (!this.parking) {
      this.parking = document.createElement('div');
      this.parking.setAttribute('aria-hidden', 'true');
      this.parking.style.cssText = 'position:fixed;left:-10000px;top:0;width:480px;height:360px;visibility:hidden;';
      document.body.appendChild(this.parking);
    }
    this.parking.appendChild(host);
  }
}

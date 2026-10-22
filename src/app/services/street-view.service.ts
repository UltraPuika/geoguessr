import { Injectable, inject, signal } from '@angular/core';
import { USAGE_CONFIG } from '../config/usage-config';
import { LatLng } from '../core/models';
import {
  CurrentView,
  FoundPanorama,
  PanoramaLike,
  ShowResult,
  StreetViewBackend,
  StreetViewController,
  ViewTarget,
  ViewerMode,
} from '../core/street-view-controller';
import { GoogleMapsLoaderService } from './google-maps-loader.service';
import { UsageService } from './usage.service';

function isZeroResults(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === 'ZERO_RESULTS' || (typeof e?.message === 'string' && e.message.includes('ZERO_RESULTS'));
}

class GoogleStreetViewBackend implements StreetViewBackend {
  private readonly service: google.maps.StreetViewService;

  constructor(private readonly lib: google.maps.StreetViewLibrary) {
    this.service = new lib.StreetViewService();
  }

  createPanorama(host: HTMLElement, options: google.maps.StreetViewPanoramaOptions): PanoramaLike {
    return new this.lib.StreetViewPanorama(host, options) as unknown as PanoramaLike;
  }

  findByLocation(target: LatLng, radiusMeters: number): Promise<FoundPanorama | null> {
    return this.query({
      location: { lat: target.lat, lng: target.lng },
      radius: radiusMeters,
      preference: this.lib.StreetViewPreference.NEAREST,
    });
  }

  findByPanoId(panoId: string): Promise<FoundPanorama | null> {
    return this.query({ pano: panoId });
  }

  private async query(
    request: google.maps.StreetViewLocationRequest | google.maps.StreetViewPanoRequest,
  ): Promise<FoundPanorama | null> {
    try {
      const { data } = await this.service.getPanorama(request);
      const loc = data.location;
      if (!loc?.pano || !loc.latLng) return null;
      return {
        panoId: loc.pano,
        lat: loc.latLng.lat(),
        lng: loc.latLng.lng(),
        description: loc.description ?? '',
        date: data.imageDate ?? null,
      };
    } catch (err) {
      if (isZeroResults(err)) return null;
      throw err;
    }
  }
}

/**
 * App-wide owner of the single Street View viewer. Components borrow the viewer's host
 * element with attach()/detach(), so navigating between screens never builds a new one.
 */
@Injectable({ providedIn: 'root' })
export class StreetViewService {
  private readonly loader = inject(GoogleMapsLoaderService);
  private readonly usage = inject(UsageService);
  private controller: StreetViewController | null = null;
  private backend: StreetViewBackend | null = null;
  private init: Promise<StreetViewController> | null = null;
  private parking: HTMLElement | null = null;

  readonly hasViewer = signal(false);
  /** Current camera heading in degrees, for the compass. */
  readonly heading = signal(0);

  get apiConfigured(): boolean {
    return this.loader.hasKey;
  }

  /** Loads the API (free) without creating a panorama. */
  ensure(): Promise<StreetViewController> {
    this.init ??= this.loader
      .load()
      .then((lib) => {
        this.backend = new GoogleStreetViewBackend(lib);
        this.controller = new StreetViewController(this.backend, this.usage, {
          countProgrammaticLocationChanges: USAGE_CONFIG.countProgrammaticLocationChanges,
          loadTimeoutMs: USAGE_CONFIG.panoramaLoadTimeoutMs,
          searchRadiusMeters: 50,
        });
        this.controller.onPovChange((pov) => this.heading.set(pov.heading));
        return this.controller;
      })
      .catch((err) => {
        this.init = null;
        throw err;
      });
    return this.init;
  }

  async attach(container: HTMLElement): Promise<void> {
    const c = await this.ensure();
    if (c.host.parentElement !== container) container.appendChild(c.host);
    c.host.inert = c.currentMode === 'nmpz';
  }

  /** Parks the viewer off-screen instead of destroying it. */
  detach(container: HTMLElement): void {
    const host = this.controller?.host;
    if (!host || host.parentElement !== container) return;
    host.inert = true;
    this.parkingElement().appendChild(host);
  }

  async show(target: ViewTarget, mode: ViewerMode): Promise<ShowResult> {
    const c = await this.ensure();
    const result = await c.show(target, mode);
    this.hasViewer.set(c.hasViewer);
    return result;
  }

  wouldConsume(target: ViewTarget): boolean {
    return this.controller ? this.controller.wouldConsume(target) : true;
  }

  async checkCoverage(target: LatLng, radiusMeters = 50): Promise<FoundPanorama | null> {
    await this.ensure();
    return this.backend!.findByLocation(target, radiusMeters);
  }

  setMode(mode: ViewerMode): void {
    this.controller?.setMode(mode);
  }

  returnToStart(): void {
    this.controller?.returnToStart();
  }

  currentView(): CurrentView | null {
    return this.controller?.currentView() ?? null;
  }

  private parkingElement(): HTMLElement {
    if (!this.parking) {
      this.parking = document.createElement('div');
      this.parking.setAttribute('aria-hidden', 'true');
      this.parking.style.cssText =
        'position:fixed;left:-10000px;top:0;width:640px;height:360px;visibility:hidden;pointer-events:none;';
      document.body.appendChild(this.parking);
    }
    return this.parking;
  }
}

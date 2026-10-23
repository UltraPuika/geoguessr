import * as L from 'leaflet';
import { LatLng } from '../core/models';
import { ACTUAL_STYLE, GUESS_STYLE, LINE_STYLE, createBaseMap, observeResize, shortestLine, toLatLng } from './leaflet';

/** The guess map used in a game, backed either by Google Maps or by Leaflet. */
export interface GuessMapView {
  readonly kind: 'google' | 'leaflet';
  onClick(fn: (p: LatLng) => void): void;
  setGuess(p: LatLng | null): void;
  showResult(actual: LatLng, guess: LatLng | null): void;
  reset(): void;
  /** Re-fits after the container changed size (e.g. result layout). */
  refit(): void;
  dispose(): void;
}

const WORLD: LatLng = { lat: 20, lng: 0 };

export class LeafletGuessMap implements GuessMapView {
  readonly kind = 'leaflet' as const;
  private readonly map: L.Map;
  private readonly layer: L.LayerGroup;
  private guess: L.CircleMarker | null = null;
  private readonly stopResize: () => void;
  private lastFit: (() => void) | null = null;

  constructor(el: HTMLElement) {
    this.map = createBaseMap(el, { zoomControl: true });
    this.layer = L.layerGroup().addTo(this.map);
    this.stopResize = observeResize(this.map, el);
  }

  onClick(fn: (p: LatLng) => void): void {
    this.map.on('click', (e: L.LeafletMouseEvent) => fn(toLatLng(e.latlng)));
  }

  setGuess(p: LatLng | null): void {
    if (!p) {
      this.guess?.remove();
      this.guess = null;
    } else if (this.guess) {
      this.guess.setLatLng([p.lat, p.lng]);
    } else {
      this.guess = L.circleMarker([p.lat, p.lng], { ...GUESS_STYLE, interactive: false }).addTo(this.map);
    }
  }

  showResult(actual: LatLng, guess: LatLng | null): void {
    this.setGuess(null);
    this.layer.clearLayers();
    L.circleMarker([actual.lat, actual.lng], ACTUAL_STYLE).bindTooltip('Correct location').addTo(this.layer);
    if (guess) {
      const line = shortestLine(actual, guess);
      L.polyline(line, LINE_STYLE).addTo(this.layer);
      L.circleMarker(line[1], GUESS_STYLE).bindTooltip('Your guess').addTo(this.layer);
      this.lastFit = () => this.map.fitBounds(L.latLngBounds(line), { padding: [50, 50], maxZoom: 16 });
    } else {
      this.lastFit = () => this.map.setView([actual.lat, actual.lng], 5);
    }
    this.lastFit();
  }

  refit(): void {
    this.map.invalidateSize();
    this.lastFit?.();
  }

  reset(): void {
    this.layer.clearLayers();
    this.setGuess(null);
    this.lastFit = null;
    this.map.setView([WORLD.lat, WORLD.lng], 2);
  }

  dispose(): void {
    this.stopResize();
    this.map.remove();
  }
}

export interface GoogleMapsLibs {
  Marker: typeof google.maps.Marker;
  Polyline: typeof google.maps.Polyline;
  LatLngBounds: typeof google.maps.LatLngBounds;
  SymbolPath: typeof google.maps.SymbolPath;
}

function dot(libs: GoogleMapsLibs, fill: string, scale = 8): google.maps.Symbol {
  return { path: libs.SymbolPath.CIRCLE, scale, fillColor: fill, fillOpacity: 1, strokeColor: '#0b0f14', strokeWeight: 3 };
}

/** Wraps the session's single Google map; dispose() only detaches, the map itself is reused. */
export class GoogleGuessMap implements GuessMapView {
  readonly kind = 'google' as const;
  private listeners: google.maps.MapsEventListener[] = [];
  private overlays: (google.maps.Marker | google.maps.Polyline)[] = [];
  private guess: google.maps.Marker | null = null;
  private lastFit: (() => void) | null = null;

  constructor(
    private readonly map: google.maps.Map,
    private readonly libs: GoogleMapsLibs,
    private readonly onDispose: () => void = () => undefined,
  ) {
    this.reset();
  }

  onClick(fn: (p: LatLng) => void): void {
    this.listeners.push(
      this.map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (e.latLng) fn({ lat: e.latLng.lat(), lng: e.latLng.lng() });
      }),
    );
  }

  setGuess(p: LatLng | null): void {
    if (!p) {
      this.guess?.setMap(null);
      this.guess = null;
    } else if (this.guess) {
      this.guess.setPosition(p);
    } else {
      this.guess = new this.libs.Marker({ map: this.map, position: p, icon: dot(this.libs, '#ffd23f'), clickable: false });
    }
  }

  showResult(actual: LatLng, guess: LatLng | null): void {
    this.setGuess(null);
    this.clearOverlays();
    this.overlays.push(
      new this.libs.Marker({ map: this.map, position: actual, icon: dot(this.libs, '#2ee66b', 9), title: 'Correct location' }),
    );
    if (guess) {
      this.overlays.push(
        new this.libs.Marker({ map: this.map, position: guess, icon: dot(this.libs, '#ffd23f', 9), title: 'Your guess' }),
        new this.libs.Polyline({
          map: this.map,
          path: [actual, guess],
          geodesic: true,
          strokeColor: '#111111',
          strokeOpacity: 0.85,
          strokeWeight: 3,
        }),
      );
      this.lastFit = () => {
        const b = new this.libs.LatLngBounds();
        b.extend(actual);
        b.extend(guess);
        this.map.fitBounds(b, 60);
        if ((this.map.getZoom() ?? 0) > 16) this.map.setZoom(16);
      };
    } else {
      this.lastFit = () => {
        this.map.setCenter(actual);
        this.map.setZoom(5);
      };
    }
    this.lastFit();
  }

  refit(): void {
    this.lastFit?.();
  }

  reset(): void {
    this.clearOverlays();
    this.setGuess(null);
    this.lastFit = null;
    this.map.setCenter(WORLD);
    this.map.setZoom(2);
  }

  dispose(): void {
    for (const l of this.listeners) l.remove();
    this.listeners = [];
    this.clearOverlays();
    this.setGuess(null);
    this.onDispose();
  }

  private clearOverlays(): void {
    for (const o of this.overlays) o.setMap(null);
    this.overlays = [];
  }
}

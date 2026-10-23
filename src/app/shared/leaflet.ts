import * as L from 'leaflet';
import { TILE_CONFIG } from '../config/tiles-config';
import { LatLng } from '../core/models';

export const GUESS_STYLE: L.CircleMarkerOptions = {
  radius: 9,
  color: '#0b0f14',
  weight: 3,
  fillColor: '#ffd23f',
  fillOpacity: 1,
};

export const ACTUAL_STYLE: L.CircleMarkerOptions = {
  radius: 9,
  color: '#0b0f14',
  weight: 3,
  fillColor: '#2ee66b',
  fillOpacity: 1,
};

export const LOCATION_STYLE: L.CircleMarkerOptions = {
  radius: 6,
  color: '#0b0f14',
  weight: 2,
  fillColor: '#4cc9f0',
  fillOpacity: 0.95,
};

export const SELECTED_STYLE: L.CircleMarkerOptions = {
  radius: 9,
  color: '#ffffff',
  weight: 3,
  fillColor: '#ff5d8f',
  fillOpacity: 1,
};

export const LINE_STYLE: L.PolylineOptions = { color: '#ffd23f', weight: 3, dashArray: '8 8', opacity: 0.9 };

export function createBaseMap(el: HTMLElement, options: L.MapOptions = {}): L.Map {
  const map = L.map(el, { worldCopyJump: true, minZoom: 1, ...options }).setView([20, 0], 2);
  L.tileLayer(TILE_CONFIG.url, {
    attribution: TILE_CONFIG.attribution,
    maxZoom: TILE_CONFIG.maxZoom,
    subdomains: TILE_CONFIG.subdomains,
  }).addTo(map);
  return map;
}

/** Wraps longitudes produced by panning across the antimeridian. */
export function toLatLng(ll: L.LatLng): LatLng {
  const w = ll.wrap();
  return { lat: Math.max(-90, Math.min(90, w.lat)), lng: w.lng };
}

/** Keeps Leaflet sized correctly when its container changes size. Returns a disposer. */
export function observeResize(map: L.Map, el: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const ro = new ResizeObserver(() => map.invalidateSize());
  ro.observe(el);
  return () => ro.disconnect();
}

/** Great-circle-ish line that crosses the antimeridian the short way. */
export function shortestLine(a: LatLng, b: LatLng): L.LatLngExpression[] {
  let lng = b.lng;
  if (lng - a.lng > 180) lng -= 360;
  else if (lng - a.lng < -180) lng += 360;
  return [
    [a.lat, a.lng],
    [b.lat, lng],
  ];
}

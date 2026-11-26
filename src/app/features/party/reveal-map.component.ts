import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import { LatLng } from '../../core/models';
import { RevealEntry } from '../../core/party-protocol';
import { ACTUAL_STYLE, createBaseMap, observeResize, shortestLine } from '../../shared/leaflet';

const PIN_COLORS = [
  '#ffd23f',
  '#4cc9f0',
  '#ff5d8f',
  '#b388ff',
  '#ff9f43',
  '#7bed9f',
  '#f8f9fa',
  '#ff6b6b',
];

/** Host screen after a live round: the correct spot and every player's guess, labelled by name. */
@Component({
  selector: 'app-reveal-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
    #map
    class="leaflet-box reveal-map"
    role="img"
    aria-label="Map of everyone's guesses"
  ></div>`,
})
export class RevealMapComponent implements OnDestroy {
  readonly actual = input.required<LatLng>();
  readonly results = input.required<readonly RevealEntry[]>();

  private readonly el = viewChild.required<ElementRef<HTMLElement>>('map');
  private map: L.Map | null = null;
  private layer: L.LayerGroup | null = null;
  private stopResize: () => void = () => undefined;

  constructor() {
    afterNextRender(() => {
      const el = this.el().nativeElement;
      this.map = createBaseMap(el, { zoomControl: true });
      this.layer = L.layerGroup().addTo(this.map);
      this.stopResize = observeResize(this.map, el);
      this.draw();
    });
    effect(() => {
      this.actual();
      this.results();
      this.draw();
    });
  }

  ngOnDestroy(): void {
    this.stopResize();
    this.map?.remove();
    this.map = null;
  }

  private draw(): void {
    const map = this.map;
    const layer = this.layer;
    if (!map || !layer) return;
    const actual = this.actual();
    layer.clearLayers();
    const points: L.LatLngExpression[] = [[actual.lat, actual.lng]];
    this.results().forEach((r, i) => {
      if (!r.guess) return;
      const color = PIN_COLORS[i % PIN_COLORS.length];
      const line = shortestLine(actual, r.guess);
      L.polyline(line, { color, weight: 2, dashArray: '6 6', opacity: 0.8 }).addTo(layer);
      L.circleMarker(line[1], {
        radius: 8,
        color: '#0b0f14',
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindTooltip(r.name, {
          permanent: true,
          direction: 'top',
          offset: [0, -8],
          className: 'reveal-label',
        })
        .addTo(layer);
      points.push(line[1]);
    });
    L.circleMarker([actual.lat, actual.lng], { ...ACTUAL_STYLE, radius: 11 })
      .bindTooltip('Correct location', { direction: 'bottom' })
      .addTo(layer);
    map.invalidateSize();
    if (points.length > 1)
      map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 14 });
    else map.setView([actual.lat, actual.lng], 5);
  }
}

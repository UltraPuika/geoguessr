import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { normalizeHeading } from '../../core/map-io';
import { CoverageStatus, GameMap, LocationOrder, MapLocation } from '../../core/models';
import { haversineDistanceKm, isValidLatLng, formatDistance } from '../../core/scoring';
import { FoundPanorama, ViewTarget } from '../../core/street-view-controller';
import { describeStorageError } from '../../data/db';
import { DatabaseService } from '../../services/database.service';
import { StreetViewService } from '../../services/street-view.service';
import { ToastService } from '../../services/toast.service';
import { UsageService } from '../../services/usage.service';
import { LOCATION_STYLE, SELECTED_STYLE, createBaseMap, observeResize, toLatLng } from '../../shared/leaflet';
import { UsageMeterComponent } from '../../shared/usage-meter.component';
import { downloadJson, formatCoord, safeFileName } from '../../shared/util';

interface Draft {
  id: string | null;
  lat: number;
  lng: number;
  name: string;
  notes: string;
  panoId: string | null;
  heading: number;
  pitch: number;
  zoom: number;
  coverage: CoverageStatus;
}

type CoverageState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'found'; pano: FoundPanorama; movedKm: number }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'app-map-editor',
  imports: [FormsModule, RouterLink, UsageMeterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './map-editor.component.html',
})
export class MapEditorComponent implements OnDestroy {
  readonly id = input.required<string>();

  private readonly db = inject(DatabaseService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly sv = inject(StreetViewService);
  protected readonly usage = inject(UsageService);

  private readonly mapEl = viewChild.required<ElementRef<HTMLElement>>('leafletMap');
  private readonly previewEl = viewChild<ElementRef<HTMLElement>>('preview');

  protected readonly map = signal<GameMap | null>(null);
  protected readonly locations = signal<MapLocation[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly notFound = signal(false);
  protected readonly busy = signal(false);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly coverage = signal<CoverageState>({ kind: 'idle' });
  protected readonly previewState = signal<'none' | 'loading' | 'ready' | 'blocked' | 'no-imagery' | 'error'>('none');
  protected readonly previewMessage = signal<string | null>(null);
  protected readonly checkAllProgress = signal<string | null>(null);

  protected details = { name: '', description: '', defaultOrder: 'random' as LocationOrder };
  protected manual = { lat: '', lng: '' };
  protected readonly manualError = signal<string | null>(null);

  protected readonly formatCoord = formatCoord;
  protected readonly formatDistance = formatDistance;

  protected readonly detailsDirty = signal(false);
  protected readonly previewWillConsume = computed(() => {
    this.previewState();
    const d = this.draft();
    return d ? this.sv.wouldConsume(this.toTarget(d)) : true;
  });

  private leaflet: L.Map | null = null;
  private markerLayer: L.LayerGroup | null = null;
  private draftMarker: L.CircleMarker | null = null;
  private disposeResize: (() => void) | null = null;
  private destroyed = false;
  private coverageSeq = 0;

  constructor() {
    afterNextRender(() => {
      this.initLeaflet();
      void this.load();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    const el = this.previewEl()?.nativeElement;
    if (el) this.sv.detach(el);
    this.disposeResize?.();
    this.leaflet?.remove();
    this.leaflet = null;
  }

  protected async load(): Promise<void> {
    try {
      const map = await this.db.maps.getMap(this.id());
      if (!map) {
        this.notFound.set(true);
        return;
      }
      this.map.set(map);
      this.details = { name: map.name, description: map.description, defaultOrder: map.defaultOrder };
      this.detailsDirty.set(false);
      await this.reloadLocations(true);
    } catch (err) {
      this.loadError.set(describeStorageError(err));
    }
  }

  private async reloadLocations(fit = false): Promise<void> {
    const locs = await this.db.maps.getLocations(this.id());
    this.locations.set(locs);
    this.renderMarkers();
    if (fit && locs.length && this.leaflet) {
      this.leaflet.fitBounds(L.latLngBounds(locs.map((l) => [l.lat, l.lng] as L.LatLngTuple)).pad(0.2), {
        maxZoom: 14,
      });
    }
  }

  private initLeaflet(): void {
    const el = this.mapEl().nativeElement;
    this.leaflet = createBaseMap(el);
    this.markerLayer = L.layerGroup().addTo(this.leaflet);
    this.leaflet.on('click', (e: L.LeafletMouseEvent) => {
      const p = toLatLng(e.latlng);
      this.startDraft({ lat: p.lat, lng: p.lng });
    });
    this.disposeResize = observeResize(this.leaflet, el);
  }

  private renderMarkers(): void {
    if (!this.markerLayer) return;
    this.markerLayer.clearLayers();
    for (const [i, l] of this.locations().entries()) {
      L.circleMarker([l.lat, l.lng], LOCATION_STYLE)
        .bindTooltip(l.name || `#${i + 1}`)
        .on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          this.editLocation(l);
        })
        .addTo(this.markerLayer);
    }
  }

  private setDraftMarker(d: Draft | null): void {
    if (!this.leaflet) return;
    if (!d) {
      this.draftMarker?.remove();
      this.draftMarker = null;
      return;
    }
    if (!this.draftMarker) this.draftMarker = L.circleMarker([d.lat, d.lng], SELECTED_STYLE).addTo(this.leaflet);
    else this.draftMarker.setLatLng([d.lat, d.lng]);
  }

  // ----- Map details -----

  protected markDirty(): void {
    this.detailsDirty.set(true);
  }

  protected async saveDetails(): Promise<void> {
    await this.run(async () => {
      const updated = await this.db.maps.updateMap(this.id(), this.details);
      this.map.set(updated);
      this.detailsDirty.set(false);
      this.toast.success('Map details saved.');
    });
  }

  protected async exportMap(): Promise<void> {
    const m = this.map();
    if (!m) return;
    await this.run(async () => downloadJson(`${safeFileName(m.name)}.json`, await this.db.maps.exportMaps([m.id])));
  }

  protected async deleteMap(): Promise<void> {
    const m = this.map();
    if (!m || !confirm(`Delete "${m.name}" and all ${this.locations().length} location(s)? This cannot be undone.`)) {
      return;
    }
    await this.run(async () => {
      await this.db.maps.deleteMap(m.id);
      this.toast.success(`Deleted "${m.name}".`);
      await this.router.navigate(['/']);
    });
  }

  // ----- Drafting locations -----

  protected addManual(): void {
    const lat = Number(this.manual.lat);
    const lng = Number(this.manual.lng);
    const p = { lat, lng };
    if (this.manual.lat.trim() === '' || this.manual.lng.trim() === '' || !isValidLatLng(p)) {
      this.manualError.set('Enter a latitude between -90 and 90 and a longitude between -180 and 180.');
      return;
    }
    this.manualError.set(null);
    this.startDraft(p);
    this.leaflet?.setView([lat, lng], Math.max(this.leaflet.getZoom(), 15));
  }

  private startDraft(p: { lat: number; lng: number }): void {
    const current = this.draft();
    const d: Draft = {
      id: current?.id ?? null,
      lat: p.lat,
      lng: p.lng,
      name: current?.name ?? '',
      notes: current?.notes ?? '',
      panoId: null,
      heading: current?.heading ?? 0,
      pitch: 0,
      zoom: 1,
      coverage: 'unknown',
    };
    this.draft.set(d);
    this.setDraftMarker(d);
    this.resetPreview();
    void this.checkCoverage();
  }

  protected editLocation(l: MapLocation): void {
    const d: Draft = {
      id: l.id,
      lat: l.lat,
      lng: l.lng,
      name: l.name,
      notes: l.notes,
      panoId: l.panoId,
      heading: l.heading,
      pitch: l.pitch,
      zoom: l.zoom,
      coverage: l.coverage,
    };
    this.draft.set(d);
    this.setDraftMarker(d);
    this.resetPreview();
    this.coverage.set({ kind: 'idle' });
    this.leaflet?.setView([l.lat, l.lng], Math.max(this.leaflet.getZoom(), 14));
  }

  protected async previewLocation(l: MapLocation): Promise<void> {
    this.editLocation(l);
    await this.loadPreview();
  }

  protected cancelDraft(): void {
    this.draft.set(null);
    this.setDraftMarker(null);
    this.resetPreview();
    this.coverage.set({ kind: 'idle' });
  }

  protected updateDraft(patch: Partial<Draft>): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, ...patch });
  }

  protected async checkCoverage(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    if (!this.sv.apiConfigured) {
      this.coverage.set({ kind: 'error', message: 'No Google Maps API key configured; coverage cannot be checked.' });
      return;
    }
    const seq = ++this.coverageSeq;
    this.coverage.set({ kind: 'checking' });
    try {
      const found = await this.sv.checkCoverage({ lat: d.lat, lng: d.lng });
      if (seq !== this.coverageSeq || this.destroyed) return;
      const current = this.draft();
      if (!current) return;
      if (!found) {
        this.coverage.set({ kind: 'missing' });
        this.draft.set({ ...current, coverage: 'missing', panoId: null });
        return;
      }
      const movedKm = haversineDistanceKm(d, found);
      this.coverage.set({ kind: 'found', pano: found, movedKm });
      // Store the panorama's own position so the answer matches the imagery.
      const next = { ...current, lat: found.lat, lng: found.lng, panoId: found.panoId, coverage: 'ok' as const };
      this.draft.set(next);
      this.setDraftMarker(next);
    } catch (err) {
      if (seq !== this.coverageSeq) return;
      this.coverage.set({ kind: 'error', message: err instanceof Error ? err.message : 'Coverage check failed.' });
      this.updateDraft({ coverage: 'error' });
    }
  }

  // ----- Street View preview -----

  private resetPreview(): void {
    this.previewState.set('none');
    this.previewMessage.set(null);
  }

  protected async loadPreview(): Promise<void> {
    const d = this.draft();
    const el = this.previewEl()?.nativeElement;
    if (!d || !el || this.previewState() === 'loading') return;
    this.previewState.set('loading');
    this.previewMessage.set(null);
    try {
      await this.sv.attach(el);
      const result = await this.sv.show(this.toTarget(d), 'editor');
      if (this.destroyed) return;
      switch (result.kind) {
        case 'ok':
          this.previewState.set('ready');
          this.updateDraft({ panoId: result.panoId, lat: result.position.lat, lng: result.position.lng, coverage: 'ok' });
          this.setDraftMarker(this.draft());
          break;
        case 'blocked':
          this.previewState.set('blocked');
          this.previewMessage.set(result.status.message ?? 'Monthly Street View limit reached.');
          break;
        case 'no-imagery':
          this.previewState.set('no-imagery');
          this.updateDraft({ coverage: 'missing', panoId: null });
          break;
        case 'error':
          this.previewState.set('error');
          this.previewMessage.set(result.message);
          break;
      }
    } catch (err) {
      this.previewState.set('error');
      this.previewMessage.set(err instanceof Error ? err.message : 'Street View could not be loaded.');
    }
  }

  protected useCurrentView(): void {
    const v = this.sv.currentView();
    if (!v) return;
    this.updateDraft({
      panoId: v.panoId,
      lat: v.lat,
      lng: v.lng,
      heading: Math.round(normalizeHeading(v.heading) * 10) / 10,
      pitch: Math.round(v.pitch * 10) / 10,
      zoom: Math.round(v.zoom * 100) / 100,
      coverage: 'ok',
    });
    this.setDraftMarker(this.draft());
    this.toast.info('Starting view captured. Save the location to keep it.');
  }

  protected async saveDraft(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    if (!isValidLatLng(d)) {
      this.toast.error('Invalid coordinates.');
      return;
    }
    if (d.coverage === 'missing' && !confirm('No Street View imagery was found here. Save anyway?')) return;
    await this.run(async () => {
      const data = {
        lat: d.lat,
        lng: d.lng,
        name: d.name.trim().slice(0, 200),
        notes: d.notes.trim().slice(0, 2000),
        panoId: d.panoId,
        heading: normalizeHeading(Number(d.heading) || 0),
        pitch: Math.max(-90, Math.min(90, Number(d.pitch) || 0)),
        zoom: Math.max(0, Math.min(5, Number(d.zoom) || 0)),
        coverage: d.coverage,
        coverageCheckedAt: d.coverage === 'unknown' ? null : new Date().toISOString(),
      };
      if (d.id) {
        const existing = this.locations().find((l) => l.id === d.id);
        if (!existing) throw new Error('Location no longer exists.');
        await this.db.maps.updateLocation({ ...existing, ...data });
        this.toast.success('Location updated.');
      } else {
        await this.db.maps.addLocation(this.id(), data);
        this.toast.success('Location added.');
      }
      this.cancelDraft();
      await this.reloadLocations();
      this.map.set((await this.db.maps.getMap(this.id())) ?? this.map());
    });
  }

  // ----- Location list -----

  protected async deleteLocation(l: MapLocation, index: number): Promise<void> {
    if (!confirm(`Delete location ${l.name ? `"${l.name}"` : `#${index + 1}`}?`)) return;
    await this.run(async () => {
      await this.db.maps.deleteLocation(l.id);
      if (this.draft()?.id === l.id) this.cancelDraft();
      await this.reloadLocations();
    });
  }

  protected async move(index: number, delta: -1 | 1): Promise<void> {
    const list = [...this.locations()];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    this.locations.set(list);
    await this.run(async () => {
      await this.db.maps.reorderLocations(
        this.id(),
        list.map((l) => l.id),
      );
      await this.reloadLocations();
    });
  }

  /** Re-checks coverage of every location using free metadata lookups. */
  protected async checkAllCoverage(): Promise<void> {
    const list = this.locations();
    if (!list.length || this.checkAllProgress()) return;
    let missing = 0;
    try {
      for (const [i, l] of list.entries()) {
        if (this.destroyed) return;
        this.checkAllProgress.set(`Checking ${i + 1} / ${list.length}…`);
        const found = await this.sv.checkCoverage(l);
        const coverage: CoverageStatus = found ? 'ok' : 'missing';
        if (!found) missing++;
        await this.db.maps.updateLocation({ ...l, coverage, coverageCheckedAt: new Date().toISOString() });
      }
      this.toast[missing ? 'error' : 'success'](
        missing ? `${missing} location(s) have no Street View imagery.` : 'All locations have Street View imagery.',
      );
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Coverage check failed.');
    } finally {
      this.checkAllProgress.set(null);
      await this.reloadLocations();
    }
  }

  private toTarget(d: Draft): ViewTarget {
    return { lat: d.lat, lng: d.lng, panoId: d.panoId, heading: d.heading, pitch: d.pitch, zoom: d.zoom };
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await fn();
    } catch (err) {
      this.toast.error(describeStorageError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

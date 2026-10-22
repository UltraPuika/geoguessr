import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { GAME_MODE_LABELS, GameWithRounds } from '../../core/models';
import { formatDistance } from '../../core/scoring';
import { describeStorageError } from '../../data/db';
import { ActiveGameService } from '../../services/active-game.service';
import { DatabaseService } from '../../services/database.service';
import { ToastService } from '../../services/toast.service';
import { UsageService } from '../../services/usage.service';
import { ACTUAL_STYLE, GUESS_STYLE, LINE_STYLE, createBaseMap, observeResize, shortestLine } from '../../shared/leaflet';
import { formatCoord, formatDate } from '../../shared/util';

@Component({
  selector: 'app-results',
  imports: [DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './results.component.html',
})
export class ResultsComponent implements OnDestroy {
  readonly id = input.required<string>();

  private readonly db = inject(DatabaseService);
  private readonly router = inject(Router);
  private readonly game = inject(ActiveGameService);
  private readonly toast = inject(ToastService);
  private readonly usage = inject(UsageService);
  private readonly mapEl = viewChild<ElementRef<HTMLElement>>('resultsMap');

  protected readonly data = signal<GameWithRounds | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly mapExists = signal(false);
  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly formatDistance = formatDistance;
  protected readonly formatCoord = formatCoord;
  protected readonly formatDate = formatDate;

  private leaflet: L.Map | null = null;
  private disposeResize: (() => void) | null = null;

  constructor() {
    afterNextRender(() => void this.load());
  }

  ngOnDestroy(): void {
    this.disposeResize?.();
    this.leaflet?.remove();
  }

  private async load(): Promise<void> {
    try {
      const data = await this.db.history.getGame(this.id());
      if (!data) {
        this.error.set('Result not found.');
        return;
      }
      this.data.set(data);
      this.mapExists.set(!!(await this.db.maps.getMap(data.game.setup.mapId)));
      setTimeout(() => {
        this.drawMap(data);
        this.leaflet?.invalidateSize();
      }, 0);
    } catch (err) {
      this.error.set(describeStorageError(err));
    } finally {
      this.loading.set(false);
    }
  }

  private drawMap(data: GameWithRounds): void {
    const el = this.mapEl()?.nativeElement;
    if (!el || this.leaflet) return;
    this.leaflet = createBaseMap(el);
    this.disposeResize = observeResize(this.leaflet, el);
    const points: L.LatLngExpression[] = [];
    for (const r of data.rounds) {
      const label = `Round ${r.index + 1}`;
      L.circleMarker([r.actual.lat, r.actual.lng], ACTUAL_STYLE).bindTooltip(`${label}: correct`).addTo(this.leaflet);
      points.push([r.actual.lat, r.actual.lng]);
      if (r.guess) {
        const line = shortestLine(r.actual, r.guess);
        L.polyline(line, LINE_STYLE).addTo(this.leaflet);
        L.circleMarker(line[1], GUESS_STYLE).bindTooltip(`${label}: your guess`).addTo(this.leaflet);
        points.push(line[1]);
      }
    }
    if (points.length) this.leaflet.fitBounds(L.latLngBounds(points as L.LatLngTuple[]).pad(0.2), { maxZoom: 14 });
  }

  /** Same map and settings, freshly ordered locations. */
  protected async replay(): Promise<void> {
    const d = this.data();
    if (!d) return;
    try {
      const locations = await this.db.maps.getLocations(d.game.setup.mapId);
      const map = await this.db.maps.getMap(d.game.setup.mapId);
      if (!map || !locations.length) {
        this.toast.error('The map no longer exists or has no locations.');
        return;
      }
      const status = await this.usage.refresh();
      if (status.blocked) {
        this.toast.error(status.message ?? 'Monthly Street View limit reached.');
        return;
      }
      this.game.start({ ...d.game.setup, mapName: map.name }, locations);
      await this.router.navigate(['/game']);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Could not start the game.');
    }
  }
}

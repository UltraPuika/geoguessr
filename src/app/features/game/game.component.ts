import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { GameSession } from '../../core/game-engine';
import { GAME_MODE_LABELS, LatLng, RoundResult, SubmitReason } from '../../core/models';
import { formatDistance } from '../../core/scoring';
import { ViewTarget } from '../../core/street-view-controller';
import { RoundTimer, formatClock } from '../../core/timer';
import { describeStorageError } from '../../data/db';
import { ActiveGameService } from '../../services/active-game.service';
import { StreetViewService } from '../../services/street-view.service';
import { UsageService } from '../../services/usage.service';
import {
  ACTUAL_STYLE,
  GUESS_STYLE,
  LINE_STYLE,
  createBaseMap,
  observeResize,
  shortestLine,
  toLatLng,
} from '../../shared/leaflet';
import { formatCoord, formatDate, isTypingTarget } from '../../shared/util';

type RoundLoad = 'loading' | 'ready' | 'blocked' | 'no-imagery' | 'error';

@Component({
  selector: 'app-game',
  imports: [DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './game.component.html',
})
export class GameComponent implements OnDestroy {
  private readonly game = inject(ActiveGameService);
  private readonly sv = inject(StreetViewService);
  private readonly router = inject(Router);
  protected readonly usage = inject(UsageService);

  private readonly svEl = viewChild<ElementRef<HTMLElement>>('svContainer');
  private readonly mapEl = viewChild<ElementRef<HTMLElement>>('guessMap');
  private readonly nextBtn = viewChild<ElementRef<HTMLButtonElement>>('nextBtn');

  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly formatDistance = formatDistance;
  protected readonly formatCoord = formatCoord;
  protected readonly formatDate = formatDate;

  private readonly snapshot = computed(() => {
    this.game.version();
    const s = this.game.session();
    if (!s) return null;
    return {
      session: s,
      index: s.index,
      total: s.totalRounds,
      phase: s.phase,
      guess: s.guess,
      result: s.lastResult,
      isLast: s.isLastRound,
      finished: s.isFinished,
      totalScore: s.roundResults.reduce((sum, r) => sum + r.score, 0),
      scores: s.roundResults.map((r) => r.score),
      dots: Array.from({ length: s.totalRounds }, (_, i) => i),
    };
  });

  protected readonly state = this.snapshot;
  protected readonly load = signal<RoundLoad>('loading');
  protected readonly loadMessage = signal<string | null>(null);
  protected readonly remainingMs = signal<number | null>(null);
  protected readonly mapSize = signal<MapSize>(loadMapSize());
  protected readonly heading = this.sv.heading;
  protected readonly compassLabel = computed(() => {
    const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const h = ((this.heading() % 360) + 360) % 360;
    return dirs[Math.round(h / 45) % 8];
  });
  protected readonly saveError = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly timerText = computed(() => {
    const ms = this.remainingMs();
    return ms === null ? null : formatClock(ms);
  });
  protected readonly timerUrgent = computed(() => {
    const ms = this.remainingMs();
    return ms !== null && ms <= 10_000;
  });
  protected readonly locked = computed(() => this.snapshot()?.phase === 'submitted');
  protected readonly canSubmit = computed(() => {
    const s = this.snapshot();
    return !!s && s.phase === 'guessing' && s.guess !== null;
  });

  private leaflet: L.Map | null = null;
  private guessMarker: L.CircleMarker | null = null;
  private resultLayer: L.LayerGroup | null = null;
  private disposeResize: (() => void) | null = null;
  private timer: RoundTimer | null = null;
  private timerRound = -1;
  private loadSeq = 0;
  private submittedAt = 0;
  private destroyed = false;

  constructor() {
    if (!this.game.session()) {
      void this.router.navigate(['/']);
      return;
    }
    afterNextRender(() => {
      this.initMap();
      void this.startRound();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.timer?.stop();
    const el = this.svEl()?.nativeElement;
    if (el) this.sv.detach(el);
    this.disposeResize?.();
    this.leaflet?.remove();
    this.leaflet = null;
  }

  @HostListener('document:visibilitychange')
  onVisibility(): void {
    // The deadline is absolute; re-check immediately when the tab becomes active again.
    this.timer?.check();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || isTypingTarget(e) || e.repeat) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Focused buttons and links keep their native activation.
    const el = e.target as HTMLElement | null;
    if (el?.closest('button, a')) return;
    const s = this.snapshot();
    if (!s) return;
    if (s.phase === 'guessing' && s.guess) {
      e.preventDefault();
      this.submit('manual');
    } else if (s.phase === 'submitted') {
      e.preventDefault();
      void this.next();
    }
  }

  private initMap(): void {
    const el = this.mapEl()?.nativeElement;
    if (!el) return;
    this.leaflet = createBaseMap(el, { zoomControl: true });
    this.resultLayer = L.layerGroup().addTo(this.leaflet);
    this.leaflet.on('click', (e: L.LeafletMouseEvent) => this.placeGuess(toLatLng(e.latlng)));
    this.disposeResize = observeResize(this.leaflet, el);
  }

  private targetFor(s: GameSession): ViewTarget {
    const l = s.currentLocation;
    return { lat: l.lat, lng: l.lng, panoId: l.panoId, heading: l.heading, pitch: l.pitch, zoom: l.zoom };
  }

  protected async startRound(): Promise<void> {
    const s = this.game.session();
    const el = this.svEl()?.nativeElement;
    if (!s || !el || s.isFinished) return;
    const seq = ++this.loadSeq;
    const roundIndex = s.index;
    this.load.set('loading');
    this.loadMessage.set(null);
    this.remainingMs.set(s.setup.timeLimitSec === null ? null : s.setup.timeLimitSec * 1000);
    try {
      await this.sv.attach(el);
      const result = await this.sv.show(this.targetFor(s), s.setup.mode);
      if (this.destroyed || seq !== this.loadSeq || s.index !== roundIndex) return;
      switch (result.kind) {
        case 'ok':
          this.load.set('ready');
          this.game.mutate((g) => g.markRoundReady());
          this.startTimer(s, roundIndex);
          break;
        case 'blocked':
          this.load.set('blocked');
          this.loadMessage.set(result.status.message ?? 'The monthly Street View limit has been reached.');
          break;
        case 'no-imagery':
          this.load.set('no-imagery');
          break;
        case 'error':
          this.load.set('error');
          this.loadMessage.set(result.message);
          break;
      }
    } catch (err) {
      if (this.destroyed || seq !== this.loadSeq) return;
      this.load.set('error');
      this.loadMessage.set(err instanceof Error ? err.message : 'Street View could not be loaded.');
    }
  }

  private startTimer(s: GameSession, roundIndex: number): void {
    // One timer per round: re-renders or panorama changes never restart it.
    if (this.timerRound === roundIndex && this.timer) return;
    this.timer?.stop();
    this.timerRound = roundIndex;
    const limit = s.setup.timeLimitSec === null ? null : s.setup.timeLimitSec * 1000;
    this.timer = new RoundTimer(
      limit,
      (ms) => this.remainingMs.set(ms),
      () => this.submit('timeout'),
    );
    this.timer.start();
  }

  protected placeGuess(p: LatLng): void {
    const ok = this.game.mutate((g) => g.placeGuess(p));
    if (!ok || !this.leaflet) return;
    if (!this.guessMarker) {
      this.guessMarker = L.circleMarker([p.lat, p.lng], { ...GUESS_STYLE, interactive: false }).addTo(this.leaflet);
    } else {
      this.guessMarker.setLatLng([p.lat, p.lng]);
    }
  }

  protected clearGuess(): void {
    if (this.game.mutate((g) => g.clearGuess())) {
      this.guessMarker?.remove();
      this.guessMarker = null;
    }
  }

  protected submit(reason: SubmitReason): void {
    const result = this.game.mutate((g) => g.submit(reason));
    if (!result) return;
    this.submittedAt = performance.now();
    this.timer?.stop();
    this.showResult(result);
    setTimeout(() => this.nextBtn()?.nativeElement.focus(), 0);
  }

  protected returnToStart(): void {
    this.sv.returnToStart();
  }

  private showResult(r: RoundResult): void {
    const map = this.leaflet;
    if (!map || !this.resultLayer) return;
    this.guessMarker?.remove();
    this.guessMarker = null;
    this.resultLayer.clearLayers();
    L.circleMarker([r.actual.lat, r.actual.lng], ACTUAL_STYLE).bindTooltip('Correct location').addTo(this.resultLayer);
    if (r.guess) {
      const line = shortestLine(r.actual, r.guess);
      L.polyline(line, LINE_STYLE).addTo(this.resultLayer);
      L.circleMarker(line[1], GUESS_STYLE).bindTooltip('Your guess').addTo(this.resultLayer);
      setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(L.latLngBounds(line), { padding: [50, 50], maxZoom: 16 });
      }, 250);
    } else {
      setTimeout(() => {
        map.invalidateSize();
        map.setView([r.actual.lat, r.actual.lng], 5);
      }, 250);
    }
  }

  protected async next(): Promise<void> {
    // Ignore an advance triggered by the same key press that submitted the guess.
    if (performance.now() - this.submittedAt < 400) return;
    const s = this.game.session();
    if (!s) return;
    if (s.isFinished) {
      await this.finish();
      return;
    }
    if (s.phase !== 'submitted') return;
    if (s.isLastRound) {
      if (!this.game.mutate((g) => g.next())) return;
      await this.finish();
      return;
    }
    if (!this.game.mutate((g) => g.next())) return;
    this.resultLayer?.clearLayers();
    this.timer?.stop();
    this.timer = null;
    this.leaflet?.setView([20, 0], 2);
    await this.startRound();
  }

  protected async finish(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const id = await this.game.saveFinished();
      this.game.clear();
      await this.router.navigate(['/results', id]);
    } catch (err) {
      this.saveError.set(describeStorageError(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected skipRound(): void {
    this.submit('skipped');
  }

  protected quit(): void {
    if (!confirm('Quit this game? Progress will not be saved.')) return;
    this.game.clear();
    void this.router.navigate(['/']);
  }

  protected resizeMap(delta: -1 | 1): void {
    const next = Math.min(3, Math.max(0, this.mapSize() + delta)) as MapSize;
    this.mapSize.set(next);
    try {
      localStorage.setItem(MAP_SIZE_KEY, String(next));
    } catch {
      // Preference only; ignore storage failures.
    }
  }
}

type MapSize = 0 | 1 | 2 | 3;
const MAP_SIZE_KEY = 'geoguess.guessMapSize';

function loadMapSize(): MapSize {
  try {
    const raw = localStorage.getItem(MAP_SIZE_KEY);
    const v = raw === null ? NaN : Number(raw);
    if (v === 0 || v === 1 || v === 2 || v === 3) return v;
  } catch {
    // Fall through to default.
  }
  return 1;
}

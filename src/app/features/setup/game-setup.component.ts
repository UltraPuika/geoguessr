import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { USAGE_CONFIG } from '../../config/usage-config';
import { describeRoundPlan } from '../../core/game-engine';
import {
  DEFAULT_PREFERENCES,
  GAME_MODE_LABELS,
  GameMap,
  GameMode,
  GameSetup,
  LocationOrder,
  MapLocation,
  ScoringScale,
} from '../../core/models';
import { DEFAULT_SCORING, WORLD_DIAGONAL_KM, mapScaleKm } from '../../core/scoring';
import { describeStorageError } from '../../data/db';
import { ActiveGameService } from '../../services/active-game.service';
import { DatabaseService } from '../../services/database.service';
import { StreetViewService } from '../../services/street-view.service';
import { ToastService } from '../../services/toast.service';
import { UsageService } from '../../services/usage.service';
import { UsageMeterComponent } from '../../shared/usage-meter.component';

const TIMER_PRESETS: { label: string; value: number | null }[] = [
  { label: 'No limit', value: null },
  { label: '15 s', value: 15 },
  { label: '30 s', value: 30 },
  { label: '60 s', value: 60 },
  { label: '2 min', value: 120 },
];

const MODE_HELP: Record<GameMode, string> = {
  moving: 'Walk around, pan and zoom freely.',
  'no-move': 'Look around and zoom, but you cannot leave the starting panorama.',
  nmpz: 'No moving, panning or zooming: one fixed view.',
};

@Component({
  selector: 'app-game-setup',
  imports: [FormsModule, RouterLink, DecimalPipe, UsageMeterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './game-setup.component.html',
})
export class GameSetupComponent implements OnInit {
  readonly mapId = input.required<string>();

  private readonly db = inject(DatabaseService);
  private readonly router = inject(Router);
  private readonly game = inject(ActiveGameService);
  private readonly toast = inject(ToastService);
  private readonly sv = inject(StreetViewService);
  protected readonly usage = inject(UsageService);

  protected readonly map = signal<GameMap | null>(null);
  protected readonly locations = signal<MapLocation[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly starting = signal(false);

  protected readonly rounds = signal(DEFAULT_PREFERENCES.rounds);
  protected readonly timerChoice = signal<string>('none');
  protected readonly customSeconds = signal(90);
  protected readonly mode = signal<GameMode>(DEFAULT_PREFERENCES.mode);
  protected readonly order = signal<LocationOrder>('random');
  protected readonly allowRepeats = signal(false);
  protected readonly scoringScale = signal<ScoringScale>('world');

  protected readonly timerPresets = TIMER_PRESETS;
  protected readonly modes: GameMode[] = ['moving', 'no-move', 'nmpz'];
  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly modeHelp = MODE_HELP;
  protected readonly apiConfigured = this.sv.apiConfigured;

  protected readonly timeLimitSec = computed<number | null>(() => {
    const c = this.timerChoice();
    if (c === 'none') return null;
    if (c === 'custom') {
      const s = Math.round(this.customSeconds());
      return Number.isFinite(s) ? Math.min(3600, Math.max(5, s)) : 60;
    }
    return Number(c);
  });

  protected readonly plan = computed(() =>
    describeRoundPlan(this.locations().length, Math.min(50, Math.max(1, this.rounds() || 1)), this.allowRepeats()),
  );

  protected readonly maxScore = computed(() => this.plan().effectiveRounds * DEFAULT_SCORING.maxScore);

  protected readonly scaleKm = computed(() =>
    this.scoringScale() === 'map' ? mapScaleKm(this.locations()) : WORLD_DIAGONAL_KM / 10,
  );

  /** Upper bound of Street View units this game can reserve. */
  protected readonly estimatedLoads = computed(() => {
    const n = this.plan().effectiveRounds;
    if (n === 0) return 0;
    if (USAGE_CONFIG.countProgrammaticLocationChanges) return n;
    return this.sv.hasViewer() ? 0 : 1;
  });

  protected readonly usageProblem = computed(() => {
    const s = this.usage.status();
    if (!s) return null;
    if (s.state !== 'ok') return s.message;
    if (s.remaining < this.estimatedLoads()) {
      return `This game may need up to ${this.estimatedLoads()} Street View loads, but only ${s.remaining} remain this month. Reduce the number of rounds or wait for the reset.`;
    }
    return null;
  });

  async ngOnInit(): Promise<void> {
    try {
      const [map, locations, prefs] = await Promise.all([
        this.db.maps.getMap(this.mapId()),
        this.db.maps.getLocations(this.mapId()),
        this.db.settings.getPreferences().catch(() => DEFAULT_PREFERENCES),
      ]);
      if (!map) {
        this.error.set('Map not found.');
        return;
      }
      this.map.set(map);
      this.locations.set(locations);
      this.rounds.set(prefs.rounds);
      this.mode.set(prefs.mode);
      this.allowRepeats.set(prefs.allowRepeats);
      this.scoringScale.set(prefs.scoringScale);
      this.order.set(map.defaultOrder);
      const preset = TIMER_PRESETS.find((p) => p.value === prefs.timeLimitSec);
      if (preset) this.timerChoice.set(preset.value === null ? 'none' : String(preset.value));
      else if (prefs.timeLimitSec !== null) {
        this.timerChoice.set('custom');
        this.customSeconds.set(prefs.timeLimitSec);
      }
      await this.usage.refresh();
    } catch (err) {
      this.error.set(describeStorageError(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected useAllLocations(): void {
    this.rounds.set(Math.min(50, this.locations().length));
  }

  protected async start(): Promise<void> {
    const map = this.map();
    if (!map || this.starting() || this.plan().effectiveRounds === 0) return;
    this.starting.set(true);
    try {
      const status = await this.usage.refresh();
      if (status.blocked || this.usageProblem()) {
        this.toast.error(this.usageProblem() ?? 'Street View is blocked.');
        return;
      }
      const setup: GameSetup = {
        mapId: map.id,
        mapName: map.name,
        rounds: this.plan().effectiveRounds,
        timeLimitSec: this.timeLimitSec(),
        mode: this.mode(),
        order: this.order(),
        allowRepeats: this.allowRepeats(),
        scoringScale: this.scoringScale(),
      };
      await this.db.settings
        .savePreferences({
          rounds: Math.min(50, Math.max(1, this.rounds())),
          timeLimitSec: setup.timeLimitSec,
          mode: setup.mode,
          allowRepeats: setup.allowRepeats,
          scoringScale: setup.scoringScale,
        })
        .catch(() => undefined);
      this.game.start(setup, this.locations());
      await this.router.navigate(['/game']);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Could not start the game.');
    } finally {
      this.starting.set(false);
    }
  }
}

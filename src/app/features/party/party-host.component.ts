import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { GAME_MODE_LABELS } from '../../core/models';
import { DEFAULT_SCORING, formatDistance } from '../../core/scoring';
import { formatClock } from '../../core/timer';
import { PartyHostService } from '../../services/party-host.service';
import { ToastService } from '../../services/toast.service';
import { RevealMapComponent } from './reveal-map.component';

@Component({
  selector: 'app-party-host',
  imports: [DecimalPipe, RouterLink, RevealMapComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './party-host.component.html',
})
export class PartyHostComponent {
  protected readonly host = inject(PartyHostService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly formatDistance = formatDistance;
  protected readonly qrDataUrl = signal<string | null>(null);
  private readonly now = signal(Date.now());

  protected readonly joinUrl = computed(() => {
    const code = this.host.code();
    if (!code) return null;
    const { origin, pathname, search } = window.location;
    return `${origin}${pathname}${search}#/join/${code}`;
  });
  protected readonly maxScore = computed(
    () => (this.host.game()?.locations.length ?? 0) * DEFAULT_SCORING.maxScore,
  );
  protected readonly isLocalhost = /^(localhost|127\.|\[::1\])/.test(window.location.hostname);

  protected readonly totalRounds = computed(() => this.host.game()?.locations.length ?? 0);
  protected readonly timerText = computed(() => {
    const endsAt = this.host.roundEndsAt();
    return endsAt === null ? null : formatClock(Math.max(0, endsAt - this.now()));
  });
  protected readonly timerUrgent = computed(() => {
    const endsAt = this.host.roundEndsAt();
    return endsAt !== null && endsAt - this.now() <= 10_000;
  });
  protected readonly revealLocation = computed(() => {
    const phase = this.host.phase();
    return phase?.kind === 'reveal' ? (this.host.game()?.locations[phase.round] ?? null) : null;
  });
  protected readonly podium = computed(() => this.host.board().slice(0, 3));

  constructor() {
    effect(() => {
      const url = this.joinUrl();
      this.qrDataUrl.set(null);
      if (url) void this.renderQr(url);
    });
    const tick = setInterval(() => {
      if (this.host.roundEndsAt() !== null) this.now.set(Date.now());
    }, 250);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  /** Positions gained (positive) or lost since the previous round. */
  protected rankChange(playerId: string, index: number): number {
    const before = this.host.previousPositions().get(playerId);
    return before === undefined ? 0 : before - (index + 1);
  }

  protected hasAnswered(playerId: string): boolean {
    return this.host.guesses().has(playerId);
  }

  protected startOrNext(): void {
    this.host.nextRound();
  }

  protected endRound(): void {
    const missing = this.host.board().length - this.host.answeredCount();
    if (missing > 0 && !confirm(`End the round now? ${missing} player${missing === 1 ? ' has' : 's have'} not answered and score 0.`))
      return;
    this.host.endRound();
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    // Closing this tab ends the party for every phone.
    if (this.host.active()) e.preventDefault();
  }

  private async renderQr(url: string): Promise<void> {
    const mod = await import('qrcode');
    // CommonJS interop differs between dev and production builds: the API may sit on `default`.
    const toDataURL = mod.toDataURL ?? (mod as unknown as { default: typeof mod }).default.toDataURL;
    const data = await toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M' });
    if (this.joinUrl() === url) this.qrDataUrl.set(data);
  }

  protected async copyLink(): Promise<void> {
    const url = this.joinUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('Join link copied.');
    } catch {
      this.toast.error('Could not copy. Select the link and copy it manually.');
    }
  }

  protected retry(): void {
    const game = this.host.game();
    if (game) void this.host.open(game);
  }

  protected remove(playerId: string, name: string): void {
    if (confirm(`Remove ${name} from the leaderboard?`)) this.host.removePlayer(playerId);
  }

  protected end(): void {
    if (
      this.host.board().length &&
      !confirm('End the party? Phones are disconnected and the leaderboard is cleared.')
    )
      return;
    const mapId = this.host.game()?.setup.mapId;
    this.host.close();
    void this.router.navigate(mapId ? ['/play', mapId] : ['/']);
  }
}

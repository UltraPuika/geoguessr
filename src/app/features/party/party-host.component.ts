import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { GAME_MODE_LABELS } from '../../core/models';
import { DEFAULT_SCORING } from '../../core/scoring';
import { PartyHostService } from '../../services/party-host.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-party-host',
  imports: [DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './party-host.component.html',
})
export class PartyHostComponent {
  protected readonly host = inject(PartyHostService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly qrDataUrl = signal<string | null>(null);

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

  constructor() {
    effect(() => {
      const url = this.joinUrl();
      this.qrDataUrl.set(null);
      if (url) void this.renderQr(url);
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    // Closing this tab ends the party for every phone.
    if (this.host.active()) e.preventDefault();
  }

  private async renderQr(url: string): Promise<void> {
    const { toDataURL } = await import('qrcode');
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

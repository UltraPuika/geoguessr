import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { USAGE_CONFIG } from '../../config/usage-config';
import { GAME_MODE_LABELS } from '../../core/models';
import { MAX_NAME_LENGTH, normalizePartyCode } from '../../core/party-protocol';
import { DEFAULT_SCORING } from '../../core/scoring';
import { ActiveGameService } from '../../services/active-game.service';
import { PartyClientService } from '../../services/party-client.service';
import { StreetViewService } from '../../services/street-view.service';
import { UsageService } from '../../services/usage.service';

@Component({
  selector: 'app-party-join',
  imports: [DecimalPipe, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './party-join.component.html',
})
export class PartyJoinComponent {
  readonly code = input<string>();

  protected readonly party = inject(PartyClientService);
  private readonly activeGame = inject(ActiveGameService);
  private readonly sv = inject(StreetViewService);
  private readonly usage = inject(UsageService);
  private readonly router = inject(Router);

  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly maxNameLength = MAX_NAME_LENGTH;
  protected readonly apiConfigured = this.sv.apiConfigured;
  protected readonly nameInput = signal(this.party.name());
  protected readonly codeInput = signal('');
  protected readonly formError = signal<string | null>(null);
  protected readonly starting = signal(false);

  protected readonly validCode = computed(() => normalizePartyCode(this.code() ?? ''));
  protected readonly maxScore = computed(
    () => (this.party.game()?.locations.length ?? 0) * DEFAULT_SCORING.maxScore,
  );
  /** Finished here, or already finished on this tab before a reload. */
  protected readonly done = computed(
    () => this.party.phase() === 'done' || !!this.party.me()?.finished,
  );
  protected readonly hasSession = computed(() => {
    this.activeGame.version();
    return this.party.ownsSession(this.activeGame.session());
  });

  constructor() {
    effect(() => {
      const code = this.validCode();
      if (code) untracked(() => void this.party.join(code));
    });
    // Live: the host started a round, so this phone joins in (also when it joined late).
    effect(() => {
      const phase = this.party.livePhase();
      const game = this.party.game();
      if (!game || !this.party.isLive() || !this.party.liveJoined() || phase?.kind !== 'round') return;
      if (untracked(() => this.party.phase() === 'done' || this.hasSession())) return;
      untracked(() => {
        const session = this.activeGame.startPlanned(game);
        this.activeGame.mutate((s) => s.advanceTo(phase.round));
        this.party.bindSession(session);
        void this.router.navigate(['/game']);
      });
    });
  }

  protected openCode(): void {
    const code = normalizePartyCode(this.codeInput());
    if (!code) {
      this.formError.set('A party code has 6 letters or digits, shown under the QR code.');
      return;
    }
    this.formError.set(null);
    void this.router.navigate(['/join', code]);
  }

  protected async start(): Promise<void> {
    const game = this.party.game();
    if (!game || this.starting()) return;
    const name = this.party.setName(this.nameInput());
    this.nameInput.set(name);
    if (!name) {
      this.formError.set('Enter a name for the leaderboard.');
      return;
    }
    this.starting.set(true);
    this.formError.set(null);
    try {
      const status = await this.usage.refresh();
      const needed = USAGE_CONFIG.countProgrammaticLocationChanges
        ? game.locations.length
        : this.sv.hasViewer()
          ? 0
          : 1;
      if (status.state !== 'ok' || status.blocked) {
        this.formError.set(status.message ?? 'Street View is blocked on this device.');
        return;
      }
      if (status.remaining < needed) {
        this.formError.set(
          `This game needs up to ${needed} Street View loads, but this device only has ${status.remaining} left this month.`,
        );
        return;
      }
      if (game.pace === 'live') {
        // The game itself starts when the host starts a round.
        this.party.joinLive();
        return;
      }
      const session = this.activeGame.startPlanned(game);
      this.party.bindSession(session);
      await this.router.navigate(['/game']);
    } catch (err) {
      this.formError.set(err instanceof Error ? err.message : 'Could not start the game.');
    } finally {
      this.starting.set(false);
    }
  }

  protected resume(): void {
    void this.router.navigate(['/game']);
  }

  protected leave(): void {
    this.party.leave();
    void this.router.navigate(['/join']);
  }
}

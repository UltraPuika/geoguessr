import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { GAME_MODE_LABELS, GameRecord } from '../../core/models';
import { formatDistance } from '../../core/scoring';
import { describeStorageError } from '../../data/db';
import { DatabaseService } from '../../services/database.service';
import { ToastService } from '../../services/toast.service';
import { formatDate } from '../../shared/util';

@Component({
  selector: 'app-history',
  imports: [DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="section-head">
        <h1>Game history</h1>
        @if (games()?.length) {
          <button type="button" class="btn btn-ghost btn-danger" (click)="clearAll()">Clear history</button>
        }
      </div>
      <p class="muted small">Stored only in this browser. History does not sync between devices.</p>
      @if (error()) {
        <div class="alert alert-error" role="alert">{{ error() }}</div>
      }
      @if (games() === null) {
        <p class="muted">Loading…</p>
      } @else if (!games()!.length) {
        <div class="empty card">
          <h2>No games yet</h2>
          <p>Finished games appear here.</p>
          <a routerLink="/" class="btn btn-primary">Pick a map</a>
        </div>
      } @else {
        <div class="card table-wrap">
          <table class="rounds-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Map</th>
                <th scope="col">Mode</th>
                <th scope="col">Rounds</th>
                <th scope="col">Avg. distance</th>
                <th scope="col" class="num">Score</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (g of games(); track g.id) {
                <tr>
                  <td>{{ formatDate(g.playedAt) }}</td>
                  <td>{{ g.setup.mapName }}</td>
                  <td>{{ modeLabels[g.setup.mode] }}</td>
                  <td>{{ g.roundCount }}</td>
                  <td>{{ formatDistance(g.averageDistanceKm) }}</td>
                  <td class="num"><strong>{{ g.totalScore | number }}</strong> / {{ g.maxScore | number }}</td>
                  <td class="row-actions">
                    <a class="btn btn-small" [routerLink]="['/results', g.id]">View</a>
                    <button type="button" class="btn btn-small btn-ghost btn-danger" (click)="remove(g)">Delete</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class HistoryComponent implements OnInit {
  private readonly db = inject(DatabaseService);
  private readonly toast = inject(ToastService);
  protected readonly games = signal<GameRecord[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly formatDate = formatDate;
  protected readonly formatDistance = formatDistance;

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.games.set(await this.db.history.listGames());
    } catch (err) {
      this.error.set(describeStorageError(err));
      this.games.set([]);
    }
  }

  protected async remove(g: GameRecord): Promise<void> {
    if (!confirm(`Delete the ${g.setup.mapName} game from ${formatDate(g.playedAt)}?`)) return;
    try {
      await this.db.history.deleteGame(g.id);
      await this.load();
    } catch (err) {
      this.toast.error(describeStorageError(err));
    }
  }

  protected async clearAll(): Promise<void> {
    if (!confirm('Delete all game history? Maps are not affected. This cannot be undone.')) return;
    try {
      await this.db.history.clearAll();
      this.toast.success('History cleared.');
      await this.load();
    } catch (err) {
      this.toast.error(describeStorageError(err));
    }
  }
}

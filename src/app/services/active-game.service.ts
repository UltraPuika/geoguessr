import { Injectable, inject, signal } from '@angular/core';
import { GameSession, buildGameRecord, planRounds } from '../core/game-engine';
import { createId } from '../core/id';
import { GameSetup, MapLocation } from '../core/models';
import { DEFAULT_SCORING, WORLD_DIAGONAL_KM, mapScaleKm } from '../core/scoring';
import { DatabaseService } from './database.service';

/** Holds the in-progress game so it survives component re-creation. */
@Injectable({ providedIn: 'root' })
export class ActiveGameService {
  private readonly db = inject(DatabaseService);
  private readonly _session = signal<GameSession | null>(null);
  /** Incremented after every mutation of the (mutable) session. */
  readonly version = signal(0);
  readonly session = this._session.asReadonly();
  private saving: Promise<string> | null = null;

  start(setup: GameSetup, mapLocations: readonly MapLocation[]): GameSession {
    const plan = planRounds(mapLocations, setup.rounds, setup.order, setup.allowRepeats);
    if (plan.effectiveRounds === 0) throw new Error(plan.message ?? 'Nothing to play.');
    const scaleKm = setup.scoringScale === 'map' ? mapScaleKm(mapLocations) : WORLD_DIAGONAL_KM / 10;
    const session = new GameSession({ ...setup, rounds: plan.effectiveRounds }, plan.locations, {
      ...DEFAULT_SCORING,
      scaleKm,
    });
    this.saving = null;
    this._session.set(session);
    this.version.update((v) => v + 1);
    return session;
  }

  mutate<T>(fn: (s: GameSession) => T): T | undefined {
    const s = this._session();
    if (!s) return undefined;
    const out = fn(s);
    this.version.update((v) => v + 1);
    return out;
  }

  /** Persists the finished game exactly once and returns its ID. */
  saveFinished(): Promise<string> {
    const s = this._session();
    if (!s || !s.isFinished) return Promise.reject(new Error('No finished game to save.'));
    this.saving ??= (async () => {
      const id = createId();
      await this.db.history.saveGame(buildGameRecord(id, s, new Date()), s.roundResults);
      return id;
    })().catch((err) => {
      this.saving = null;
      throw err;
    });
    return this.saving;
  }

  clear(): void {
    this._session.set(null);
    this.saving = null;
  }
}

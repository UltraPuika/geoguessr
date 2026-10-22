import { DEFAULT_PREFERENCES, GamePreferences, GameRecord, GameWithRounds, RoundResult } from '../core/models';
import { StoredRound } from './db';
import { DbProvider } from './usage-repository';

export class HistoryRepository {
  constructor(private readonly db: DbProvider) {}

  async saveGame(game: GameRecord, rounds: readonly RoundResult[]): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['games', 'rounds'], 'readwrite');
    await tx.objectStore('games').add(game);
    for (const r of rounds) {
      await tx.objectStore('rounds').add({ ...r, gameId: game.id });
    }
    await tx.done;
  }

  /** Most recent first. */
  async listGames(limit?: number): Promise<GameRecord[]> {
    const db = await this.db();
    const out: GameRecord[] = [];
    let cursor = await db.transaction('games').store.index('byPlayedAt').openCursor(null, 'prev');
    while (cursor && (limit === undefined || out.length < limit)) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }

  async getGame(id: string): Promise<GameWithRounds | undefined> {
    const db = await this.db();
    const tx = db.transaction(['games', 'rounds'], 'readonly');
    const game = await tx.objectStore('games').get(id);
    const rounds = await tx.objectStore('rounds').index('byGameId').getAll(id);
    await tx.done;
    if (!game) return undefined;
    return { game, rounds: rounds.sort((a, b) => a.index - b.index).map(stripGameId) };
  }

  async deleteGame(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['games', 'rounds'], 'readwrite');
    const keys = await tx.objectStore('rounds').index('byGameId').getAllKeys(id);
    for (const k of keys) await tx.objectStore('rounds').delete(k);
    await tx.objectStore('games').delete(id);
    await tx.done;
  }

  async clearAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['games', 'rounds'], 'readwrite');
    await tx.objectStore('rounds').clear();
    await tx.objectStore('games').clear();
    await tx.done;
  }
}

function stripGameId(r: StoredRound): RoundResult {
  const { gameId: _gameId, ...rest } = r;
  return rest;
}

export class SettingsRepository {
  constructor(private readonly db: DbProvider) {}

  async getPreferences(): Promise<GamePreferences> {
    const db = await this.db();
    const rec = await db.get('settings', 'preferences');
    return sanitizePreferences(rec?.value);
  }

  async savePreferences(prefs: GamePreferences): Promise<void> {
    const db = await this.db();
    await db.put('settings', { key: 'preferences', value: sanitizePreferences(prefs) });
  }
}

export function sanitizePreferences(raw: unknown): GamePreferences {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<GamePreferences>;
  const d = DEFAULT_PREFERENCES;
  return {
    rounds: Number.isInteger(p.rounds) && p.rounds! >= 1 && p.rounds! <= 50 ? p.rounds! : d.rounds,
    timeLimitSec:
      p.timeLimitSec === null || (Number.isInteger(p.timeLimitSec) && p.timeLimitSec! >= 5 && p.timeLimitSec! <= 3600)
        ? (p.timeLimitSec ?? null)
        : d.timeLimitSec,
    mode: p.mode === 'moving' || p.mode === 'no-move' || p.mode === 'nmpz' ? p.mode : d.mode,
    allowRepeats: typeof p.allowRepeats === 'boolean' ? p.allowRepeats : d.allowRepeats,
    scoringScale: p.scoringScale === 'map' || p.scoringScale === 'world' ? p.scoringScale : d.scoringScale,
  };
}

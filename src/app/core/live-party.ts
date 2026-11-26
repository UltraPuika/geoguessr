import { LatLng, MapLocation } from './models';
import { BoardEntry, RevealEntry } from './party-protocol';
import { ScoringConfig, scoreGuess } from './scoring';

/** Extra time the host allows past a round's deadline for guesses still in flight. */
export const LIVE_GRACE_MS = 2500;

/**
 * Scores one live round on the host. Every player on the board gets an entry; anyone who did not
 * answer scores 0. Best score first, then the closest guess, then by name.
 */
export function scoreLiveRound(
  players: readonly Pick<BoardEntry, 'playerId' | 'name'>[],
  guesses: ReadonlyMap<string, LatLng | null>,
  location: Pick<MapLocation, 'lat' | 'lng'>,
  scoring: ScoringConfig,
): RevealEntry[] {
  const actual = { lat: location.lat, lng: location.lng };
  return players
    .map((p) => {
      const guess = guesses.get(p.playerId) ?? null;
      const { distanceKm, score } = scoreGuess(guess, actual, scoring);
      return { playerId: p.playerId, name: p.name, guess, distanceKm, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
        a.name.localeCompare(b.name),
    );
}

/** True when every connected player has answered (and at least one has). */
export function everyoneAnswered(
  players: readonly Pick<BoardEntry, 'playerId' | 'connected'>[],
  guesses: ReadonlyMap<string, unknown>,
): boolean {
  const waiting = players.filter((p) => p.connected);
  return waiting.length > 0 && waiting.every((p) => guesses.has(p.playerId));
}

/** 1-based positions by player ID, for an already ranked board. */
export function positions(board: readonly Pick<BoardEntry, 'playerId'>[]): Map<string, number> {
  return new Map(board.map((e, i) => [e.playerId, i + 1]));
}

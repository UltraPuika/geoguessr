export interface LatLng {
  lat: number;
  lng: number;
}

export type GameMode = 'moving' | 'no-move' | 'nmpz';
export type LocationOrder = 'fixed' | 'random';
export type CoverageStatus = 'unknown' | 'ok' | 'missing' | 'error';
export type ScoringScale = 'world' | 'map';

export const GAME_MODE_LABELS: Record<GameMode, string> = {
  moving: 'Moving',
  'no-move': 'No Moving',
  nmpz: 'NMPZ',
};

export interface GameMap {
  id: string;
  name: string;
  description: string;
  defaultOrder: LocationOrder;
  createdAt: string;
  updatedAt: string;
}

export interface MapSummary extends GameMap {
  locationCount: number;
}

export interface MapLocation {
  id: string;
  mapId: string;
  order: number;
  lat: number;
  lng: number;
  name: string;
  notes: string;
  panoId: string | null;
  heading: number;
  pitch: number;
  zoom: number;
  coverage: CoverageStatus;
  coverageCheckedAt: string | null;
}

export interface GameSetup {
  mapId: string;
  mapName: string;
  rounds: number;
  /** Seconds per round; null means no limit. */
  timeLimitSec: number | null;
  mode: GameMode;
  order: LocationOrder;
  allowRepeats: boolean;
  scoringScale: ScoringScale;
}

export type SubmitReason = 'manual' | 'timeout' | 'skipped';

export interface RoundResult {
  index: number;
  locationId: string;
  locationName: string;
  actual: LatLng;
  guess: LatLng | null;
  distanceKm: number | null;
  score: number;
  reason: SubmitReason;
  timeTakenMs: number | null;
}

export interface GameRecord {
  id: string;
  setup: GameSetup;
  playedAt: string;
  totalScore: number;
  maxScore: number;
  roundCount: number;
  totalDistanceKm: number;
  averageDistanceKm: number | null;
  guessedRounds: number;
  scaleKm: number;
}

export interface GameWithRounds {
  game: GameRecord;
  rounds: RoundResult[];
}

export interface GamePreferences {
  rounds: number;
  timeLimitSec: number | null;
  mode: GameMode;
  allowRepeats: boolean;
  scoringScale: ScoringScale;
}

export const DEFAULT_PREFERENCES: GamePreferences = {
  rounds: 5,
  timeLimitSec: null,
  mode: 'moving',
  allowRepeats: false,
  scoringScale: 'world',
};

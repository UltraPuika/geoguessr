import {
  GameRecord,
  GameSetup,
  LatLng,
  LocationOrder,
  MapLocation,
  RoundResult,
  SubmitReason,
} from './models';
import { DEFAULT_SCORING, ScoringConfig, isValidLatLng, scoreGuess } from './scoring';

export type Rng = () => number;

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface RoundPlan {
  locations: MapLocation[];
  requestedRounds: number;
  effectiveRounds: number;
  /** True when the round count was reduced because repeats are disabled. */
  capped: boolean;
  /** True when at least one location appears more than once. */
  repeats: boolean;
  message: string | null;
}

/** Describes what will happen for the requested settings without randomising. */
export function describeRoundPlan(
  locationCount: number,
  requestedRounds: number,
  allowRepeats: boolean,
): Omit<RoundPlan, 'locations'> {
  const requested = Math.max(1, Math.floor(requestedRounds));
  if (locationCount === 0) {
    return {
      requestedRounds: requested,
      effectiveRounds: 0,
      capped: true,
      repeats: false,
      message: 'This map has no locations yet. Add locations in the editor before playing.',
    };
  }
  if (requested <= locationCount) {
    return { requestedRounds: requested, effectiveRounds: requested, capped: false, repeats: false, message: null };
  }
  if (allowRepeats) {
    return {
      requestedRounds: requested,
      effectiveRounds: requested,
      capped: false,
      repeats: true,
      message: `The map has ${locationCount} location${locationCount === 1 ? '' : 's'}, so some will repeat across ${requested} rounds.`,
    };
  }
  return {
    requestedRounds: requested,
    effectiveRounds: locationCount,
    capped: true,
    repeats: false,
    message: `The map has only ${locationCount} location${locationCount === 1 ? '' : 's'}. With repeats off the game will have ${locationCount} round${locationCount === 1 ? '' : 's'}. Enable repeats or add locations to play ${requested}.`,
  };
}

export function planRounds(
  locations: readonly MapLocation[],
  requestedRounds: number,
  order: LocationOrder,
  allowRepeats: boolean,
  rng: Rng = Math.random,
): RoundPlan {
  const sorted = [...locations].sort((a, b) => a.order - b.order);
  const info = describeRoundPlan(sorted.length, requestedRounds, allowRepeats);
  const picked: MapLocation[] = [];
  while (picked.length < info.effectiveRounds) {
    let pass = order === 'random' ? shuffle(sorted, rng) : sorted;
    // Avoid the same location twice in a row at a pass boundary.
    if (order === 'random' && pass.length > 1 && picked.length > 0 && pass[0].id === picked[picked.length - 1].id) {
      pass = [...pass.slice(1), pass[0]];
    }
    picked.push(...pass.slice(0, info.effectiveRounds - picked.length));
  }
  return { ...info, locations: picked };
}

export type RoundPhase = 'loading' | 'guessing' | 'submitted';

/**
 * Pure game state machine. All guards live here so UI events (timer expiry, button
 * clicks, keyboard shortcuts) cannot produce duplicate or out-of-order submissions.
 */
export class GameSession {
  private readonly results: RoundResult[] = [];
  private roundIndex = 0;
  private roundPhase: RoundPhase = 'loading';
  private currentGuess: LatLng | null = null;
  private roundStartedAt: number | null = null;
  private finished = false;

  constructor(
    readonly setup: GameSetup,
    readonly locations: readonly MapLocation[],
    readonly scoring: ScoringConfig = DEFAULT_SCORING,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (locations.length === 0) throw new Error('A game needs at least one round.');
  }

  get index(): number {
    return this.roundIndex;
  }
  get totalRounds(): number {
    return this.locations.length;
  }
  get phase(): RoundPhase {
    return this.roundPhase;
  }
  get guess(): LatLng | null {
    return this.currentGuess;
  }
  get isFinished(): boolean {
    return this.finished;
  }
  get isLastRound(): boolean {
    return this.roundIndex === this.locations.length - 1;
  }
  get currentLocation(): MapLocation {
    return this.locations[this.roundIndex];
  }
  get roundResults(): readonly RoundResult[] {
    return this.results;
  }
  get lastResult(): RoundResult | null {
    return this.results.length > this.roundIndex ? this.results[this.roundIndex] : null;
  }
  get maxScore(): number {
    return this.scoring.maxScore * this.locations.length;
  }

  /** Called once the panorama is ready; starts the round clock. */
  markRoundReady(): boolean {
    if (this.finished || this.roundPhase !== 'loading') return false;
    this.roundPhase = 'guessing';
    this.roundStartedAt = this.now();
    return true;
  }

  placeGuess(p: LatLng): boolean {
    if (this.finished || this.roundPhase === 'submitted' || !isValidLatLng(p)) return false;
    this.currentGuess = { lat: p.lat, lng: p.lng };
    return true;
  }

  clearGuess(): boolean {
    if (this.finished || this.roundPhase === 'submitted') return false;
    this.currentGuess = null;
    return true;
  }

  canSubmit(reason: SubmitReason): boolean {
    if (this.finished || this.roundPhase === 'submitted') return false;
    if (reason === 'manual') return this.roundPhase === 'guessing' && this.currentGuess !== null;
    if (reason === 'timeout') return this.roundPhase === 'guessing';
    return true;
  }

  /** Returns the result, or null if the submission is not allowed (e.g. duplicate). */
  submit(reason: SubmitReason): RoundResult | null {
    if (!this.canSubmit(reason)) return null;
    const loc = this.currentLocation;
    const actual = { lat: loc.lat, lng: loc.lng };
    const guess = reason === 'skipped' ? null : this.currentGuess;
    const { distanceKm, score } = scoreGuess(guess, actual, this.scoring);
    const result: RoundResult = {
      index: this.roundIndex,
      locationId: loc.id,
      locationName: loc.name,
      actual,
      guess,
      distanceKm,
      score,
      reason,
      timeTakenMs: this.roundStartedAt === null ? null : Math.max(0, this.now() - this.roundStartedAt),
    };
    this.results.push(result);
    this.roundPhase = 'submitted';
    return result;
  }

  /** Advances after a submitted round. Returns false if not allowed. */
  next(): boolean {
    if (this.finished || this.roundPhase !== 'submitted') return false;
    if (this.isLastRound) {
      this.finished = true;
      return true;
    }
    this.roundIndex++;
    this.roundPhase = 'loading';
    this.currentGuess = null;
    this.roundStartedAt = null;
    return true;
  }
}

export interface GameSummary {
  totalScore: number;
  maxScore: number;
  totalDistanceKm: number;
  averageDistanceKm: number | null;
  guessedRounds: number;
}

export function summarizeRounds(rounds: readonly RoundResult[], maxScorePerRound: number): GameSummary {
  const guessed = rounds.filter((r) => r.distanceKm !== null);
  const totalDistanceKm = guessed.reduce((sum, r) => sum + (r.distanceKm ?? 0), 0);
  return {
    totalScore: rounds.reduce((sum, r) => sum + r.score, 0),
    maxScore: maxScorePerRound * rounds.length,
    totalDistanceKm,
    averageDistanceKm: guessed.length ? totalDistanceKm / guessed.length : null,
    guessedRounds: guessed.length,
  };
}

export function buildGameRecord(id: string, session: GameSession, playedAt: Date): GameRecord {
  const summary = summarizeRounds(session.roundResults, session.scoring.maxScore);
  return {
    id,
    setup: { ...session.setup, rounds: session.totalRounds },
    playedAt: playedAt.toISOString(),
    roundCount: session.roundResults.length,
    scaleKm: session.scoring.scaleKm,
    ...summary,
  };
}

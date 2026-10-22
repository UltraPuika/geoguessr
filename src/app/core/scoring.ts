import { LatLng } from './models';

/** Mean Earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;

/** Approximate world-map diagonal used by the classic GeoGuessr-style curve, km. */
export const WORLD_DIAGONAL_KM = 14916.862;

export interface ScoringConfig {
  maxScore: number;
  /** Distance (km) at which the score drops to maxScore / e. */
  scaleKm: number;
  /** Guesses within this distance (km) receive the maximum score. */
  perfectRadiusKm: number;
}

/**
 * Exponential decay `max * exp(-d / scale)` with scale = diagonal / 10.
 * This mirrors the widely documented community approximation of GeoGuessr's classic
 * scoring; it is not claimed to equal GeoGuessr's current proprietary formula.
 */
export const DEFAULT_SCORING: ScoringConfig = {
  maxScore: 5000,
  scaleKm: WORLD_DIAGONAL_KM / 10,
  perfectRadiusKm: 0.025,
};

/** Lower bound so tiny or single-location maps remain playable. */
export const MIN_MAP_DIAGONAL_KM = 50;

export function isValidLatLng(p: unknown): p is LatLng {
  if (typeof p !== 'object' || p === null) return false;
  const { lat, lng } = p as Record<string, unknown>;
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export class InvalidCoordinatesError extends Error {
  constructor(message = 'Invalid coordinates') {
    super(message);
    this.name = 'InvalidCoordinatesError';
  }
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance using the haversine formula. */
export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  if (!isValidLatLng(a) || !isValidLatLng(b)) {
    throw new InvalidCoordinatesError();
  }
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Integer score in [0, maxScore]. Non-finite or negative distances score 0. */
export function scoreFromDistance(distanceKm: number, config: ScoringConfig = DEFAULT_SCORING): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  const max = Math.max(0, Math.floor(config.maxScore));
  if (distanceKm <= config.perfectRadiusKm) return max;
  if (!(config.scaleKm > 0)) return 0;
  const raw = max * Math.exp(-distanceKm / config.scaleKm);
  return Math.min(max, Math.max(0, Math.round(raw)));
}

export interface GuessScore {
  distanceKm: number | null;
  score: number;
}

/** Scores a guess; a missing or invalid guess scores zero. */
export function scoreGuess(
  guess: LatLng | null,
  actual: LatLng,
  config: ScoringConfig = DEFAULT_SCORING,
): GuessScore {
  if (guess === null || !isValidLatLng(guess) || !isValidLatLng(actual)) {
    return { distanceKm: null, score: 0 };
  }
  const distanceKm = haversineDistanceKm(guess, actual);
  return { distanceKm, score: scoreFromDistance(distanceKm, config) };
}

/** Scale derived from the bounding-box diagonal of a map's locations (diagonal / 10). */
export function mapScaleKm(points: readonly LatLng[]): number {
  const valid = points.filter(isValidLatLng);
  if (valid.length === 0) return MIN_MAP_DIAGONAL_KM / 10;
  const lats = valid.map((p) => p.lat);
  const lngs = valid.map((p) => p.lng);
  const diagonal = haversineDistanceKm(
    { lat: Math.min(...lats), lng: Math.min(...lngs) },
    { lat: Math.max(...lats), lng: Math.max(...lngs) },
  );
  return Math.min(WORLD_DIAGONAL_KM, Math.max(MIN_MAP_DIAGONAL_KM, diagonal)) / 10;
}

export function formatDistance(km: number | null): string {
  if (km === null) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

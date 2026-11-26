import { GameMode, GameSetup, LocationOrder, MapLocation, ScoringScale } from './models';
import { DEFAULT_SCORING, isValidLatLng } from './scoring';

/** Namespaces our peer IDs on the shared public PeerJS signalling server. */
export const PARTY_PEER_PREFIX = 'geoguess-party-v1-';
export const PARTY_CODE_LENGTH = 6;
export const MAX_NAME_LENGTH = 24;
export const MAX_PARTY_PLAYERS = 100;
const MAX_ROUNDS = 50;
// No 0/O/1/I/L so codes can be typed from the screen without confusion.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** The planned rounds every phone plays, in the same order. */
export interface PartyGame {
  setup: GameSetup;
  locations: MapLocation[];
  scaleKm: number;
}

/** What a phone reports about itself; sent as a full snapshot so reconnects are idempotent. */
export interface PlayerState {
  playerId: string;
  name: string;
  roundsPlayed: number;
  totalScore: number;
  finished: boolean;
}

export interface BoardEntry extends PlayerState {
  connected: boolean;
}

/** Leaderboard row as phones see it: no player IDs, just a marker for their own row. */
export type PublicBoardEntry = Omit<BoardEntry, 'playerId'> & { you: boolean };

export type HostMessage =
  { t: 'game'; game: PartyGame } | { t: 'board'; entries: PublicBoardEntry[] } | { t: 'closed' };

export type ClientMessage = { t: 'state'; state: PlayerState };

export function createPartyCode(): string {
  const bytes = new Uint8Array(PARTY_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Normalises user input (from a URL or typed) to a party code, or null if it cannot be one. */
export function normalizePartyCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${PARTY_CODE_LENGTH}}$`).test(code) ? code : null;
}

export function peerIdForCode(code: string): string {
  return PARTY_PEER_PREFIX + code;
}

export function normalizePlayerName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(
    raw
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
}

/** Highest score first; ties go to whoever has played fewer rounds, then by name. */
export function rankBoard<T extends Omit<PlayerState, 'playerId'>>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      a.roundsPlayed - b.roundsPlayed ||
      a.name.localeCompare(b.name),
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isFiniteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isShortString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}

/** Validates a message from a phone. The host never trusts the shape or the numbers. */
export function parseClientMessage(raw: unknown, totalRounds: number): ClientMessage | null {
  if (!isRecord(raw) || raw['t'] !== 'state' || !isRecord(raw['state'])) return null;
  const s = raw['state'];
  const name = normalizePlayerName(s['name']);
  if (!name || !isShortString(s['playerId'], 64) || !/^[\w-]{8,64}$/.test(s['playerId']))
    return null;
  if (!isInt(s['roundsPlayed'], 0, totalRounds) || typeof s['finished'] !== 'boolean') return null;
  if (!isInt(s['totalScore'], 0, s['roundsPlayed'] * DEFAULT_SCORING.maxScore)) return null;
  if (s['finished'] && s['roundsPlayed'] !== totalRounds) return null;
  return {
    t: 'state',
    state: {
      playerId: s['playerId'],
      name,
      roundsPlayed: s['roundsPlayed'],
      totalScore: s['totalScore'],
      finished: s['finished'],
    },
  };
}

const MODES: readonly GameMode[] = ['moving', 'no-move', 'nmpz'];
const ORDERS: readonly LocationOrder[] = ['fixed', 'random'];
const SCALES: readonly ScoringScale[] = ['world', 'map'];

function parseSetup(v: unknown, rounds: number): GameSetup | null {
  if (!isRecord(v)) return null;
  const { mapId, mapName, timeLimitSec, mode, order, allowRepeats, scoringScale } = v;
  if (!isShortString(mapId, 100) || !isShortString(mapName, 2000)) return null;
  if (timeLimitSec !== null && !isInt(timeLimitSec, 5, 3600)) return null;
  if (!MODES.includes(mode as GameMode) || !ORDERS.includes(order as LocationOrder)) return null;
  if (typeof allowRepeats !== 'boolean' || !SCALES.includes(scoringScale as ScoringScale))
    return null;
  return {
    mapId,
    mapName,
    rounds,
    timeLimitSec,
    mode: mode as GameMode,
    order: order as LocationOrder,
    allowRepeats,
    scoringScale: scoringScale as ScoringScale,
  };
}

function parseLocation(v: unknown, index: number, mapId: string): MapLocation | null {
  if (!isRecord(v) || !isValidLatLng(v)) return null;
  const { id, name, panoId, heading, pitch, zoom } = v;
  if (!isShortString(id, 100) || !isShortString(name, 2000)) return null;
  if (panoId !== null && !isShortString(panoId, 500)) return null;
  if (!isFiniteIn(heading, -360, 720) || !isFiniteIn(pitch, -90, 90) || !isFiniteIn(zoom, 0, 5))
    return null;
  return {
    id,
    mapId,
    order: index,
    lat: v.lat,
    lng: v.lng,
    name,
    notes: '',
    panoId,
    heading,
    pitch,
    zoom,
    coverage: 'unknown',
    coverageCheckedAt: null,
  };
}

function parseBoardEntry(v: unknown): PublicBoardEntry | null {
  if (!isRecord(v)) return null;
  const name = normalizePlayerName(v['name']);
  if (!name) return null;
  if (
    !isInt(v['roundsPlayed'], 0, MAX_ROUNDS) ||
    !isInt(v['totalScore'], 0, MAX_ROUNDS * DEFAULT_SCORING.maxScore)
  )
    return null;
  const { finished, connected, you } = v;
  if (typeof finished !== 'boolean' || typeof connected !== 'boolean' || typeof you !== 'boolean')
    return null;
  return {
    name,
    roundsPlayed: v['roundsPlayed'],
    totalScore: v['totalScore'],
    finished,
    connected,
    you,
  };
}

/** Validates a message from the host before a phone acts on it. */
export function parseHostMessage(raw: unknown): HostMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw['t']) {
    case 'closed':
      return { t: 'closed' };
    case 'board': {
      const list = raw['entries'];
      if (!Array.isArray(list) || list.length > MAX_PARTY_PLAYERS) return null;
      const entries = list.map(parseBoardEntry);
      return entries.every((e) => e !== null)
        ? { t: 'board', entries: entries as PublicBoardEntry[] }
        : null;
    }
    case 'game': {
      const g = raw['game'];
      if (!isRecord(g) || !Array.isArray(g['locations'])) return null;
      const list = g['locations'];
      if (list.length < 1 || list.length > MAX_ROUNDS) return null;
      const setup = parseSetup(g['setup'], list.length);
      if (!setup || !isFiniteIn(g['scaleKm'], 1, 100_000)) return null;
      const locations = list.map((l, i) => parseLocation(l, i, setup.mapId));
      if (!locations.every((l) => l !== null)) return null;
      return {
        t: 'game',
        game: { setup, locations: locations as MapLocation[], scaleKm: g['scaleKm'] },
      };
    }
    default:
      return null;
  }
}

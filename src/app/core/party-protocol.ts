import { GameMode, GameSetup, LocationOrder, MapLocation, ScoringScale } from './models';
import { DEFAULT_SCORING, isValidLatLng } from './scoring';

/** Namespaces our topics on the shared public MQTT broker. */
export const PARTY_TOPIC_ROOT = 'geoguess-personal/party/v1';
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

/** offline is the host's MQTT last will: the host tab dropped off without ending the party. */
export type HostMessage =
  | { t: 'game'; game: PartyGame }
  | { t: 'board'; entries: BoardEntry[] }
  | { t: 'closed' }
  | { t: 'offline' };

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

export interface PartyTopics {
  /** Retained, host-published: the game, or closed/offline. */
  host: string;
  /** Retained, host-published leaderboard. */
  board: string;
  /** Phones publish to state/<playerId>; the host subscribes to the wildcard. */
  state: (playerId: string) => string;
  stateWildcard: string;
  /** Phones' last will, so the host can mark them offline. */
  left: (playerId: string) => string;
  leftWildcard: string;
  /** Phones ask the host to re-send the game, in case the broker did not deliver the retained copy. */
  hello: (playerId: string) => string;
  helloWildcard: string;
}

export function partyTopics(code: string): PartyTopics {
  const base = `${PARTY_TOPIC_ROOT}/${code}`;
  return {
    host: `${base}/host`,
    board: `${base}/board`,
    state: (id) => `${base}/state/${id}`,
    stateWildcard: `${base}/state/+`,
    left: (id) => `${base}/left/${id}`,
    leftWildcard: `${base}/left/+`,
    hello: (id) => `${base}/hello/${id}`,
    helloWildcard: `${base}/hello/+`,
  };
}

/** Extracts the last topic segment (the player ID) from a state/left topic. */
export function playerIdFromTopic(topic: string): string {
  return topic.slice(topic.lastIndexOf('/') + 1);
}

/** Parses a JSON payload; empty (retained-message clears), oversized or malformed payloads give null. */
export function decodePayload(payload: Uint8Array, maxBytes: number): unknown {
  if (payload.length === 0 || payload.length > maxBytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
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

export function isValidPlayerId(v: unknown): v is string {
  return typeof v === 'string' && /^[\w-]{8,64}$/.test(v);
}

/** Validates a message from a phone. The host never trusts the shape or the numbers. */
export function parseClientMessage(raw: unknown, totalRounds: number): ClientMessage | null {
  if (!isRecord(raw) || raw['t'] !== 'state' || !isRecord(raw['state'])) return null;
  const s = raw['state'];
  const name = normalizePlayerName(s['name']);
  if (!name || !isValidPlayerId(s['playerId'])) return null;
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

function parseBoardEntry(v: unknown): BoardEntry | null {
  if (!isRecord(v)) return null;
  const name = normalizePlayerName(v['name']);
  if (!name || !isValidPlayerId(v['playerId'])) return null;
  if (
    !isInt(v['roundsPlayed'], 0, MAX_ROUNDS) ||
    !isInt(v['totalScore'], 0, MAX_ROUNDS * DEFAULT_SCORING.maxScore)
  )
    return null;
  const { finished, connected } = v;
  if (typeof finished !== 'boolean' || typeof connected !== 'boolean') return null;
  return {
    playerId: v['playerId'],
    name,
    roundsPlayed: v['roundsPlayed'],
    totalScore: v['totalScore'],
    finished,
    connected,
  };
}

/** Validates a message from the host before a phone acts on it. */
export function parseHostMessage(raw: unknown): HostMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw['t']) {
    case 'closed':
      return { t: 'closed' };
    case 'offline':
      return { t: 'offline' };
    case 'board': {
      const list = raw['entries'];
      if (!Array.isArray(list) || list.length > MAX_PARTY_PLAYERS) return null;
      const entries = list.map(parseBoardEntry);
      return entries.every((e) => e !== null)
        ? { t: 'board', entries: entries as BoardEntry[] }
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

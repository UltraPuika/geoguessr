import { Injectable, computed, signal } from '@angular/core';
import type { MqttClient } from 'mqtt';
import { PARTY_MAX_PAYLOAD_BYTES } from '../config/party-config';
import { GameSession } from '../core/game-engine';
import { createId } from '../core/id';
import {
  BoardEntry,
  ClientMessage,
  PartyGame,
  PartyTopics,
  PlayerState,
  decodePayload,
  normalizePlayerName,
  parseHostMessage,
  partyTopics,
} from '../core/party-protocol';
import { connectToBroker, describeConnectionError, publishJson } from './party-broker';

export type PartyClientStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';
/** lobby: entering a name · playing: in /game · done: finished or quit */
export type PartyClientPhase = 'lobby' | 'playing' | 'done';
export type PhoneBoardEntry = BoardEntry & { you: boolean };

const NAME_KEY = 'geoguess.party.name';
/** How long to wait for the host's retained game before reporting the party as missing. */
const NOT_FOUND_MS = 10_000;

/** The phone side of a party: joins a host, plays its rounds and reports the running score. */
@Injectable({ providedIn: 'root' })
export class PartyClientService {
  readonly code = signal<string | null>(null);
  readonly status = signal<PartyClientStatus>('idle');
  readonly error = signal<string | null>(null);
  readonly game = signal<PartyGame | null>(null);
  readonly phase = signal<PartyClientPhase>('lobby');
  readonly name = signal(loadName());
  /** Local history ID of the finished game, for the details link. */
  readonly resultId = signal<string | null>(null);
  private readonly rawBoard = signal<BoardEntry[]>([]);
  private readonly playerId = signal('');
  readonly board = computed<PhoneBoardEntry[]>(() =>
    this.rawBoard().map((e) => ({ ...e, you: e.playerId === this.playerId() })),
  );
  readonly me = computed(() => this.board().find((e) => e.you) ?? null);

  private client: MqttClient | null = null;
  private topics: PartyTopics | null = null;
  private session: GameSession | null = null;
  private lastState: PlayerState | null = null;
  private generation = 0;
  private notFoundTimer: ReturnType<typeof setTimeout> | null = null;

  /** Connects to a party, or does nothing if already connected to the same one. */
  async join(code: string): Promise<void> {
    if (this.code() === code && this.status() !== 'error' && this.status() !== 'idle') return;
    this.leave();
    const gen = ++this.generation;
    const topics = partyTopics(code);
    const playerId = loadPlayerId(code);
    this.code.set(code);
    this.playerId.set(playerId);
    this.topics = topics;
    this.status.set('connecting');
    try {
      const client = await connectToBroker({
        will: { topic: topics.left(playerId), payload: '1', qos: 1, retain: false },
      });
      if (gen !== this.generation) {
        client.end(true);
        return;
      }
      this.client = client;
      client.on('connect', () => {
        if (gen !== this.generation) return;
        client.subscribe([topics.host, topics.board], { qos: 1 });
        // Re-announce after every reconnect, so the host marks this phone online again.
        this.send();
        if (!this.game()) this.startNotFoundTimer(gen);
      });
      client.on('message', (topic, payload) => gen === this.generation && this.onMessage(topic, payload));
      client.on('offline', () => {
        if (gen !== this.generation) return;
        if (this.game()) {
          this.status.set('reconnecting');
          this.error.set('Lost connection to the party server.');
        }
      });
      client.on('error', (err) => {
        if (gen === this.generation && !this.game()) this.fail(describeConnectionError(err));
      });
      this.startNotFoundTimer(gen, NOT_FOUND_MS + 15_000);
    } catch (err) {
      if (gen === this.generation) this.fail(describeConnectionError(err));
    }
  }

  /** Re-attempts after an error (e.g. host screen was reopened). */
  retry(): void {
    const code = this.code();
    if (!code) return;
    this.status.set('idle');
    void this.join(code);
  }

  setName(raw: string): string {
    const name = normalizePlayerName(raw);
    this.name.set(name);
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // Convenience only.
    }
    return name;
  }

  ownsSession(s: GameSession | null): boolean {
    return !!s && s === this.session;
  }

  /** Links a freshly started game to the party and announces the player on the leaderboard. */
  bindSession(s: GameSession): void {
    this.session = s;
    this.phase.set('playing');
    this.resultId.set(null);
    this.report(s);
  }

  report(s: GameSession, resultId?: string): void {
    if (!this.ownsSession(s)) return;
    const results = s.roundResults;
    this.lastState = {
      playerId: this.playerId(),
      name: this.name(),
      roundsPlayed: results.length,
      totalScore: results.reduce((sum, r) => sum + r.score, 0),
      finished: s.isFinished,
    };
    if (resultId) this.resultId.set(resultId);
    this.send();
  }

  /** The game ended (finished or quit); the phone returns to the leaderboard. */
  endSession(s: GameSession): void {
    if (!this.ownsSession(s)) return;
    this.report(s);
    this.session = null;
    this.phase.set('done');
  }

  leave(): void {
    this.generation++;
    this.clearNotFoundTimer();
    const client = this.client;
    const topics = this.topics;
    if (client) {
      // A clean disconnect suppresses the last will, so say goodbye explicitly.
      if (topics && this.lastState) client.publish(topics.left(this.playerId()), '1', { qos: 1 });
      client.end(false);
    }
    this.client = null;
    this.topics = null;
    this.session = null;
    this.lastState = null;
    this.code.set(null);
    this.game.set(null);
    this.rawBoard.set([]);
    this.phase.set('lobby');
    this.resultId.set(null);
    this.status.set('idle');
    this.error.set(null);
  }

  private onMessage(topic: string, payload: Uint8Array): void {
    const topics = this.topics;
    if (!topics || (topic !== topics.host && topic !== topics.board)) return;
    const msg = parseHostMessage(decodePayload(payload, PARTY_MAX_PAYLOAD_BYTES));
    if (!msg) return;
    if (topic === topics.board) {
      if (msg.t === 'board') this.rawBoard.set(msg.entries);
      return;
    }
    switch (msg.t) {
      case 'game':
        this.clearNotFoundTimer();
        // Keep the first plan; a host reconnect must never swap rounds under a running game.
        if (!this.game()) this.game.set(msg.game);
        this.status.set('connected');
        this.error.set(null);
        break;
      case 'offline':
        if (this.game()) {
          this.status.set('reconnecting');
          this.error.set('The host screen lost its connection. Waiting for it to come back…');
        }
        break;
      case 'closed':
        this.clearNotFoundTimer();
        if (!this.game()) {
          this.fail('This party has ended. Ask the host for the new QR code.');
          return;
        }
        this.status.set('closed');
        this.generation++;
        this.client?.end(false);
        this.client = null;
        break;
    }
  }

  private startNotFoundTimer(gen: number, ms = NOT_FOUND_MS): void {
    this.clearNotFoundTimer();
    this.notFoundTimer = setTimeout(() => {
      this.notFoundTimer = null;
      if (gen !== this.generation || this.game()) return;
      this.fail(
        this.client?.connected
          ? 'Party not found. Check the code, and make sure the host screen is still open.'
          : 'Could not reach the party server. Check the internet connection and try again.',
      );
    }, ms);
  }

  private clearNotFoundTimer(): void {
    if (this.notFoundTimer) clearTimeout(this.notFoundTimer);
    this.notFoundTimer = null;
  }

  private fail(message: string): void {
    this.clearNotFoundTimer();
    this.generation++;
    this.client?.end(true);
    this.client = null;
    this.status.set('error');
    this.error.set(message);
  }

  private send(): void {
    const client = this.client;
    const topics = this.topics;
    if (!client || !topics || !this.lastState) return;
    // QoS 1 messages are queued by mqtt.js while offline and delivered after reconnecting.
    publishJson(client, topics.state(this.lastState.playerId), { t: 'state', state: this.lastState } satisfies ClientMessage);
  }
}

function loadName(): string {
  try {
    return normalizePlayerName(localStorage.getItem(NAME_KEY) ?? '');
  } catch {
    return '';
  }
}

/** Stable per tab and party, so a reload or reconnect updates the same leaderboard row. */
function loadPlayerId(code: string): string {
  const key = `geoguess.party.${code}.player`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && /^[\w-]{8,64}$/.test(existing)) return existing;
    const id = createId();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return createId();
  }
}

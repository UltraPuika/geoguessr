import { Injectable, computed, signal } from '@angular/core';
import type { MqttClient } from 'mqtt';
import { PARTY_MAX_PAYLOAD_BYTES } from '../config/party-config';
import { GameSession } from '../core/game-engine';
import { createId } from '../core/id';
import { LatLng } from '../core/models';
import {
  BoardEntry,
  ClientMessage,
  LivePhase,
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
  readonly myRank = computed(() => {
    const i = this.board().findIndex((e) => e.you);
    return i < 0 ? null : i + 1;
  });

  readonly isLive = computed(() => this.game()?.pace === 'live');
  /** Live parties: the host's current phase. */
  readonly livePhase = signal<LivePhase | null>(null);
  /** Live parties: this phone has entered a name and is taking part. */
  readonly liveJoined = signal(false);
  /** Live parties: when this phone's countdown for the current round ends (local clock). */
  readonly roundDeadline = signal<number | null>(null);
  /** Live parties: this phone's line in the current reveal, with its round rank. */
  readonly myReveal = computed(() => {
    const phase = this.livePhase();
    if (phase?.kind !== 'reveal') return null;
    const i = phase.results.findIndex((r) => r.playerId === this.playerId());
    return i < 0 ? null : { round: phase.round, rank: i + 1, of: phase.results.length, entry: phase.results[i] };
  });

  private client: MqttClient | null = null;
  private topics: PartyTopics | null = null;
  private session: GameSession | null = null;
  private lastState: PlayerState | null = null;
  private lastGuess: Extract<ClientMessage, { t: 'guess' }> | null = null;
  private generation = 0;
  private notFoundTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setInterval> | null = null;

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
        // Ask for the game only once subscribed, so the host's answer cannot be missed.
        client.subscribe([topics.host, topics.board, topics.phase], { qos: 1 }, () => {
          if (gen === this.generation && !this.game()) this.startHello(gen);
        });
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
    if (resultId) this.resultId.set(resultId);
    // Live parties are scored by the host from each guess instead.
    if (this.isLive()) return;
    const results = s.roundResults;
    this.lastState = {
      playerId: this.playerId(),
      name: this.name(),
      roundsPlayed: results.length,
      totalScore: results.reduce((sum, r) => sum + r.score, 0),
      finished: s.isFinished,
    };
    this.send();
  }

  /** Live: takes part under the given name; the host adds this phone to the board. */
  joinLive(): void {
    if (!this.isLive() || !this.name()) return;
    this.liveJoined.set(true);
    saveJoined(this.code(), true);
    this.phase.set('lobby');
    this.resultId.set(null);
    this.send();
  }

  /** Live: sends this round's answer (null when time ran out without a guess). */
  submitGuess(round: number, guess: LatLng | null): void {
    if (!this.isLive() || !this.liveJoined()) return;
    this.lastGuess = { t: 'guess', playerId: this.playerId(), round, guess };
    this.send();
  }

  /** The game ended (finished or quit); the phone returns to the leaderboard. */
  endSession(s: GameSession): void {
    if (!this.ownsSession(s)) return;
    this.report(s);
    this.session = null;
    this.phase.set('done');
    if (this.isLive() && !s.isFinished) {
      // Quitting a live game: stop the host waiting for this phone's answers.
      this.liveJoined.set(false);
      saveJoined(this.code(), false);
      const client = this.client;
      const topics = this.topics;
      if (client && topics) client.publish(topics.left(this.playerId()), '1', { qos: 1 });
    }
  }

  leave(): void {
    this.generation++;
    this.clearNotFoundTimer();
    const client = this.client;
    const topics = this.topics;
    if (client) {
      // A clean disconnect suppresses the last will, so say goodbye explicitly.
      if (topics && (this.lastState || this.liveJoined())) {
        client.publish(topics.left(this.playerId()), '1', { qos: 1 });
      }
      client.end(false);
    }
    this.client = null;
    this.topics = null;
    this.session = null;
    this.lastState = null;
    this.lastGuess = null;
    this.code.set(null);
    this.game.set(null);
    this.rawBoard.set([]);
    this.livePhase.set(null);
    this.liveJoined.set(false);
    this.roundDeadline.set(null);
    this.phase.set('lobby');
    this.resultId.set(null);
    this.status.set('idle');
    this.error.set(null);
  }

  private onMessage(topic: string, payload: Uint8Array): void {
    const topics = this.topics;
    if (!topics || (topic !== topics.host && topic !== topics.board && topic !== topics.phase)) return;
    const msg = parseHostMessage(decodePayload(payload, PARTY_MAX_PAYLOAD_BYTES));
    if (!msg) return;
    if (topic === topics.board) {
      if (msg.t === 'board') this.rawBoard.set(msg.entries);
      return;
    }
    if (topic === topics.phase) {
      if (msg.t === 'phase') this.onPhase(msg.phase);
      return;
    }
    switch (msg.t) {
      case 'game':
        this.clearNotFoundTimer();
        // Keep the first plan; a host reconnect must never swap rounds under a running game.
        if (!this.game()) {
          this.game.set(msg.game);
          // After a reload, a phone that had joined a live game takes part again automatically.
          if (msg.game.pace === 'live' && !this.liveJoined() && this.name() && loadJoined(this.code())) {
            this.liveJoined.set(true);
            this.send();
          }
        }
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

  /** Pings the host every couple of seconds until the game arrives (or the not-found timer fires). */
  private startHello(gen: number): void {
    this.stopHello();
    const ping = () => {
      const client = this.client;
      const topics = this.topics;
      if (gen !== this.generation || this.game() || !client || !topics) {
        this.stopHello();
        return;
      }
      client.publish(topics.hello(this.playerId()), '1', { qos: 0 });
    };
    ping();
    this.helloTimer = setInterval(ping, 2000);
  }

  private stopHello(): void {
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = null;
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
    this.stopHello();
  }

  private fail(message: string): void {
    this.clearNotFoundTimer();
    this.generation++;
    this.client?.end(true);
    this.client = null;
    this.status.set('error');
    this.error.set(message);
  }

  private onPhase(phase: LivePhase): void {
    const prev = this.livePhase();
    if (phase.kind === 'round') {
      const deadline = phase.durationMs === null ? null : Date.now() + phase.durationMs;
      const current = this.roundDeadline();
      // A re-delivered copy of the same round (stale retained copy or a fresher re-publish with
      // the time left) may only shorten the countdown, never extend it.
      const sameRound = prev?.kind === 'round' && prev.round === phase.round;
      this.roundDeadline.set(
        sameRound && current !== null && deadline !== null ? Math.min(current, deadline) : deadline,
      );
    } else {
      this.roundDeadline.set(null);
    }
    this.livePhase.set(phase);
  }

  private send(): void {
    const client = this.client;
    const topics = this.topics;
    if (!client || !topics) return;
    const topic = topics.state(this.playerId());
    // QoS 1 messages are queued by mqtt.js while offline and delivered after reconnecting.
    if (this.isLive()) {
      if (!this.liveJoined() || !this.name()) return;
      publishJson(client, topic, { t: 'join', playerId: this.playerId(), name: this.name() } satisfies ClientMessage);
      const phase = this.livePhase();
      // The host ignores repeats, so resending the current answer after a reconnect is safe.
      if (this.lastGuess && phase?.kind === 'round' && phase.round === this.lastGuess.round) {
        publishJson(client, topic, this.lastGuess);
      }
      return;
    }
    if (!this.lastState) return;
    publishJson(client, topic, { t: 'state', state: this.lastState } satisfies ClientMessage);
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

function joinedKey(code: string | null): string {
  return `geoguess.party.${code}.joined`;
}

function loadJoined(code: string | null): boolean {
  try {
    return !!code && sessionStorage.getItem(joinedKey(code)) === '1';
  } catch {
    return false;
  }
}

function saveJoined(code: string | null, joined: boolean): void {
  if (!code) return;
  try {
    if (joined) sessionStorage.setItem(joinedKey(code), '1');
    else sessionStorage.removeItem(joinedKey(code));
  } catch {
    // Convenience only.
  }
}

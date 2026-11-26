import { Injectable, computed, signal } from '@angular/core';
import type { MqttClient } from 'mqtt';
import { PARTY_MAX_PAYLOAD_BYTES } from '../config/party-config';
import { LIVE_GRACE_MS, everyoneAnswered, positions, scoreLiveRound } from '../core/live-party';
import { LatLng } from '../core/models';
import {
  BoardEntry,
  ClientMessage,
  HostMessage,
  LivePhase,
  MAX_PARTY_PLAYERS,
  PartyGame,
  PartyTopics,
  PlayerState,
  createPartyCode,
  decodePayload,
  isValidPlayerId,
  parseClientMessage,
  partyTopics,
  playerIdFromTopic,
  rankBoard,
} from '../core/party-protocol';
import { DEFAULT_SCORING } from '../core/scoring';
import { connectToBroker, describeConnectionError, publishJson, waitForConnect } from './party-broker';

export type PartyHostStatus = 'idle' | 'starting' | 'open' | 'error';

/**
 * Turns this browser into the party host. The host and phones exchange small JSON messages through
 * a public MQTT broker: the host publishes the planned rounds and the leaderboard, phones publish
 * their running score (self-paced) or each round's guess (live). The host validates everything, so
 * the leaderboard state lives in this tab and the party ends when it is closed.
 */
@Injectable({ providedIn: 'root' })
export class PartyHostService {
  readonly status = signal<PartyHostStatus>('idle');
  readonly error = signal<string | null>(null);
  readonly code = signal<string | null>(null);
  readonly game = signal<PartyGame | null>(null);
  private readonly players = signal<ReadonlyMap<string, BoardEntry>>(new Map());
  readonly board = computed(() => rankBoard([...this.players().values()]));
  readonly active = computed(() => this.game() !== null);

  readonly isLive = computed(() => this.game()?.pace === 'live');
  /** Live parties only; null for self-paced ones. */
  readonly phase = signal<LivePhase | null>(null);
  /** Answers received for the current live round, by player ID. */
  readonly guesses = signal<ReadonlyMap<string, LatLng | null>>(new Map());
  /** When the current live round's countdown ends (this tab's clock), or null without a time limit. */
  readonly roundEndsAt = signal<number | null>(null);
  /** Board positions before the last reveal, to show who moved up or down. */
  readonly previousPositions = signal<ReadonlyMap<string, number>>(new Map());
  readonly answeredCount = computed(() => {
    const guesses = this.guesses();
    return this.board().filter((p) => guesses.has(p.playerId)).length;
  });

  private client: MqttClient | null = null;
  private topics: PartyTopics | null = null;
  private generation = 0;
  private boardTimer: ReturnType<typeof setTimeout> | null = null;
  private roundTimer: ReturnType<typeof setTimeout> | null = null;
  private lastGamePublish = 0;

  async open(game: PartyGame): Promise<void> {
    this.close();
    const gen = ++this.generation;
    const code = createPartyCode();
    const topics = partyTopics(code);
    this.game.set(game);
    this.phase.set(game.pace === 'live' ? { kind: 'lobby' } : null);
    this.status.set('starting');
    this.error.set(null);
    try {
      const client = await connectToBroker({
        // If this tab vanishes without "End party", phones learn the host went offline.
        will: {
          topic: topics.host,
          payload: JSON.stringify({ t: 'offline' } satisfies HostMessage),
          qos: 1,
          retain: true,
        },
      });
      if (gen !== this.generation) {
        client.end(true);
        return;
      }
      this.client = client;
      this.topics = topics;
      client.on('connect', () => gen === this.generation && this.announce());
      client.on('message', (topic, payload) => gen === this.generation && this.onMessage(topic, payload));
      client.on('offline', () => gen === this.generation && this.error.set('Connection lost. Reconnecting…'));
      await waitForConnect(client);
      if (gen !== this.generation) return;
      this.code.set(code);
      this.status.set('open');
    } catch (err) {
      if (gen !== this.generation) return;
      this.client?.end(true);
      this.client = null;
      this.status.set('error');
      this.error.set(describeConnectionError(err));
    }
  }

  /** Ends the party: tells every phone, clears the retained board, then disconnects. */
  close(): void {
    this.generation++;
    if (this.boardTimer) clearTimeout(this.boardTimer);
    this.boardTimer = null;
    this.clearRoundTimer();
    const client = this.client;
    const topics = this.topics;
    this.client = null;
    this.topics = null;
    if (client && topics) {
      publishJson(client, topics.host, { t: 'closed' } satisfies HostMessage, true);
      // An empty retained payload deletes the stored leaderboard on the broker.
      if (this.phase()) client.publish(topics.phase, '', { qos: 1, retain: true });
      client.publish(topics.board, '', { qos: 1, retain: true }, () => client.end());
      setTimeout(() => client.end(true), 3000);
    }
    this.players.set(new Map());
    this.game.set(null);
    this.phase.set(null);
    this.guesses.set(new Map());
    this.roundEndsAt.set(null);
    this.previousPositions.set(new Map());
    this.code.set(null);
    this.status.set('idle');
    this.error.set(null);
  }

  removePlayer(playerId: string): void {
    const next = new Map(this.players());
    if (!next.delete(playerId)) return;
    this.players.set(next);
    this.publishBoard();
    this.closeRoundIfEveryoneAnswered();
  }

  /** Live: starts the first round (from the lobby) or the next one (from a reveal). */
  nextRound(): void {
    const game = this.game();
    const phase = this.phase();
    if (!game || !phase) return;
    let round: number;
    if (phase.kind === 'lobby') round = 0;
    else if (phase.kind === 'reveal') round = phase.round + 1;
    else return;
    if (round >= game.locations.length) {
      this.finishGame();
      return;
    }
    const limitSec = game.setup.timeLimitSec;
    const durationMs = limitSec === null ? null : limitSec * 1000;
    this.guesses.set(new Map());
    this.roundEndsAt.set(durationMs === null ? null : Date.now() + durationMs);
    this.setPhase({ kind: 'round', round, durationMs });
    this.clearRoundTimer();
    if (durationMs !== null) {
      this.roundTimer = setTimeout(() => this.endRound(), durationMs + LIVE_GRACE_MS);
    }
  }

  /** Live: closes the current round, scores it and shows the reveal. Missing answers score 0. */
  endRound(): void {
    const game = this.game();
    const phase = this.phase();
    if (!game || phase?.kind !== 'round') return;
    this.clearRoundTimer();
    this.roundEndsAt.set(null);
    const board = this.board();
    this.previousPositions.set(positions(board));
    const results = scoreLiveRound(board, this.guesses(), game.locations[phase.round], {
      ...DEFAULT_SCORING,
      scaleKm: game.scaleKm,
    });
    const next = new Map(this.players());
    for (const r of results) {
      const p = next.get(r.playerId);
      if (p) next.set(r.playerId, { ...p, totalScore: p.totalScore + r.score, roundsPlayed: phase.round + 1 });
    }
    this.players.set(next);
    this.publishBoard(true);
    this.setPhase({ kind: 'reveal', round: phase.round, results });
  }

  private finishGame(): void {
    const next = new Map<string, BoardEntry>();
    for (const [id, p] of this.players()) next.set(id, { ...p, finished: true });
    this.players.set(next);
    this.previousPositions.set(new Map());
    this.publishBoard(true);
    this.setPhase({ kind: 'final' });
  }

  private setPhase(phase: LivePhase): void {
    this.phase.set(phase);
    this.publishPhase();
  }

  private publishPhase(): void {
    const client = this.client;
    const topics = this.topics;
    let phase = this.phase();
    if (!client || !topics || !phase) return;
    const endsAt = this.roundEndsAt();
    // Re-published copies (reconnects, late joiners) carry the time left, not the full round.
    if (phase.kind === 'round' && endsAt !== null) {
      phase = { ...phase, durationMs: Math.max(0, Math.round(endsAt - Date.now())) };
    }
    publishJson(client, topics.phase, { t: 'phase', phase } satisfies HostMessage, true);
  }

  private clearRoundTimer(): void {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = null;
  }

  /** Rounds played so far, for players who join a live party late. */
  private completedRounds(): number {
    const phase = this.phase();
    if (!phase || phase.kind === 'lobby') return 0;
    if (phase.kind === 'round') return phase.round;
    if (phase.kind === 'reveal') return phase.round + 1;
    return this.game()?.locations.length ?? 0;
  }

  private closeRoundIfEveryoneAnswered(): void {
    if (this.phase()?.kind === 'round' && everyoneAnswered(this.board(), this.guesses())) this.endRound();
  }

  /** (Re)publishes the retained game and board; runs on every (re)connect. */
  private announce(): void {
    const client = this.client;
    const topics = this.topics;
    const game = this.game();
    if (!client || !topics || !game) return;
    this.error.set(null);
    client.subscribe([topics.stateWildcard, topics.leftWildcard, topics.helloWildcard], { qos: 1 });
    this.publishGame();
    this.publishPhase();
    this.publishBoard(true);
  }

  private publishGame(): void {
    const client = this.client;
    const topics = this.topics;
    const game = this.game();
    if (!client || !topics || !game) return;
    this.lastGamePublish = Date.now();
    publishJson(client, topics.host, { t: 'game', game } satisfies HostMessage, true);
  }

  private onMessage(topic: string, payload: Uint8Array): void {
    const topics = this.topics;
    const game = this.game();
    if (!topics || !game) return;
    const playerId = playerIdFromTopic(topic);
    if (!isValidPlayerId(playerId)) return;
    if (topic === topics.hello(playerId)) {
      // Throttled so a burst of joining phones costs one re-publish.
      if (Date.now() - this.lastGamePublish > 1000) {
        this.publishGame();
        this.publishPhase();
        this.publishBoard(true);
      }
      return;
    }
    if (topic === topics.left(playerId)) {
      this.patch(playerId, { connected: false });
      this.closeRoundIfEveryoneAnswered();
      return;
    }
    if (topic !== topics.state(playerId)) return;
    const msg = parseClientMessage(decodePayload(payload, PARTY_MAX_PAYLOAD_BYTES), game.locations.length);
    // The topic and payload must agree, so a phone cannot write into another player's row by accident.
    if (!msg || messagePlayerId(msg) !== playerId) return;
    if (game.pace === 'live') {
      if (msg.t === 'join') this.join(msg.playerId, msg.name);
      else if (msg.t === 'guess') this.acceptGuess(msg.playerId, msg.round, msg.guess);
    } else if (msg.t === 'state') {
      this.update(msg.state);
    }
  }

  private join(playerId: string, name: string): void {
    const existing = this.players().get(playerId);
    if (existing) {
      this.patch(playerId, { connected: true, name });
      return;
    }
    if (this.players().size >= MAX_PARTY_PLAYERS || this.phase()?.kind === 'final') return;
    const next = new Map(this.players());
    next.set(playerId, {
      playerId,
      name,
      roundsPlayed: this.completedRounds(),
      totalScore: 0,
      finished: false,
      connected: true,
    });
    this.players.set(next);
    this.publishBoard();
  }

  private acceptGuess(playerId: string, round: number, guess: LatLng | null): void {
    const phase = this.phase();
    // Only the current round, only known players, and the first answer counts.
    if (phase?.kind !== 'round' || phase.round !== round) return;
    if (!this.players().has(playerId) || this.guesses().has(playerId)) return;
    const next = new Map(this.guesses());
    next.set(playerId, guess);
    this.guesses.set(next);
    this.patch(playerId, { connected: true });
    this.closeRoundIfEveryoneAnswered();
  }

  private update(state: PlayerState): void {
    const existing = this.players().get(state.playerId);
    // A finished score is final, even if the phone reloads and tries again.
    if (existing?.finished) {
      this.patch(state.playerId, { connected: true });
      return;
    }
    if (!existing && this.players().size >= MAX_PARTY_PLAYERS) return;
    const next = new Map(this.players());
    next.set(state.playerId, { ...state, connected: true });
    this.players.set(next);
    this.publishBoard();
  }

  private patch(playerId: string, change: Partial<BoardEntry>): void {
    const existing = this.players().get(playerId);
    if (!existing) return;
    if (Object.entries(change).every(([k, v]) => existing[k as keyof BoardEntry] === v)) return;
    const next = new Map(this.players());
    next.set(playerId, { ...existing, ...change });
    this.players.set(next);
    this.publishBoard();
  }

  /** Coalesces bursts (several phones submitting at once) into one retained update. */
  private publishBoard(immediate = false): void {
    if (this.boardTimer && !immediate) return;
    if (this.boardTimer) clearTimeout(this.boardTimer);
    const send = () => {
      this.boardTimer = null;
      const client = this.client;
      const topics = this.topics;
      if (client && topics) {
        publishJson(client, topics.board, { t: 'board', entries: this.board() } satisfies HostMessage, true);
      }
    };
    if (immediate) send();
    else this.boardTimer = setTimeout(send, 250);
  }
}

function messagePlayerId(msg: ClientMessage): string {
  return msg.t === 'state' ? msg.state.playerId : msg.playerId;
}

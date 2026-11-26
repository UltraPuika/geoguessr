import { Injectable, computed, signal } from '@angular/core';
import type { MqttClient } from 'mqtt';
import { PARTY_MAX_PAYLOAD_BYTES } from '../config/party-config';
import {
  BoardEntry,
  HostMessage,
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
import { connectToBroker, describeConnectionError, publishJson, waitForConnect } from './party-broker';

export type PartyHostStatus = 'idle' | 'starting' | 'open' | 'error';

/**
 * Turns this browser into the party host. The host and phones exchange small JSON messages through
 * a public MQTT broker: the host publishes the planned rounds and the leaderboard, phones publish
 * their running score. The host validates everything, so the leaderboard state lives in this tab
 * and the party ends when it is closed.
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

  private client: MqttClient | null = null;
  private topics: PartyTopics | null = null;
  private generation = 0;
  private boardTimer: ReturnType<typeof setTimeout> | null = null;

  async open(game: PartyGame): Promise<void> {
    this.close();
    const gen = ++this.generation;
    const code = createPartyCode();
    const topics = partyTopics(code);
    this.game.set(game);
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
    const client = this.client;
    const topics = this.topics;
    this.client = null;
    this.topics = null;
    if (client && topics) {
      publishJson(client, topics.host, { t: 'closed' } satisfies HostMessage, true);
      // An empty retained payload deletes the stored leaderboard on the broker.
      client.publish(topics.board, '', { qos: 1, retain: true }, () => client.end());
      setTimeout(() => client.end(true), 3000);
    }
    this.players.set(new Map());
    this.game.set(null);
    this.code.set(null);
    this.status.set('idle');
    this.error.set(null);
  }

  removePlayer(playerId: string): void {
    const next = new Map(this.players());
    if (!next.delete(playerId)) return;
    this.players.set(next);
    this.publishBoard();
  }

  /** (Re)publishes the retained game and board; runs on every (re)connect. */
  private announce(): void {
    const client = this.client;
    const topics = this.topics;
    const game = this.game();
    if (!client || !topics || !game) return;
    this.error.set(null);
    client.subscribe([topics.stateWildcard, topics.leftWildcard], { qos: 1 });
    publishJson(client, topics.host, { t: 'game', game } satisfies HostMessage, true);
    this.publishBoard(true);
  }

  private onMessage(topic: string, payload: Uint8Array): void {
    const topics = this.topics;
    const game = this.game();
    if (!topics || !game) return;
    const playerId = playerIdFromTopic(topic);
    if (!isValidPlayerId(playerId)) return;
    if (topic === topics.left(playerId)) {
      this.patch(playerId, { connected: false });
      return;
    }
    if (topic !== topics.state(playerId)) return;
    const msg = parseClientMessage(decodePayload(payload, PARTY_MAX_PAYLOAD_BYTES), game.locations.length);
    // The topic and payload must agree, so a phone cannot write into another player's row by accident.
    if (msg && msg.state.playerId === playerId) this.update(msg.state);
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

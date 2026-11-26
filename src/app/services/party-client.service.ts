import { Injectable, computed, signal } from '@angular/core';
import type { DataConnection, Peer } from 'peerjs';
import { HAS_TURN_RELAY, peerOptions } from '../config/peer-config';
import { GameSession } from '../core/game-engine';
import { createId } from '../core/id';
import {
  ClientMessage,
  PartyGame,
  PlayerState,
  PublicBoardEntry,
  normalizePlayerName,
  parseHostMessage,
  peerIdForCode,
} from '../core/party-protocol';
import { describePeerError } from './party-host.service';

export type PartyClientStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';
/** lobby: entering a name · playing: in /game · done: finished or quit */
export type PartyClientPhase = 'lobby' | 'playing' | 'done';

const NAME_KEY = 'geoguess.party.name';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECTS = 20;

/** The phone side of a party: joins a host, plays its rounds and reports the running score. */
@Injectable({ providedIn: 'root' })
export class PartyClientService {
  readonly code = signal<string | null>(null);
  readonly status = signal<PartyClientStatus>('idle');
  readonly error = signal<string | null>(null);
  readonly game = signal<PartyGame | null>(null);
  readonly board = signal<PublicBoardEntry[]>([]);
  readonly phase = signal<PartyClientPhase>('lobby');
  readonly name = signal(loadName());
  /** Local history ID of the finished game, for the details link. */
  readonly resultId = signal<string | null>(null);
  readonly me = computed(() => this.board().find((e) => e.you) ?? null);

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private session: GameSession | null = null;
  private playerId = '';
  private lastState: PlayerState | null = null;
  private generation = 0;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Connects to a party, or does nothing if already connected to the same one. */
  async join(code: string): Promise<void> {
    if (this.code() === code && this.status() !== 'error' && this.status() !== 'idle') return;
    this.leave();
    const gen = ++this.generation;
    this.code.set(code);
    this.playerId = loadPlayerId(code);
    this.status.set('connecting');
    try {
      const { Peer } = await import('peerjs');
      if (gen !== this.generation) return;
      const peer = new Peer(peerOptions());
      this.peer = peer;
      peer.on('error', (err) => {
        if (gen !== this.generation) return;
        if (this.status() === 'reconnecting' && err.type === 'peer-unavailable') {
          this.scheduleReconnect(gen);
          return;
        }
        this.fail(describePeerError(err));
      });
      peer.on('disconnected', () => {
        // Only the signalling link dropped; the data channel to the host may still be alive.
        if (gen === this.generation && !peer.destroyed)
          setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
      });
      peer.once('open', () => gen === this.generation && this.connect(gen));
    } catch (err) {
      if (gen === this.generation) this.fail(describePeerError(err));
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
      playerId: this.playerId,
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
    this.session = null;
    this.lastState = null;
    this.reconnects = 0;
    this.code.set(null);
    this.game.set(null);
    this.board.set([]);
    this.phase.set('lobby');
    this.resultId.set(null);
    this.status.set('idle');
    this.error.set(null);
  }

  private connect(gen: number): void {
    const peer = this.peer;
    const code = this.code();
    if (!peer || !code || peer.destroyed) return;
    const conn = peer.connect(peerIdForCode(code), { reliable: true, serialization: 'json' });
    this.conn = conn;
    const timeout = setTimeout(() => {
      if (gen === this.generation && this.conn === conn && !conn.open) {
        conn.close();
        this.lost(
          gen,
          HAS_TURN_RELAY
            ? 'Timed out connecting to the host. Both devices need internet access.'
            : 'Timed out connecting to the host. Join the same Wi-Fi as the host screen and try again.',
        );
      }
    }, 20_000);
    conn.on('open', () => {
      clearTimeout(timeout);
      if (gen !== this.generation || this.conn !== conn) return;
      this.reconnects = 0;
      this.status.set('connected');
      this.error.set(null);
      this.send();
    });
    conn.on('data', (raw) => {
      if (gen !== this.generation || this.conn !== conn) return;
      const msg = parseHostMessage(raw);
      if (!msg) return;
      switch (msg.t) {
        case 'game':
          // Keep the first plan; a reconnect must never swap rounds under a running game.
          if (!this.game()) this.game.set(msg.game);
          break;
        case 'board':
          this.board.set(msg.entries);
          break;
        case 'closed':
          this.status.set('closed');
          this.generation++;
          conn.close();
          break;
      }
    });
    conn.on('close', () => {
      clearTimeout(timeout);
      if (gen === this.generation && this.conn === conn)
        this.lost(gen, 'Lost connection to the host.');
    });
  }

  private lost(gen: number, message: string): void {
    // Before ever reaching the host there is nothing to resume; report it straight away.
    if (!this.game()) {
      this.fail(message);
      return;
    }
    this.status.set('reconnecting');
    this.error.set(message);
    this.scheduleReconnect(gen);
  }

  private scheduleReconnect(gen: number): void {
    if (this.reconnectTimer || gen !== this.generation) return;
    if (++this.reconnects > MAX_RECONNECTS) {
      this.fail('Could not reconnect to the host. Is the host screen still open?');
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen === this.generation) this.connect(gen);
    }, RECONNECT_DELAY_MS);
  }

  private fail(message: string): void {
    this.status.set('error');
    this.error.set(message);
  }

  private send(): void {
    const conn = this.conn;
    if (!conn?.open || !this.lastState) return;
    try {
      void conn.send({ t: 'state', state: this.lastState } satisfies ClientMessage);
    } catch {
      // The close handler takes over; the latest state is re-sent after reconnecting.
    }
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

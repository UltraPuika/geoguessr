import { Injectable, computed, signal } from '@angular/core';
import type { DataConnection, Peer, PeerError } from 'peerjs';
import {
  BoardEntry,
  HostMessage,
  MAX_PARTY_PLAYERS,
  PartyGame,
  PlayerState,
  createPartyCode,
  parseClientMessage,
  peerIdForCode,
  rankBoard,
} from '../core/party-protocol';

export type PartyHostStatus = 'idle' | 'starting' | 'open' | 'error';

/**
 * Turns this browser into the party host: phones connect peer-to-peer (WebRTC, signalled by the
 * public PeerJS server), receive the planned rounds and report their scores back. All state lives
 * in this tab, so the party ends when it is closed.
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

  private peer: Peer | null = null;
  private readonly conns = new Map<DataConnection, string | null>();
  private generation = 0;

  async open(game: PartyGame): Promise<void> {
    this.close();
    const gen = ++this.generation;
    this.game.set(game);
    this.status.set('starting');
    this.error.set(null);
    try {
      const { Peer } = await import('peerjs');
      for (let attempt = 0; ; attempt++) {
        const code = createPartyCode();
        const peer = new Peer(peerIdForCode(code), { debug: 1 });
        try {
          await waitForOpen(peer);
        } catch (err) {
          peer.destroy();
          if ((err as PeerError<string>).type === 'unavailable-id' && attempt < 3) continue;
          throw err;
        }
        if (gen !== this.generation) {
          peer.destroy();
          return;
        }
        this.peer = peer;
        this.code.set(code);
        this.status.set('open');
        this.listen(peer, gen);
        return;
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.status.set('error');
      this.error.set(describePeerError(err));
    }
  }

  /** Ends the party: tells every phone, then drops all connections. */
  close(): void {
    this.generation++;
    for (const conn of this.conns.keys()) {
      try {
        if (conn.open) void conn.send({ t: 'closed' } satisfies HostMessage);
      } catch {
        // The connection is going away anyway.
      }
    }
    const peer = this.peer;
    this.peer = null;
    this.conns.clear();
    // Give the "closed" messages a moment to leave before tearing down the channels.
    if (peer) setTimeout(() => peer.destroy(), 300);
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
    for (const [conn, id] of this.conns) if (id === playerId) this.conns.set(conn, null);
    this.broadcast();
  }

  private listen(peer: Peer, gen: number): void {
    peer.on('connection', (conn) => this.accept(conn, gen));
    peer.on('disconnected', () => {
      // Lost the signalling server only; existing phones stay connected. Reconnect so new phones can join.
      setTimeout(() => {
        if (gen === this.generation && !peer.destroyed) peer.reconnect();
      }, 2000);
    });
    peer.on('error', (err) => {
      if (gen !== this.generation) return;
      if (err.type === 'peer-unavailable' || err.type === 'webrtc') return;
      this.error.set(describePeerError(err));
    });
  }

  private accept(conn: DataConnection, gen: number): void {
    conn.on('open', () => {
      const game = this.game();
      if (gen !== this.generation || !game || this.conns.size >= MAX_PARTY_PLAYERS * 2) {
        conn.close();
        return;
      }
      this.conns.set(conn, null);
      void conn.send({ t: 'game', game } satisfies HostMessage);
      this.sendBoard(conn);
    });
    conn.on('data', (raw) => {
      const game = this.game();
      if (gen !== this.generation || !game || !this.conns.has(conn)) return;
      const msg = parseClientMessage(raw, game.locations.length);
      if (msg) this.update(conn, msg.state);
    });
    const drop = () => {
      if (!this.conns.has(conn)) return;
      const id = this.conns.get(conn) ?? null;
      this.conns.delete(conn);
      if (id && ![...this.conns.values()].includes(id)) this.patch(id, { connected: false });
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  private update(conn: DataConnection, state: PlayerState): void {
    const bound = this.conns.get(conn);
    // One phone, one player: a connection cannot switch identities mid-party.
    if (bound && bound !== state.playerId) return;
    const existing = this.players().get(state.playerId);
    // A finished score is final, even if the phone reloads and tries again.
    if (existing?.finished) {
      this.conns.set(conn, state.playerId);
      this.patch(state.playerId, { connected: true });
      return;
    }
    if (!existing && this.players().size >= MAX_PARTY_PLAYERS) return;
    this.conns.set(conn, state.playerId);
    const next = new Map(this.players());
    next.set(state.playerId, { ...state, connected: true });
    this.players.set(next);
    this.broadcast();
  }

  private patch(playerId: string, change: Partial<BoardEntry>): void {
    const existing = this.players().get(playerId);
    if (!existing) return;
    const next = new Map(this.players());
    next.set(playerId, { ...existing, ...change });
    this.players.set(next);
    this.broadcast();
  }

  private broadcast(): void {
    for (const conn of this.conns.keys()) this.sendBoard(conn);
  }

  private sendBoard(conn: DataConnection): void {
    if (!conn.open) return;
    const me = this.conns.get(conn) ?? null;
    // Player IDs act as secrets for reconnecting, so other phones never see them.
    const entries = this.board().map(({ playerId, ...rest }) => ({
      ...rest,
      you: playerId === me,
    }));
    try {
      void conn.send({ t: 'board', entries } satisfies HostMessage);
    } catch {
      // Closed between the check and the send; the close handler cleans up.
    }
  }
}

function waitForOpen(peer: Peer): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out contacting the PeerJS server.')),
      15_000,
    );
    peer.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    peer.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function describePeerError(err: unknown): string {
  const type = (err as Partial<PeerError<string>> | null)?.type;
  switch (type) {
    case 'browser-incompatible':
      return 'This browser does not support WebRTC, which party games need.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the PeerJS connection server. Check the internet connection and try again.';
    case 'peer-unavailable':
      return 'Party not found. Check the code, and make sure the host screen is still open.';
    default:
      return err instanceof Error ? err.message : 'The party connection failed.';
  }
}

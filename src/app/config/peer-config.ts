import type { PeerOptions } from 'peerjs';
import { environment } from '../../environments/environment.local';

const STUN_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// Older generated environment files have no `turnServers` field.
const TURN_SERVERS: RTCIceServer[] = (environment as { turnServers?: RTCIceServer[] }).turnServers ?? [];

/** Without a relay, phones can only connect when NAT allows a direct path (usually: same Wi-Fi). */
export const HAS_TURN_RELAY = TURN_SERVERS.length > 0;

export function peerOptions(): PeerOptions {
  // Replaces PeerJS's default ICE list, whose free TURN relay is unreliable.
  return { debug: 1, config: { iceServers: [...STUN_SERVERS, ...TURN_SERVERS] } };
}

/**
 * Party mode relays its messages through a free public MQTT broker over a secure WebSocket, which
 * works on any network (Wi-Fi or mobile data) without accounts. Anyone on the broker who knows or
 * finds a party's topic can read its names and scores; nothing else is sent.
 */
export const PARTY_BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';

/** Retained party messages expire on the broker after this long, so abandoned parties vanish. */
export const PARTY_RETAIN_EXPIRY_SEC = 12 * 60 * 60;

/** Larger payloads are ignored; a 50-round game is well under 50 KB. */
export const PARTY_MAX_PAYLOAD_BYTES = 256 * 1024;

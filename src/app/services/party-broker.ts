import type { IClientOptions, MqttClient } from 'mqtt';
import { PARTY_BROKER_URL, PARTY_RETAIN_EXPIRY_SEC } from '../config/party-config';

/** Lazily loads mqtt.js (only party pages need it) and opens a client to the party broker. */
export async function connectToBroker(options: IClientOptions): Promise<MqttClient> {
  const mod = await import('mqtt');
  // CommonJS/ESM interop differs between dev and production builds.
  const connect = mod.connect ?? (mod as unknown as { default: typeof mod }).default.connect;
  return connect(PARTY_BROKER_URL, {
    protocolVersion: 5,
    clean: true,
    connectTimeout: 15_000,
    reconnectPeriod: 3_000,
    ...options,
  });
}

export function publishJson(client: MqttClient, topic: string, message: unknown, retain = false): void {
  client.publish(topic, JSON.stringify(message), {
    qos: 1,
    retain,
    properties: retain ? { messageExpiryInterval: PARTY_RETAIN_EXPIRY_SEC } : undefined,
  });
}

/** Resolves on the first successful connection; rejects on error or timeout. */
export function waitForConnect(client: MqttClient, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.connected) {
      resolve();
      return;
    }
    const done = (err?: Error) => {
      clearTimeout(timer);
      client.off('connect', onConnect);
      client.off('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onConnect = () => done();
    const onError = (err: Error) => done(err);
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);
    client.on('connect', onConnect);
    client.on('error', onError);
  });
}

export function describeConnectionError(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg === 'timeout' || /websocket|network|ECONN|offline/i.test(msg)) {
    return 'Could not reach the party server. Check the internet connection and try again.';
  }
  return msg || 'The party connection failed.';
}

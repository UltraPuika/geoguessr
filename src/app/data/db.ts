import { DBSchema, IDBPDatabase, IDBPTransaction, StoreNames, openDB } from 'idb';
import { GameMap, GamePreferences, GameRecord, MapLocation, RoundResult } from '../core/models';
import { UsageMetaRecord, UsageMonthRecord } from '../core/usage-ledger';

export const DEFAULT_DB_NAME = 'geoguessr-personal';
export const DB_VERSION = 2;

export interface StoredRound extends RoundResult {
  gameId: string;
}

export interface SettingsRecord {
  key: 'preferences';
  value: GamePreferences;
}

export interface AppDB extends DBSchema {
  maps: { key: string; value: GameMap; indexes: { byUpdatedAt: string } };
  locations: { key: string; value: MapLocation; indexes: { byMapId: string } };
  settings: { key: string; value: SettingsRecord };
  usage: { key: string; value: UsageMetaRecord | UsageMonthRecord };
  games: { key: string; value: GameRecord; indexes: { byPlayedAt: string; byMapId: string } };
  rounds: { key: [string, number]; value: StoredRound; indexes: { byGameId: string } };
}

export type AppDatabase = IDBPDatabase<AppDB>;

type UpgradeTx = IDBPTransaction<AppDB, StoreNames<AppDB>[], 'versionchange'>;

/**
 * Versioned schema. Each step only runs for databases older than that version, so a
 * v1 database is upgraded in place without data loss.
 */
export async function migrate(db: AppDatabase, oldVersion: number, tx: UpgradeTx): Promise<void> {
  if (oldVersion < 1) {
    const maps = db.createObjectStore('maps', { keyPath: 'id' });
    maps.createIndex('byUpdatedAt', 'updatedAt');
    const locations = db.createObjectStore('locations', { keyPath: 'id' });
    locations.createIndex('byMapId', 'mapId');
    db.createObjectStore('settings', { keyPath: 'key' });
    db.createObjectStore('usage', { keyPath: 'key' });
    const games = db.createObjectStore('games', { keyPath: 'id' });
    games.createIndex('byMapId', 'setup.mapId');
    const rounds = db.createObjectStore('rounds', { keyPath: ['gameId', 'index'] });
    rounds.createIndex('byGameId', 'gameId');
  }
  if (oldVersion < 2) {
    // v2: sort history by date, and per-map default location order.
    tx.objectStore('games').createIndex('byPlayedAt', 'playedAt');
    let cursor = await tx.objectStore('maps').openCursor();
    while (cursor) {
      const map = cursor.value as Partial<GameMap> & { id: string };
      if (map.defaultOrder !== 'fixed' && map.defaultOrder !== 'random') {
        await cursor.update({ ...(map as GameMap), defaultOrder: 'random' });
      }
      cursor = await cursor.continue();
    }
  }
}

export function openAppDb(name: string = DEFAULT_DB_NAME): Promise<AppDatabase> {
  return openDB<AppDB>(name, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      // The returned promise is tracked by the versionchange transaction.
      void migrate(db, oldVersion, tx);
    },
    blocking(_current, _blocked, event) {
      // Another tab needs a newer schema: release our connection so it can upgrade.
      (event.target as IDBDatabase).close();
    },
  });
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export function describeStorageError(err: unknown): string {
  if (err instanceof StorageUnavailableError) return err.message;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') {
    return 'Browser storage is full. Export your maps, delete old game history, or free up disk space.';
  }
  if (name === 'InvalidStateError' || name === 'UnknownError') {
    return 'Browser storage is unavailable (private browsing or blocked site data?). Changes cannot be saved.';
  }
  if (name === 'VersionError') {
    return 'The stored data was created by a newer version of this app. Reload or update the app.';
  }
  return err instanceof Error ? err.message : 'Unexpected storage error.';
}

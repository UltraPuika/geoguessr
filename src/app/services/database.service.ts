import { Injectable, InjectionToken, inject } from '@angular/core';
import { AppDatabase, DEFAULT_DB_NAME, StorageUnavailableError, openAppDb } from '../data/db';
import { HistoryRepository, SettingsRepository } from '../data/history-repository';
import { MapRepository } from '../data/map-repository';
import { UsageRepository } from '../data/usage-repository';

export const DB_NAME = new InjectionToken<string>('DB_NAME', { factory: () => DEFAULT_DB_NAME });

@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private readonly name = inject(DB_NAME);
  private connection: Promise<AppDatabase> | null = null;

  readonly db = (): Promise<AppDatabase> => {
    if (!this.connection) {
      if (typeof indexedDB === 'undefined') {
        return Promise.reject(new StorageUnavailableError('This browser does not support IndexedDB.'));
      }
      this.connection = openAppDb(this.name).catch((err) => {
        this.connection = null;
        throw err;
      });
    }
    return this.connection;
  };

  readonly maps = new MapRepository(this.db);
  readonly history = new HistoryRepository(this.db);
  readonly settings = new SettingsRepository(this.db);
  readonly usage = new UsageRepository(this.db);
}

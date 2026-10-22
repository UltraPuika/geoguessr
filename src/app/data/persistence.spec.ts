import { openDB } from 'idb';
import { dbHarness } from '../../testing/db-harness';
import { buildGameRecord, GameSession } from '../core/game-engine';
import { parseImport } from '../core/map-io';
import { GameSetup, MapLocation } from '../core/models';
import { DB_VERSION, openAppDb } from './db';
import { HistoryRepository, SettingsRepository } from './history-repository';
import { MapRepository, NewLocation } from './map-repository';

const newLoc = (lat: number, lng: number, name = ''): NewLocation => ({
  lat,
  lng,
  name,
  notes: '',
  panoId: null,
  heading: 0,
  pitch: 0,
  zoom: 1,
  coverage: 'unknown',
  coverageCheckedAt: null,
});

describe('MapRepository persistence', () => {
  it('keeps maps and locations across an app restart', async () => {
    const h = dbHarness();
    const repo = new MapRepository(h.provider);
    const map = await repo.createMap('Europe', 'desc');
    await repo.addLocation(map.id, newLoc(48.85, 2.35, 'Paris'));
    await repo.addLocation(map.id, newLoc(52.52, 13.4, 'Berlin'));
    await h.restart();

    const reopened = new MapRepository(h.provider);
    const maps = await reopened.listMaps();
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ name: 'Europe', locationCount: 2 });
    const locs = await reopened.getLocations(map.id);
    expect(locs.map((l) => l.name)).toEqual(['Paris', 'Berlin']);
  });

  it('renames, duplicates, reorders and deletes', async () => {
    const h = dbHarness();
    const repo = new MapRepository(h.provider);
    const map = await repo.createMap('A');
    const l1 = await repo.addLocation(map.id, newLoc(1, 1, 'one'));
    const l2 = await repo.addLocation(map.id, newLoc(2, 2, 'two'));
    await repo.updateMap(map.id, { name: 'Renamed', defaultOrder: 'fixed' });
    await repo.reorderLocations(map.id, [l2.id, l1.id]);
    expect((await repo.getLocations(map.id)).map((l) => l.name)).toEqual(['two', 'one']);

    const copy = await repo.duplicateMap(map.id);
    expect(copy.name).toBe('Renamed (copy)');
    expect(await repo.getLocations(copy.id)).toHaveLength(2);

    await repo.deleteMap(map.id);
    expect(await repo.getMap(map.id)).toBeUndefined();
    expect(await repo.getLocations(map.id)).toHaveLength(0);
    expect(await repo.getLocations(copy.id)).toHaveLength(2);
  });

  it('rejects invalid coordinates', async () => {
    const repo = new MapRepository(dbHarness().provider);
    const map = await repo.createMap('A');
    await expect(repo.addLocation(map.id, newLoc(100, 0))).rejects.toThrow();
  });

  it('imports as new maps without overwriting existing ones', async () => {
    const h = dbHarness();
    const repo = new MapRepository(h.provider);
    const original = await repo.createMap('Alps');
    await repo.addLocation(original.id, newLoc(46, 8, 'original'));
    const exported = await repo.exportMaps([original.id]);

    const parsed = parseImport(JSON.stringify(exported));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [created] = await repo.importMaps(parsed.maps);

    expect(created.id).not.toBe(original.id);
    expect(created.name).toBe('Alps (imported)');
    const maps = await repo.listMaps();
    expect(maps).toHaveLength(2);
    expect((await repo.getLocations(original.id))[0].name).toBe('original');
    expect(await repo.getLocations(created.id)).toHaveLength(1);
  });

  it('does not write anything for an invalid import file', async () => {
    const repo = new MapRepository(dbHarness().provider);
    const parsed = parseImport('{"format":"geoguessr-personal-maps","schemaVersion":1,"maps":[{"name":"x","locations":[{"lat":999,"lng":0}]}]}');
    expect(parsed.ok).toBe(false);
    expect(await repo.listMaps()).toHaveLength(0);
  });
});

describe('HistoryRepository persistence', () => {
  const setup: GameSetup = {
    mapId: 'm',
    mapName: 'Test',
    rounds: 1,
    timeLimitSec: 30,
    mode: 'nmpz',
    order: 'fixed',
    allowRepeats: false,
    scoringScale: 'world',
  };
  const location: MapLocation = { ...newLoc(10, 10, 'X'), id: 'l', mapId: 'm', order: 0 };

  it('keeps game history across an app restart', async () => {
    const h = dbHarness();
    const session = new GameSession(setup, [location]);
    session.markRoundReady();
    session.placeGuess({ lat: 10.1, lng: 10 });
    session.submit('manual');
    session.next();
    const record = buildGameRecord('g1', session, new Date('2026-10-01T10:00:00Z'));
    await new HistoryRepository(h.provider).saveGame(record, session.roundResults);
    await h.restart();

    const repo = new HistoryRepository(h.provider);
    const games = await repo.listGames();
    expect(games).toHaveLength(1);
    const full = await repo.getGame('g1');
    expect(full?.game.totalScore).toBe(session.roundResults[0].score);
    expect(full?.rounds).toHaveLength(1);
    expect(full?.rounds[0]).not.toHaveProperty('gameId');
  });

  it('lists games newest first', async () => {
    const h = dbHarness();
    const repo = new HistoryRepository(h.provider);
    const base = { setup, totalScore: 0, maxScore: 5000, roundCount: 0, totalDistanceKm: 0, averageDistanceKm: null, guessedRounds: 0, scaleKm: 1 };
    await repo.saveGame({ ...base, id: 'old', playedAt: '2026-01-01T00:00:00Z' }, []);
    await repo.saveGame({ ...base, id: 'new', playedAt: '2026-06-01T00:00:00Z' }, []);
    expect((await repo.listGames()).map((g) => g.id)).toEqual(['new', 'old']);
    expect((await repo.listGames(1)).map((g) => g.id)).toEqual(['new']);
  });
});

describe('SettingsRepository', () => {
  it('returns safe defaults for corrupted preferences', async () => {
    const h = dbHarness();
    const db = await h.provider();
    await db.put('settings', { key: 'preferences', value: { rounds: -3, mode: 'flying' } as never });
    const prefs = await new SettingsRepository(h.provider).getPreferences();
    expect(prefs.rounds).toBe(5);
    expect(prefs.mode).toBe('moving');
  });
});

describe('schema migration', () => {
  it('upgrades a v1 database in place without losing data', async () => {
    const name = `migrate-${Math.random()}`;
    // Build a v1 database exactly as version 1 of the app did.
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('maps', { keyPath: 'id' }).createIndex('byUpdatedAt', 'updatedAt');
        db.createObjectStore('locations', { keyPath: 'id' }).createIndex('byMapId', 'mapId');
        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('usage', { keyPath: 'key' });
        db.createObjectStore('games', { keyPath: 'id' }).createIndex('byMapId', 'setup.mapId');
        db.createObjectStore('rounds', { keyPath: ['gameId', 'index'] }).createIndex('byGameId', 'gameId');
      },
    });
    await v1.put('maps', { id: 'legacy', name: 'Old map', description: '', createdAt: 'x', updatedAt: 'x' });
    v1.close();

    const db = await openAppDb(name);
    expect(db.version).toBe(DB_VERSION);
    const map = await db.get('maps', 'legacy');
    expect(map).toMatchObject({ name: 'Old map', defaultOrder: 'random' });
    expect(db.transaction('games').store.indexNames.contains('byPlayedAt')).toBe(true);
    db.close();
  });

  it('refuses to open a database from a newer app version', async () => {
    const name = `future-${Math.random()}`;
    (await openDB(name, DB_VERSION + 1)).close();
    await expect(openAppDb(name)).rejects.toMatchObject({ name: 'VersionError' });
  });
});

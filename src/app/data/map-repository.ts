import { createId } from '../core/id';
import { ExportFile, ImportedMap, buildExport, uniqueName } from '../core/map-io';
import { GameMap, LocationOrder, MapLocation, MapSummary } from '../core/models';
import { isValidLatLng } from '../core/scoring';
import { DbProvider } from './usage-repository';

export type NewLocation = Omit<MapLocation, 'id' | 'mapId' | 'order'>;

export class MapRepository {
  constructor(
    private readonly db: DbProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listMaps(): Promise<MapSummary[]> {
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readonly');
    const maps = await tx.objectStore('maps').getAll();
    const index = tx.objectStore('locations').index('byMapId');
    const counts = await Promise.all(maps.map((m) => index.count(m.id)));
    await tx.done;
    return maps.map((m, i) => ({ ...m, locationCount: counts[i] }));
  }

  async getMap(id: string): Promise<GameMap | undefined> {
    const db = await this.db();
    return db.get('maps', id);
  }

  async getLocations(mapId: string): Promise<MapLocation[]> {
    const db = await this.db();
    const locs = await db.getAllFromIndex('locations', 'byMapId', mapId);
    return locs.sort((a, b) => a.order - b.order);
  }

  async createMap(name: string, description = '', defaultOrder: LocationOrder = 'random'): Promise<GameMap> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Map name is required.');
    const ts = this.now().toISOString();
    const map: GameMap = {
      id: createId(),
      name: trimmed.slice(0, 200),
      description: description.trim().slice(0, 2000),
      defaultOrder,
      createdAt: ts,
      updatedAt: ts,
    };
    const db = await this.db();
    // `add` (not `put`) fails instead of overwriting if an ID ever collided.
    await db.add('maps', map);
    return map;
  }

  async updateMap(id: string, changes: Partial<Pick<GameMap, 'name' | 'description' | 'defaultOrder'>>): Promise<GameMap> {
    const db = await this.db();
    const tx = db.transaction('maps', 'readwrite');
    const existing = await tx.store.get(id);
    if (!existing) throw new Error('Map not found.');
    const name = changes.name !== undefined ? changes.name.trim().slice(0, 200) : existing.name;
    if (!name) throw new Error('Map name is required.');
    const updated: GameMap = {
      ...existing,
      name,
      description: changes.description !== undefined ? changes.description.trim().slice(0, 2000) : existing.description,
      defaultOrder: changes.defaultOrder ?? existing.defaultOrder,
      updatedAt: this.now().toISOString(),
    };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  }

  async duplicateMap(id: string): Promise<GameMap> {
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readwrite');
    const source = await tx.objectStore('maps').get(id);
    if (!source) throw new Error('Map not found.');
    const names = new Set((await tx.objectStore('maps').getAll()).map((m) => m.name));
    let name = `${source.name} (copy)`;
    for (let n = 2; names.has(name); n++) name = `${source.name} (copy ${n})`;
    const ts = this.now().toISOString();
    const copy: GameMap = { ...source, id: createId(), name, createdAt: ts, updatedAt: ts };
    await tx.objectStore('maps').add(copy);
    const locs = await tx.objectStore('locations').index('byMapId').getAll(id);
    for (const l of locs) {
      await tx.objectStore('locations').add({ ...l, id: createId(), mapId: copy.id });
    }
    await tx.done;
    return copy;
  }

  async deleteMap(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readwrite');
    const keys = await tx.objectStore('locations').index('byMapId').getAllKeys(id);
    for (const k of keys) await tx.objectStore('locations').delete(k);
    await tx.objectStore('maps').delete(id);
    await tx.done;
  }

  async addLocation(mapId: string, loc: NewLocation): Promise<MapLocation> {
    if (!isValidLatLng(loc)) throw new Error('Invalid coordinates.');
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readwrite');
    const map = await tx.objectStore('maps').get(mapId);
    if (!map) throw new Error('Map not found.');
    const existing = await tx.objectStore('locations').index('byMapId').getAll(mapId);
    const order = existing.reduce((max, l) => Math.max(max, l.order), -1) + 1;
    const location: MapLocation = { ...loc, id: createId(), mapId, order };
    await tx.objectStore('locations').add(location);
    await tx.objectStore('maps').put({ ...map, updatedAt: this.now().toISOString() });
    await tx.done;
    return location;
  }

  async updateLocation(location: MapLocation): Promise<void> {
    if (!isValidLatLng(location)) throw new Error('Invalid coordinates.');
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readwrite');
    const existing = await tx.objectStore('locations').get(location.id);
    if (!existing || existing.mapId !== location.mapId) throw new Error('Location not found.');
    await tx.objectStore('locations').put(location);
    await this.touch(tx.objectStore('maps'), location.mapId);
    await tx.done;
  }

  async deleteLocation(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readwrite');
    const existing = await tx.objectStore('locations').get(id);
    if (existing) {
      await tx.objectStore('locations').delete(id);
      await this.touch(tx.objectStore('maps'), existing.mapId);
    }
    await tx.done;
  }

  async reorderLocations(mapId: string, orderedIds: string[]): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readwrite');
    const store = tx.objectStore('locations');
    const locs = await store.index('byMapId').getAll(mapId);
    const byId = new Map(locs.map((l) => [l.id, l]));
    if (orderedIds.length !== locs.length || orderedIds.some((id) => !byId.has(id))) {
      throw new Error('Location list changed; reload and try again.');
    }
    for (const [i, id] of orderedIds.entries()) {
      await store.put({ ...byId.get(id)!, order: i });
    }
    await this.touch(tx.objectStore('maps'), mapId);
    await tx.done;
  }

  /** Always creates new maps with new IDs; existing maps are never overwritten. */
  async importMaps(maps: ImportedMap[]): Promise<GameMap[]> {
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readwrite');
    const names = new Set((await tx.objectStore('maps').getAll()).map((m) => m.name));
    const created: GameMap[] = [];
    const ts = this.now().toISOString();
    for (const m of maps) {
      const name = uniqueName(m.name, names);
      names.add(name);
      const map: GameMap = {
        id: createId(),
        name,
        description: m.description,
        defaultOrder: m.defaultOrder,
        createdAt: ts,
        updatedAt: ts,
      };
      await tx.objectStore('maps').add(map);
      for (const [i, l] of m.locations.entries()) {
        await tx.objectStore('locations').add({ ...l, id: createId(), mapId: map.id, order: i });
      }
      created.push(map);
    }
    await tx.done;
    return created;
  }

  async exportMaps(ids?: string[]): Promise<ExportFile> {
    const db = await this.db();
    const tx = db.transaction(['maps', 'locations'], 'readonly');
    const all = await tx.objectStore('maps').getAll();
    const selected = ids ? all.filter((m) => ids.includes(m.id)) : all;
    const entries = await Promise.all(
      selected.map(async (map) => ({
        map,
        locations: await tx.objectStore('locations').index('byMapId').getAll(map.id),
      })),
    );
    await tx.done;
    return buildExport(entries, this.now());
  }

  private async touch(
    store: { get(id: string): Promise<GameMap | undefined>; put(v: GameMap): Promise<unknown> },
    mapId: string,
  ): Promise<void> {
    const map = await store.get(mapId);
    if (map) await store.put({ ...map, updatedAt: this.now().toISOString() });
  }
}

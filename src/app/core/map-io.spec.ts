import { buildExport, parseImport, uniqueName, EXPORT_FORMAT } from './map-io';
import { GameMap, MapLocation } from './models';

const map: GameMap = {
  id: 'm1',
  name: 'Alps',
  description: 'Mountain roads',
  defaultOrder: 'fixed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const location: MapLocation = {
  id: 'l1',
  mapId: 'm1',
  order: 0,
  lat: 46.5,
  lng: 8.1,
  name: 'Pass',
  notes: '',
  panoId: 'abc',
  heading: 90,
  pitch: 5,
  zoom: 1,
  coverage: 'ok',
  coverageCheckedAt: null,
};

describe('map import/export', () => {
  it('round-trips an export', () => {
    const file = buildExport([{ map, locations: [location] }]);
    const result = parseImport(JSON.stringify(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.maps[0]).toMatchObject({ name: 'Alps', defaultOrder: 'fixed' });
    expect(result.maps[0].locations[0]).toMatchObject({ lat: 46.5, lng: 8.1, panoId: 'abc', heading: 90, pitch: 5 });
  });

  it('rejects invalid JSON', () => {
    expect(parseImport('{nope')).toEqual({ ok: false, errors: ['File is not valid JSON.'] });
  });

  it('rejects an unknown format', () => {
    const r = parseImport(JSON.stringify({ format: 'other', schemaVersion: 1, maps: [] }));
    expect(r.ok).toBe(false);
  });

  it('rejects unsupported schema versions', () => {
    const r = parseImport(JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: 99, maps: [{ name: 'x', locations: [] }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('Unsupported schema version 99');
  });

  it('rejects malformed coordinates and writes nothing', () => {
    const r = parseImport(
      JSON.stringify({
        format: EXPORT_FORMAT,
        schemaVersion: 1,
        maps: [
          { name: 'ok', locations: [{ lat: 1, lng: 1 }] },
          { name: 'bad', locations: [{ lat: 95, lng: 1 }, { lat: '1', lng: 2 }] },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('Map 2, location 1'))).toBe(true);
      expect(r.errors.some((e) => e.includes('Map 2, location 2'))).toBe(true);
    }
  });

  it('requires a map name', () => {
    const r = parseImport(JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: 1, maps: [{ name: ' ', locations: [] }] }));
    expect(r.ok).toBe(false);
  });

  it('normalises headings and defaults optional fields', () => {
    const r = parseImport(
      JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: 1, maps: [{ name: 'x', locations: [{ lat: 0, lng: 0, heading: -90 }] }] }),
    );
    expect(r.ok && r.maps[0].locations[0]).toMatchObject({ heading: 270, pitch: 0, zoom: 1, panoId: null, name: '' });
  });

  it('generates non-colliding names', () => {
    expect(uniqueName('A', new Set(['B']))).toBe('A');
    expect(uniqueName('A', new Set(['A']))).toBe('A (imported)');
    expect(uniqueName('A', new Set(['A', 'A (imported)']))).toBe('A (imported 2)');
  });
});

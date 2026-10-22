import { CoverageStatus, GameMap, LocationOrder, MapLocation } from './models';
import { isValidLatLng } from './scoring';

export const EXPORT_FORMAT = 'geoguessr-personal-maps';
export const EXPORT_SCHEMA_VERSION = 1;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_MAPS_PER_IMPORT = 500;
export const MAX_LOCATIONS_PER_MAP = 20000;
const MAX_TEXT = 2000;

export interface ExportedLocation {
  lat: number;
  lng: number;
  name?: string;
  notes?: string;
  panoId?: string | null;
  heading?: number;
  pitch?: number;
  zoom?: number;
}

export interface ExportedMap {
  name: string;
  description?: string;
  defaultOrder?: LocationOrder;
  createdAt?: string;
  updatedAt?: string;
  locations: ExportedLocation[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  maps: ExportedMap[];
}

/** Validated, normalised map ready to be written with fresh IDs. */
export interface ImportedMap {
  name: string;
  description: string;
  defaultOrder: LocationOrder;
  locations: Omit<MapLocation, 'id' | 'mapId' | 'order'>[];
}

export type ImportResult = { ok: true; maps: ImportedMap[] } | { ok: false; errors: string[] };

export function buildExport(entries: { map: GameMap; locations: MapLocation[] }[], now = new Date()): ExportFile {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    maps: entries.map(({ map, locations }) => ({
      name: map.name,
      description: map.description,
      defaultOrder: map.defaultOrder,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
      locations: [...locations]
        .sort((a, b) => a.order - b.order)
        .map((l) => ({
          lat: l.lat,
          lng: l.lng,
          name: l.name,
          notes: l.notes,
          panoId: l.panoId,
          heading: l.heading,
          pitch: l.pitch,
          zoom: l.zoom,
        })),
    })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function optText(v: unknown, field: string, errors: string[], max = MAX_TEXT): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') {
    errors.push(`${field} must be text.`);
    return '';
  }
  if (v.length > max) errors.push(`${field} is too long (max ${max} characters).`);
  return v.trim();
}

function optNumber(v: unknown, field: string, min: number, max: number, fallback: number, errors: string[]): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    errors.push(`${field} must be a number between ${min} and ${max}.`);
    return fallback;
  }
  return v;
}

export function normalizeHeading(h: number): number {
  return ((h % 360) + 360) % 360;
}

export function parseImport(text: string): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, errors: ['File is too large to import.'] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['File is not valid JSON.'] };
  }
  return validateImport(data);
}

export function validateImport(data: unknown): ImportResult {
  if (!isObj(data)) return { ok: false, errors: ['Expected a JSON object.'] };
  if (data['format'] !== EXPORT_FORMAT) {
    return { ok: false, errors: [`Unrecognised file format (expected "${EXPORT_FORMAT}").`] };
  }
  const version = data['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { ok: false, errors: ['Missing schemaVersion.'] };
  }
  if (version > EXPORT_SCHEMA_VERSION || version < 1) {
    return {
      ok: false,
      errors: [`Unsupported schema version ${version}. This app supports version ${EXPORT_SCHEMA_VERSION}.`],
    };
  }
  const maps = data['maps'];
  if (!Array.isArray(maps) || maps.length === 0) return { ok: false, errors: ['The file contains no maps.'] };
  if (maps.length > MAX_MAPS_PER_IMPORT) return { ok: false, errors: ['Too many maps in one file.'] };

  const errors: string[] = [];
  const out: ImportedMap[] = [];
  maps.forEach((raw, mi) => {
    const where = `Map ${mi + 1}`;
    if (!isObj(raw)) {
      errors.push(`${where}: expected an object.`);
      return;
    }
    const mapErrors: string[] = [];
    const name = optText(raw['name'], `${where} name`, mapErrors, 200);
    if (!name) mapErrors.push(`${where}: name is required.`);
    const description = optText(raw['description'], `${where} description`, mapErrors);
    const order = raw['defaultOrder'];
    if (order !== undefined && order !== 'fixed' && order !== 'random') {
      mapErrors.push(`${where}: defaultOrder must be "fixed" or "random".`);
    }
    const locs = raw['locations'];
    if (!Array.isArray(locs)) {
      mapErrors.push(`${where}: locations must be a list.`);
    } else if (locs.length > MAX_LOCATIONS_PER_MAP) {
      mapErrors.push(`${where}: too many locations (max ${MAX_LOCATIONS_PER_MAP}).`);
    }
    const locations: ImportedMap['locations'] = [];
    if (Array.isArray(locs) && locs.length <= MAX_LOCATIONS_PER_MAP) {
      locs.forEach((l, li) => {
        const lw = `${where}, location ${li + 1}`;
        if (!isObj(l) || !isValidLatLng(l)) {
          mapErrors.push(`${lw}: invalid coordinates (lat -90..90, lng -180..180).`);
          return;
        }
        const panoRaw = l['panoId'];
        if (panoRaw !== undefined && panoRaw !== null && (typeof panoRaw !== 'string' || panoRaw.length > 200)) {
          mapErrors.push(`${lw}: panoId must be text.`);
        }
        locations.push({
          lat: l['lat'] as number,
          lng: l['lng'] as number,
          name: optText(l['name'], `${lw} name`, mapErrors, 200),
          notes: optText(l['notes'], `${lw} notes`, mapErrors),
          panoId: typeof panoRaw === 'string' && panoRaw.trim() ? panoRaw.trim() : null,
          heading: normalizeHeading(optNumber(l['heading'], `${lw} heading`, -360, 720, 0, mapErrors)),
          pitch: optNumber(l['pitch'], `${lw} pitch`, -90, 90, 0, mapErrors),
          zoom: optNumber(l['zoom'], `${lw} zoom`, 0, 5, 1, mapErrors),
          coverage: 'unknown' as CoverageStatus,
          coverageCheckedAt: null,
        });
      });
    }
    if (mapErrors.length) {
      errors.push(...mapErrors.slice(0, 20));
      if (mapErrors.length > 20) errors.push(`${where}: ${mapErrors.length - 20} more problems.`);
      return;
    }
    out.push({ name, description, defaultOrder: (order as LocationOrder | undefined) ?? 'random', locations });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, maps: out };
}

/** Picks a name that does not collide with existing ones, never replacing an existing map. */
export function uniqueName(desired: string, existing: ReadonlySet<string>): string {
  if (!existing.has(desired)) return desired;
  let n = 1;
  let candidate = `${desired} (imported)`;
  while (existing.has(candidate)) {
    n++;
    candidate = `${desired} (imported ${n})`;
  }
  return candidate;
}

export interface TileConfig {
  url: string;
  attribution: string;
  maxZoom: number;
  subdomains: string;
}

/**
 * OpenStreetMap tiles for Leaflet maps (editor, results, and the guess-map fallback).
 * The OSMF tile policy allows light use with attribution:
 * https://operations.osmfoundation.org/policies/tiles/
 */
export const TILE_CONFIG: TileConfig = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  maxZoom: 19,
  subdomains: 'abc',
};

/**
 * Raster tile provider for Leaflet maps (guess map, editor, results).
 *
 * Default: OpenStreetMap standard tiles. The OSMF Tile Usage Policy permits light,
 * non-bulk use from browsers with visible attribution and a valid Referer header,
 * which suits a private, low-traffic game. For heavier use switch to a commercial or
 * self-hosted provider: https://operations.osmfoundation.org/policies/tiles/
 */
export const TILE_CONFIG = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  maxZoom: 19,
} as const;

/**
 * Central configuration for the Street View cost safeguard.
 *
 * Verified against Google Maps Platform documentation last updated 2026-10-21:
 * - SKU "Dynamic Street View" (Pro), billable event: "Successful panorama load",
 *   triggered by `google.maps.StreetViewPanorama` / `Map.getStreetView()`.
 * - 5,000 free billable events per month, then USD 14.00 per 1,000 (first tier).
 * - `StreetViewService` metadata lookups are documented as not billed.
 * Pricing and free allowances can change; re-check before relying on these numbers.
 */
export const USAGE_CONFIG = {
  /** App-level hard limit of potentially billable Street View panorama loads per month. */
  monthlyLimit: 4500,

  /** Assumed Google free monthly allowance for the Dynamic Street View SKU (informational only). */
  assumedFreeMonthlyAllowance: 5000,

  /** Fractions of the limit at which warnings are shown. */
  warningThresholds: [0.8, 0.9, 1.0] as const,

  /**
   * Google's docs do not state whether pointing an existing panorama at a new location
   * (setPano/setPosition) is a new "panorama load". When true, every programmatic change
   * to a different location (new round, editor preview of another spot) reserves one unit.
   * Set to false only if you have verified in your Cloud billing reports that it is not billed.
   */
  countProgrammaticLocationChanges: true,

  /**
   * Google Cloud billing months follow US Pacific time. Using the same zone avoids the
   * app resetting its counter hours before Google's month actually rolls over.
   */
  billingTimeZone: 'America/Los_Angeles',

  /** How long to wait for a panorama to report its status before treating the load as failed. */
  panoramaLoadTimeoutMs: 15000,

  billingSkuName: 'Dynamic Street View',
  docsVerifiedOn: '2026-10-21',
} as const;

export type UsageConfig = typeof USAGE_CONFIG;

/**
 * Google guess-map loads. SKU "Dynamic Maps" (Essentials): billable event "successful map load"
 * of `google.maps.Map`; 10,000 free per month, then USD 7.00 per 1,000 (docs dated 2026-10-21).
 * When this limit is reached, or the counter is unreadable, the free Leaflet map is used instead.
 */
export const MAP_LOAD_CONFIG = {
  monthlyLimit: 9000,
  assumedFreeMonthlyAllowance: 10000,
  warningThresholds: [0.8, 0.9, 1.0] as const,
  billingTimeZone: USAGE_CONFIG.billingTimeZone,
  keyPrefix: 'maps:',
  detectWipe: false,
  loadTimeoutMs: 15000,
  billingSkuName: 'Dynamic Maps',
} as const;

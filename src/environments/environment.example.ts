/**
 * Example environment. Do not put a real key here.
 *
 * `npm start` / `npm run build` run scripts/ensure-env.mjs, which creates the git-ignored
 * `environment.local.ts` from this file, or from the GOOGLE_MAPS_API_KEY environment
 * variable when it is set (used by the GitHub Actions deployment).
 */
export const environment = {
  /** Browser key restricted by HTTP referrer and to the Maps JavaScript API only. */
  googleMapsApiKey: 'YOUR_GOOGLE_MAPS_API_KEY',
};

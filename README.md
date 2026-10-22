# GeoGuess Personal

A private, single-player GeoGuessr-style game. Build maps from your own Street View spots, then play
them alone or pass the device around. Static site (GitHub Pages), no backend, no accounts, no analytics.

- **Modes:** Moving, No Moving, NMPZ (no move/pan/zoom)
- **Map editor:** click-to-add or enter coordinates, free coverage check, Street View preview, starting
  heading/pitch/zoom, reorder, JSON import/export
- **Games:** 1–50 rounds, timer presets (none/15/30/60/120 s/custom), fixed or random order, optional
  repeats, 5,000 points per round, history stored locally
- **Cost guard:** persistent monthly Street View counter with a hard stop at 4,500 (configurable)

> ⚠️ This app **cannot guarantee zero Google charges.** It reduces and caps *its own* usage inside one
> browser. Read [Cost protection](#cost-protection) and set up the Google Cloud safeguards.

---

## Contents

1. [Prerequisites](#prerequisites)
2. [Quick start](#quick-start)
3. [Configure the API key](#configure-the-api-key)
4. [Google Cloud setup](#google-cloud-setup)
5. [Cost protection](#cost-protection)
6. [Using the app](#using-the-app)
7. [Game modes and their limits](#game-modes-and-their-limits)
8. [Scoring](#scoring)
9. [Data, backup and JSON format](#data-backup-and-json-format)
10. [Deploy to GitHub Pages](#deploy-to-github-pages)
11. [Development](#development)
12. [Architecture](#architecture)
13. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js 22+ (developed with Node 24) and npm
- A Google Cloud project with billing enabled (required by Google Maps Platform even within free usage)
- A modern desktop or mobile browser with IndexedDB

## Quick start

```bash
npm install
npm start            # creates src/environments/environment.local.ts if missing, serves http://localhost:4200
```

Without a key, everything except Street View works (maps, import/export, history, settings).

> Windows PowerShell blocks `npm.ps1` by default; use `npm.cmd …` or run from cmd/Git Bash.

## Configure the API key

The key is read from `src/environments/environment.local.ts`, which is **git-ignored**. Never commit a real key.

Option A — edit the generated file:

```ts
// src/environments/environment.local.ts
export const environment = {
  googleMapsApiKey: 'AIza…',
};
```

Option B — environment variable (used by CI). `scripts/ensure-env.mjs` runs before `start`, `build`,
`build:gh-pages` and `test` and writes the file from `GOOGLE_MAPS_API_KEY` when it is set:

```bash
GOOGLE_MAPS_API_KEY=AIza… npm run build:gh-pages
```

`src/environments/environment.example.ts` shows the expected shape with a placeholder.

A browser API key is always visible in the shipped JavaScript. Its protection comes from the
restrictions and quotas below, not from secrecy.

## Google Cloud setup

Do these steps **before** heavy testing with Street View. Use a dedicated Cloud project for this app so
its quotas and budgets are isolated.

### 1. Enable only what is needed

APIs & Services → Library → enable **Maps JavaScript API** only. Street View panoramas and the
Street View metadata service used for coverage checks are part of it. Leave other Maps APIs disabled.

### 2. Restrict the key

APIs & Services → Credentials → your key:

- **Application restriction:** Websites (HTTP referrers). Add
  - `http://localhost:4200/*` (development)
  - `https://YOUR_USERNAME.github.io/*` (GitHub Pages)

  Browsers send only the origin (not the path) on cross-origin requests to Google, so a path-specific
  pattern like `https://YOUR_USERNAME.github.io/REPO/*` may be rejected. The origin-wide pattern also
  covers your other `github.io` project sites, which are under your control.
  Add a custom domain here too if you use one.
- **API restriction:** Restrict key → **Maps JavaScript API** only.

### 3. Quotas (the only Google-side *hard* control)

Google Maps Platform → **Quotas** → select **Maps JavaScript API**. Google offers per-minute and per-day
request quotas (names vary by API and over time). If a per-day quota applies to your usage, set it to
about **150 per day** (≈ 4,500/month). When a quota is reached, Google stops serving requests instead of
billing for them.

Important caveats, from Google's own documentation (*Manage costs*, 2026-10-21):

- Quota and billing are technically separate systems; their numbers can differ. Set quotas a little
  below your real ceiling.
- The Quotas page is not a source of truth for billing; the Billing reports can lag up to 48 hours.
- **Verify in your console which quota (if any) actually counts Street View panorama loads.** If no
  quota applies to them, Google Cloud cannot enforce a usage ceiling for this SKU, and you are relying on
  the app's local limit plus budget alerts.

### 4. Budget and alerts (notification only)

Billing → Budgets & alerts → create a budget for the project (e.g. USD 1) with alerts at 50/90/100 %.
**A budget does not cap spending.** Google states that budgets and alerts do not automatically stop
usage or billing. For an automated cut-off you would have to build Google's "disable billing with budget
notifications" pattern (Pub/Sub + Cloud Function), which has delays and shuts down the whole project.

### Pricing facts used (re-check before relying on them)

Verified against Google Maps Platform docs last updated **2026-10-21**:

| Item | Value |
| --- | --- |
| SKU | Dynamic Street View (Pro) |
| Billable event | "Successful panorama load", triggered by `google.maps.StreetViewPanorama` / `Map.getStreetView()` |
| Free usage | 5,000 events per month (per billing account) |
| Price after free usage | USD 14.00 per 1,000 (first tier) |
| `StreetViewService` metadata | Not billed (per the Street View guide) |
| Map loads (Dynamic Maps) | Not used — the guess map is Leaflet + OpenStreetMap |

Google can change prices and free allowances at any time. The free usage is shared by everything on the
same billing account.

## Cost protection

### What the app does

Settings live in [src/app/config/usage-config.ts](src/app/config/usage-config.ts):

| Setting | Default | Meaning |
| --- | --- | --- |
| `monthlyLimit` | 4,500 | Hard stop for new Street View loads per month |
| `warningThresholds` | 80 %, 90 %, 100 % | Warning levels shown in the UI |
| `countProgrammaticLocationChanges` | `true` | Count each switch of the viewer to a new location |
| `billingTimeZone` | `America/Los_Angeles` | Month boundary (Google billing uses Pacific time) |

How it works:

1. **One viewer per page session.** The app constructs a single `StreetViewPanorama` and moves it between
   screens (editor preview ↔ game). Rounds reuse it.
2. **Reserve before load.** Before constructing the viewer (and, in conservative mode, before pointing it
   at a different location) the app reserves one unit in IndexedDB. Check-and-reserve runs in one
   IndexedDB read-write transaction, which the browser serialises, so parallel requests or several tabs
   cannot overshoot the limit.
3. **Settle afterwards.** Successful loads are confirmed. Failed loads *stay counted* (they might still be
   billed). A unit is only returned when no request can have reached Google (no imagery found by the free
   metadata lookup, or the viewer could not even be constructed).
4. **Never counted:** panning, tilting, zooming, walking around in Moving mode, "Return to start",
   re-showing the same location, coverage checks.
5. **Hard stop.** At the limit, new viewers/locations are refused with the reset date. Map editing,
   import/export, history and settings keep working. There is no reset button.
6. **Fail safe.** If the usage record is missing, fails its integrity check, the storage is unreadable,
   or the device clock jumps back before the last recorded month, Street View is blocked. Settings offers
   a *conservative rebuild*, which marks the current month as fully used.
7. **Monthly reset.** A new record is started automatically when the Pacific-time month changes. Old
   months are kept.
8. **Manual sync.** If the Cloud console shows more usage, you can add units (increase only).

### Uncertainty about billing events

Google documents the billable event as a "successful panorama load" triggered by the
`StreetViewPanorama` class, but does not say whether `setPano()` on an existing viewer is a new load.
The app therefore counts each programmatic location change by default. A 5-round game costs up to
5 units; previews in the editor cost 1 unit per *different* location. If your Cloud billing reports show
that only viewer construction is billed, you may set `countProgrammaticLocationChanges: false`.

The automated tests verify **the app's accounting**, not Google's actual billing. Compare with the
Google Cloud Billing reports periodically.

### Limitations of a browser-only counter

- Clearing site data, private windows, another browser/device or editing IndexedDB bypasses it.
- It cannot see usage from other apps or people using the same key or billing account.
- It does not synchronise between devices.

A genuinely enforceable cross-device limit needs a small backend that issues reservations (and ideally
a key that only the backend can use). This project deliberately stays static; Google Cloud quotas are the
server-side backstop.

## Using the app

1. **Create a map** on the Maps page and open the editor.
2. **Add locations** by clicking the map or typing coordinates. A free metadata lookup checks for
   Street View within 50 m and snaps the location to the panorama.
3. **Preview (optional):** "Load Street View preview" shows the imagery. Look around, then
   "Use current view as start" to store pano ID, heading, pitch and zoom. You can also type them.
4. **Manage locations:** reorder (↑/↓), edit, preview, delete; "Check all coverage" re-validates all.
5. **Play:** choose mode, rounds, timer, order, repeats and scoring scale. The setup screen shows the
   effective number of rounds, the maximum score and how many Street View units the game may use.
6. **Guess:** click the small map (hover or ⤢ to enlarge), move the marker as often as you like, then
   **Confirm guess** (Space/Enter). After the reveal, **Next round** (Space/Enter).
7. **Results** are saved automatically and listed under History.

Keyboard: Space or Enter submits a placed guess and advances after a result (not while typing in a field).

## Game modes and their limits

| | Move | Pan/tilt | Zoom |
| --- | --- | --- | --- |
| Moving | ✓ | ✓ | ✓ |
| No Moving | ✗ | ✓ | ✓ |
| NMPZ | ✗ | ✗ | ✗ |

All modes hide road labels, the address box and the imagery date.

How restrictions are enforced (all with supported APIs/DOM features):

- **Controls:** `linksControl`, `clickToGo`, `disableDoubleClickZoom`, `panControl`, `zoomControl`,
  `scrollwheel`, `motionTracking*` are set per mode.
- **Keyboard:** `StreetViewPanoramaOptions` has no `keyboardShortcuts` option, so a capture-phase key
  listener swallows move keys (↑/↓/W/S) in No Moving and all keys in NMPZ when focus is in the viewer.
- **Guards:** `pano_changed`, `pov_changed` and `zoom_changed` listeners immediately revert any change the
  mode forbids (e.g. via an unexpected built-in control).
- **NMPZ:** the viewer is made `inert` and covered by a transparent overlay, because the API has no option
  to disable mouse-drag panning.

Known limitation: a guard revert happens after the change event, so a forbidden movement may flash for a
frame before snapping back. In Moving mode, "Return to start" jumps back to the round's start.

## Scoring

`score = round(5000 × e^(−distance / scale))`, 5,000 within 25 m, integer 0–5,000, 0 for no guess.

- **World (classic):** scale = 1,491.7 km (world diagonal ÷ 10) — the commonly documented approximation
  of GeoGuessr's classic curve. It is *not* claimed to equal GeoGuessr's current formula.
- **Fit to this map:** scale = bounding-box diagonal of the map's locations ÷ 10 (minimum 5 km).

Distances use the haversine great-circle formula. Code: [src/app/core/scoring.ts](src/app/core/scoring.ts).

## Data, backup and JSON format

All data is in this browser's IndexedDB (`geoguessr-personal`): maps, locations, preferences, usage
records, games and rounds. **Nothing syncs between devices** — use Export/Import.

Export format (`schemaVersion` 1):

```json
{
  "format": "geoguessr-personal-maps",
  "schemaVersion": 1,
  "exportedAt": "2026-10-22T12:00:00.000Z",
  "maps": [
    {
      "name": "Alps",
      "description": "Mountain passes",
      "defaultOrder": "random",
      "locations": [
        { "lat": 46.56, "lng": 8.56, "name": "Furka", "notes": "", "panoId": "…", "heading": 120, "pitch": 0, "zoom": 1 }
      ]
    }
  ]
}
```

Import validates everything first (format, version, coordinate ranges, field types, sizes). If anything
is invalid, nothing is written. Imported maps always become **new** maps; a name clash gets
" (imported)" appended. Existing maps are never overwritten. Pano IDs can expire; coordinates are kept
so the game falls back to the nearest panorama.

## Deploy to GitHub Pages

The app uses hash URLs (`/#/maps/…`) and a relative base href, so it works under any repository path
without a 404 redirect.

### Automatic (GitHub Actions)

1. Push the repository to GitHub.
2. Settings → Secrets and variables → Actions → New repository secret: `GOOGLE_MAPS_API_KEY`.
3. Settings → Pages → Source: **GitHub Actions**.
4. Push to `main` (or run the workflow manually). [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
   installs, runs tests, builds with `npm run build:gh-pages` and deploys `dist/geoguessr/browser`.
5. Add `https://YOUR_USERNAME.github.io/*` to the key's referrer restrictions.

### Manual

```bash
GOOGLE_MAPS_API_KEY=AIza… npm run build:gh-pages
# publish the contents of dist/geoguessr/browser to your Pages branch/site
```

To use an absolute base href instead: `npx ng build --base-href /REPO_NAME/`.

## Development

```bash
npm start                # dev server
npm test                 # unit tests (Vitest, jsdom, fake-indexeddb)
npm run build            # production build
npm run build:gh-pages   # production build with relative base href
```

Tests cover scoring, timer (deadline, suspension, unlimited, single expiry), round planning and game
state guards, mode restrictions and guards with a fake panorama, the usage ledger (persistence, monthly
reset, Pacific-time boundary, concurrency, corruption, hard stop, map management after the stop),
import validation, persistence across restarts and schema migration.

## Architecture

```
src/app
├─ config/        usage-config.ts (limits), tiles-config.ts (Leaflet tiles)
├─ core/          pure logic: scoring, timer, game-engine, map-io, month, usage-ledger,
│                 street-view-controller (single viewer, mode guards, reservations)
├─ data/          IndexedDB schema/migrations (idb) and repositories for maps, history, settings, usage
├─ services/      Angular wrappers: database, usage, Maps loader, Street View owner, active game, toasts
├─ shared/        Leaflet helpers, usage meter, utilities
└─ features/      home, editor, setup, game, results, history, settings (standalone, lazy-loaded)
```

- Angular 22 standalone components, signals, zoneless change detection, strict TypeScript.
- Google Maps JavaScript API is loaded lazily, only when Street View is needed.
- Leaflet + OpenStreetMap tiles for every 2D map (no Google map loads). OSM's tile policy allows light use
  with attribution; switch `tiles-config.ts` to another provider for heavier use.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No Google Maps API key is configured" | Set the key (see above) and restart `npm start`. |
| "Google rejected the API key" / grey Street View | Check referrer restrictions include the exact origin, the key is restricted to Maps JavaScript API, and billing is enabled. See the browser console for `RefererNotAllowedMapError` etc. |
| "Street View is blocked … integrity check" | Usage data is unreadable. Settings → *Rebuild usage tracking (worst case)*; Street View unlocks at the next monthly reset. |
| "device clock is earlier than the latest recorded usage month" | Fix the system clock. |
| "No imagery for this location" in a game | The panorama was removed or the pano ID expired and nothing is within 50 m. Edit or delete the location. |
| "Browser storage is full / unavailable" | Leave private mode, allow site data, free disk space, export maps and delete old history. |
| Maps disappeared | Browser data was cleared or you are in another browser/profile. Import your JSON backup. |
| Leaflet map grey | OSM tiles blocked by network/extension, or tile usage limits; try another tile provider. |

# GeoGuess Personal

A private GeoGuessr-style game. Build maps from your own Street View spots, then play them alone, pass
the device around, or let friends play on their phones via a QR code. Static site (GitHub Pages), no
backend, no accounts, no analytics.

- **Modes:** Moving, No Moving, NMPZ (no move/pan/zoom)
- **Map editor:** click-to-add or enter coordinates, free coverage check, Street View preview, starting
  heading/pitch/zoom, reorder, JSON import/export
- **Games:** 1–50 rounds, timer presets (none/15/30/60/120 s/custom), fixed or random order, optional
  repeats, 5,000 points per round, history stored locally
- **Party mode:** players scan a QR code, enter a name and play on their phones; scores appear on a
  live leaderboard on the host screen. A **live** variant works like Kahoot: the host starts every
  round for everyone at once and shows all guesses on a map after each round
  (see [Party mode](#party-mode-play-on-phones))
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
billing for them. If one quota covers both map loads and panoramas, allow for both (the guess map adds
roughly one load per page session).

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
| Map loads (Dynamic Maps) | Guess map: "successful map load" of `google.maps.Map`; 10,000 free/month, then USD 7.00 per 1,000 |

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

### Google guess map and free fallback

During games the guess map is a real Google map while the monthly allowance lasts:

- One `google.maps.Map` is created per page session (1 unit) and reused for every round and game;
  panning, zooming and clicking are not new loads. A page reload creates a new one.
- Its own counter (`MAP_LOAD_CONFIG` in `usage-config.ts`) stops at **9,000** per month, below the
  10,000 free "Dynamic Maps" loads. Settings shows the usage.
- The pegman is disabled, so the guess map can never open a (billable, answer-revealing) Street View.
- When the allowance is used up, the counter is unreadable, or there is no key, the game uses the free
  Leaflet + OpenStreetMap map instead ("free map" in the panel header). The editor and results pages
  always use the OpenStreetMap map.

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

### Party mode (play on phones)

1. On the setup screen, choose the settings and click **Host on phones**. The host screen shows a QR code,
   a 6-character party code and a live leaderboard. The host does not play.
2. Players scan the QR code (or open `#/join` and type the code), enter a name and tap **Start playing**.
   Everyone gets the same rounds in the same order and plays at their own pace.
3. Each round's score appears on the host's leaderboard and on every phone right away. A finished score
   is final, even if the phone reloads. **End party** disconnects everyone.

#### Live game (Kahoot-style)

Click **Host live game** instead. The host screen is meant for a TV or projector; the host does not play.

1. Players join the same way and tap **Join game**. Their names appear in the lobby; click **Start game**.
2. Every phone gets the round at the same moment. The countdown starts when the round starts, while
   Street View may still be loading. The host screen shows the timer and who has answered. A guess
   that is placed when time runs out still counts; a guess that is placed but not confirmed when the
   host ends the round does not.
3. The round ends when everyone connected has answered, when time is up, or when you click
   **End round now**. The host screen then shows a map with every player's pin, the round's scores and
   the leaderboard with ▲/▼ position changes. Phones show their round rank and overall rank.
4. Click **Next round**. After the last round, **Show final results** shows a podium. Each phone saves the
   game to its own history.

Players who join late, or who reload, jump in at the current round; rounds they missed score 0.
Without a time limit, a round only ends when everyone has answered or when you end it. In live games
the host computes every score from the guessed coordinates, so phones cannot report made-up scores.

How it works and its limits:

- Messages go through the free public [HiveMQ MQTT broker](https://www.hivemq.com/mqtt/public-mqtt-broker/)
  over a secure WebSocket (`src/app/config/party-config.ts`), so phones can join from any network
  (same Wi-Fi or mobile data) with no setup. Only the planned rounds, names, scores and (in live games)
  guess coordinates are sent.
  **The broker is public:** anyone who knows or finds a party's topic can read those messages. Don't
  use names you want to keep private. Retained party data expires on the broker after 12 hours and is
  cleared when you end the party.
- The leaderboard lives in the host tab. If it loses its connection, phones wait and resend scores
  when it is back; closing the tab ends the party for new players.
- Each phone loads Street View itself, with your API key, and counts against **its own** browser usage
  counter. A 5-round party with 6 players can use up to 30 panorama loads of your Google free allowance.
- Phones need to reach the same site as the host. Use the GitHub Pages deployment, or for local testing
  run `npm start -- --host 0.0.0.0`, open the host page via your computer's LAN address
  (e.g. `http://192.168.1.20:4200`), and add that origin to the key's referrer restrictions.
- In self-paced parties, scores are reported by the phones. The host checks they are plausible
  (0–5,000 per played round), but a determined player could cheat. It is meant for friends, not
  competitions.

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
├─ core/          pure logic: scoring, timer, game-engine, map-io, month, usage-ledger, party-protocol,
│                 live-party, street-view-controller (single viewer, mode guards, reservations)
├─ data/          IndexedDB schema/migrations (idb) and repositories for maps, history, settings, usage
├─ services/      Angular wrappers: database, usage, Maps loader, Street View owner, active game, toasts,
│                 party host/client (MQTT)
├─ shared/        Leaflet helpers, usage meter, utilities
└─ features/      home, editor, setup, game, results, history, settings, party (standalone, lazy-loaded)
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
| Phone: “Party not found” / “Could not reach the party server” | The host tab must stay open; check the code. If the server is unreachable, the network may block `broker.hivemq.com` (port 8884); try mobile data. |

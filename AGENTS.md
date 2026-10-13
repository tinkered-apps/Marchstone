# AGENTS.md

The [README](README.md) says what the app does and what data it keeps. This file holds the
commands and conventions.

## Commands

```bash
npm install                       # dev dependencies only (wrangler, @playwright/test, @axe-core/playwright, eslint)
npx playwright install chromium   # once, before the first e2e run
npm start                         # wrangler dev on http://localhost:8123, with production headers
npm test                          # ESLint (eslint.config.mjs), then unit tests: geometry, tracking, marks and files, version, pages
npm run test:e2e                  # Playwright, desktop and mobile, against npm start; includes an axe scan in both themes
npm run deploy                    # npm test, then wrangler deploy
```

On Windows, `start.cmd` runs `npm start` and opens the browser. Geolocation works on
`localhost` without https. Opening `index.html` from disk does not work: the scripts are ES
modules and the service worker needs a real origin.

`npm run deploy` publishes `public/` to <https://marchstone.tinkered.app> as the `marchstone`
Worker (static assets only). It is the only deploy path until the repository is connected to
Workers Builds. Playwright is not part of the deploy gate; run `npm run test:e2e` before
deploying UI changes.

`allowScripts` in `package.json` pins the `esbuild` and `workerd` versions whose install scripts
npm may run. Update it when a Wrangler upgrade changes those versions.

## Versions

- `APP_VERSION` in `public/app.js` fills the footer. It started at 1.00.
- `CACHE` in `public/sw.js` names the app cache and carries the same number
  (`marchstone-v1.00`). A new name is what makes an installed phone fetch the new files.
- Bump both together, by 0.01, on a user-visible release and whenever `SHELL` or the caching
  rules change. `npm test` fails if they differ.
- `SHELL` lists pages by their clean URLs (`./`, `./privacy`). Cloudflare redirects `index.html`
  and `privacy.html` there, and a cached redirect cannot answer a navigation, so a `.html` entry
  breaks the page once the service worker is in charge.
- The tile cache stays `fb-tiles-v1` across releases. The name is older than the app's, and
  renaming it would delete imagery people saved for offline use.

## Layout

Everything served lives in `public/`; nothing outside it is uploaded.

| file | holds |
|---|---|
| `geo.js` | The maths: lat/lng onto a local metre grid, point-in-polygon, distance to edge |
| `track.js` | The judgements: how old a fix really is, which to throw away, what the screen may claim, when the alarm may follow |
| `marks.js` | What a dropped point may say about itself, down to what changes when a hand moves it |
| `io.js` | KML, GPX and GeoJSON, in and out |
| `alerts.js` | The beep and buzz patterns |
| `app.js` | Screens, map, position feed, tracking loop, file downloads |
| `i18n.js` | Every sentence the app says, in English and Polish, and the Polish plural rule |
| `privacy.html`, `privacy.js` | The data and privacy note (GDPR Art. 13) in both languages, and the script that gives it the app's theme and language |
| `sw.js` | Two caches, app and tiles, so updates leave saved imagery alone |
| `_headers` | Security headers for every response |

Leaflet and both Barlow families are vendored in `public/vendor/`, so a phone with no signal
still gets the real interface.

## Privacy and third parties

A private, non-commercial hobby project. No accounts, no analytics, no server-side data, and
Workers Logs stays off in `wrangler.jsonc`, so the only visitor addresses anyone here can read
are the sample Cloudflare shows in its dashboard (up to 7 days), which the privacy page describes.

The only third-party requests are map tiles from `server.arcgisonline.com` (Esri World Imagery)
and `tile.openstreetmap.org`. They are the map; the app has no substitute. Anything else that
leaves the device needs a new legal check first.

`public/privacy.html` is the data note (GDPR Art. 13), linked from the footer and the last line
of Settings, served as `/privacy` and kept out of search results by `X-Robots-Tag` in `_headers` and a
robots meta tag. Its sections on the controller, hosting, email and rights come from the shared
tinkered.app template and publisher profile (`../.tinkered-legal/`, outside this repository) and keep
that wording. Update its map section and storage list, in both languages, when the app contacts
a new service or stores something new; it is the one place that lists them. Its
top bar links back as `index.html` and `index.html#settings`; `app.js` opens Settings from that
hash and then drops it.

`public/_headers` sets the baseline security headers, loosened only where the app needs it:

- `img-src` and `connect-src` allow the two tile origins: Leaflet draws tiles as images, and
  **Save map** and the service worker fetch them.
- `Permissions-Policy` allows `geolocation=(self)`: position is the app.
- `Referrer-Policy: no-referrer` applies everywhere except the OpenStreetMap layer, which sends
  its origin (`referrerPolicy` in `TILES`, `app.js`) because OpenStreetMap's tile usage policy
  asks web pages to identify themselves.

`TILES` in `app.js` is also where to point the map at tiles you host yourself.

The link preview is the `og:*` block in `index.html`, pointing to `public/social-card.png`
(1200×630). The tags are static English with absolute URLs because crawlers do not run scripts,
and the image is not in `SHELL` because no page loads it.

The footer credit "Marchstone vX.XX by Kuba · tinkered.app · Privacy" links Kuba to
`mailto:kuba@tinkered.app`, tinkered.app to `https://tinkered.app` and Privacy to `privacy.html`. The logo is inlined in
`index.html`, so nothing loads from another origin.

## Conventions

- `geo.js`, `track.js`, `marks.js` and `io.js` never touch the page (`document`, `window`), so
  `npm test` covers them in Node. Keep them that way. `io.js` reads KML and GPX with `DOMParser`,
  which is a parser, not the page.
- No runtime dependencies beyond the vendored Leaflet and fonts. Dev dependencies are pinned
  exactly.
- User-facing text: no em dashes.
- **Two languages, one dictionary.** Every user-facing string lives in `i18n.js` under a key, in
  English and Polish; `npm test` fails if either side lacks a key. `index.html` keeps the English
  words for the first paint and names the key in `data-i18n` (text), `data-i18n-html` (markup)
  or `data-i18n-aria` (label). Counts go through `pl()` for Polish plurals, never a trailing "s".
  In `app.js` the translator is imported as `tr`, because `t` there is the tracking session.
  The language is `lang` in `fb.settings`, default English, and the privacy page reads it too.
- **The first screen waits for `app.js`.** The list of areas is drawn by script, above the
  buttons. `.ledger-col` stays `visibility: hidden` until the start-up code sets `data-ready` on
  `<html>`, so nothing is shown and then pushed down (that was a layout shift of 0.34 on a slow
  phone). A CSS animation shows the column after 3 s if the script never runs. `npm run test:e2e`
  measures the shift under slow-4G and CPU throttling.
- **Green, amber and red belong to the answer.** No button, icon, accent or focus ring may use
  them.
- **The screen always shows the live fix.** Colour, word and distance never disagree.
- **The alarm lags it.** A status holds 1.5 s before the sound follows, or jitter on the line
  beeps every second. Crossing to *outside* fires at once.
- **Fix age is measured, not delivered.** The clock runs from the receiver's own timestamp, so a
  position cached four minutes ago reads four minutes old. Arrival time is kept separately and
  only drives stall detection.
- **The feed has two channels.** `watchPosition` where it behaves, an outright request every
  1.2 s where it does not, both landing in `ingest()`.
- **One feed, two callers.** Tracking and walking a boundary run the same feed and share nothing
  else. `startFeed(onFix, onError)` hands over only the readings that survived `keepFix`, and
  what they mean is the caller's business. `session()` is whichever of the two is running.
- Never cover the map credit; Esri and OpenStreetMap make it a condition of use.

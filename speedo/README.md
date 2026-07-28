# Boat Speedo — web app

A GPS speedometer for use on a boat. Installs to the iPhone home screen and runs
fullscreen and offline, with no app store and no account.

Self-contained, no dependencies, no build step. These files are plain static
assets with **no YAML front matter**, so Jekyll copies them through untouched
rather than rendering them into the site layout.

## Installing on the iPhone

1. Open the page in **Safari** (not Chrome — only Safari can install to the home screen).
2. **Share → Add to Home Screen.**
3. Launch it from the icon. It opens fullscreen with its own splash, and works
   with no signal once loaded.
4. Tap **START** and allow location access.

> **It must be served over HTTPS.** Safari refuses the Geolocation API on plain
> `http://`, apart from `localhost`.

## What it does

Two screens: the **helm** screen, and a **passage** screen you swipe to.

### Helm

- **Speed** in knots, large, with mph underneath.
- **Speed history** — a ten-minute trace under the dial, scaled to its own peak.
- **Compass** showing course over ground. Tap **COMPASS** to add the magnetometer,
  which unlike GPS course still works at rest. iOS requires that tap — it will not
  grant motion access without one.
- **Current run** — distance in nautical miles, max, average while under way, and
  time under way. Survives a reload.
- **Anchor watch** — drop a pin, set a swing radius, get an alarm if you drift out.
- **No-wake alarm** — alerts above a set speed.
- **NIGHT** — red-on-black to protect night vision.
- **END TRIP** — files the run to the log and zeroes the counters.

### Passage

- **Tide graph** for your nearest station: a 24-hour curve, current height, whether
  it is rising or falling, time to the next high or low, and the next four extremes.
  Tap **change** to pin a different station — the nearest is often across a bridge or
  up a different creek — or type a NOAA station ID directly.
- **Sun** — sunrise, sunset, daylight length, civil dawn and dusk, solar noon.
  Computed locally, no network. Optionally switches night mode at sunset for you.
- **Trip log** — every saved run with distance, duration, average and max, plus
  season totals and CSV export via the iOS share sheet.

`?demo=1` replays a synthetic track, for showing the app off on dry land.

## Tides need a signal — everything else does not

There is no offline formula for tides: prediction needs harmonic constants measured
at a specific station. The app fetches four days at a time from **NOAA CO-OPS**
(free, no API key) and caches them, so a single connection before you leave the dock
covers a weekend. Predictions are heights above MLLW in feet, at station local time.

Two things worth knowing:

- **Coverage is US waters and the Great Lakes only.** For elsewhere, the provider is
  a swappable module — see `resolve()` at the top of `tides.js`.
- **If the cached predictions do not cover right now, no graph is drawn.** The card
  says so instead. A stale tide curve is worse than no tide curve.

Trip saving has a safety net: if a run has real distance in it and the boat has been
stopped for twenty minutes, it is filed automatically, so forgetting to tap END TRIP
never merges two days into one run.

## The anchor watch limitation

**It only runs while the app is open and the screen is awake.** iOS suspends web
apps when they are backgrounded or the screen locks, and no browser API can change
that. The app holds a screen wake lock while it is open, but do not rely on it as
a sleep-through-the-night alarm.

The native version in [`../ios/`](../ios/) does not have this limitation, because
CoreLocation background updates keep it alive.

## How the numbers are worked out

Rules are shared with the native version so both agree on the same track:

| Rule | Value | Why |
|---|---|---|
| Speed smoothing | EMA, weight 0.3 | Stops the needle twitching at anchor without lagging a boat coming onto plane |
| Accuracy gate | 25 m | A 60 m fix invents distance that was never travelled |
| Jitter floor | max(3 m, accuracy ÷ 2) | A boat on a mooring must not log a passage overnight |
| Under-way threshold | 0.5 kn | Average speed reflects time moving, not time rafted up at lunch |
| Maximum gap | 60 s | After a suspend, the elapsed time is real but was not spent under way |
| Stale fix | 8 s | Show zero rather than a comforting stale number |

Speed comes from `coords.speed` when the GPS chip supplies it, and falls back to
distance over time when it does not — iOS reports no speed at very low speeds.

## Verifying changes

The maths is checked against exact ground truth with a Playwright harness that
drives the app two ways: through the real Geolocation API, and through a
deterministic feed with exact timestamps. It asserts trip distance, max, average,
elapsed time, jitter rejection, both alarms firing and clearing, silence
behaviour, persistence across a reload, and an offline load with the network cut.

It also checks that the helm screen fits without clipping on both a current iPhone
and an iPhone SE — that screen is `overflow: hidden`, so anything that did not fit
would be silently cut off rather than scrolling.

Sun times are cross-checked against independent spherical geometry rather than
against the app's own output: day length is derived in the test from the standard
hour-angle relation using textbook solstice declination, so an error in the solar
series cannot hide behind a self-consistent test.

The tide tests intercept the HTTP layer and answer with generated NOAA-shaped
payloads, exercising URL construction, parsing, nearest-station choice,
interpolation, graph geometry, caching, the stale-cache refusal and the CORS
failure message. **The live request to NOAA is not covered** — see below.

```sh
npx http-server speedo -p 8099 -a 127.0.0.1 --silent &
node speedo/test/verify.js       # needs playwright + chromium available to node
```

It exits non-zero on any failed check and writes day/night screenshots to a temp
directory (override with `SHOT_DIR=...`). `speedo/test/` is excluded from the
Jekyll build, so it never ships with the site.

### What the tests do not cover

- **The live tide request.** It was developed in an environment where NOAA is
  blocked by egress policy, so the real HTTPS call has never run. The most likely
  failure is the browser rejecting the cross-origin request; the app names CORS
  explicitly in that case rather than showing an empty card, so you will know
  within a minute of first load. If that happens, the native app in `../ios/` has
  no CORS restriction.
- **Real-world GPS accuracy.** Only confirmable under way — compare against a
  chartplotter once before trusting it.

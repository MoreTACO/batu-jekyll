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

- **Speed** in knots, large, with mph underneath.
- **Compass** showing course over ground. Tap **COMPASS** to add the magnetometer,
  which unlike GPS course still works at rest. iOS requires that tap — it will not
  grant motion access without one.
- **Trip log** — distance run in nautical miles, max, average while under way, and
  time under way. Survives a reload; **RESET TRIP** clears it.
- **Anchor watch** — drop a pin, set a swing radius, get an alarm if you drift out.
- **No-wake alarm** — alerts above a set speed.
- **NIGHT** — red-on-black to protect night vision.
- `?demo=1` replays a synthetic track, for showing the app off on dry land.

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
behaviour, and persistence across a reload.

```sh
npx http-server speedo -p 8099 -a 127.0.0.1 --silent &
node speedo/test/verify.js       # needs playwright + chromium available to node
```

It exits non-zero on any failed check and writes day/night screenshots to a temp
directory (override with `SHOT_DIR=...`). `speedo/test/` is excluded from the
Jekyll build, so it never ships with the site.

Real-world accuracy can only be confirmed under way — compare against a
chartplotter once before trusting it.

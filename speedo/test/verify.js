// Verification harness for speedo/.
//
// Two passes:
//   A. Real Geolocation API via Playwright's setGeolocation — proves the actual
//      watchPosition wiring, permission flow and derived-speed fallback work.
//   B. Deterministic feed — the same onPosition path driven with exact timestamps,
//      so trip distance / max / average can be checked against real ground truth.
const { chromium } = require('playwright');

const os = require('os');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const R = 6371008.8;                 // must match the app's haversine radius
const SHOT = process.env.SHOT_DIR || fs.mkdtempSync(`${os.tmpdir()}/speedo-`);

const KN = 1.9438445;
let failures = 0;

function check(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected} ±${tol}`);
}
function checkEq(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got "${actual}", expected "${expected}"`);
}

// Metres north -> degrees of latitude, using the app's own earth radius so the
// expected distance is exact rather than approximate.
const northDeg = (m) => (m / R) * (180 / Math.PI);

const IPHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
};

// Synthetic semidiurnal tide, used both to stub the network and to seed the cache
// for screenshots. A real curve is not a pure sinusoid, but it is close enough to
// exercise every code path and to show what the graph looks like with data in it.
const TIDE = { periodH: 12.42, meanFt: 3.0, ampFt: 2.5, firstHighOffsetH: 1.7 };

function tideHeightAt(t, firstHigh) {
  return TIDE.meanFt + TIDE.ampFt *
    Math.cos(2 * Math.PI * (t - firstHigh) / (TIDE.periodH * 3600000));
}

/** The bundle shape BoatTides caches, for seeding localStorage directly. */
function makeTideBundle(now) {
  const HOUR = 3600000;
  const firstHigh = now + TIDE.firstHighOffsetH * HOUR;
  const curve = [];
  for (let t = now - 24 * HOUR; t <= now + 48 * HOUR; t += HOUR) {
    curve.push({ t, v: tideHeightAt(t, firstHigh), type: null });
  }
  const hilo = [];
  for (let n = -3; n <= 6; n++) {
    hilo.push({ t: firstHigh + n * TIDE.periodH * HOUR, v: TIDE.meanFt + TIDE.ampFt, type: 'H' });
    hilo.push({ t: firstHigh + (n + 0.5) * TIDE.periodH * HOUR, v: TIDE.meanFt - TIDE.ampFt, type: 'L' });
  }
  hilo.sort((a, b) => a.t - b.t);
  return {
    stationId: '8518750',
    stationName: 'The Battery, NY',
    distanceM: 2856,
    fetchedAt: now - 1800000,
    hilo,
    curve: curve.concat(hilo).sort((a, b) => a.t - b.t)
  };
}

(async () => {
  const browser = await chromium.launch();

  // ------------------------------------------------------------------ pass A
  console.log('\n--- A. real Geolocation API ---');
  {
    const ctx = await browser.newContext({
      ...IPHONE,
      permissions: ['geolocation'],
      geolocation: { latitude: 40.6892, longitude: -74.0445, accuracy: 5 }
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  page error:', e.message); });
    await page.goto(`${BASE}/index.html`);
    await page.click('#start-btn');

    // Wait for the first real fix, then zero the trip. Chromium may coalesce
    // geolocation updates, so instead of assuming all 12 land we compare the
    // logged distance against the true displacement of the fixes it did receive.
    await page.waitForFunction(() => window.__speedo.prev !== null);
    const startLat = await page.evaluate(() => {
      window.__speedo.trip.distM = 0;
      return window.__speedo.prev.lat;
    });

    // Walk north in 8 m steps. Playwright supplies no coords.speed, so this
    // exercises the derived-speed fallback end to end.
    let lat = startLat;
    for (let i = 0; i < 12; i++) {
      lat += northDeg(8);
      await ctx.setGeolocation({ latitude: lat, longitude: -74.0445, accuracy: 5 });
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(600);

    const endLat = await page.evaluate(() => window.__speedo.prev.lat);
    const trueDisplacement = ((endLat - startLat) * Math.PI / 180) * R;

    const s = await page.evaluate(() => ({
      dist: document.getElementById('dist').textContent,
      kn: document.getElementById('kn').textContent,
      acc: document.getElementById('accuracy').textContent,
      fix: document.getElementById('fix-label').textContent,
      cog: document.getElementById('cog').textContent,
      raw: window.__speedo.trip.distM
    }));
    console.log('   observed:', JSON.stringify(s));

    // Distance logged must equal the true displacement of the delivered fixes.
    check('A: trip distance matches true displacement (m)', s.raw, trueDisplacement, 0.5);
    if (trueDisplacement < 60) { failures++; console.log('FAIL  A: barely any fixes were delivered'); }
    else console.log(`PASS  A: moved ${trueDisplacement.toFixed(1)} m through the real API`);
    checkEq('A: fix quality', s.fix, 'GPS FIX');
    checkEq('A: accuracy readout', s.acc, '5');
    checkEq('A: course made good (due north)', s.cog, '000');
    if (Number(s.kn) <= 0) { failures++; console.log('FAIL  A: speed stayed at zero'); }
    else console.log(`PASS  A: derived speed non-zero (${s.kn} kn)`);

    await ctx.close();
  }

  // ------------------------------------------------------------------ pass B
  console.log('\n--- B. deterministic track, exact ground truth ---');
  {
    const ctx = await browser.newContext(IPHONE);
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  page error:', e.message); });

    // Capture the app's watchPosition callback so we can drive it with exact
    // timestamps instead of wall-clock jitter.
    await page.addInitScript(() => {
      window.__cb = null;
      navigator.geolocation.watchPosition = function (cb) { window.__cb = cb; return 1; };
      window.__feed = function (lat, lon, t, acc, speed, heading) {
        window.__cb({
          coords: {
            latitude: lat, longitude: lon, accuracy: acc,
            speed: speed === undefined ? null : speed,
            heading: heading === undefined ? null : heading,
            altitude: null, altitudeAccuracy: null
          },
          timestamp: t
        });
      };
    });

    await page.goto(`${BASE}/index.html`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('#start-btn');

    // 60 fixes at 5.0 m/s, then 60 at 9.5 m/s, one second apart, heading due north.
    // Ground truth: 60*5 + 60*9.5 = 870 m over 120 s under way.
    const res = await page.evaluate((Rv) => {
      const nd = (m) => (m / Rv) * (180 / Math.PI);
      let lat = 40.0, t = 1700000000000;
      window.__feed(lat, -74, t, 6);            // first fix only seeds prev
      for (let i = 0; i < 60; i++) { lat += nd(5.0); t += 1000; window.__feed(lat, -74, t, 6); }
      for (let i = 0; i < 60; i++) { lat += nd(9.5); t += 1000; window.__feed(lat, -74, t, 6); }
      return {
        distM: window.__speedo.trip.distM,
        maxMs: window.__speedo.trip.maxMs,
        movingMs: window.__speedo.trip.movingMs,
        speedMs: window.__speedo.speedMs,
        dist: document.getElementById('dist').textContent,
        max: document.getElementById('max').textContent,
        avg: document.getElementById('avg').textContent,
        elapsed: document.getElementById('elapsed').textContent,
        kn: document.getElementById('kn').textContent,
        mph: document.getElementById('mph').textContent
      };
    }, R);
    console.log('   observed:', JSON.stringify(res));

    check('B: trip distance (m)', res.distM, 870, 0.5);
    checkEq('B: NM readout', res.dist, '0.47');            // 870 / 1852 = 0.4698
    check('B: max speed (m/s)', res.maxMs, 9.5, 0.05);
    checkEq('B: max readout (kn)', res.max, (9.5 * KN).toFixed(1));
    check('B: time under way (ms)', res.movingMs, 120000, 1);
    checkEq('B: elapsed readout', res.elapsed, '2:00');
    checkEq('B: average readout (kn)', res.avg, ((870 / 120) * KN).toFixed(1));
    checkEq('B: mph is the knots value rescaled',
      res.mph, (Number(res.kn) / KN * 2.2369363).toFixed(1));

    // --- jitter rejection: a boat sitting still must not log a passage ---
    await page.evaluate(() => {
      window.__speedo.trip.distM = 0;
      let t = 1700001000000;
      // 1.5 m of wander per fix, under the 3 m jitter floor.
      for (let i = 0; i < 40; i++) {
        t += 1000;
        window.__feed(40.0 + (i % 2 ? 0.0000135 : 0), -74, t, 6);
      }
    });
    const jitter = await page.evaluate(() => window.__speedo.trip.distM);
    check('B: moored jitter logs no distance (m)', jitter, 0, 0.01);

    // --- no-wake alarm ---
    await page.evaluate(() => {
      window.__speedo.trip.distM = 0;
      document.getElementById('nowake-limit').value = '5';
      document.getElementById('nowake-limit').dispatchEvent(new Event('input'));
    });
    await page.click('#nowake-btn');
    await page.evaluate((Rv) => {
      const nd = (m) => (m / Rv) * (180 / Math.PI);
      let lat = 41.0, t = 1700002000000;
      window.__feed(lat, -74, t, 6);
      for (let i = 0; i < 30; i++) { lat += nd(8); t += 1000; window.__feed(lat, -74, t, 6); }
    }, R);
    const nowake = await page.evaluate(() => ({
      alarm: window.__speedo.alarm,
      banner: !document.getElementById('alarm-banner').hidden,
      text: document.getElementById('alarm-text').textContent,
      state: document.getElementById('nowake-state').textContent
    }));
    console.log('   no-wake:', JSON.stringify(nowake));
    checkEq('B: no-wake alarm fires above threshold', nowake.alarm, 'nowake');
    checkEq('B: no-wake banner visible', nowake.banner, true);
    checkEq('B: no-wake panel state', nowake.state, 'OVER LIMIT');

    const shotNoWake = `${SHOT}/shot-alarm.png`;
    await page.screenshot({ path: shotNoWake });

    // Slowing down must clear it again.
    await page.evaluate((Rv) => {
      const nd = (m) => (m / Rv) * (180 / Math.PI);
      let lat = 42.0, t = 1700003000000;
      window.__feed(lat, -74, t, 6);
      for (let i = 0; i < 40; i++) { lat += nd(0.6); t += 1000; window.__feed(lat, -74, t, 6); }
    }, R);
    const cleared = await page.evaluate(() => window.__speedo.alarm);
    checkEq('B: no-wake alarm clears when slow', cleared, null);
    await page.click('#nowake-btn');   // disarm for the anchor test

    // --- anchor watch ---
    await page.evaluate(() => {
      document.getElementById('anchor-radius').value = '30';
      document.getElementById('anchor-radius').dispatchEvent(new Event('input'));
      window.__feed(43.0, -74, 1700004000000, 6);
    });
    await page.click('#anchor-btn');
    const anchorSet = await page.evaluate(() => window.__speedo.anchor);
    checkEq('B: anchor drops at current fix', anchorSet && Math.round(anchorSet.lat), 43);

    // Drift 20 m — inside a 30 m swing circle, so still quiet.
    await page.evaluate((Rv) => {
      const nd = (m) => (m / Rv) * (180 / Math.PI);
      window.__feed(43.0 + nd(20), -74, 1700004060000, 6);
    }, R);
    const inside = await page.evaluate(() => ({
      alarm: window.__speedo.alarm,
      drift: document.getElementById('drift').textContent,
      state: document.getElementById('anchor-state').textContent
    }));
    console.log('   anchor inside:', JSON.stringify(inside));
    checkEq('B: no alarm inside swing circle', inside.alarm, null);
    checkEq('B: drift readout (m)', inside.drift, '20');
    checkEq('B: anchor panel state', inside.state, 'WATCHING');

    // Drift 45 m — outside the circle, alarm must fire.
    await page.evaluate((Rv) => {
      const nd = (m) => (m / Rv) * (180 / Math.PI);
      window.__feed(43.0 + nd(45), -74, 1700004120000, 6);
    }, R);
    const outside = await page.evaluate(() => ({
      alarm: window.__speedo.alarm,
      text: document.getElementById('alarm-text').textContent,
      state: document.getElementById('anchor-state').textContent,
      drift: document.getElementById('drift').textContent
    }));
    console.log('   anchor outside:', JSON.stringify(outside));
    checkEq('B: anchor alarm fires outside swing circle', outside.alarm, 'anchor');
    checkEq('B: anchor alarm text', outside.text, 'ANCHOR DRAGGING');
    checkEq('B: anchor panel state', outside.state, 'DRAGGING');
    checkEq('B: anchor drift readout (m)', outside.drift, '45');

    // Silence must hide the banner without disarming the watch.
    await page.click('#alarm-ack');
    const acked = await page.evaluate(() => ({
      banner: !document.getElementById('alarm-banner').hidden,
      stillWatching: !!window.__speedo.anchor
    }));
    checkEq('B: silence hides the banner', acked.banner, false);
    checkEq('B: silence keeps the anchor watch armed', acked.stillWatching, true);

    // --- persistence across a reload ---
    await page.reload();
    const restored = await page.evaluate(() => ({
      anchor: !!window.__speedo.anchor,
      radius: window.__speedo.anchorRadius
    }));
    checkEq('B: anchor survives a reload', restored.anchor, true);
    checkEq('B: swing radius survives a reload', restored.radius, 30);

    await ctx.close();
  }

  // ------------------------------------------------------------- screenshots
  console.log('\n--- C. appearance and fit ---');
  {
    // The helm screen is overflow:hidden, so anything that does not fit would be
    // silently clipped rather than scrolling. Check the tightest phone we support
    // as well as a current one.
    const DEVICES = [
      { name: 'iphone-16', viewport: { width: 393, height: 852 } },
      { name: 'iphone-se', viewport: { width: 375, height: 667 } }
    ];

    for (const mode of ['day', 'night']) {
      for (const device of DEVICES) {
        const ctx = await browser.newContext({
          ...IPHONE,
          viewport: device.viewport,
          permissions: ['geolocation'],
          geolocation: { latitude: 40.6892, longitude: -74.0445, accuracy: 5 }
        });
        const page = await ctx.newPage();
        await page.addInitScript((seed) => {
          localStorage.setItem('boat-speedo/v1', JSON.stringify({
            trip: { distM: 8043, maxMs: 9.9, movingMs: 2760000, startedAt: Date.now() - 2760000 },
            anchor: null, anchorRadius: 30, noWakeKn: 5,
            // autoNight off here: with it on, the app would correctly override the
            // seeded palette to match the actual time of day, which is the wrong
            // thing for a screenshot of night mode.
            noWakeArmed: false, night: seed.night, autoNight: false
          }));
          localStorage.setItem('boat-speedo/trips/v1', JSON.stringify([
            { id: 'a', startedAt: Date.now() - 86400000, endedAt: Date.now() - 79200000,
              distM: 22040, maxMs: 10.8, movingMs: 6300000 },
            { id: 'b', startedAt: Date.now() - 604800000, endedAt: Date.now() - 597600000,
              distM: 9210, maxMs: 8.2, movingMs: 3900000 }
          ]));
          localStorage.setItem('boat-speedo/tides/v1', JSON.stringify(seed.tide));
        }, { night: mode === 'night', tide: makeTideBundle(Date.now()) });
        await page.goto(`${BASE}/index.html?demo=1`);
        await page.click('#start-btn');
        await page.waitForTimeout(mode === 'day' && device.name === 'iphone-16' ? 9000 : 2500);

        const fit = await page.evaluate(() => {
          const helm = document.getElementById('screen-helm');
          return {
            overflow: helm.scrollHeight - helm.clientHeight,
            dialVar: getComputedStyle(document.documentElement).getPropertyValue('--dial').trim(),
            readoutPx: getComputedStyle(document.querySelector('.readout__primary')).fontSize
          };
        });
        if (fit.overflow > 1) {
          failures++;
          console.log(`FAIL  C: helm screen overflows by ${fit.overflow}px on ${device.name}`);
        } else {
          console.log(`PASS  C: helm screen fits ${device.name} (dial ${fit.dialVar}, readout ${fit.readoutPx})`);
        }

        if (device.name === 'iphone-16') {
          await page.screenshot({ path: `${SHOT}/shot-${mode}.png` });
          // Swipe to the passage screen and capture that too.
          await page.evaluate(() => {
            const s = document.getElementById('screens');
            s.scrollLeft = s.clientWidth;
            s.dispatchEvent(new Event('scroll'));
          });
          await page.waitForTimeout(600);
          await page.screenshot({ path: `${SHOT}/shot-passage-${mode}.png` });
          console.log(`   wrote ${SHOT}/shot-${mode}.png and shot-passage-${mode}.png`);
        }

        await ctx.close();
      }
    }
  }

  // ---------------------------------------------------------------- offline
  console.log('\n--- D. offline ---');
  {
    const ctx = await browser.newContext({
      ...IPHONE,
      permissions: ['geolocation'],
      geolocation: { latitude: 40.6892, longitude: -74.0445, accuracy: 5 }
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html`);
    // Wait for the service worker to finish activating and claim the page.
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
      null,
      { timeout: 15000 }
    ).catch(() => {});
    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    checkEq('D: service worker controls the page', controlled, true);

    // Cut the network entirely and reload — this is a mile offshore.
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    const offline = await page.evaluate(() => ({
      title: document.title,
      // Proves app.css and app.js both came from cache, not just the HTML.
      styled: getComputedStyle(document.body).backgroundColor,
      ticks: document.getElementById('ticks').children.length,
      gate: !document.getElementById('gate').hidden
    }));
    console.log('   offline reload:', JSON.stringify(offline));
    checkEq('D: page loads with no network', offline.title, 'Boat Speedo');
    checkEq('D: stylesheet served from cache', offline.styled, 'rgb(7, 26, 43)');
    checkEq('D: script ran and drew the dial', offline.ticks > 0, true);
    checkEq('D: start screen shown', offline.gate, true);

    await ctx.setOffline(false);
    await ctx.close();
  }

  // ------------------------------------------------------------ E. sun times
  //
  // Cross-checked against independent spherical geometry, NOT against the app's
  // own numbers. Day length is derived here from the standard hour-angle relation
  // using textbook solstice declination, so an error in the app's solar series —
  // the part most likely to be wrong — cannot hide behind a self-consistent test.
  console.log('\n--- E. sun times ---');
  {
    const ctx = await browser.newContext(IPHONE);
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  page error:', e.message); });
    await page.goto(`${BASE}/index.html`);

    // Hours of daylight for a latitude and solar declination, upper limb at the
    // horizon including refraction (-0.833°).
    const expectedDayLenH = (latDeg, decDeg) => {
      const r = Math.PI / 180;
      const cosH = (Math.sin(-0.833 * r) - Math.sin(latDeg * r) * Math.sin(decDeg * r))
                 / (Math.cos(latDeg * r) * Math.cos(decDeg * r));
      return 2 * Math.acos(Math.max(-1, Math.min(1, cosH))) / r / 15;
    };

    const sun = await page.evaluate(() => {
      const at = (lat, lon, iso) => {
        const t = window.BoatSun.times(lat, lon, new Date(iso));
        return {
          dayLengthMin: t.dayLengthMin,
          sunrise: t.sunrise ? t.sunrise.getTime() : null,
          sunset: t.sunset ? t.sunset.getTime() : null,
          noon: t.solarNoon.getTime(),
          polar: t.polar
        };
      };
      return {
        equatorEquinox: at(0, 0, '2026-03-20T12:00:00Z'),
        nycEquinox:     at(40.7, -74.0, '2026-03-20T17:00:00Z'),
        nycJune:        at(40.7, -74.0, '2026-06-21T16:00:00Z'),
        nycDec:         at(40.7, -74.0, '2026-12-21T17:00:00Z'),
        noonAt0:        at(51.5, 0, '2026-05-15T12:00:00Z'),
        noonAtMinus75:  at(51.5, -75, '2026-05-15T17:00:00Z'),
        arcticJune:     at(80, 20, '2026-06-21T12:00:00Z'),
        arcticDec:      at(80, 20, '2026-12-21T12:00:00Z')
      };
    });

    check('E: equator, equinox day length (h)',
      sun.equatorEquinox.dayLengthMin / 60, expectedDayLenH(0, 0), 0.17);
    check('E: 40.7°N, equinox day length (h)',
      sun.nycEquinox.dayLengthMin / 60, expectedDayLenH(40.7, 0), 0.17);
    check('E: 40.7°N, June solstice day length (h)',
      sun.nycJune.dayLengthMin / 60, expectedDayLenH(40.7, 23.44), 0.14);
    check('E: 40.7°N, Dec solstice day length (h)',
      sun.nycDec.dayLengthMin / 60, expectedDayLenH(40.7, -23.44), 0.14);

    // Sunrise and sunset must sit symmetrically either side of solar noon.
    const beforeNoon = (sun.nycJune.noon - sun.nycJune.sunrise) / 60000;
    const afterNoon = (sun.nycJune.sunset - sun.nycJune.noon) / 60000;
    check('E: sunrise/sunset symmetric about solar noon (min)', beforeNoon, afterNoon, 1);

    // Solar noon at the prime meridian is 12:00 UTC give or take the equation of
    // time, which never exceeds ~16 minutes.
    const noonUTCmin = (sun.noonAt0.noon % 86400000) / 60000;
    check('E: solar noon at lon 0 is near 12:00 UTC (min past midnight)',
      noonUTCmin, 720, 17);

    // Longitude must shift solar noon by exactly 4 minutes per degree.
    const shiftH = (sun.noonAtMinus75.noon - sun.noonAt0.noon) / 3600000;
    check('E: solar noon shifts by lon/15 hours', shiftH, 5, 0.05);

    checkEq('E: Arctic midnight sun has no sunrise', sun.arcticJune.sunrise, null);
    checkEq('E: Arctic midnight sun flagged as polar day', sun.arcticJune.polar, 'day');
    checkEq('E: Arctic polar night flagged', sun.arcticDec.polar, 'night');

    const dark = await page.evaluate(() => ({
      // 03:00 and 13:00 local, mid-summer in NYC.
      night: window.BoatSun.isDark(40.7, -74, new Date(2026, 5, 21, 3, 0)),
      day: window.BoatSun.isDark(40.7, -74, new Date(2026, 5, 21, 13, 0))
    }));
    checkEq('E: isDark true before dawn', dark.night, true);
    checkEq('E: isDark false at midday', dark.day, false);

    // Auto night mode: whatever the real time is when this runs, two positions
    // half a world apart cannot both be in daylight, so this checks the palette
    // actually follows the sun rather than a hard-coded guess.
    await page.click('#start-btn');
    const auto = await page.evaluate(() => {
      const s = window.__speedo, api = window.__speedoApi;
      const probe = (lat, lon) => {
        s.prev = { lat, lon, t: Date.now() };
        s.autoNight = true;
        s.lastAutoDark = null;
        api.applyAutoNight();
        return { dark: window.BoatSun.isDark(lat, lon, new Date()), night: s.night };
      };
      const west = probe(40.7, -74);      // New York
      const east = probe(40.7, 106);      // roughly antipodal in longitude

      // A manual tap must survive until the next sunrise or sunset.
      s.prev = { lat: 40.7, lon: -74, t: Date.now() };
      s.autoNight = true; s.lastAutoDark = null;
      api.applyAutoNight();
      const afterAuto = s.night;
      s.night = !afterAuto;               // simulate the user tapping NIGHT
      api.applyAutoNight();               // must not immediately undo it
      return { west, east, manualHeld: s.night === !afterAuto };
    });
    console.log('   auto-night:', JSON.stringify(auto));

    checkEq('E: exactly one of the two positions is in darkness',
      auto.west.dark !== auto.east.dark, true);
    checkEq('E: palette follows the sun (west)', auto.west.night, auto.west.dark);
    checkEq('E: palette follows the sun (east)', auto.east.night, auto.east.dark);
    checkEq('E: a manual night toggle is not immediately overridden',
      auto.manualHeld, true);

    await ctx.close();
  }

  // ------------------------------------------------------------ F. sparkline
  console.log('\n--- F. speed sparkline ---');
  {
    const ctx = await browser.newContext(IPHONE);
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  page error:', e.message); });
    await page.goto(`${BASE}/index.html`);

    const spark = await page.evaluate(() => {
      const api = window.__speedoApi;
      const s = window.__speedo;
      s.spark.length = 0;
      api.resetSparkClock();

      // 12 minutes of samples every 2 s, peaking at 10 m/s halfway through. The
      // window is 10 minutes, so the first 2 minutes must fall off the back.
      const base = Date.now();
      const total = 360;
      for (let i = 0; i < total; i++) {
        const t = base + i * 2000;
        const ms = i === 180 ? 10 : 2;
        api.pushSpark(t, ms);
      }
      const last = base + (total - 1) * 2000;
      api.renderSpark(last);

      const d = document.getElementById('spark-line').getAttribute('d');
      const pts = d.trim().split(/(?=[ML] )/).filter(Boolean).map(seg => {
        const [, x, y] = seg.trim().split(/\s+/);
        return { x: Number(x), y: Number(y) };
      });
      return {
        buffered: s.spark.length,
        oldest: s.spark[0].t - base,
        pointCount: pts.length,
        minY: Math.min(...pts.map(p => p.y)),
        maxY: Math.max(...pts.map(p => p.y)),
        peakLabel: document.getElementById('spark-peak').textContent,
        spanLabel: document.getElementById('spark-span').textContent,
        firstX: pts[0].x,
        lastX: pts[pts.length - 1].x,
        area: document.getElementById('spark-area').getAttribute('d')
      };
    });
    console.log('   spark:', JSON.stringify({ ...spark, area: spark.area.slice(0, 20) + '…' }));

    // 10-minute window at one sample per 2 s = 300 samples, plus the boundary one.
    check('F: buffer holds one window', spark.buffered, 301, 1);
    check('F: samples older than the window are dropped (ms)', spark.oldest, 120000, 2000);
    checkEq('F: path has one point per sample', spark.pointCount, spark.buffered);
    // Peak sample maps to the top of the 40-unit box (H - (H-2) = 2).
    check('F: peak sample drawn at the top of the box', spark.minY, 2, 0.2);
    // 2 m/s against a 10 m/s peak = 20% of the way up from the baseline.
    check('F: quiet samples drawn proportionally', spark.maxY, 40 - 0.2 * 38, 0.3);
    checkEq('F: peak label in knots', spark.peakLabel, (10 * KN).toFixed(1));
    checkEq('F: area path is closed', spark.area.trim().endsWith('Z'), true);
    check('F: trace starts at the left edge', spark.firstX, 0, 0.01);
    check('F: trace ends at the right edge', spark.lastX, 300, 0.01);
    checkEq('F: span label matches the data held', spark.spanLabel, 'last 10 min');

    // Before the window fills, the trace must still span the box rather than
    // being squashed against the right-hand edge.
    const young = await page.evaluate(() => {
      const api = window.__speedoApi, s = window.__speedo;
      s.spark.length = 0;
      api.resetSparkClock();
      const base = Date.now();
      for (let i = 0; i < 5; i++) api.pushSpark(base + i * 2000, 1 + i);
      api.renderSpark(base + 8000);
      const d = document.getElementById('spark-line').getAttribute('d');
      const xs = d.trim().split(/(?=[ML] )/).filter(Boolean)
        .map(seg => Number(seg.trim().split(/\s+/)[1]));
      return { first: xs[0], last: xs[xs.length - 1], count: xs.length,
               label: document.getElementById('spark-span').textContent };
    });
    checkEq('F: young trace still has every sample', young.count, 5);
    check('F: young trace starts at the left edge', young.first, 0, 0.01);
    check('F: young trace ends at the right edge', young.last, 300, 0.01);
    checkEq('F: young trace labels its real span', young.label, 'last 8 s');

    await ctx.close();
  }

  // ------------------------------------------------------------ G. trip log
  console.log('\n--- G. saved trip log ---');
  {
    const ctx = await browser.newContext(IPHONE);
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  page error:', e.message); });
    await page.addInitScript(() => {
      window.__cb = null;
      navigator.geolocation.watchPosition = function (cb) { window.__cb = cb; return 1; };
      window.__feed = function (lat, lon, t, acc) {
        window.__cb({
          coords: { latitude: lat, longitude: lon, accuracy: acc, speed: null, heading: null },
          timestamp: t
        });
      };
    });
    await page.goto(`${BASE}/index.html`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('#start-btn');

    // Same 870 m / 120 s track as pass B, then file it.
    const logged = await page.evaluate((Rv) => {
      const nd = (m) => (m / Rv) * (180 / Math.PI);
      let lat = 40.0, t = 1700000000000;
      window.__feed(lat, -74, t, 6);
      for (let i = 0; i < 60; i++) { lat += nd(5.0); t += 1000; window.__feed(lat, -74, t, 6); }
      for (let i = 0; i < 60; i++) { lat += nd(9.5); t += 1000; window.__feed(lat, -74, t, 6); }
      const startedAt = window.__speedo.trip.startedAt;
      const entry = window.__speedoApi.endTrip(false);
      return {
        entry, startedAt,
        stored: window.BoatTrips.list(),
        tripAfter: window.__speedo.trip,
        csv: window.BoatTrips.toCSV()
      };
    }, R);
    console.log('   logged:', JSON.stringify(logged.stored));

    check('G: stored distance (m)', logged.stored[0].distM, 870, 0.5);
    check('G: stored time under way (ms)', logged.stored[0].movingMs, 120000, 1);
    check('G: stored max speed (m/s)', logged.stored[0].maxMs, 9.5, 0.05);
    checkEq('G: one trip in the log', logged.stored.length, 1);
    checkEq('G: trip start recorded', typeof logged.startedAt, 'number');
    check('G: counters zeroed after filing', logged.tripAfter.distM, 0, 0.001);
    checkEq('G: start time cleared after filing', logged.tripAfter.startedAt, null);

    const csvLines = logged.csv.trim().split('\n');
    checkEq('G: CSV header', csvLines[0],
      'started,ended,distance_nm,duration_min,max_kn,avg_kn');
    checkEq('G: CSV row count', csvLines.length, 2);
    checkEq('G: CSV distance column', csvLines[1].split(',')[2], '0.47');
    checkEq('G: CSV max column', csvLines[1].split(',')[4], (9.5 * KN).toFixed(1));

    // A few metres on the dock is not a passage.
    const tooShort = await page.evaluate(() => {
      const before = window.BoatTrips.list().length;
      const r = window.BoatTrips.add({ distM: 40, maxMs: 1, movingMs: 30000, startedAt: Date.now() });
      return { r, after: window.BoatTrips.list().length, before };
    });
    checkEq('G: sub-100 m run is not logged', tooShort.r, null);
    checkEq('G: log unchanged by a too-short run', tooShort.after, tooShort.before);

    // Auto-save only after twenty minutes stopped.
    const auto = await page.evaluate(() => {
      const s = window.__speedo;
      s.trip = { distM: 2000, maxMs: 5, movingMs: 600000, startedAt: Date.now() - 900000 };
      s.stoppedSince = Date.now() - 19 * 60000;
      window.__speedoApi.maybeAutoSave(Date.now());
      const at19 = window.BoatTrips.list().length;

      s.stoppedSince = Date.now() - 21 * 60000;
      window.__speedoApi.maybeAutoSave(Date.now());
      return { at19, at21: window.BoatTrips.list().length, distAfter: s.trip.distM };
    });
    checkEq('G: no auto-save at 19 minutes stopped', auto.at19, 1);
    checkEq('G: auto-save fires at 21 minutes stopped', auto.at21, 2);
    check('G: auto-saved trip is cleared', auto.distAfter, 0, 0.001);

    await page.reload();
    const persisted = await page.evaluate(() => window.BoatTrips.list().length);
    checkEq('G: log survives a reload', persisted, 2);

    await ctx.close();
  }

  // ------------------------------------------------------------ H. tides
  //
  // The NOAA host is unreachable from this environment (blocked by egress
  // policy), so the HTTP layer is intercepted and answered with generated
  // NOAA-shaped payloads. Everything downstream of the request is exercised for
  // real: URL construction, parsing, nearest-station choice, interpolation,
  // graph geometry, caching and the stale-cache refusal. The live request itself
  // is NOT covered by this suite.
  console.log('\n--- H. tides (network intercepted) ---');
  {
    const HOUR = 3600000;
    const PERIOD_H = 12.42;       // one semidiurnal tidal cycle
    const MEAN_FT = 3.0, AMP_FT = 2.5;
    const now = Date.now();
    const firstHigh = now + 1.7 * HOUR;

    const heightAt = (t) =>
      MEAN_FT + AMP_FT * Math.cos(2 * Math.PI * (t - firstHigh) / (PERIOD_H * HOUR));

    const stamp = (t) => {
      const d = new Date(t);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
             `${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    const hourly = [];
    for (let t = now - 24 * HOUR; t <= now + 48 * HOUR; t += HOUR) {
      hourly.push({ t: stamp(t), v: heightAt(t).toFixed(3) });
    }
    const hilo = [];
    for (let n = -3; n <= 6; n++) {
      hilo.push({ t: stamp(firstHigh + n * PERIOD_H * HOUR),
                  v: (MEAN_FT + AMP_FT).toFixed(3), type: 'H' });
      hilo.push({ t: stamp(firstHigh + (n + 0.5) * PERIOD_H * HOUR),
                  v: (MEAN_FT - AMP_FT).toFixed(3), type: 'L' });
    }
    hilo.sort((a, b) => new Date(a.t.replace(' ', 'T')) - new Date(b.t.replace(' ', 'T')));

    const STATIONS = { stations: [
      { id: '8518750', name: 'The Battery, NY', lat: 40.7006, lng: -74.0142 },
      { id: '8516945', name: 'Kings Point, NY', lat: 40.8103, lng: -73.7649 },
      { id: '8531680', name: 'Sandy Hook, NJ',  lat: 40.4669, lng: -74.0094 },
      { id: '8461490', name: 'New London, CT',  lat: 41.3614, lng: -72.0900 }
    ] };

    const seen = [];
    const ctx = await browser.newContext({
      ...IPHONE,
      permissions: ['geolocation'],
      geolocation: { latitude: 40.6892, longitude: -74.0445, accuracy: 5 }
    });

    await ctx.route('**://api.tidesandcurrents.noaa.gov/**', async (route) => {
      const url = route.request().url();
      seen.push(url);
      const body = url.includes('stations.json')
        ? STATIONS
        : (url.includes('interval=hilo') ? { predictions: hilo } : { predictions: hourly });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body)
      });
    });

    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  page error:', e.message); });
    await page.addInitScript(() => {
      window.__cb = null;
      navigator.geolocation.watchPosition = function (cb) { window.__cb = cb; return 1; };
      window.__feed = function (lat, lon, t, acc) {
        window.__cb({
          coords: { latitude: lat, longitude: lon, accuracy: acc, speed: null, heading: null },
          timestamp: t
        });
      };
    });
    await page.goto(`${BASE}/index.html`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('#start-btn');

    await page.evaluate(() => window.__feed(40.6892, -74.0445, Date.now(), 5));
    await page.evaluate(() => window.__speedoApi.ensureTides(true));
    await page.waitForFunction(() => window.__speedo.tide.bundle !== null, null, { timeout: 15000 })
      .catch(() => {});

    const tide = await page.evaluate(() => {
      window.__speedoApi.renderPassage();
      const b = window.__speedo.tide.bundle;
      return {
        stationId: b && b.stationId,
        stationName: b && b.stationName,
        hiloCount: b && b.hilo.length,
        curveCount: b && b.curve.length,
        height: document.getElementById('tide-height').textContent,
        trend: document.getElementById('tide-trend').textContent,
        next: document.getElementById('tide-next').textContent,
        state: document.getElementById('tide-state').textContent,
        listItems: document.getElementById('tide-list').children.length,
        pathPoints: (document.getElementById('tide-line').getAttribute('d') || '')
          .split(/(?=[ML] )/).filter(Boolean).length,
        nowX: Number(document.getElementById('tide-nowline').getAttribute('x1')),
        stationLine: document.getElementById('tide-station-name').textContent,
        firstX: Number(((document.getElementById('tide-line').getAttribute('d') || '')
          .match(/^M ([\d.]+)/) || [])[1]),
        lastX: Number(((document.getElementById('tide-line').getAttribute('d') || '')
          .match(/L ([\d.]+) [\d.]+$/) || [])[1]),
        axis: document.getElementById('tide-axis').textContent
      };
    });
    console.log('   tide:', JSON.stringify(tide));

    checkEq('H: nearest station chosen', tide.stationId, '8518750');
    checkEq('H: station name shown', tide.stationName, 'The Battery, NY');
    checkEq('H: hi/lo request made', seen.some(u => u.includes('interval=hilo')), true);
    checkEq('H: hourly request made', seen.some(u => /interval=h(&|$)/.test(u)), true);
    checkEq('H: request carries the station id',
      seen.some(u => u.includes('station=8518750')), true);
    checkEq('H: request asks for MLLW', seen.some(u => u.includes('datum=MLLW')), true);

    // Interpolated height must track the true sinusoid the fixture was built from.
    check('H: current height interpolated correctly (ft)',
      Number(tide.height), heightAt(now), 0.06);
    checkEq('H: trend towards the next high', tide.trend, 'Rising');
    checkEq('H: next event is a high', tide.next.startsWith('High'), true);
    checkEq('H: four upcoming events listed', tide.listItems, 4);
    checkEq('H: station distance shown', tide.stationLine.includes('NM away'), true);

    // 24-hour window at hourly resolution, plus the exact extremes merged in.
    if (tide.pathPoints < 24 || tide.pathPoints > 32) {
      failures++;
      console.log(`FAIL  H: graph point count out of range: ${tide.pathPoints}`);
    } else {
      console.log(`PASS  H: graph drawn from ${tide.pathPoints} merged points`);
    }
    // The curve is scaled to the data it has, so it must span the full box.
    check('H: curve starts at the left edge', tide.firstX, 0, 0.01);
    check('H: curve ends at the right edge', tide.lastX, 300, 0.01);
    // Window runs from now-6h to now+18h, so "now" sits about a quarter across.
    if (tide.nowX < 60 || tide.nowX > 90) {
      failures++;
      console.log(`FAIL  H: now-line misplaced at x=${tide.nowX}`);
    } else {
      console.log(`PASS  H: now-line placed at x=${tide.nowX.toFixed(1)} of 300`);
    }
    checkEq('H: axis marks the far end as the next day', tide.axis.includes('+1d'), true);

    // --- cache survives going offline ---
    await ctx.setOffline(true);
    await page.reload();
    await page.click('#start-btn');
    const offline = await page.evaluate(() => {
      window.__feed(40.6892, -74.0445, Date.now(), 5);
      window.__speedoApi.renderPassage();
      return {
        hasBundle: window.__speedo.tide.bundle !== null,
        height: document.getElementById('tide-height').textContent,
        state: document.getElementById('tide-state').textContent,
        note: document.getElementById('tide-note').textContent
      };
    });
    console.log('   offline tide:', JSON.stringify(offline));
    checkEq('H: cached predictions available with no network', offline.hasBundle, true);
    checkEq('H: height still shown offline', offline.height !== '--', true);
    await ctx.setOffline(false);

    // --- a cache that does not cover now must refuse to draw ---
    const stale = await page.evaluate(() => {
      const b = window.__speedo.tide.bundle;
      const shift = 5 * 86400000;                       // shove the whole cache into the past
      b.curve = b.curve.map(p => ({ ...p, t: p.t - shift }));
      b.hilo = b.hilo.map(p => ({ ...p, t: p.t - shift }));
      window.__speedoApi.renderPassage();
      return {
        state: document.getElementById('tide-state').textContent,
        line: document.getElementById('tide-line').getAttribute('d'),
        height: document.getElementById('tide-height').textContent,
        note: document.getElementById('tide-note').textContent
      };
    });
    checkEq('H: stale cache reports out of date', stale.state, 'OUT OF DATE');
    checkEq('H: stale cache draws no curve', stale.line, '');
    checkEq('H: stale cache shows no height', stale.height, '--');
    checkEq('H: stale cache explains itself',
      stale.note.includes('do not cover right now'), true);

    // --- pinning a different station refetches against that station ---
    seen.length = 0;
    await page.evaluate(() => {
      window.BoatTides.pinStation('8531680', 'Sandy Hook, NJ');
      return window.__speedoApi.ensureTides(true);
    });
    await page.waitForFunction(
      () => window.__speedo.tide.bundle && window.__speedo.tide.bundle.stationId === '8531680',
      null, { timeout: 15000 }
    ).catch(() => {});
    const pinned = await page.evaluate(() => window.__speedo.tide.bundle.stationId);
    checkEq('H: pinned station is used', pinned, '8531680');
    checkEq('H: refetch targets the pinned station',
      seen.some(u => u.includes('station=8531680')), true);

    await ctx.close();
  }

  // ------------------------------------------------------- I. tide failures
  console.log('\n--- I. tide failure handling ---');
  {
    const ctx = await browser.newContext({
      ...IPHONE,
      permissions: ['geolocation'],
      geolocation: { latitude: 40.6892, longitude: -74.0445, accuracy: 5 }
    });
    // Simulate the browser refusing the cross-origin request, which is the most
    // likely real-world failure and must not look like "no tides here".
    await ctx.route('**://api.tidesandcurrents.noaa.gov/**', route => route.abort('failed'));

    const page = await ctx.newPage();
    await page.addInitScript(() => {
      navigator.geolocation.watchPosition = function (cb) { window.__cb = cb; return 1; };
      window.__feed = function (lat, lon, t, acc) {
        window.__cb({ coords: { latitude: lat, longitude: lon, accuracy: acc,
                                speed: null, heading: null }, timestamp: t });
      };
    });
    await page.goto(`${BASE}/index.html`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('#start-btn');
    await page.evaluate(() => window.__feed(40.6892, -74.0445, Date.now(), 5));
    await page.evaluate(() => window.__speedoApi.ensureTides(true));
    await page.waitForFunction(() => window.__speedo.tide.busy === false, null, { timeout: 15000 })
      .catch(() => {});

    const failed = await page.evaluate(() => ({
      error: window.__speedo.tide.error,
      note: document.getElementById('tide-note').textContent,
      state: document.getElementById('tide-state').textContent
    }));
    console.log('   failure:', JSON.stringify(failed));
    checkEq('I: fetch failure is surfaced', typeof failed.error, 'string');
    checkEq('I: CORS named as the likely cause', failed.note.includes('CORS'), true);
    checkEq('I: card reports no data', failed.state, 'NO DATA');

    await ctx.close();
  }

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();

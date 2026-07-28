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
  console.log('\n--- C. appearance ---');
  {
    for (const mode of ['day', 'night']) {
      const ctx = await browser.newContext({
        ...IPHONE,
        permissions: ['geolocation'],
        geolocation: { latitude: 40.6892, longitude: -74.0445, accuracy: 5 }
      });
      const page = await ctx.newPage();
      await page.addInitScript((night) => {
        localStorage.setItem('boat-speedo/v1', JSON.stringify({
          trip: { distM: 8043, maxMs: 9.9, movingMs: 2760000 },
          anchor: null, anchorRadius: 30, noWakeKn: 5,
          noWakeArmed: false, night: night
        }));
      }, mode === 'night');
      await page.goto(`${BASE}/index.html?demo=1`);
      await page.click('#start-btn');
      await page.waitForTimeout(9000);           // let the demo track build speed
      const path = `${SHOT}/shot-${mode}.png`;
      await page.screenshot({ path });
      console.log('   wrote', path);
      await ctx.close();
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

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();

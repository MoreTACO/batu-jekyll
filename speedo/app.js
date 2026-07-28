/* Boat Speedo — GPS speedometer, compass, trip log, anchor watch and no-wake alarm.
   No dependencies. Mirrors the logic in ios/BoatSpeedo/. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- constants

  var KN_PER_MS  = 1.9438445;   // m/s -> knots
  var MPH_PER_MS = 2.2369363;   // m/s -> mph
  var M_PER_NM   = 1852;

  var DIAL_MIN_MAX_KN = 30;     // dial tops out here, then rescales in 15kn steps
  var SPEED_ALPHA     = 0.3;    // EMA weight on the newest fix
  var ACCURACY_LIMIT  = 25;     // metres; worse fixes never touch the trip log
  var MIN_STEP_M      = 3;      // metres; below this it is GPS jitter, not movement
  var MOVING_KN       = 0.5;    // under way threshold for average speed
  var STALE_MS        = 8000;   // no fix for this long => show zero, not a stale number
  var COG_MIN_KN      = 1.0;    // GPS course is meaningless below this

  var SPARK_WINDOW_MS = 10 * 60 * 1000;  // sparkline covers the last ten minutes
  var SPARK_STEP_MS   = 2000;            // one sample every two seconds
  var SPARK_FLOOR_KN  = 5;               // never scale below this, or drift looks dramatic
  var AUTOSAVE_STOP_MS = 20 * 60 * 1000; // stopped this long ends the trip by itself
  var TIDE_REFRESH_MS = 6 * 3600 * 1000; // re-fetch predictions this often when online

  var STORE_KEY = 'boat-speedo/v1';

  // ---------------------------------------------------------------- state

  var state = {
    started: false,
    prev: null,           // { lat, lon, t }
    speedMs: 0,           // smoothed
    accuracy: null,
    fixAt: null,
    cog: null,            // degrees 0-359
    cogSource: 'COG',
    trip: { distM: 0, maxMs: 0, movingMs: 0, startedAt: null },
    anchor: null,         // { lat, lon }
    anchorRadius: 30,
    noWakeKn: 5,
    noWakeArmed: false,
    night: false,
    autoNight: false,
    lastAutoDark: null,   // last state auto-night applied, so a manual flip sticks
    alarm: null,          // 'anchor' | 'nowake'
    acked: false,         // alarm silenced by the user until it clears
    dialMaxKn: DIAL_MIN_MAX_KN,
    spark: [],            // [{ t, ms }]
    stoppedSince: null,   // when the boat last came to rest
    tide: { bundle: null, stations: null, busy: false, error: null, triedAt: 0 }
  };

  var el = {};
  [
    'fix-dot', 'fix-label', 'accuracy', 'fix-age', 'wake-dot', 'wake-label',
    'dial-value', 'needle', 'ticks', 'kn', 'mph', 'rose', 'rose-ticks', 'cog', 'cog-src',
    'dist', 'max', 'avg', 'elapsed',
    'spark-svg', 'spark-line', 'spark-area', 'spark-peak', 'spark-span',
    'anchor-panel', 'anchor-state', 'anchor-radius', 'anchor-radius-out', 'anchor-btn',
    'drift', 'drift-fill', 'drift-wrap',
    'nowake-panel', 'nowake-state', 'nowake-limit', 'nowake-limit-out', 'nowake-btn',
    'night-btn', 'compass-btn', 'endtrip-btn',
    'alarm-banner', 'alarm-text', 'alarm-ack',
    'screens', 'dots',
    'tide-state', 'tide-station-name', 'tide-change', 'tide-height', 'tide-trend',
    'tide-next', 'tide-area', 'tide-line', 'tide-nowline', 'tide-markers', 'tide-axis',
    'tide-list', 'tide-note', 'tide-picker', 'tide-stations', 'tide-station-id',
    'tide-station-set', 'tide-refresh',
    'sun-state', 'sunrise', 'sunset', 'daylen', 'dawn', 'dusk', 'noon', 'autonight',
    'log-state', 'log-list', 'log-totals', 'log-export', 'log-clear',
    'gate', 'gate-err', 'start-btn'
  ].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  // ---------------------------------------------------------------- geo maths

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  /* Great-circle distance in metres. */
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371008.8;
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* Initial bearing in degrees, 0-359. */
  function bearing(lat1, lon1, lat2, lon2) {
    var p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // ---------------------------------------------------------------- storage

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        trip: state.trip,
        anchor: state.anchor,
        anchorRadius: state.anchorRadius,
        noWakeKn: state.noWakeKn,
        noWakeArmed: state.noWakeArmed,
        night: state.night,
        autoNight: state.autoNight
      }));
    } catch (e) { /* private mode / quota — the app still works, it just forgets */ }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return; }
    if (!s || typeof s !== 'object') return;
    if (s.trip && typeof s.trip.distM === 'number') {
      state.trip.distM   = s.trip.distM   || 0;
      state.trip.maxMs   = s.trip.maxMs   || 0;
      state.trip.movingMs = s.trip.movingMs || 0;
      state.trip.startedAt = s.trip.startedAt || null;
    }
    if (s.anchor && typeof s.anchor.lat === 'number') state.anchor = s.anchor;
    if (typeof s.anchorRadius === 'number') state.anchorRadius = s.anchorRadius;
    if (typeof s.noWakeKn === 'number') state.noWakeKn = s.noWakeKn;
    state.noWakeArmed = !!s.noWakeArmed;
    state.night = !!s.night;
    state.autoNight = !!s.autoNight;
  }

  // ---------------------------------------------------------------- audio

  /* One AudioContext, unlocked on the first user gesture. If we waited until the
     alarm fired, iOS would refuse to make a sound — a silent failure in exactly
     the situation where noise matters. */
  var audioCtx = null;
  var alarmTimer = null;

  function unlockAudio() {
    try {
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }

  function beep(freq, seconds) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    var now = audioCtx.currentTime;
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + seconds + 0.02);
  }

  function startAlarmSound(kind) {
    stopAlarmSound();
    var fire = kind === 'anchor'
      ? function () { beep(880, 0.18); setTimeout(function () { beep(880, 0.18); }, 260); }
      : function () { beep(560, 0.3); };
    fire();
    alarmTimer = setInterval(fire, kind === 'anchor' ? 900 : 1400);
  }

  function stopAlarmSound() {
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
  }

  function vibrate(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  // ---------------------------------------------------------------- wake lock

  var wakeLock = null;

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) { setWakeUI(false, 'NO LOCK'); return; }
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      setWakeUI(true, 'SCREEN ON');
      lock.addEventListener('release', function () {
        wakeLock = null;
        setWakeUI(false, 'SCREEN');
      });
    }).catch(function () {
      setWakeUI(false, 'NO LOCK');
    });
  }

  function setWakeUI(on, label) {
    el['wake-dot'].className = 'status__dot' + (on ? ' is-good' : '');
    el['wake-label'].textContent = label;
  }

  // iOS drops the wake lock whenever you switch away; take it back on return.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.started && !wakeLock) requestWakeLock();
  });

  // ---------------------------------------------------------------- dial setup

  var DIAL_CX = 150, DIAL_CY = 150, DIAL_R = 128;
  var DIAL_START = 135, DIAL_SWEEP = 270;
  var ARC_LEN = 2 * Math.PI * DIAL_R * (DIAL_SWEEP / 360);

  function buildTicks(maxKn) {
    var step = maxKn <= 30 ? 5 : 10;
    var out = '';
    for (var v = 0; v <= maxKn; v += step) {
      var ang = toRad(DIAL_START + DIAL_SWEEP * (v / maxKn));
      var cos = Math.cos(ang), sin = Math.sin(ang);
      out += '<line class="tick tick--major" x1="' + (DIAL_CX + cos * 116).toFixed(1) +
             '" y1="' + (DIAL_CY + sin * 116).toFixed(1) +
             '" x2="' + (DIAL_CX + cos * 104).toFixed(1) +
             '" y2="' + (DIAL_CY + sin * 104).toFixed(1) + '"/>';
      out += '<text class="tick-label" x="' + (DIAL_CX + cos * 90).toFixed(1) +
             '" y="' + (DIAL_CY + sin * 90).toFixed(1) + '">' + v + '</text>';
    }
    var minor = step / 5;
    for (var m = 0; m <= maxKn; m += minor) {
      if (Math.abs(m / step - Math.round(m / step)) < 1e-9) continue;
      var a2 = toRad(DIAL_START + DIAL_SWEEP * (m / maxKn));
      out += '<line class="tick" x1="' + (DIAL_CX + Math.cos(a2) * 116).toFixed(1) +
             '" y1="' + (DIAL_CY + Math.sin(a2) * 116).toFixed(1) +
             '" x2="' + (DIAL_CX + Math.cos(a2) * 109).toFixed(1) +
             '" y2="' + (DIAL_CY + Math.sin(a2) * 109).toFixed(1) + '"/>';
    }
    el.ticks.innerHTML = out;
  }

  function buildRoseTicks() {
    var out = '';
    for (var d = 0; d < 360; d += 30) {
      var a = toRad(d - 90);
      var inner = (d % 90 === 0) ? 40 : 44;
      out += '<line class="rose-tick" x1="' + (60 + Math.cos(a) * 50).toFixed(1) +
             '" y1="' + (60 + Math.sin(a) * 50).toFixed(1) +
             '" x2="' + (60 + Math.cos(a) * inner).toFixed(1) +
             '" y2="' + (60 + Math.sin(a) * inner).toFixed(1) + '"/>';
    }
    el['rose-ticks'].innerHTML = out;
  }

  // ---------------------------------------------------------------- render

  function fmtClock(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }

  function render() {
    var stale = state.fixAt == null || (Date.now() - state.fixAt) > STALE_MS;
    var ms = stale ? 0 : state.speedMs;
    var kn = ms * KN_PER_MS;

    // Rescale the dial in 15 kn steps once the boat outruns it, and never scale back
    // down mid-trip — a jumping scale is unreadable at speed.
    while (kn > state.dialMaxKn) {
      state.dialMaxKn += 15;
      buildTicks(state.dialMaxKn);
    }

    var frac = Math.max(0, Math.min(1, kn / state.dialMaxKn));
    el['dial-value'].style.strokeDasharray = ARC_LEN.toFixed(2);
    el['dial-value'].style.strokeDashoffset = (ARC_LEN * (1 - frac)).toFixed(2);
    el.needle.setAttribute('transform',
      'rotate(' + (DIAL_START + DIAL_SWEEP * frac).toFixed(2) + ' 150 150)');

    el.kn.textContent = kn.toFixed(1);
    el.mph.textContent = (ms * MPH_PER_MS).toFixed(1);

    document.body.classList.toggle('over-limit',
      state.noWakeArmed && kn > state.noWakeKn);

    // compass
    if (state.cog == null) {
      el.cog.textContent = '---';
    } else {
      el.cog.textContent = String(Math.round(state.cog)).padStart(3, '0');
      el.rose.setAttribute('transform', 'rotate(' + (-state.cog).toFixed(1) + ' 60 60)');
    }
    el['cog-src'].textContent = state.cogSource;

    // trip
    el.dist.textContent = (state.trip.distM / M_PER_NM).toFixed(2);
    el.max.textContent = (state.trip.maxMs * KN_PER_MS).toFixed(1);
    var avgMs = state.trip.movingMs > 0
      ? state.trip.distM / (state.trip.movingMs / 1000)
      : 0;
    el.avg.textContent = (avgMs * KN_PER_MS).toFixed(1);
    el.elapsed.textContent = fmtClock(state.trip.movingMs);

    // status strip
    if (state.accuracy == null) {
      el.accuracy.textContent = '--';
      el['fix-dot'].className = 'status__dot';
      el['fix-label'].textContent = 'NO FIX';
    } else {
      el.accuracy.textContent = Math.round(state.accuracy);
      var cls = state.accuracy <= 10 ? ' is-good' : (state.accuracy <= ACCURACY_LIMIT ? ' is-weak' : ' is-bad');
      el['fix-dot'].className = 'status__dot' + cls;
      el['fix-label'].textContent = state.accuracy <= ACCURACY_LIMIT ? 'GPS FIX' : 'WEAK FIX';
    }
    el['fix-age'].textContent = state.fixAt == null
      ? '--'
      : Math.min(999, Math.round((Date.now() - state.fixAt) / 1000)) + 's ago';

    var now = Date.now();
    if (state.started) pushSpark(now, ms);
    renderSpark(now);

    renderAnchor();
    renderNoWake();
  }

  function renderAnchor() {
    var armed = !!state.anchor;
    el['anchor-panel'].classList.toggle('is-armed', armed && state.alarm !== 'anchor');
    el['anchor-panel'].classList.toggle('is-alarm', state.alarm === 'anchor');
    el['anchor-btn'].textContent = armed ? 'WEIGH ANCHOR' : 'DROP ANCHOR';
    el['anchor-btn'].classList.toggle('is-on', armed);
    el['drift-wrap'].hidden = !armed;

    if (!armed) { el['anchor-state'].textContent = 'OFF'; return; }

    var drift = currentDrift();
    if (drift == null) { el['anchor-state'].textContent = 'WAITING FOR FIX'; return; }
    el['anchor-state'].textContent = state.alarm === 'anchor' ? 'DRAGGING' : 'WATCHING';
    el.drift.textContent = Math.round(drift);
    var pct = Math.max(0, Math.min(100, (drift / state.anchorRadius) * 100));
    el['drift-fill'].style.width = pct.toFixed(0) + '%';
    el['drift-fill'].className = 'drift__fill' +
      (pct >= 100 ? ' is-out' : (pct >= 70 ? ' is-close' : ''));
  }

  function renderNoWake() {
    el['nowake-panel'].classList.toggle('is-armed', state.noWakeArmed && state.alarm !== 'nowake');
    el['nowake-panel'].classList.toggle('is-alarm', state.alarm === 'nowake');
    el['nowake-btn'].textContent = state.noWakeArmed ? 'DISARM' : 'ARM ALARM';
    el['nowake-btn'].classList.toggle('is-on', state.noWakeArmed);
    el['nowake-state'].textContent = !state.noWakeArmed
      ? 'OFF'
      : (state.alarm === 'nowake' ? 'OVER LIMIT' : 'ARMED');
  }

  function currentDrift() {
    if (!state.anchor || !state.prev) return null;
    return haversine(state.anchor.lat, state.anchor.lon, state.prev.lat, state.prev.lon);
  }

  // ---------------------------------------------------------------- sparkline

  var lastSparkAt = 0;

  function pushSpark(now, ms) {
    if (now - lastSparkAt < SPARK_STEP_MS) return;
    lastSparkAt = now;
    state.spark.push({ t: now, ms: ms });
    var cutoff = now - SPARK_WINDOW_MS;
    while (state.spark.length && state.spark[0].t < cutoff) state.spark.shift();
  }

  function renderSpark(now) {
    var pts = state.spark;
    if (pts.length < 2) {
      el['spark-line'].setAttribute('d', '');
      el['spark-area'].setAttribute('d', '');
      el['spark-peak'].textContent = '0.0';
      return;
    }

    var W = 300, H = 40;
    var peakMs = 0;
    for (var i = 0; i < pts.length; i++) if (pts[i].ms > peakMs) peakMs = pts[i].ms;

    // Scale to the window's own peak, with a floor so a slow drift does not render
    // as dramatic mountains.
    var peakKn = Math.max(SPARK_FLOOR_KN, peakMs * KN_PER_MS);

    // Span the box with whatever we have. In the first ten minutes after starting
    // there is less than a full window, and squeezing it against the right-hand
    // edge looks like a broken graph rather than a young one.
    var from = pts[0].t;
    var to = pts[pts.length - 1].t;
    if (to - from < 1000) { to = from + 1000; }
    var span = to - from;

    var d = '';
    for (var j = 0; j < pts.length; j++) {
      var x = (pts[j].t - from) / span * W;
      var y = H - (pts[j].ms * KN_PER_MS / peakKn) * (H - 2);
      d += (j === 0 ? 'M ' : 'L ') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }

    var firstX = '0.0';
    var lastX = W.toFixed(1);

    var spanMin = Math.round(span / 60000);
    el['spark-span'].textContent = spanMin >= 1
      ? 'last ' + spanMin + ' min'
      : 'last ' + Math.round(span / 1000) + ' s';

    el['spark-line'].setAttribute('d', d.trim());
    el['spark-area'].setAttribute('d', d + 'L ' + lastX + ' ' + H + ' L ' + firstX + ' ' + H + ' Z');
    el['spark-peak'].textContent = (peakMs * KN_PER_MS).toFixed(1);
  }

  // ---------------------------------------------------------------- sun

  function renderSun() {
    if (!state.prev) {
      el['sun-state'].textContent = 'NEEDS A FIX';
      return;
    }
    var t = window.BoatSun.times(state.prev.lat, state.prev.lon, new Date());
    el.sunrise.textContent = window.BoatSun.fmt(t.sunrise);
    el.sunset.textContent = window.BoatSun.fmt(t.sunset);
    el.dawn.textContent = window.BoatSun.fmt(t.civilDawn);
    el.dusk.textContent = window.BoatSun.fmt(t.civilDusk);
    el.noon.textContent = window.BoatSun.fmt(t.solarNoon);
    el.daylen.textContent = t.polar === 'day' ? '24h'
                          : (t.polar === 'night' ? '0h' : window.BoatSun.fmtDuration(t.dayLengthMin));
    el['sun-state'].textContent = t.polar === 'day' ? 'MIDNIGHT SUN'
                                : (t.polar === 'night' ? 'POLAR NIGHT' : 'LOCAL TIME');
  }

  /* Flip the palette at sunrise and sunset. A manual tap wins until the next
     transition, rather than being undone a second later. */
  function applyAutoNight() {
    if (!state.autoNight || !state.prev) return;
    var dark = window.BoatSun.isDark(state.prev.lat, state.prev.lon, new Date());
    if (dark === state.lastAutoDark) return;
    state.lastAutoDark = dark;
    if (state.night !== dark) {
      state.night = dark;
      applyNight();
      save();
    }
  }

  // ---------------------------------------------------------------- tides

  function tideStatus(text, cls) {
    el['tide-state'].textContent = text;
    el['tide-state'].className = 'card__state' + (cls ? ' ' + cls : '');
  }

  function note(text, warn) {
    el['tide-note'].textContent = text || '';
    el['tide-note'].className = 'card__note' + (warn ? ' is-warn' : '');
  }

  function hhmm(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0');
  }

  /* Collapse the readout, graph, axis and list together. Showing an empty graph
     frame with nothing in it reads as a broken app rather than as missing data. */
  function showTideDetail(show) {
    ['tide-now-wrap', 'tide-axis', 'tide-list'].forEach(function (id) {
      el[id] = el[id] || document.getElementById(id);
      if (el[id]) el[id].hidden = !show;
    });
    var graph = document.getElementById('tide-graph');
    if (graph) graph.hidden = !show;
  }

  function renderTide() {
    var T = window.BoatTides;
    var bundle = state.tide.bundle;
    var now = Date.now();

    if (state.tide.busy) tideStatus('FETCHING…');

    if (!bundle) {
      if (!state.tide.busy) tideStatus('NO DATA', 'is-warn');
      el['tide-station-name'].textContent = 'No station yet';
      showTideDetail(false);
      note(state.tide.error
        ? state.tide.error
        : 'Tides cannot be computed offline. Connect once with a signal and the '
          + 'predictions are cached for several days.', !!state.tide.error);
      return;
    }

    el['tide-station-name'].textContent = bundle.stationName +
      (bundle.distanceM != null
        ? ' · ' + (bundle.distanceM / 1852).toFixed(1) + ' NM away'
        : '');

    var covers = T.coversNow(bundle, now);
    if (!covers) {
      if (!state.tide.busy) tideStatus('OUT OF DATE', 'is-warn');
      note('The cached predictions do not cover right now, so no graph is drawn — '
         + 'a stale tide curve is worse than none. Connect and refresh.', true);
      showTideDetail(false);
      el['tide-line'].setAttribute('d', '');
      el['tide-area'].setAttribute('d', '');
      el['tide-markers'].innerHTML = '';
      el['tide-list'].innerHTML = '';
      el['tide-height'].textContent = '--';
      el['tide-trend'].textContent = '—';
      el['tide-next'].textContent = '—';
      return;
    }

    showTideDetail(true);

    var ageH = (now - bundle.fetchedAt) / 3600000;
    if (!state.tide.busy) {
      tideStatus(ageH < 1 ? 'UP TO DATE' : 'CACHED', ageH < 12 ? 'is-ok' : '');
    }
    note(ageH < 1
      ? 'Predicted heights above MLLW, station local time.'
      : 'Cached ' + (ageH < 24
          ? Math.round(ageH) + ' h ago'
          : Math.round(ageH / 24) + ' d ago') + '. Predicted heights above MLLW.');

    // now readout
    var h = T.heightAt(bundle, now);
    el['tide-height'].textContent = h == null ? '--' : h.toFixed(1);
    var trend = T.trendAt(bundle, now);
    el['tide-trend'].textContent = trend === 'rising' ? 'Rising'
                                 : (trend === 'falling' ? 'Falling' : '—');

    var next = T.nextEvent(bundle, now);
    if (next) {
      var mins = Math.round((next.t - now) / 60000);
      el['tide-next'].textContent =
        (next.type === 'H' ? 'High' : 'Low') + ' ' + next.v.toFixed(1) + ' ft at ' +
        hhmm(next.t) + ' · in ' + (mins >= 60
          ? Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm'
          : mins + 'm');
    } else {
      el['tide-next'].textContent = '—';
    }

    // graph
    var win = T.window24(bundle, now);
    var geo = T.geometry(win, 300, 110, 6);
    if (!geo) {
      el['tide-line'].setAttribute('d', '');
      el['tide-area'].setAttribute('d', '');
      el['tide-axis'].innerHTML = '';
    } else {
      el['tide-line'].setAttribute('d', geo.d);
      el['tide-area'].setAttribute('d', geo.area);
      var nx = geo.x(now).toFixed(2);
      el['tide-nowline'].setAttribute('x1', nx);
      el['tide-nowline'].setAttribute('x2', nx);

      var marks = '';
      bundle.hilo.forEach(function (p) {
        if (p.t < win.from || p.t > win.to) return;
        var x = geo.x(p.t), y = geo.y(p.v);
        marks += '<line class="tide__mark-tick" x1="' + x.toFixed(2) + '" y1="' + y.toFixed(2) +
                 '" x2="' + x.toFixed(2) + '" y2="' + (y + (p.type === 'H' ? -7 : 7)).toFixed(2) +
                 '" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
      });
      el['tide-markers'].innerHTML = marks;

      // Over a 24-hour window both ends land on the same clock time, so say which
      // day the right-hand one is.
      var sameDay = new Date(geo.tFrom).getDate() === new Date(geo.tTo).getDate();
      el['tide-axis'].innerHTML =
        '<span>' + hhmm(geo.tFrom) + '</span><span>now</span>' +
        '<span>' + hhmm(geo.tTo) + (sameDay ? '' : ' +1d') + '</span>';
    }

    // upcoming highs and lows
    var upcoming = bundle.hilo.filter(function (p) { return p.t > now - 3600000; }).slice(0, 4);
    el['tide-list'].innerHTML = upcoming.map(function (p) {
      return '<li class="' + (p.type === 'H' ? 'is-high' : 'is-low') + '">' +
             '<span>' + (p.type === 'H' ? 'High' : 'Low') + ' ' + hhmm(p.t) + '</span>' +
             '<span>' + p.v.toFixed(1) + ' ft</span></li>';
    }).join('');
  }

  function renderStationPicker() {
    var list = state.tide.stations;
    if (!list) { el['tide-stations'].innerHTML = '<li class="tide__empty">Needs a signal once.</li>'; return; }
    var pinned = window.BoatTides.pinnedStationId();
    el['tide-stations'].innerHTML = list.map(function (s) {
      return '<li><button type="button" data-station="' + s.id + '" data-name="' +
             s.name.replace(/"/g, '&quot;') + '"' +
             (s.id === pinned ? ' class="is-on"' : '') + '>' +
             '<span>' + s.name + '</span>' +
             '<span class="dist">' + (s.distanceM / 1852).toFixed(1) + ' NM</span>' +
             '</button></li>';
    }).join('');
  }

  /* Pick a station and fetch, but only when there is a plausible reason to: no
     cache, a different station, stale data, or the user asked. */
  function ensureTides(force) {
    var T = window.BoatTides;
    if (state.tide.busy || !state.prev) return Promise.resolve();
    if (navigator.onLine === false && !force) return Promise.resolve();

    var bundle = state.tide.bundle;
    var fresh = bundle &&
                (Date.now() - bundle.fetchedAt) < TIDE_REFRESH_MS &&
                T.coversNow(bundle, Date.now()) &&
                (!T.pinnedStationId() || T.pinnedStationId() === bundle.stationId);
    if (fresh && !force) return Promise.resolve();

    // Do not hammer a failing network on every fix.
    if (!force && Date.now() - state.tide.triedAt < 60000) return Promise.resolve();
    state.tide.triedAt = Date.now();
    state.tide.busy = true;
    state.tide.error = null;
    renderTide();

    return T.loadStations().then(function (stations) {
      state.tide.stations = T.nearest(stations, state.prev.lat, state.prev.lon, 8);
      renderStationPicker();

      var pinned = T.pinnedStationId();
      var chosen = null;
      if (pinned) {
        for (var i = 0; i < stations.length; i++) {
          if (stations[i].id === pinned) {
            chosen = {
              id: stations[i].id, name: stations[i].name,
              distanceM: T.haversine(state.prev.lat, state.prev.lon,
                                     stations[i].lat, stations[i].lon)
            };
            break;
          }
        }
        if (!chosen) chosen = { id: pinned, name: 'Station ' + pinned, distanceM: null };
      } else {
        chosen = state.tide.stations[0];
      }
      if (!chosen) throw new Error('no station found near you');
      return T.fetchPredictions(chosen);
    }).then(function (bundle) {
      state.tide.bundle = bundle;
      state.tide.busy = false;
      renderTide();
    }).catch(function (err) {
      state.tide.busy = false;
      state.tide.error = tideErrorText(err);
      renderTide();
    });
  }

  function tideErrorText(err) {
    var msg = (err && err.message) || String(err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return 'Could not reach the tide service. If you have a signal, this is most '
           + 'likely the browser blocking a cross-origin request (CORS).';
    }
    return 'Tide fetch failed: ' + msg;
  }

  // ---------------------------------------------------------------- trip log

  function renderLog() {
    var trips = window.BoatTrips.list();
    el['log-state'].textContent = trips.length
      ? trips.length + (trips.length === 1 ? ' TRIP' : ' TRIPS')
      : 'NO TRIPS';

    el['log-list'].innerHTML = trips.map(function (t) {
      return '<li class="log__row" data-id="' + t.id + '">' +
             '<span class="log__when">' + window.BoatTrips.when(t) + '</span>' +
             '<span class="log__stats"><b>' + window.BoatTrips.nm(t.distM) + ' NM</b> · ' +
             window.BoatTrips.duration(t.movingMs) + ' · ' +
             window.BoatTrips.knots(window.BoatTrips.avgMs(t)) + ' avg · ' +
             window.BoatTrips.knots(t.maxMs) + ' max</span>' +
             '<button type="button" class="log__del" data-del="' + t.id +
             '" aria-label="Delete trip">&times;</button></li>';
    }).join('');

    var tot = window.BoatTrips.totals();
    el['log-totals'].hidden = tot.count === 0;
    el['log-totals'].textContent = tot.count
      ? tot.count + ' trips · ' + window.BoatTrips.nm(tot.distM) + ' NM · ' +
        window.BoatTrips.duration(tot.movingMs) + ' under way · ' +
        window.BoatTrips.knots(tot.maxMs) + ' kn best'
      : '';
  }

  function endTrip(auto) {
    var saved = window.BoatTrips.add(state.trip, Date.now());
    state.trip = { distM: 0, maxMs: 0, movingMs: 0, startedAt: null };
    state.stoppedSince = null;
    state.dialMaxKn = DIAL_MIN_MAX_KN;
    buildTicks(state.dialMaxKn);
    renderLog();
    render();
    save();
    if (!auto && !saved) {
      // Be honest that nothing was filed rather than silently zeroing.
      el['log-state'].textContent = 'TOO SHORT TO LOG';
    }
    return saved;
  }

  /* Safety net: a run that has been stopped for twenty minutes is over, whether
     or not anyone remembered to tap END TRIP. */
  function maybeAutoSave(now) {
    if (!window.BoatTrips.isLoggable(state.trip)) return;
    if (state.stoppedSince == null) return;
    if (now - state.stoppedSince < AUTOSAVE_STOP_MS) return;
    endTrip(true);
  }

  function renderPassage() {
    renderSun();
    renderTide();
    renderLog();
  }

  // ---------------------------------------------------------------- alarms

  function setAlarm(kind) {
    if (state.alarm === kind) return;
    state.alarm = kind;
    if (kind) {
      if (state.acked) return;             // user silenced this episode
      el['alarm-text'].textContent = kind === 'anchor'
        ? 'ANCHOR DRAGGING'
        : 'OVER ' + state.noWakeKn.toFixed(1) + ' KN';
      el['alarm-banner'].hidden = false;
      document.body.classList.add('alarming');
      startAlarmSound(kind);
      vibrate([300, 150, 300, 150, 300]);
    } else {
      state.acked = false;
      el['alarm-banner'].hidden = true;
      document.body.classList.remove('alarming');
      stopAlarmSound();
      vibrate(0);
    }
  }

  function checkAlarms() {
    // Anchor drag outranks the speed alarm — it is the one that means trouble.
    var drift = currentDrift();
    if (drift != null && drift > state.anchorRadius) { setAlarm('anchor'); return; }

    var kn = state.speedMs * KN_PER_MS;
    var fresh = state.fixAt != null && (Date.now() - state.fixAt) <= STALE_MS;
    if (state.noWakeArmed && fresh && kn > state.noWakeKn) { setAlarm('nowake'); return; }

    setAlarm(null);
  }

  // ---------------------------------------------------------------- position

  function onPosition(pos) {
    var c = pos.coords;
    var t = pos.timestamp || Date.now();

    state.accuracy = (typeof c.accuracy === 'number') ? c.accuracy : null;
    state.fixAt = Date.now();

    var usable = state.accuracy == null || state.accuracy <= ACCURACY_LIMIT;
    var prev = state.prev;

    // Distance since the last usable fix, used both for the trip log and as the
    // speed fallback when the GPS chip reports no speed of its own.
    var stepM = null, dtS = null;
    if (prev && usable) {
      var dt = (t - prev.t) / 1000;
      // Reject absurd gaps outright: after a long suspend the elapsed time is real
      // but it was not spent under way, and counting it would wreck the average.
      if (dt > 0.2 && dt < 60) {
        dtS = dt;
        stepM = haversine(prev.lat, prev.lon, c.latitude, c.longitude);
      }
    }

    var rawMs;
    if (typeof c.speed === 'number' && c.speed >= 0 && isFinite(c.speed)) {
      rawMs = c.speed;
    } else if (stepM != null && dtS) {
      rawMs = stepM / dtS;         // iOS reports null speed when nearly stationary
    } else {
      rawMs = state.speedMs;
    }

    state.speedMs = state.speedMs + SPEED_ALPHA * (rawMs - state.speedMs);
    if (state.speedMs < 0.02) state.speedMs = 0;

    if (usable) {
      // Ignore sub-jitter wobble so a boat on a mooring does not log a passage.
      var floor = Math.max(MIN_STEP_M, (state.accuracy || 0) * 0.5);
      if (stepM != null && stepM >= floor) {
        state.trip.distM += stepM;
        if (state.cogSource !== 'MAG') {
          state.cog = bearing(prev.lat, prev.lon, c.latitude, c.longitude);
          state.cogSource = 'COG';
        }
      }
      var underWay = state.speedMs * KN_PER_MS >= MOVING_KN;
      if (dtS && underWay) state.trip.movingMs += dtS * 1000;
      if (state.speedMs > state.trip.maxMs) state.trip.maxMs = state.speedMs;

      // A trip starts the first time the boat actually moves, not when the app
      // was opened, so the log shows time under way rather than time on the dock.
      if (underWay) {
        if (state.trip.startedAt == null) state.trip.startedAt = Date.now();
        state.stoppedSince = null;
      } else if (state.stoppedSince == null) {
        state.stoppedSince = Date.now();
      }

      state.prev = { lat: c.latitude, lon: c.longitude, t: t };
    }

    // The GPS course is better than a derived bearing when the chip supplies it.
    if (state.cogSource !== 'MAG' &&
        typeof c.heading === 'number' && isFinite(c.heading) && c.heading >= 0 &&
        state.speedMs * KN_PER_MS >= COG_MIN_KN) {
      state.cog = c.heading;
      state.cogSource = 'COG';
    }

    checkAlarms();
    render();
    save();
  }

  function onPositionError(err) {
    var msg = err && err.code === 1
      ? 'Location permission was denied. Enable it in Settings › Privacy › Location Services, then reload.'
      : 'No GPS fix yet. Move somewhere with a clear view of the sky.';
    if (!state.started || err.code === 1) showGateError(msg);
  }

  // ---------------------------------------------------------------- compass

  function enableCompass() {
    function attach() {
      window.addEventListener('deviceorientation', function (e) {
        // webkitCompassHeading is already a true-north bearing; the generic
        // alpha value is not, so only trust the Apple one.
        if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) {
          state.cog = e.webkitCompassHeading;
          state.cogSource = 'MAG';
        }
      });
      el['compass-btn'].classList.add('is-on');
    }

    var DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(function (r) {
        if (r === 'granted') attach();
      }).catch(function () {});
    } else if (DOE) {
      attach();
    }
  }

  // ---------------------------------------------------------------- demo mode

  /* ?demo=1 replays a synthetic track: accelerate out, run a few legs, slow down.
     Useful ashore, and it exercises exactly the same handler as the real GPS. */
  function startDemo() {
    var lat = 40.6892, lon = -74.0445, hdg = 45, kn = 0, tick = 0;
    setInterval(function () {
      tick++;
      kn += (tick < 40 ? 0.45 : (tick < 150 ? (Math.random() - 0.45) * 0.4 : -0.3));
      kn = Math.max(0, Math.min(22, kn));
      if (tick % 45 === 0) hdg = (hdg + 35) % 360;
      var ms = kn / KN_PER_MS;
      var d = ms * 1;                                   // one second per tick
      lat += (d * Math.cos(toRad(hdg))) / 111320;
      lon += (d * Math.sin(toRad(hdg))) / (111320 * Math.cos(toRad(lat)));
      onPosition({
        coords: { latitude: lat, longitude: lon, accuracy: 6, speed: ms, heading: hdg },
        timestamp: Date.now()
      });
    }, 1000);
  }

  // ---------------------------------------------------------------- controls

  el['anchor-radius'].addEventListener('input', function () {
    state.anchorRadius = Number(this.value);
    el['anchor-radius-out'].textContent = state.anchorRadius + ' m';
    state.acked = false;
    checkAlarms();
    render();
    save();
  });

  el['nowake-limit'].addEventListener('input', function () {
    state.noWakeKn = Number(this.value);
    el['nowake-limit-out'].textContent = state.noWakeKn.toFixed(1) + ' kn';
    state.acked = false;
    checkAlarms();
    render();
    save();
  });

  el['anchor-btn'].addEventListener('click', function () {
    unlockAudio();
    if (state.anchor) {
      state.anchor = null;
    } else if (state.prev) {
      state.anchor = { lat: state.prev.lat, lon: state.prev.lon };
    } else {
      el['anchor-state'].textContent = 'NO FIX YET';
      return;
    }
    state.acked = false;
    checkAlarms();
    render();
    save();
  });

  el['nowake-btn'].addEventListener('click', function () {
    unlockAudio();
    state.noWakeArmed = !state.noWakeArmed;
    state.acked = false;
    checkAlarms();
    render();
    save();
  });

  el['alarm-ack'].addEventListener('click', function () {
    // Silence this episode only. If the condition clears and returns, it sounds again.
    state.acked = true;
    el['alarm-banner'].hidden = true;
    document.body.classList.remove('alarming');
    stopAlarmSound();
    vibrate(0);
  });

  el['night-btn'].addEventListener('click', function () {
    state.night = !state.night;
    applyNight();
    save();
  });

  el['compass-btn'].addEventListener('click', function () {
    unlockAudio();
    enableCompass();
  });

  el['endtrip-btn'].addEventListener('click', function () { endTrip(false); });

  // ---------------------------------------------------------------- passage controls

  el.autonight.addEventListener('change', function () {
    state.autoNight = this.checked;
    state.lastAutoDark = null;      // apply immediately rather than at the next transition
    applyAutoNight();
    save();
  });

  el['tide-refresh'].addEventListener('click', function () { ensureTides(true); });

  el['tide-change'].addEventListener('click', function () {
    el['tide-picker'].hidden = !el['tide-picker'].hidden;
    if (!el['tide-picker'].hidden) renderStationPicker();
  });

  el['tide-stations'].addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-station]');
    if (!btn) return;
    window.BoatTides.pinStation(btn.getAttribute('data-station'), btn.getAttribute('data-name'));
    el['tide-picker'].hidden = true;
    ensureTides(true);
  });

  el['tide-station-set'].addEventListener('click', function () {
    var id = el['tide-station-id'].value.trim();
    if (!id) return;
    window.BoatTides.pinStation(id, 'Station ' + id);
    el['tide-picker'].hidden = true;
    ensureTides(true);
  });

  el['log-list'].addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-del]');
    if (!btn) return;
    window.BoatTrips.remove(btn.getAttribute('data-del'));
    renderLog();
  });

  el['log-export'].addEventListener('click', function () {
    if (!window.BoatTrips.list().length) { el['log-state'].textContent = 'NOTHING TO EXPORT'; return; }
    window.BoatTrips.exportCSV();
  });

  el['log-clear'].addEventListener('click', function () {
    if (!window.BoatTrips.list().length) return;
    // Two taps to wipe the log — one stray touch should not delete a season.
    if (el['log-clear'].dataset.armed === '1') {
      window.BoatTrips.clear();
      delete el['log-clear'].dataset.armed;
      el['log-clear'].textContent = 'CLEAR LOG';
      el['log-clear'].classList.remove('is-on');
      renderLog();
    } else {
      el['log-clear'].dataset.armed = '1';
      el['log-clear'].textContent = 'TAP AGAIN';
      el['log-clear'].classList.add('is-on');
      setTimeout(function () {
        delete el['log-clear'].dataset.armed;
        el['log-clear'].textContent = 'CLEAR LOG';
        el['log-clear'].classList.remove('is-on');
      }, 4000);
    }
  });

  // ---------------------------------------------------------------- screens

  el.screens.addEventListener('scroll', function () {
    var idx = Math.round(el.screens.scrollLeft / el.screens.clientWidth);
    var dots = el.dots.children;
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('is-on', i === idx);
    }
    // Refresh the passage screen as it comes into view rather than every tick.
    if (idx === 1) renderPassage();
  }, { passive: true });

  function applyNight() {
    document.body.classList.toggle('night', state.night);
    el['night-btn'].classList.toggle('is-on', state.night);
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', state.night ? '#000000' : '#071A2B');
  }

  function showGateError(msg) {
    el['gate-err'].textContent = msg;
    el['gate-err'].hidden = false;
    el.gate.hidden = false;
  }

  // ---------------------------------------------------------------- start

  function start() {
    unlockAudio();               // must happen inside the tap, not later
    if (!navigator.geolocation) {
      showGateError('This browser has no Geolocation support.');
      return;
    }
    state.started = true;
    el.gate.hidden = true;
    requestWakeLock();

    if (new URLSearchParams(location.search).get('demo') === '1') {
      startDemo();
      return;
    }

    navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });
  }

  el['start-btn'].addEventListener('click', start);

  // ---------------------------------------------------------------- boot

  load();
  applyNight();
  buildTicks(state.dialMaxKn);
  buildRoseTicks();
  el['anchor-radius'].value = state.anchorRadius;
  el['anchor-radius-out'].textContent = state.anchorRadius + ' m';
  el['nowake-limit'].value = state.noWakeKn;
  el['nowake-limit-out'].textContent = state.noWakeKn.toFixed(1) + ' kn';
  el.autonight.checked = state.autoNight;
  state.tide.bundle = window.BoatTides.cached();
  render();
  renderPassage();

  /* Publish the dial's rendered width so the readout inside it can be sized from
     the dial rather than from the viewport — the dial flexes, the viewport does not. */
  (function trackDialSize() {
    var svg = document.querySelector('.dial');
    if (!svg) return;
    function apply() {
      var w = svg.getBoundingClientRect().width;
      if (w > 0) document.documentElement.style.setProperty('--dial', w + 'px');
    }
    if (window.ResizeObserver) new ResizeObserver(apply).observe(svg);
    window.addEventListener('resize', apply);
    apply();
  })();

  // Keep the fix-age counter and stale-speed handling honest between fixes.
  var lastPassageAt = 0;
  setInterval(function () {
    if (!state.started) return;
    var now = Date.now();
    checkAlarms();
    render();
    maybeAutoSave(now);
    applyAutoNight();
    ensureTides(false);
    if (now - lastPassageAt > 10000) { lastPassageAt = now; renderPassage(); }
  }, 1000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // Exposed for the automated test harness.
  window.__speedo = state;
  window.__speedoApi = {
    endTrip: endTrip,
    ensureTides: ensureTides,
    renderPassage: renderPassage,
    maybeAutoSave: maybeAutoSave,
    applyAutoNight: applyAutoNight,
    pushSpark: pushSpark,
    renderSpark: renderSpark,
    resetSparkClock: function () { lastSparkAt = 0; }
  };
})();

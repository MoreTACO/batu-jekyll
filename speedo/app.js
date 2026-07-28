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
    trip: { distM: 0, maxMs: 0, movingMs: 0 },
    anchor: null,         // { lat, lon }
    anchorRadius: 30,
    noWakeKn: 5,
    noWakeArmed: false,
    night: false,
    alarm: null,          // 'anchor' | 'nowake'
    acked: false,         // alarm silenced by the user until it clears
    dialMaxKn: DIAL_MIN_MAX_KN
  };

  var el = {};
  [
    'fix-dot', 'fix-label', 'accuracy', 'fix-age', 'wake-dot', 'wake-label',
    'dial-value', 'needle', 'ticks', 'kn', 'mph', 'rose', 'rose-ticks', 'cog', 'cog-src',
    'dist', 'max', 'avg', 'elapsed',
    'anchor-panel', 'anchor-state', 'anchor-radius', 'anchor-radius-out', 'anchor-btn',
    'drift', 'drift-fill', 'drift-wrap',
    'nowake-panel', 'nowake-state', 'nowake-limit', 'nowake-limit-out', 'nowake-btn',
    'night-btn', 'compass-btn', 'reset-btn',
    'alarm-banner', 'alarm-text', 'alarm-ack',
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
        night: state.night
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
    }
    if (s.anchor && typeof s.anchor.lat === 'number') state.anchor = s.anchor;
    if (typeof s.anchorRadius === 'number') state.anchorRadius = s.anchorRadius;
    if (typeof s.noWakeKn === 'number') state.noWakeKn = s.noWakeKn;
    state.noWakeArmed = !!s.noWakeArmed;
    state.night = !!s.night;
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
      if (dtS && state.speedMs * KN_PER_MS >= MOVING_KN) state.trip.movingMs += dtS * 1000;
      if (state.speedMs > state.trip.maxMs) state.trip.maxMs = state.speedMs;

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

  el['reset-btn'].addEventListener('click', function () {
    state.trip = { distM: 0, maxMs: 0, movingMs: 0 };
    state.dialMaxKn = DIAL_MIN_MAX_KN;
    buildTicks(state.dialMaxKn);
    render();
    save();
  });

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
  render();

  // Keep the fix-age counter and stale-speed handling honest between fixes.
  setInterval(function () {
    if (state.started) { checkAlarms(); render(); }
  }, 1000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // Exposed for the automated test harness.
  window.__speedo = state;
})();

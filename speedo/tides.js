/* Tide predictions.
 *
 * Unlike everything else in this app, tides cannot be computed offline — there is
 * no formula from latitude and longitude. Prediction needs harmonic constants
 * measured at a specific tide station, so this module fetches them and caches the
 * result aggressively. With no signal you get the last download, clearly labelled;
 * if that download does not cover today you get a message rather than a wrong graph.
 *
 * Default source is NOAA CO-OPS: free, no API key, ~3,000 US stations. The URL
 * builder is swappable via configure(), which is how the test harness points it at
 * recorded fixtures, and how a worldwide provider would be added.
 *
 * Mirrored in ios/BoatSpeedo/TideStore.swift.
 */
window.BoatTides = (function () {
  'use strict';

  var STATIONS_KEY = 'boat-speedo/tide-stations/v1';
  var TIDES_KEY    = 'boat-speedo/tides/v1';
  var PREF_KEY     = 'boat-speedo/tide-station/v1';

  var STATIONS_TTL = 30 * 24 * 3600 * 1000;   // station list barely changes
  var HOUR_MS = 3600000;
  var DAY_MS = 86400000;

  var NOAA = 'https://api.tidesandcurrents.noaa.gov';

  /* Overridable so the harness can serve fixtures, and so another provider can be
     dropped in without touching the graph, the cache or the UI. */
  var resolve = function (kind, params) {
    if (kind === 'stations') {
      return NOAA + '/mdapi/prod/webapi/stations.json?type=tidepredictions&units=english';
    }
    return NOAA + '/api/prod/datagetter'
      + '?product=predictions&application=BoatSpeedo&format=json'
      + '&datum=MLLW&units=english&time_zone=lst_ldt'
      + '&station=' + encodeURIComponent(params.station)
      + '&begin_date=' + params.begin
      + '&end_date=' + params.end
      + '&interval=' + (kind === 'hilo' ? 'hilo' : 'h');
  };

  function configure(opts) {
    if (opts && typeof opts.resolve === 'function') resolve = opts.resolve;
  }

  // ---------------------------------------------------------------- storage

  function readJSON(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { /* quota — tides degrade to online-only, everything else is fine */ }
  }

  // ---------------------------------------------------------------- helpers

  function toRad(d) { return d * Math.PI / 180; }

  /* Same great-circle formula and earth radius as app.js, so distances agree. */
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371008.8;
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* NOAA returns station local time as "YYYY-MM-DD HH:MM" with no zone. The boat
     and the station share a timezone in any realistic case, so parsing it as
     device-local time is the correct reading. */
  function parseStamp(s) {
    if (typeof s !== 'string') return NaN;
    var t = new Date(s.replace(' ', 'T')).getTime();
    return isNaN(t) ? NaN : t;
  }

  function yyyymmdd(date) {
    return String(date.getFullYear()) +
           String(date.getMonth() + 1).padStart(2, '0') +
           String(date.getDate()).padStart(2, '0');
  }

  function fetchJSON(url) {
    return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      // NOAA reports problems in the body with a 200 status.
      if (json && json.error && json.error.message) throw new Error(json.error.message);
      return json;
    });
  }

  // ---------------------------------------------------------------- stations

  function cachedStations() {
    var c = readJSON(STATIONS_KEY);
    return c && Array.isArray(c.stations) ? c : null;
  }

  function normaliseStations(json) {
    var raw = (json && json.stations) || [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      // NOAA uses `lng`; accept `lon` too so another provider can slot in.
      var lat = Number(s.lat);
      var lon = Number(s.lng !== undefined ? s.lng : s.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      out.push({ id: String(s.id), name: s.name || String(s.id), lat: lat, lon: lon });
    }
    return out;
  }

  function loadStations(force) {
    var cached = cachedStations();
    if (!force && cached && (Date.now() - cached.fetchedAt) < STATIONS_TTL) {
      return Promise.resolve(cached.stations);
    }
    return fetchJSON(resolve('stations', {})).then(function (json) {
      var stations = normaliseStations(json);
      if (!stations.length) throw new Error('no stations in response');
      writeJSON(STATIONS_KEY, { fetchedAt: Date.now(), stations: stations });
      return stations;
    }).catch(function (err) {
      // A stale list is still perfectly usable; stations do not move.
      if (cached) return cached.stations;
      throw err;
    });
  }

  /* Nearest stations to a position, closest first. The nearest is often not the
     right one — it can be across a bridge or up a different creek — so this
     returns several and lets the user pin one. */
  function nearest(stations, lat, lon, count) {
    return stations.map(function (s) {
      return {
        id: s.id, name: s.name, lat: s.lat, lon: s.lon,
        distanceM: haversine(lat, lon, s.lat, s.lon)
      };
    }).sort(function (a, b) {
      return a.distanceM - b.distanceM;
    }).slice(0, count || 8);
  }

  function pinnedStationId() {
    var p = readJSON(PREF_KEY);
    return p && p.stationId ? String(p.stationId) : null;
  }

  function pinStation(id, name) {
    writeJSON(PREF_KEY, { stationId: String(id), name: name || null });
  }

  function unpinStation() {
    try { localStorage.removeItem(PREF_KEY); } catch (e) {}
  }

  // ---------------------------------------------------------------- predictions

  function parsePredictions(json) {
    var raw = (json && json.predictions) || [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var t = parseStamp(raw[i].t);
      var v = Number(raw[i].v);
      if (isNaN(t) || !isFinite(v)) continue;
      out.push({ t: t, v: v, type: raw[i].type || null });
    }
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  /* Merge the hourly curve with the exact extremes, so the drawn line actually
     passes through high and low water instead of cutting the corners. */
  function mergeCurve(hourly, hilo) {
    var byTime = {};
    hourly.concat(hilo).forEach(function (p) { byTime[p.t] = p; });
    return Object.keys(byTime)
      .map(function (k) { return byTime[k]; })
      .sort(function (a, b) { return a.t - b.t; });
  }

  function cached() {
    var c = readJSON(TIDES_KEY);
    return c && Array.isArray(c.curve) ? c : null;
  }

  /* Fetch a four-day window around today: yesterday for context, two days ahead
     so an overnight passage still has data without a signal. */
  function fetchPredictions(station) {
    var now = new Date();
    var begin = yyyymmdd(new Date(now.getTime() - DAY_MS));
    var end = yyyymmdd(new Date(now.getTime() + 2 * DAY_MS));
    var params = { station: station.id, begin: begin, end: end };

    return Promise.all([
      fetchJSON(resolve('hilo', params)),
      fetchJSON(resolve('hourly', params))
    ]).then(function (both) {
      var hilo = parsePredictions(both[0]);
      var hourly = parsePredictions(both[1]);
      if (!hilo.length && !hourly.length) throw new Error('no predictions returned');

      var bundle = {
        stationId: station.id,
        stationName: station.name,
        distanceM: station.distanceM != null ? station.distanceM : null,
        fetchedAt: Date.now(),
        hilo: hilo,
        curve: mergeCurve(hourly, hilo)
      };
      writeJSON(TIDES_KEY, bundle);
      return bundle;
    });
  }

  // ---------------------------------------------------------------- reading it

  /* True when the cached curve brackets the given moment. A curve that stops
     before now cannot be drawn honestly, so the UI says so instead. */
  function coversNow(bundle, now) {
    if (!bundle || !bundle.curve.length) return false;
    now = now || Date.now();
    return bundle.curve[0].t <= now && bundle.curve[bundle.curve.length - 1].t >= now;
  }

  function heightAt(bundle, when) {
    if (!bundle || bundle.curve.length < 2) return null;
    var c = bundle.curve;
    if (when < c[0].t || when > c[c.length - 1].t) return null;
    for (var i = 1; i < c.length; i++) {
      if (c[i].t >= when) {
        var span = c[i].t - c[i - 1].t;
        var f = span > 0 ? (when - c[i - 1].t) / span : 0;
        return c[i - 1].v + (c[i].v - c[i - 1].v) * f;
      }
    }
    return null;
  }

  /* Rising or falling now, taken from the next extreme rather than the local
     slope — near slack water the slope is noise, but the next event is not. */
  function trendAt(bundle, when) {
    var next = nextEvent(bundle, when);
    if (!next) return null;
    return next.type === 'H' ? 'rising' : 'falling';
  }

  function nextEvent(bundle, when) {
    if (!bundle) return null;
    when = when || Date.now();
    for (var i = 0; i < bundle.hilo.length; i++) {
      if (bundle.hilo[i].t > when) return bundle.hilo[i];
    }
    return null;
  }

  /* The slice of curve to draw: a 24-hour window with a little of the past for
     context and the rest ahead, which is the part you can still act on. */
  function window24(bundle, now) {
    now = now || Date.now();
    var from = now - 6 * HOUR_MS;
    var to = now + 18 * HOUR_MS;
    var pts = (bundle ? bundle.curve : []).filter(function (p) {
      return p.t >= from && p.t <= to;
    });
    return { from: from, to: to, points: pts };
  }

  /**
   * Pure geometry for the graph, kept out of the DOM so it can be asserted
   * directly. Returns SVG path data plus the mapping used, in a box of w x h.
   */
  function geometry(win, w, h, pad) {
    pad = pad || 0;
    var pts = win.points;
    if (pts.length < 2) return null;

    var vs = pts.map(function (p) { return p.v; });
    var vMin = Math.min.apply(null, vs);
    var vMax = Math.max.apply(null, vs);
    if (vMax - vMin < 0.1) { vMax = vMin + 0.1; }   // dead-flat day still draws

    // Scale time to the points we actually have rather than to the nominal window.
    // Hourly data rarely starts exactly on the window edge, and a curve that stops
    // short of the box looks like missing data instead of a rounding detail.
    var tFrom = pts[0].t;
    var tTo = pts[pts.length - 1].t;
    if (tTo === tFrom) return null;

    var innerH = h - pad * 2;
    var x = function (t) { return (t - tFrom) / (tTo - tFrom) * w; };
    var y = function (v) { return pad + (1 - (v - vMin) / (vMax - vMin)) * innerH; };

    var d = pts.map(function (p, i) {
      return (i === 0 ? 'M ' : 'L ') + x(p.t).toFixed(2) + ' ' + y(p.v).toFixed(2);
    }).join(' ');

    var area = d + ' L ' + x(pts[pts.length - 1].t).toFixed(2) + ' ' + h.toFixed(2) +
               ' L ' + x(pts[0].t).toFixed(2) + ' ' + h.toFixed(2) + ' Z';

    return { d: d, area: area, x: x, y: y, vMin: vMin, vMax: vMax,
             tFrom: tFrom, tTo: tTo, count: pts.length };
  }

  return {
    configure: configure,
    loadStations: loadStations,
    nearest: nearest,
    normaliseStations: normaliseStations,
    parsePredictions: parsePredictions,
    mergeCurve: mergeCurve,
    fetchPredictions: fetchPredictions,
    cached: cached,
    coversNow: coversNow,
    heightAt: heightAt,
    trendAt: trendAt,
    nextEvent: nextEvent,
    window24: window24,
    geometry: geometry,
    pinnedStationId: pinnedStationId,
    pinStation: pinStation,
    unpinStation: unpinStation,
    haversine: haversine
  };
})();

/* Saved trip log. Plain localStorage, newest first, capped so it cannot grow
   without bound. Mirrored in ios/BoatSpeedo/TripLog.swift. */
window.BoatTrips = (function () {
  'use strict';

  var KEY = 'boat-speedo/trips/v1';
  var MAX_TRIPS = 100;
  var M_PER_NM = 1852;
  var KN_PER_MS = 1.9438445;

  /* Below this a "trip" is someone testing the app on the dock, not a passage. */
  var MIN_LOGGABLE_M = 100;

  function read() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return []; }
    if (!raw) return [];
    try {
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_TRIPS))); }
    catch (e) { /* quota or private mode — the current run still works */ }
  }

  function list() { return read(); }

  function isLoggable(trip) {
    return !!trip && trip.distM >= MIN_LOGGABLE_M;
  }

  /**
   * Save a finished run. Returns the stored entry, or null if it was too short
   * to be worth keeping.
   */
  function add(trip, endedAt) {
    if (!isLoggable(trip)) return null;
    var entry = {
      id: String(trip.startedAt || Date.now()) + '-' + Math.round(trip.distM),
      startedAt: trip.startedAt || null,
      endedAt: endedAt || Date.now(),
      distM: trip.distM,
      maxMs: trip.maxMs,
      movingMs: trip.movingMs
    };
    var all = read();
    all.unshift(entry);
    write(all);
    return entry;
  }

  function remove(id) {
    write(read().filter(function (t) { return t.id !== id; }));
  }

  function clear() { write([]); }

  function totals() {
    return read().reduce(function (acc, t) {
      acc.count += 1;
      acc.distM += t.distM || 0;
      acc.movingMs += t.movingMs || 0;
      acc.maxMs = Math.max(acc.maxMs, t.maxMs || 0);
      return acc;
    }, { count: 0, distM: 0, movingMs: 0, maxMs: 0 });
  }

  // ---------------------------------------------------------------- formatting

  function nm(distM) { return (distM / M_PER_NM).toFixed(2); }
  function knots(ms) { return (ms * KN_PER_MS).toFixed(1); }

  function duration(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return h > 0 ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
  }

  function when(entry) {
    var d = new Date(entry.startedAt || entry.endedAt);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
           ' ' + String(d.getHours()).padStart(2, '0') +
           ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function avgMs(entry) {
    return entry.movingMs > 0 ? entry.distM / (entry.movingMs / 1000) : 0;
  }

  // ---------------------------------------------------------------- export

  function toCSV() {
    var rows = [['started', 'ended', 'distance_nm', 'duration_min', 'max_kn', 'avg_kn']];
    read().forEach(function (t) {
      rows.push([
        t.startedAt ? new Date(t.startedAt).toISOString() : '',
        t.endedAt ? new Date(t.endedAt).toISOString() : '',
        nm(t.distM),
        (t.movingMs / 60000).toFixed(1),
        knots(t.maxMs),
        knots(avgMs(t))
      ]);
    });
    return rows.map(function (r) { return r.join(','); }).join('\n') + '\n';
  }

  /* Share sheet where iOS offers it, plain download everywhere else. */
  function exportCSV() {
    var csv = toCSV();
    var name = 'boat-speedo-trips.csv';

    if (navigator.canShare && window.File) {
      try {
        var file = new File([csv], name, { type: 'text/csv' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: 'Boat Speedo trips' })
            .catch(function () {});
          return true;
        }
      } catch (e) { /* fall through to the download */ }
    }

    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return true;
  }

  return {
    list: list, add: add, remove: remove, clear: clear, totals: totals,
    isLoggable: isLoggable, toCSV: toCSV, exportCSV: exportCSV,
    nm: nm, knots: knots, duration: duration, when: when, avgMs: avgMs,
    MIN_LOGGABLE_M: MIN_LOGGABLE_M
  };
})();

/* Sunrise, sunset and civil twilight — computed locally, no network.
   Standard low-precision solar position from the Astronomical Almanac, the same
   basis as NOAA's solar calculator. Good to well under a minute, which is far
   finer than anything you need to decide whether to put the nav lights on.

   Mirrored in ios/BoatSpeedo/SunTimes.swift. */
window.BoatSun = (function () {
  'use strict';

  var RAD = Math.PI / 180;
  var DAY_MS = 86400000;
  var J1970 = 2440588;
  var J2000 = 2451545;
  var OBLIQUITY = 23.4397 * RAD;      // earth's axial tilt
  var PERIHELION = 102.9372 * RAD;    // longitude of perihelion

  /* Altitude of the sun's centre at the moment the upper limb touches the
     horizon: half a disc down, plus refraction. */
  var H_HORIZON = -0.833 * RAD;
  var H_CIVIL = -6 * RAD;

  function toJulian(date) { return date.valueOf() / DAY_MS - 0.5 + J1970; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * DAY_MS); }
  function toDays(date) { return toJulian(date) - J2000; }

  function solarMeanAnomaly(d) { return RAD * (357.5291 + 0.98560028 * d); }

  /* Apparent ecliptic longitude: mean anomaly plus the equation of the centre,
     which is what makes the sun run fast or slow against clock time. */
  function eclipticLongitude(M) {
    var C = RAD * (1.9148 * Math.sin(M)
                 + 0.0200 * Math.sin(2 * M)
                 + 0.0003 * Math.sin(3 * M));
    return M + C + PERIHELION + Math.PI;
  }

  function declination(L) {
    return Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
  }

  /* Hour angle at which the sun sits at altitude h. NaN when the sun never
     reaches that altitude — polar day or polar night. */
  function hourAngle(h, phi, dec) {
    var cosH = (Math.sin(h) - Math.sin(phi) * Math.sin(dec))
             / (Math.cos(phi) * Math.cos(dec));
    if (cosH > 1 || cosH < -1) return NaN;
    return Math.acos(cosH);
  }

  function julianCycle(d, lw) { return Math.round(d - 0.0009 - lw / (2 * Math.PI)); }
  function approxTransit(Ht, lw, n) { return 0.0009 + (Ht + lw) / (2 * Math.PI) + n; }

  function solarTransitJ(ds, M, L) {
    return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  }

  /**
   * Sun times for a position and date.
   * @returns {{sunrise:Date|null, sunset:Date|null, civilDawn:Date|null,
   *            civilDusk:Date|null, solarNoon:Date, dayLengthMin:number|null,
   *            polar:'day'|'night'|null}}
   */
  function times(lat, lon, date) {
    var d = toDays(date || new Date());
    var lw = -lon * RAD;
    var phi = lat * RAD;

    var n = julianCycle(d, lw);
    var ds = approxTransit(0, lw, n);
    var M = solarMeanAnomaly(ds);
    var L = eclipticLongitude(M);
    var dec = declination(L);
    var noonJ = solarTransitJ(ds, M, L);

    function eventPair(h) {
      var w = hourAngle(h, phi, dec);
      if (isNaN(w)) return { rise: null, set: null };
      var setJ = solarTransitJ(approxTransit(w, lw, n), M, L);
      var riseJ = noonJ - (setJ - noonJ);      // sunrise mirrors sunset about noon
      return { rise: fromJulian(riseJ), set: fromJulian(setJ) };
    }

    var horizon = eventPair(H_HORIZON);
    var civil = eventPair(H_CIVIL);

    // Distinguish midnight sun from polar night: if there is no sunrise, the sun
    // is either always up or always down depending on which side of the horizon
    // it sits at local noon.
    var polar = null;
    if (!horizon.rise) {
      var noonAltitude = Math.asin(
        Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec)
      );
      polar = noonAltitude > H_HORIZON ? 'day' : 'night';
    }

    return {
      sunrise: horizon.rise,
      sunset: horizon.set,
      civilDawn: civil.rise,
      civilDusk: civil.set,
      solarNoon: fromJulian(noonJ),
      dayLengthMin: horizon.rise
        ? (horizon.set - horizon.rise) / 60000
        : null,
      polar: polar
    };
  }

  /* True between sunset and sunrise, for the automatic night mode. Uses the sun
     times of the day being asked about, so it stays right either side of midnight. */
  function isDark(lat, lon, now) {
    now = now || new Date();
    var t = times(lat, lon, now);
    if (t.polar === 'day') return false;
    if (t.polar === 'night') return true;
    return now < t.sunrise || now > t.sunset;
  }

  function fmt(date) {
    if (!date) return '--:--';
    return String(date.getHours()).padStart(2, '0') + ':' +
           String(date.getMinutes()).padStart(2, '0');
  }

  function fmtDuration(minutes) {
    if (minutes == null) return '--';
    var h = Math.floor(minutes / 60);
    var m = Math.round(minutes % 60);
    if (m === 60) { h += 1; m = 0; }
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }

  return { times: times, isDark: isDark, fmt: fmt, fmtDuration: fmtDuration };
})();

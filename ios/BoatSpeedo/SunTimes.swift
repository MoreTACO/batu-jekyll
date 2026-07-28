import Foundation

/// Sunrise, sunset and civil twilight, computed locally with no network.
/// Low-precision solar position from the Astronomical Almanac — the same basis as
/// NOAA's solar calculator, and a direct port of `speedo/sun.js`.
enum SunTimes {

    private static let dayMs: Double = 86_400_000
    private static let j1970: Double = 2_440_588
    private static let j2000: Double = 2_451_545
    private static let rad = Double.pi / 180
    private static let obliquity = 23.4397 * rad
    private static let perihelion = 102.9372 * rad

    /// Altitude of the sun's centre when its upper limb touches the horizon:
    /// half a disc down, plus atmospheric refraction.
    private static let hHorizon = -0.833 * rad
    private static let hCivil = -6.0 * rad

    struct Result {
        let sunrise: Date?
        let sunset: Date?
        let civilDawn: Date?
        let civilDusk: Date?
        let solarNoon: Date
        let dayLength: TimeInterval?
        let polar: Polar?

        enum Polar { case day, night }
    }

    // MARK: - solar position

    private static func toDays(_ date: Date) -> Double {
        date.timeIntervalSince1970 * 1000 / dayMs - 0.5 + j1970 - j2000
    }

    private static func fromJulian(_ j: Double) -> Date {
        Date(timeIntervalSince1970: (j + 0.5 - j1970) * dayMs / 1000)
    }

    private static func solarMeanAnomaly(_ d: Double) -> Double {
        rad * (357.5291 + 0.98560028 * d)
    }

    /// Apparent ecliptic longitude: mean anomaly plus the equation of the centre,
    /// which is what makes the sun run fast or slow against clock time.
    private static func eclipticLongitude(_ m: Double) -> Double {
        let c = rad * (1.9148 * sin(m) + 0.0200 * sin(2 * m) + 0.0003 * sin(3 * m))
        return m + c + perihelion + .pi
    }

    private static func declination(_ l: Double) -> Double {
        asin(sin(obliquity) * sin(l))
    }

    /// Hour angle at which the sun sits at altitude `h`; nil when it never does —
    /// polar day or polar night.
    private static func hourAngle(_ h: Double, _ phi: Double, _ dec: Double) -> Double? {
        let cosH = (sin(h) - sin(phi) * sin(dec)) / (cos(phi) * cos(dec))
        guard cosH <= 1, cosH >= -1 else { return nil }
        return acos(cosH)
    }

    private static func solarTransitJ(_ ds: Double, _ m: Double, _ l: Double) -> Double {
        j2000 + ds + 0.0053 * sin(m) - 0.0069 * sin(2 * l)
    }

    // MARK: - public

    static func times(latitude: Double, longitude: Double, date: Date = Date()) -> Result {
        let d = toDays(date)
        let lw = -longitude * rad
        let phi = latitude * rad

        let n = (d - 0.0009 - lw / (2 * .pi)).rounded()
        let ds = 0.0009 + lw / (2 * .pi) + n
        let m = solarMeanAnomaly(ds)
        let l = eclipticLongitude(m)
        let dec = declination(l)
        let noonJ = solarTransitJ(ds, m, l)

        func pair(_ h: Double) -> (rise: Date?, set: Date?) {
            guard let w = hourAngle(h, phi, dec) else { return (nil, nil) }
            let setJ = solarTransitJ(0.0009 + (w + lw) / (2 * .pi) + n, m, l)
            // Sunrise mirrors sunset about solar noon.
            return (fromJulian(noonJ - (setJ - noonJ)), fromJulian(setJ))
        }

        let horizon = pair(hHorizon)
        let civil = pair(hCivil)

        // Midnight sun or polar night, decided by where the sun sits at local noon.
        var polar: Result.Polar?
        if horizon.rise == nil {
            let noonAltitude = asin(sin(phi) * sin(dec) + cos(phi) * cos(dec))
            polar = noonAltitude > hHorizon ? .day : .night
        }

        return Result(
            sunrise: horizon.rise,
            sunset: horizon.set,
            civilDawn: civil.rise,
            civilDusk: civil.set,
            solarNoon: fromJulian(noonJ),
            dayLength: horizon.rise.flatMap { r in horizon.set.map { $0.timeIntervalSince(r) } },
            polar: polar
        )
    }

    /// True between sunset and sunrise, for the automatic night mode.
    static func isDark(latitude: Double, longitude: Double, at now: Date = Date()) -> Bool {
        let t = times(latitude: latitude, longitude: longitude, date: now)
        if t.polar == .day { return false }
        if t.polar == .night { return true }
        guard let rise = t.sunrise, let set = t.sunset else { return false }
        return now < rise || now > set
    }

    // MARK: - formatting

    static func clock(_ date: Date?) -> String {
        guard let date else { return "--:--" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    static func duration(_ interval: TimeInterval?) -> String {
        guard let interval else { return "--" }
        let m = Int((interval / 60).rounded())
        return "\(m / 60)h \(String(format: "%02d", m % 60))m"
    }
}

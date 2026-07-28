import CoreLocation
import Combine

/// Thin wrapper over CoreLocation. Publishes raw fixes; all interpretation of
/// them lives in `SpeedoModel` so the same rules apply as in the web version.
final class LocationManager: NSObject, ObservableObject {

    @Published private(set) var location: CLLocation?
    @Published private(set) var heading: CLLocationDirection?   // magnetic compass, true north
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    @Published private(set) var failure: String?

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        // BestForNavigation is the only setting that gives usable speed on the water.
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.activityType = .otherNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        // Without this iOS will helpfully "pause" updates when it thinks you have
        // stopped — which on a drifting boat is exactly when you still want them.
        manager.pausesLocationUpdatesAutomatically = false
        authorization = manager.authorizationStatus
    }

    func start() {
        // Always-authorization is what lets the anchor watch keep running with the
        // screen off. Ask for when-in-use first; iOS requires that escalation order.
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        }
    }

    /// Call before arming the anchor watch, so it survives the screen locking.
    func enableBackgroundUpdates() {
        guard manager.authorizationStatus == .authorizedAlways else {
            manager.requestAlwaysAuthorization()
            return
        }
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
    }

    func disableBackgroundUpdates() {
        manager.allowsBackgroundLocationUpdates = false
    }
}

extension LocationManager: CLLocationManagerDelegate {

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        failure = nil
        location = latest
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        // Negative accuracy means the magnetometer needs calibrating; ignore those.
        guard newHeading.headingAccuracy >= 0 else { return }
        heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorization = manager.authorizationStatus
        if manager.authorizationStatus == .authorizedAlways {
            manager.allowsBackgroundLocationUpdates = true
            manager.showsBackgroundLocationIndicator = true
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A transient "location unknown" just means no fix yet; do not alarm the user.
        if let clError = error as? CLError, clError.code == .locationUnknown { return }
        failure = error.localizedDescription
    }
}

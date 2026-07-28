import CoreLocation
import UserNotifications
import AVFoundation
import AudioToolbox

/// Anchor drag watch. Unlike the web version this keeps working with the screen
/// off, because CoreLocation background updates keep the process alive and a
/// local notification can wake the phone.
final class AnchorWatch: ObservableObject {

    @Published private(set) var anchor: CLLocation?
    @Published var radiusMeters: CLLocationDistance = 30
    @Published private(set) var driftMeters: CLLocationDistance?
    @Published private(set) var isDragging = false

    var isSet: Bool { anchor != nil }

    private var alarmTimer: Timer?
    private var notifiedAt: Date?

    // MARK: - arming

    func drop(at location: CLLocation) {
        anchor = location
        driftMeters = 0
        isDragging = false
        Self.requestNotificationPermission()
    }

    func weigh() {
        anchor = nil
        driftMeters = nil
        stopAlarm()
        isDragging = false
    }

    // MARK: - evaluation

    /// Fold in a new fix. Returns true if the boat is outside its swing circle.
    @discardableResult
    func evaluate(_ fix: CLLocation) -> Bool {
        guard let anchor else { return false }

        let drift = fix.distance(from: anchor)
        driftMeters = drift

        // Give the fix's own error budget the benefit of the doubt, so a single
        // sloppy fix at the edge of the circle does not wake the whole boat.
        let slop = max(0, fix.horizontalAccuracy)
        let outside = drift > radiusMeters + slop

        if outside && !isDragging {
            isDragging = true
            startAlarm()
            notify(drift: drift)
        } else if !outside && isDragging {
            isDragging = false
            stopAlarm()
        }
        return outside
    }

    // MARK: - alarm

    /// Silence the current episode. The watch stays armed: if the boat swings back
    /// inside and drags again, it sounds again.
    func silence() {
        stopAlarm()
    }

    private func startAlarm() {
        configureAudioSession()
        fireAlertOnce()
        alarmTimer?.invalidate()
        alarmTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.fireAlertOnce()
        }
    }

    private func stopAlarm() {
        alarmTimer?.invalidate()
        alarmTimer = nil
    }

    private func fireAlertOnce() {
        // See README: swap this for a bundled looping .caf if you want something
        // genuinely loud. System alert sounds respect the ringer volume.
        AudioServicesPlayAlertSound(kSystemSoundID_Vibrate)
        AudioServicesPlaySystemSound(1005)
    }

    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback, mode: .default, options: [.duckOthers]
            )
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Nothing useful to do here; the notification still fires.
        }
    }

    private func notify(drift: CLLocationDistance) {
        // Rate-limit so a boat sitting on the edge of the circle does not produce
        // a notification every single fix.
        if let notifiedAt, Date().timeIntervalSince(notifiedAt) < 60 { return }
        notifiedAt = Date()

        let content = UNMutableNotificationContent()
        content.title = "Anchor dragging"
        content.body = String(format: "%.0f m from where you dropped — limit %.0f m.",
                              drift, radiusMeters)
        content.sound = .defaultCritical
        content.interruptionLevel = .timeSensitive

        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        )
    }

    static func requestNotificationPermission() {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }
}

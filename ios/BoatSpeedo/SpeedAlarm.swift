import Foundation
import AudioToolbox

/// No-wake alarm: sounds while speed is over a set limit. Deliberately simple —
/// it only ever reacts to the smoothed speed the dial is already showing, so what
/// you hear always matches what you see.
final class SpeedAlarm: ObservableObject {

    @Published var limitKnots: Double = 5
    @Published var isArmed = false
    @Published private(set) var isOverLimit = false

    private var alarmTimer: Timer?
    private var silenced = false

    func toggleArmed() {
        isArmed.toggle()
        silenced = false
        if !isArmed {
            isOverLimit = false
            stopAlarm()
        }
    }

    /// Silence this episode only; it re-arms once you drop back under the limit.
    func silence() {
        silenced = true
        stopAlarm()
    }

    func evaluate(knots: Double, hasFreshFix: Bool) {
        guard isArmed, hasFreshFix else {
            if isOverLimit { isOverLimit = false; stopAlarm() }
            return
        }

        let over = knots > limitKnots

        if over && !isOverLimit {
            isOverLimit = true
            if !silenced { startAlarm() }
        } else if !over && isOverLimit {
            isOverLimit = false
            silenced = false
            stopAlarm()
        }
    }

    private func startAlarm() {
        fireOnce()
        alarmTimer?.invalidate()
        alarmTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.fireOnce()
        }
    }

    private func stopAlarm() {
        alarmTimer?.invalidate()
        alarmTimer = nil
    }

    private func fireOnce() {
        AudioServicesPlaySystemSound(1057)
    }
}

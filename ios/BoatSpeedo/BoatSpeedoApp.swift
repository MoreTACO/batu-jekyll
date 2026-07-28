import SwiftUI
import UserNotifications

@main
struct BoatSpeedoApp: App {

    init() {
        // Ask early so the anchor watch can actually reach you later. The location
        // prompt is deliberately left until the first fix is requested, so the
        // system dialog appears with the app already on screen explaining why.
        AnchorWatch.requestNotificationPermission()
        UNUserNotificationCenter.current().delegate = NotificationPresenter.shared
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .persistentSystemOverlays(.hidden)
        }
    }
}

/// Show the drag alarm even when the app is the thing already on screen.
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationPresenter()

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler handler:
                                @escaping (UNNotificationPresentationOptions) -> Void) {
        handler([.banner, .sound, .list])
    }
}

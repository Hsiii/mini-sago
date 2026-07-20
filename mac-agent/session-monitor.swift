import AppKit
import CoreGraphics
import Foundation

func isSessionLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return true
    }

    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
}

func emit(_ state: String) {
    print(state)
    fflush(stdout)
}

let distributedCenter = DistributedNotificationCenter.default()
let workspaceCenter = NSWorkspace.shared.notificationCenter

distributedCenter.addObserver(
    forName: Notification.Name("com.apple.screenIsLocked"),
    object: nil,
    queue: .main
) { _ in
    emit("locked")
}

distributedCenter.addObserver(
    forName: Notification.Name("com.apple.screenIsUnlocked"),
    object: nil,
    queue: .main
) { _ in
    emit("unlocked")
}

workspaceCenter.addObserver(
    forName: NSWorkspace.willSleepNotification,
    object: nil,
    queue: .main
) { _ in
    emit("locked")
}

workspaceCenter.addObserver(
    forName: NSWorkspace.didWakeNotification,
    object: nil,
    queue: .main
) { _ in
    emit(isSessionLocked() ? "locked" : "unlocked")
}

emit(isSessionLocked() ? "locked" : "unlocked")
RunLoop.main.run()

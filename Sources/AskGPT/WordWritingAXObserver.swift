import AppKit
import ApplicationServices
import AskGPTCore
import os

/// Observes only event names. It never reads window titles or document content.
/// Application-level registration includes events from every Word window.
@MainActor final class WordWritingAXObserver {
    typealias Change = WordWritingObservationHealth.Notification
    var onChange: ((Change, AXUIElement?) -> Void)?
    private var health = WordWritingObservationHealth()
    private var session: WordWritingObservationHealth.Session?
    private var processID: pid_t?
    private var application: AXUIElement?
    private var observer: AXObserver?
    private var subscriptions: [CFString] = []
    private var lastEvent: Change?
    private let diagnostic = Logger(subsystem: "local.askgpt.reader", category: "writing-inline")

    var token: WordWritingObservationHealth.Token? { health.token }
    func permitsReuse(_ token: WordWritingObservationHealth.Token, window: WordWritingWindowStamp) -> Bool {
        guard processID == window.processID, let observer, health.permitsReuse(token) else { return false }
        let source = AXObserverGetRunLoopSource(observer)
        guard AXIsProcessTrusted(), CFRunLoopSourceIsValid(source), CFRunLoopContainsSource(CFRunLoopGetMain(), source, .commonModes) else {
            health.stop()
            diagnostic.info("ax_observer_mode=poll reason=run_loop_source")
            onChange?(.layout, nil)
            return false
        }
        return true
    }

    func startIfNeeded(processID: pid_t) {
        guard self.processID != processID else { return }
        stop()
        self.processID = processID
        let session = health.begin(); self.session = session
        let source = AXUIElementCreateApplication(processID); application = source
        var created: AXObserver?
        let error = AXObserverCreate(processID, { observer, element, notification, context in
            guard let context else { return }
            let owner = Unmanaged<WordWritingAXObserver>.fromOpaque(context).takeUnretainedValue()
            // This source is installed only on the main run loop below.
            MainActor.assumeIsolated { owner.received(observer, element: element, notification: notification) }
        }, &created)
        guard error == .success, let created else {
            health.finish(session)
            diagnostic.info("ax_observer_mode=poll reason=create ax_error=\(Int(error.rawValue), privacy: .public)")
            return
        }
        observer = created
        _ = AXUIElementSetMessagingTimeout(source, 0.05)
        let context = Unmanaged.passUnretained(self).toOpaque()
        for notification in Change.allCases {
            let name = Self.name(notification)
            let status = AXObserverAddNotification(created, source, name, context)
            health.record(notification, succeeded: status == .success, for: session)
            let required = WordWritingObservationHealth.requiredNotifications.contains(notification)
            diagnostic.info("ax_observer_registration=\(notification.rawValue, privacy: .public) required=\(required, privacy: .public) ax_status=\(Int(status.rawValue), privacy: .public)")
            if status == .success { subscriptions.append(name) }
        }
        health.finish(session)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        let mode = health.token == nil ? "poll" : "events"
        diagnostic.info("ax_observer_mode=\(mode, privacy: .public) registered_count=\(self.subscriptions.count, privacy: .public)")
    }

    func stop() {
        health.stop(); session = nil
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            if let application {
                for notification in subscriptions { _ = AXObserverRemoveNotification(observer, application, notification) }
            }
        }
        observer = nil; application = nil; processID = nil; subscriptions.removeAll(); lastEvent = nil
    }

    deinit {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
    }

    private func received(_ source: AXObserver, element: AXUIElement, notification: CFString) {
        guard let observer, CFEqual(observer, source), let session,
              let change = Change.allCases.first(where: { CFEqual(Self.name($0), notification) }),
              health.observe(session) else { return }
        if lastEvent != change {
            lastEvent = change
            diagnostic.info("ax_observer_event=\(change.rawValue, privacy: .public)")
        }
        onChange?(change, element)
    }
    private static func name(_ notification: Change) -> CFString {
        switch notification {
        case .mainWindow: return kAXMainWindowChangedNotification as CFString
        case .focusedWindow: return kAXFocusedWindowChangedNotification as CFString
        case .focusedElement: return kAXFocusedUIElementChangedNotification as CFString
        case .windowCreated: return kAXWindowCreatedNotification as CFString
        case .windowMoved: return kAXWindowMovedNotification as CFString
        case .windowResized: return kAXWindowResizedNotification as CFString
        case .destroyed: return kAXUIElementDestroyedNotification as CFString
        case .miniaturized: return kAXWindowMiniaturizedNotification as CFString
        case .deminiaturized: return kAXWindowDeminiaturizedNotification as CFString
        case .layout: return kAXLayoutChangedNotification as CFString
        case .value: return kAXValueChangedNotification as CFString
        case .selectedText: return kAXSelectedTextChangedNotification as CFString
        }
    }
}

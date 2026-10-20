import Foundation

/// Binds a reusable visual proof to one fully registered observer session.
/// Notifications invalidate a proof even when they arrive during its capture.
public struct WordWritingObservationHealth: Sendable {
    public enum Notification: String, CaseIterable, Hashable, Sendable {
        case mainWindow, focusedWindow, focusedElement, windowCreated
        case windowMoved, windowResized, destroyed, miniaturized, deminiaturized, layout, value, selectedText
    }
    public static let requiredNotifications: Set<Notification> = [
        .focusedWindow, .windowMoved, .windowResized, .destroyed, .miniaturized, .deminiaturized, .layout
    ]
    public struct Session: Equatable, Sendable { fileprivate let serial: UInt64 }
    public struct Token: Equatable, Sendable {
        fileprivate let session: Session
        fileprivate let revision: UInt64
    }
    private var serial: UInt64 = 0
    private var revision: UInt64 = 0
    private var session: Session?
    private var registered: Set<Notification> = []
    private var registrationFailed = false
    private var finished = false
    public init() {}
    public mutating func begin() -> Session {
        serial &+= 1; revision &+= 1
        let next = Session(serial: serial); session = next
        registered.removeAll(); registrationFailed = false; finished = false
        return next
    }
    public mutating func record(_ notification: Notification, succeeded: Bool, for session: Session) {
        guard self.session == session, !finished else { return }
        if succeeded { registered.insert(notification) }
        else if Self.requiredNotifications.contains(notification) { registrationFailed = true }
    }
    public mutating func finish(_ session: Session) {
        guard self.session == session else { return }
        finished = true
    }
    @discardableResult public mutating func observe(_ session: Session) -> Bool {
        guard self.session == session else { return false }
        revision &+= 1
        return true
    }
    public mutating func stop() {
        revision &+= 1; session = nil; registered.removeAll(); finished = false
    }
    public var token: Token? {
        guard let session, finished, !registrationFailed,
              registered.isSuperset(of: Self.requiredNotifications) else { return nil }
        return .init(session: session, revision: revision)
    }
    public func permitsReuse(_ token: Token) -> Bool { self.token == token }
}

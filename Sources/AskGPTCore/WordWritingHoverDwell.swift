import Foundation

/// Event-driven dwell state used by the native Word overlay. It stores no pointer history.
public final class WordWritingHoverDwell {
    public struct Ticket: Equatable, Sendable {
        public let target: String
        public let deadline: TimeInterval
        fileprivate let serial: UInt64
    }
    private var serial: UInt64 = 0
    private var pending: Ticket?
    private var inFlight = false
    private var attempts = 0
    private var observedTarget: String?
    private var presentedTarget: String?
    private var blockedTarget: String?
    private var waitingForPointerMove = false
    public init() {}

    public func observe(target: String?, now: TimeInterval, canActivate: Bool, pointerMoved: Bool = false) -> Ticket? {
        if pointerMoved { waitingForPointerMove = false }
        recordTarget(target)
        guard now.isFinite, canActivate, !waitingForPointerMove, let target,
              target != presentedTarget, target != blockedTarget else { cancelPending(); return nil }
        if let pending, pending.target == target { return pending }
        attempts = 1
        return schedule(target, now: now)
    }

    public func fire(_ ticket: Ticket, now: TimeInterval, target: String?, canActivate: Bool) -> String? {
        guard pending == ticket else { return nil }
        recordTarget(target)
        guard now.isFinite, canActivate, !waitingForPointerMove, target == ticket.target else { cancelPending(); return nil }
        guard !inFlight, now >= ticket.deadline else { return nil }
        inFlight = true
        return ticket.target
    }

    /// At most two fresh-proof attempts per uninterrupted stay. A failed proof
    /// never counts as an opened card; moving away permits a later new stay.
    public func complete(_ ticket: Ticket, displayed: Bool, now: TimeInterval, target: String?, canActivate: Bool) -> Ticket? {
        guard pending == ticket, inFlight else { return nil }
        recordTarget(target)
        guard now.isFinite, canActivate, !waitingForPointerMove, target == ticket.target else { cancelPending(); return nil }
        if displayed { presented(ticket.target); return nil }
        if attempts < 2 {
            attempts += 1
            return schedule(ticket.target, now: now)
        }
        blockedTarget = ticket.target
        cancelPending()
        return nil
    }

    public func presented(_ target: String) {
        cancelPending(); presentedTarget = target; blockedTarget = nil
    }
    public func dismissPresented() {
        cancelPending()
        if let presentedTarget, observedTarget == presentedTarget { blockedTarget = presentedTarget }
        presentedTarget = nil
    }
    public func cancelPending() { pending = nil; inFlight = false; attempts = 0 }
    public func reset() {
        cancelPending(); observedTarget = nil; presentedTarget = nil; blockedTarget = nil
        // A document refresh must not undo suppression caused by keyboard input.
    }
    public func suppressUntilPointerMove() { reset(); waitingForPointerMove = true }

    private func recordTarget(_ target: String?) {
        if blockedTarget != target { blockedTarget = nil }
        observedTarget = target
    }
    private func schedule(_ target: String, now: TimeInterval) -> Ticket {
        serial &+= 1
        let ticket = Ticket(target: target, deadline: now + 0.28, serial: serial)
        pending = ticket; inFlight = false
        return ticket
    }
}

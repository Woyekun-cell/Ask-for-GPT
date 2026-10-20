import Foundation
import os


/// Only fixed codes and bounded metadata may cross the local logging boundary.
enum NativeWritingDocumentDiagnostics {
    enum StateError: String {
        case none, other, document_inactive, active_window_unavailable, documentChanged, disposed
        case spelling_failed, scope_too_large, payload_too_large, invalid_issue, invalidEnvelope, originalMismatch, outsideTarget
        case scopeTooLarge, staleSnapshot, pageMetadataUnavailable, GeneralException, InvalidObjectPath, InvalidArgument, ItemNotFound, NotSupported
        case document_service_failed, document_bridge_unavailable, document_service_paused
    }
    enum AgeBucket: String { case none, other, clockMoved = "clock_moved", under1 = "under_1s", under3 = "under_3s", under5 = "under_5s", fivePlus = "5s_plus" }
    enum NoActiveReason: String { case noLease = "no_lease", inactive, ambiguous }
    enum RevokeReason: String { case ttl, commandTTL = "command_ttl", close, invalid, shutdown }
    enum SocketOutcome: String { case sent, cancelled, ioFailed = "io_failed" }
    static func stateError(_ value: String?) -> StateError { value.map { StateError(rawValue: $0) ?? .other } ?? .none }
    static func bounded(_ value: Int, maximum: Int) -> Int { max(0, min(value, maximum)) }
    static func ageBucket(_ seconds: TimeInterval?) -> AgeBucket {
        guard let seconds else { return .none }
        guard seconds.isFinite else { return .other }
        if seconds < 0 { return .clockMoved }
        if seconds < 1 { return .under1 }
        if seconds < 3 { return .under3 }
        if seconds < 5 { return .under5 }
        return .fivePlus
    }
    static func socketOutcome(sent: Bool, cancelled: Bool) -> SocketOutcome { sent ? .sent : cancelled ? .cancelled : .ioFailed }
}

public enum NativeWritingDocumentBrokerError: Error, Equatable, Sendable {
    case invalidRequest, unavailable, ambiguousActiveDocument, stale, busy
}

public struct NativeWritingDocumentCapabilities: Codable, Equatable, Sendable {
    public var sharedRuntime: Bool
    public var activeWindow: Bool
    public var hiddenRuntime: Bool
    public var safeReplace: Bool
}
public struct NativeWritingDocumentRegistration: Codable, Sendable {
    public var version: Int
    public var documentSessionID: String
    public var capabilities: NativeWritingDocumentCapabilities
}
public struct NativeWritingDocumentLease: Codable, Sendable {
    public let leaseID: String
    public let epoch: Int
    public let leaseTTLMilliseconds: Int
    public let pollAfterMilliseconds: Int
}
public struct NativeWritingDocumentIssue: Codable, Equatable, Sendable {
    public var handle: String
    public var envelope: IssueEnvelope
    public var canApply: Bool
    public var reason: String
}
public struct NativeWritingDocumentState: Codable, Equatable, Sendable {
    public enum Visibility: String, Codable, Sendable { case taskpane = "Taskpane", hidden = "Hidden" }
    public enum Status: String, Codable, Sendable { case ready, paused, preview, failed }
    public var epoch: Int
    public var active: Bool
    public var visibility: Visibility
    public var status: Status
    public var scope: CapturedScope?
    public var issues: [NativeWritingDocumentIssue]
    public var errorCode: String?
    public var profile: WritingProfile? = nil
}
public enum NativeWritingDocumentAction: String, Codable, Sendable {
    case captureSelection, prepareSuggestions, apply, ignore, addTerm, pause, resume
}
public struct NativeWritingDocumentCommand: Codable, Sendable {
    public let id: String
    public let epoch: Int
    public let action: NativeWritingDocumentAction
    public let handle: String?
    public let snapshotRequestID: String?
    public let issues: [WritingIssue]?
}
/// Relative timestamps from one host clock; diagnostics never authorize an edit.
public struct NativeWritingApplyTiming: Codable, Sendable {
    public let queueMilliseconds: Int
    public let editMilliseconds: Int
    public let resultMilliseconds: Int

    private enum CodingKeys: String, CodingKey {
        case queueMilliseconds, editMilliseconds, resultMilliseconds
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.singleValueContainer().decode([String: Int].self)
        guard Set(values.keys) == Set(["queueMilliseconds", "editMilliseconds", "resultMilliseconds"]),
              let queue = values["queueMilliseconds"], let edit = values["editMilliseconds"], let result = values["resultMilliseconds"],
              (0...60_000).contains(queue), queue <= edit, edit <= result, result <= 60_000 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid apply timing"))
        }
        queueMilliseconds = queue; editMilliseconds = edit; resultMilliseconds = result
    }
}
public struct NativeWritingDocumentResult: Codable, Sendable {
    public enum Status: String, Codable, Sendable { case completed, rejected, failed }
    public var commandID: String
    public var status: Status
    public var code: String
    public var scope: CapturedScope?
    public var prepared: [NativeWritingDocumentIssue]?
    public var timing: NativeWritingApplyTiming? = nil
    private enum CodingKeys: String, CodingKey { case commandID, status, code, scope, prepared, timing }
}
extension NativeWritingDocumentResult {
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        commandID = try values.decode(String.self, forKey: .commandID)
        status = try values.decode(Status.self, forKey: .status)
        code = try values.decode(String.self, forKey: .code)
        scope = try values.decodeIfPresent(CapturedScope.self, forKey: .scope)
        prepared = try values.decodeIfPresent([NativeWritingDocumentIssue].self, forKey: .prepared)
        // Bad optional measurements must never turn a committed write into a failure.
        timing = try? values.decode(NativeWritingApplyTiming.self, forKey: .timing)
    }
}
public struct NativeWritingDocumentExchange: Codable, Sendable {
    public var version: Int
    public var leaseID: String
    public var sequence: Int
    public var state: NativeWritingDocumentState?
    public var result: NativeWritingDocumentResult?
}
public struct NativeWritingDocumentExchangeResponse: Codable, Sendable {
    public let commands: [NativeWritingDocumentCommand]
    public let idleWaitMilliseconds: Int?
    public init(commands: [NativeWritingDocumentCommand], idleWaitMilliseconds: Int? = nil) {
        self.commands = commands; self.idleWaitMilliseconds = idleWaitMilliseconds
    }
}
public struct NativeWritingDocumentClose: Codable, Sendable {
    public var version: Int
    public var leaseID: String
}
public struct NativeWritingActiveDocument: Sendable {
    public let leaseID: String
    public let documentSessionID: String
    public let state: NativeWritingDocumentState
}
public struct NativeWritingCommandCompletion: Sendable {
    public enum Status: String, Sendable { case completed, rejected, failed, indeterminate, expired }
    public let commandID: String
    public let status: Status
    public let code: String
    public let scope: CapturedScope?
    public let prepared: [NativeWritingDocumentIssue]?
}

/// An in-memory, per-document mailbox. It never locates documents by their text and
/// never sends a delivered command twice. AX foreground/geometry verification remains
/// the native caller's responsibility before presenting or accepting any edit.
public actor NativeWritingDocumentBroker {
    private struct Lease {
        let documentSessionID: String
        let capabilities: NativeWritingDocumentCapabilities
        var epoch = 1
        var sequence = 0
        var touched: TimeInterval
        var state: NativeWritingDocumentState?
        var selectionSnapshots: [WritingSnapshot] = []
        var handles: [String: NativeWritingDocumentIssue] = [:]
        var preparedHandles: Set<String> = []
        var consumed: Set<String> = []
        var queued: [NativeWritingDocumentCommand] = []
        var delivered: NativeWritingDocumentCommand?
        var deliveredAt: TimeInterval?
    }
    private enum ExchangeWake { case timeout, command, stateChanged }
    private struct ExchangeWaiter {
        let id: UUID
        let sequence: Int
        let epoch: Int
        var continuation: CheckedContinuation<ExchangeWake, Error>?
        let timer: Task<Void, Never>
    }
    private var exchangeWaiters: [String: ExchangeWaiter] = [:]
    private let clock: @Sendable () -> TimeInterval
    private var leases: [String: Lease] = [:]
    private var completions: [String: NativeWritingCommandCompletion] = [:]
    private var completionOrder: [String] = []
    private var stopped = false
    private static let ttl: TimeInterval = 5
    private let documentDiagnostic = Logger(subsystem: "local.askgpt.reader", category: "writing-document")
    private var lastAcceptedDiagnosticAt: TimeInterval?
    private var lastNoActiveDiagnostic: String?

    public init() { clock = { ProcessInfo.processInfo.systemUptime } }
    init(clock: @escaping @Sendable () -> TimeInterval) { self.clock = clock }

    public func register(_ request: NativeWritingDocumentRegistration) throws -> NativeWritingDocumentLease {
        purgeExpired()
        guard !stopped else { throw NativeWritingDocumentBrokerError.unavailable }
        guard request.version == 1, Self.validID(request.documentSessionID),
              request.capabilities.sharedRuntime, request.capabilities.activeWindow, request.capabilities.hiddenRuntime else {
            throw NativeWritingDocumentBrokerError.invalidRequest
        }
        // One runtime owns each opaque document session. A fresh registration revokes
        // its predecessor instead of allowing two mailboxes to target the same host.
        for (id, value) in leases where value.documentSessionID == request.documentSessionID { revoke(id) }
        guard leases.count < 8 else { throw NativeWritingDocumentBrokerError.busy }
        let id = UUID().uuidString
        leases[id] = Lease(documentSessionID: request.documentSessionID, capabilities: request.capabilities, touched: clock())
        return .init(leaseID: id, epoch: 1, leaseTTLMilliseconds: 5000, pollAfterMilliseconds: 750)
    }

    public func exchange(_ request: NativeWritingDocumentExchange, waitForCommands: Bool = false) async throws -> NativeWritingDocumentExchangeResponse {
        let response = try acceptExchange(request)
        guard waitForCommands, request.result == nil, let accepted = leases[request.leaseID],
              accepted.delivered == nil, accepted.queued.isEmpty else { return response }
        let epoch = accepted.epoch, waiterID = UUID()
        defer { finishWaiter(leaseID: request.leaseID, id: waiterID) }
        do {
            let reason: ExchangeWake = try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await withCheckedThrowingContinuation { continuation in
                    guard let current = leases[request.leaseID], current.sequence == request.sequence, current.epoch == epoch,
                          exchangeWaiters[request.leaseID] == nil else {
                        continuation.resume(throwing: NativeWritingDocumentBrokerError.stale); return
                    }
                    let timer = Task { [weak self] in
                        do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
                        await self?.wakeWaiter(leaseID: request.leaseID, id: waiterID, reason: .timeout)
                    }
                    exchangeWaiters[request.leaseID] = .init(id: waiterID, sequence: request.sequence, epoch: epoch, continuation: continuation, timer: timer)
                    if !current.queued.isEmpty { wakeWaiter(leaseID: request.leaseID, id: waiterID, reason: .command) }
                }
            } onCancel: {
                Task { await self.cancelWaiter(leaseID: request.leaseID, id: waiterID) }
            }
            try Task.checkCancellation()
            purgeExpired()
            guard let waiter = exchangeWaiters[request.leaseID], waiter.id == waiterID,
                  waiter.sequence == request.sequence, waiter.epoch == epoch,
                  let current = leases[request.leaseID], current.sequence == request.sequence, current.epoch == epoch else {
                throw NativeWritingDocumentBrokerError.unavailable
            }
            if reason == .stateChanged { return .init(commands: []) }
            if !current.queued.isEmpty, uniqueActiveLeaseID() != request.leaseID { return .init(commands: []) }
            let delivered = try deliverQueued(leaseID: request.leaseID)
            let capability = reason == .timeout || !delivered.commands.isEmpty ? 1000 : nil
            return .init(commands: delivered.commands, idleWaitMilliseconds: capability)
        } catch {
            revoke(request.leaseID)
            throw error
        }
    }

    private func acceptExchange(_ request: NativeWritingDocumentExchange) throws -> NativeWritingDocumentExchangeResponse {
        purgeExpired()
        guard !stopped, var lease = leases[request.leaseID] else { throw NativeWritingDocumentBrokerError.unavailable }
        do {
            guard exchangeWaiters[request.leaseID] == nil, request.version == 1, request.sequence > 0, request.sequence == lease.sequence + 1 else {
                throw NativeWritingDocumentBrokerError.invalidRequest
            }
            // A successful edit may advance the host epoch in this same exchange.
            // Acknowledge the prior command before invalidating its old handles.
            if let result = request.result {
                guard let command = lease.delivered, result.commandID == command.id, command.epoch == lease.epoch,
                      Self.validCode(result.code) else { throw NativeWritingDocumentBrokerError.stale }
                try accept(result, for: command, in: &lease)
                lease.delivered = nil; lease.deliveredAt = nil
            }
            if let state = request.state {
                try validate(state, document: lease.documentSessionID)
                guard state.epoch >= lease.epoch else { throw NativeWritingDocumentBrokerError.stale }
                if state.epoch > lease.epoch {
                    expireCommands(lease)
                    lease.epoch = state.epoch; lease.handles.removeAll(); lease.consumed.removeAll()
                    lease.preparedHandles.removeAll(); lease.selectionSnapshots.removeAll(); lease.queued.removeAll()
                    lease.delivered = nil; lease.deliveredAt = nil
                } else if let previous = lease.state, previous.active != state.active {
                    throw NativeWritingDocumentBrokerError.stale
                } else if let previous = lease.state, previous.profile != state.profile {
                    throw NativeWritingDocumentBrokerError.stale
                } else if let previous = lease.state?.scope, let next = state.scope, !Self.sameContent(previous, next) {
                    throw NativeWritingDocumentBrokerError.stale
                }
                lease.state = state
                // Automatic spelling refreshes cannot resurrect a consumed handle.
                for item in state.issues where !lease.consumed.contains(item.handle) {
                    if let old = lease.handles[item.handle], old != item {
                        // Read-only marks may arrive before Word's replacement
                        // preflight. Only that exact automatic envelope may
                        // finish qualification once within its original epoch.
                        guard !lease.preparedHandles.contains(item.handle),
                              !old.canApply, old.reason == "preparing", item.reason != "preparing",
                              old.envelope == item.envelope else { throw NativeWritingDocumentBrokerError.stale }
                    }
                    lease.handles[item.handle] = item
                }
                guard lease.handles.count <= 128 else { throw NativeWritingDocumentBrokerError.invalidRequest }
            }
            lease.sequence = request.sequence; lease.touched = clock()
            leases[request.leaseID] = lease
            logAcceptedExchange(sequence: request.sequence, lease: lease)
            wakeInvalidActiveWaiters()
            return try deliverQueued(leaseID: request.leaseID)
        } catch {
            // A lost or replayed exchange has unknown delivery state. Re-registration
            // is required; apply is never automatically retried under a new lease.
            revoke(request.leaseID)
            throw error
        }
    }

    private func deliverQueued(leaseID: String) throws -> NativeWritingDocumentExchangeResponse {
        guard var current = leases[leaseID] else { throw NativeWritingDocumentBrokerError.unavailable }
        guard current.delivered == nil, let command = current.queued.first else { return .init(commands: []) }
        guard command.epoch == current.epoch else { throw NativeWritingDocumentBrokerError.stale }
        if ![.pause, .resume].contains(command.action) {
            guard uniqueActiveLeaseID() == leaseID else { return .init(commands: []) }
        }
        current.queued.removeFirst(); current.delivered = command; current.deliveredAt = clock(); leases[leaseID] = current
        return .init(commands: [command])
    }

    private func wakeWaiter(leaseID: String, id: UUID? = nil, reason: ExchangeWake) {
        guard var waiter = exchangeWaiters[leaseID], id == nil || waiter.id == id,
              let continuation = waiter.continuation else { return }
        waiter.continuation = nil; waiter.timer.cancel(); exchangeWaiters[leaseID] = waiter
        continuation.resume(returning: reason)
    }
    private func finishWaiter(leaseID: String, id: UUID) {
        guard exchangeWaiters[leaseID]?.id == id else { return }
        exchangeWaiters.removeValue(forKey: leaseID)?.timer.cancel()
    }
    private func cancelWaiter(leaseID: String, id: UUID) {
        guard exchangeWaiters[leaseID]?.id == id else { return }
        revoke(leaseID, waiterError: CancellationError())
    }
    private func wakeInvalidActiveWaiters() {
        let activeID = uniqueActiveLeaseID()
        for (id, waiter) in exchangeWaiters {
            guard let current = leases[id] else { continue }
            if current.epoch != waiter.epoch || (current.state?.active == true && activeID != id) {
                wakeWaiter(leaseID: id, reason: .stateChanged)
            }
        }
    }

    public func close(_ request: NativeWritingDocumentClose) throws {
        guard request.version == 1, Self.validID(request.leaseID) else { throw NativeWritingDocumentBrokerError.invalidRequest }
        revoke(request.leaseID, reason: .close)
    }

    /// Observes a current unconsumed suggestion. Enqueue still validates and
    /// consumes atomically; this read never grants permission to write.
    public func issue(leaseID: String, handle: String) -> NativeWritingDocumentIssue? {
        purgeExpired()
        guard !stopped, uniqueActiveLeaseID() == leaseID, let lease = leases[leaseID],
              !lease.consumed.contains(handle) else { return nil }
        return lease.handles[handle]
    }

    public func activeDocument() -> NativeWritingActiveDocument? {
        purgeExpired()
        guard let id = uniqueActiveLeaseID(), let lease = leases[id], let state = lease.state else {
            logNoActiveDocument(); return nil
        }
        lastNoActiveDiagnostic = nil
        return .init(leaseID: id, documentSessionID: lease.documentSessionID, state: state)
    }

    @discardableResult public func enqueueCaptureSelection(leaseID: String) throws -> String {
        try enqueue(.captureSelection, leaseID: leaseID)
    }
    @discardableResult public func enqueuePrepareSuggestions(leaseID: String, snapshotRequestID: String, issues: [WritingIssue]) throws -> String {
        purgeExpired()
        guard let lease = leases[leaseID], let snapshot = cachedSnapshot(snapshotRequestID, in: lease),
              !issues.isEmpty, issues.count <= 128 else { throw NativeWritingDocumentBrokerError.stale }
        try validateIssues(issues.map { NativeWritingDocumentIssue(handle: UUID().uuidString, envelope: .init(snapshot: snapshot, issue: $0),
            canApply: $0.original != $0.replacement, reason: "") }, snapshots: [snapshot], spellingOnly: false, profile: lease.state?.profile ?? .init())
        return try enqueue(.prepareSuggestions, leaseID: leaseID, snapshotRequestID: snapshotRequestID, issues: issues)
    }
    @discardableResult public func enqueueApply(leaseID: String, handle: String) throws -> String {
        try enqueue(.apply, leaseID: leaseID, handle: handle)
    }
    @discardableResult public func enqueueIgnore(leaseID: String, handle: String) throws -> String {
        try enqueue(.ignore, leaseID: leaseID, handle: handle)
    }
    @discardableResult public func enqueueAddTerm(leaseID: String, handle: String) throws -> String {
        try enqueue(.addTerm, leaseID: leaseID, handle: handle)
    }
    @discardableResult public func enqueuePause(leaseID: String) throws -> String { try enqueue(.pause, leaseID: leaseID) }
    @discardableResult public func enqueueResume(leaseID: String) throws -> String { try enqueue(.resume, leaseID: leaseID) }

    public func takeResult(commandID: String) -> NativeWritingCommandCompletion? {
        purgeExpired()
        completionOrder.removeAll { $0 == commandID }
        return completions.removeValue(forKey: commandID)
    }
    public func shutdown() {
        stopped = true
        for id in Array(leases.keys) { revoke(id, reason: .shutdown) }
    }

    private func enqueue(_ action: NativeWritingDocumentAction, leaseID: String, handle: String? = nil,
                         snapshotRequestID: String? = nil, issues: [WritingIssue]? = nil) throws -> String {
        purgeExpired()
        guard !stopped, var lease = leases[leaseID], let state = lease.state else { throw NativeWritingDocumentBrokerError.unavailable }
        guard uniqueActiveLeaseID() == leaseID else { throw NativeWritingDocumentBrokerError.ambiguousActiveDocument }
        guard lease.queued.count < 8 else { throw NativeWritingDocumentBrokerError.busy }
        if ![.pause, .resume].contains(action) {
            guard state.status == .ready || state.status == .preview else { throw NativeWritingDocumentBrokerError.unavailable }
        }
        if let handle {
            guard let item = lease.handles[handle], !lease.consumed.contains(handle) else { throw NativeWritingDocumentBrokerError.stale }
            if action == .apply {
                guard lease.capabilities.safeReplace, item.canApply else { throw NativeWritingDocumentBrokerError.unavailable }
                try validateIssues([item], snapshots: [item.envelope.snapshot], spellingOnly: false, profile: state.profile ?? .init())
            }
            if action == .addTerm {
                guard item.envelope.issue.category == "spelling", item.envelope.issue.original.utf16.count <= 256 else {
                    throw NativeWritingDocumentBrokerError.invalidRequest
                }
            }
            guard lease.consumed.count < 512 else { throw NativeWritingDocumentBrokerError.busy }
            lease.consumed.insert(handle); lease.handles.removeValue(forKey: handle); lease.preparedHandles.remove(handle)
        }
        let id = UUID().uuidString
        lease.queued.append(.init(id: id, epoch: lease.epoch, action: action, handle: handle, snapshotRequestID: snapshotRequestID, issues: issues))
        leases[leaseID] = lease
        wakeWaiter(leaseID: leaseID, reason: .command)
        return id
    }

    private func accept(_ result: NativeWritingDocumentResult, for command: NativeWritingDocumentCommand, in lease: inout Lease) throws {
        guard result.prepared == nil || command.action == .prepareSuggestions,
              result.scope == nil || command.action == .captureSelection else { throw NativeWritingDocumentBrokerError.invalidRequest }
        if result.status == .completed {
            if command.action == .captureSelection {
                guard let scope = result.scope, scope.scope == .selection, scope.snapshots.count == 1 else { throw NativeWritingDocumentBrokerError.invalidRequest }
                try validate(scope, document: lease.documentSessionID); cacheSelection(scope.snapshots[0], in: &lease)
            }
            if command.action == .prepareSuggestions {
                guard let prepared = result.prepared, let requested = command.issues, let requestID = command.snapshotRequestID,
                      let snapshot = cachedSnapshot(requestID, in: lease),
                      prepared.count == requested.count else { throw NativeWritingDocumentBrokerError.invalidRequest }
                try validateIssues(prepared, snapshots: [snapshot], spellingOnly: false, profile: lease.state?.profile ?? .init())
                guard Set(prepared.map { $0.envelope.issue.id }).count == requested.count,
                      prepared.allSatisfy({ item in requested.contains(item.envelope.issue)
                          && !lease.consumed.contains(item.handle) && lease.handles[item.handle] == nil }) else {
                    throw NativeWritingDocumentBrokerError.invalidRequest
                }
                for handle in lease.preparedHandles { lease.handles.removeValue(forKey: handle) }
                lease.preparedHandles = Set(prepared.map(\.handle))
                for item in prepared { lease.handles[item.handle] = item }
                guard lease.handles.count <= 128 else { throw NativeWritingDocumentBrokerError.invalidRequest }
            }
        } else {
            guard result.scope == nil, result.prepared == nil else { throw NativeWritingDocumentBrokerError.invalidRequest }
        }
        record(.init(commandID: command.id, status: .init(rawValue: result.status.rawValue)!, code: result.code, scope: result.scope, prepared: result.prepared))
        if command.action == .apply, result.status == .completed, result.code == "applied", let timing = result.timing {
            documentDiagnostic.info("event=apply_timing queue_ms=\(timing.queueMilliseconds, privacy: .public) edit_ms=\(timing.editMilliseconds, privacy: .public) result_ms=\(timing.resultMilliseconds, privacy: .public)")
        }
    }

    private func validate(_ state: NativeWritingDocumentState, document: String) throws {
        guard state.epoch > 0, state.epoch <= 1_000_000_000, state.errorCode.map(Self.validCode) ?? true else { throw NativeWritingDocumentBrokerError.invalidRequest }
        if let profile = state.profile {
            guard ["en-US", "en-GB"].contains(profile.spellingVariant), ["minimal", "clarity"].contains(profile.style),
                  profile.customTerms.count <= 128, profile.customTerms.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 256 }),
                  profile.customTerms.reduce(0, { $0 + $1.utf16.count }) <= 4096 else { throw NativeWritingDocumentBrokerError.invalidRequest }
        }
        if let scope = state.scope { try validate(scope, document: document) }
        guard state.scope != nil || state.issues.isEmpty else { throw NativeWritingDocumentBrokerError.invalidRequest }
        try validateIssues(state.issues, snapshots: state.scope?.snapshots ?? [], spellingOnly: true, profile: state.profile ?? .init())
    }
    private func validate(_ scope: CapturedScope, document: String) throws {
        guard scope.snapshots.count <= 64, scope.pageIndices.count <= 256, scope.pageIndices.allSatisfy({ $0 >= 0 }),
              Set(scope.snapshots.map(\.requestID)).count == scope.snapshots.count,
              scope.snapshots.reduce(0, { $0 + $1.rawText.utf16.count + $1.contextBefore.utf16.count + $1.contextAfter.utf16.count }) <= 16_000 else {
            throw NativeWritingDocumentBrokerError.invalidRequest
        }
        for snapshot in scope.snapshots {
            guard snapshot.documentSessionID == document, snapshot.scope == scope.scope,
                  snapshot.protectedRanges.count <= 512, snapshot.pageIndices.count <= 256,
                  [snapshot.requestID, snapshot.documentSessionID, snapshot.blockID, snapshot.revision].allSatisfy(Self.validID) else {
                throw NativeWritingDocumentBrokerError.invalidRequest
            }
            do { try WritingSnapshotPreflight.validate(snapshot, profile: .init()) }
            catch { throw NativeWritingDocumentBrokerError.invalidRequest }
        }
    }
    private func validateIssues(_ items: [NativeWritingDocumentIssue], snapshots: [WritingSnapshot], spellingOnly: Bool, profile: WritingProfile) throws {
        guard items.count <= 128, Set(items.map(\.handle)).count == items.count else { throw NativeWritingDocumentBrokerError.invalidRequest }
        for item in items {
            let snapshot = item.envelope.snapshot, issue = item.envelope.issue
            do { try WritingSnapshotPreflight.validate(snapshot, profile: .init()) }
            catch { throw NativeWritingDocumentBrokerError.invalidRequest }
            guard Self.validHandle(item.handle), Self.validID(issue.id), item.reason.utf16.count <= 512,
                  !item.canApply || item.reason != "preparing",
                  snapshots.contains(snapshot), issue.original.utf16.count <= 4000, issue.replacement.utf16.count <= 4000,
                  issue.reason.utf16.count <= 2048, !issue.original.isEmpty,
                  ["spelling", "grammar", "expression", "context"].contains(issue.category),
                  !spellingOnly || issue.category == "spelling" else { throw NativeWritingDocumentBrokerError.invalidRequest }
            let boundaries = WritingSnapshotPreflight.graphemeBoundaries(snapshot.rawText)
            do { try WritingSnapshotPreflight.validate(issue.range, count: snapshot.rawText.utf16.count, boundaries: boundaries) }
            catch { throw NativeWritingDocumentBrokerError.invalidRequest }
            guard let end = issue.range.end, let targetEnd = snapshot.targetRange.end,
                  issue.range.length > 0, issue.range.start >= snapshot.targetRange.start, end <= targetEnd,
                  Data((snapshot.rawText as NSString).substring(with: NSRange(location: issue.range.start, length: issue.range.length)).utf8) == Data(issue.original.utf8) else {
                throw NativeWritingDocumentBrokerError.invalidRequest
            }
            if item.canApply {
                let text = snapshot.rawText as NSString
                let suggestion = ModelWritingSuggestion(original: issue.original, replacement: issue.replacement,
                    prefix: text.substring(to: issue.range.start), suffix: text.substring(from: end), category: issue.category, reason: issue.reason)
                do {
                    let validated = try WritingIssueValidator(profile: profile).validate(suggestion, in: snapshot)
                    guard validated.range == issue.range, issue.original != issue.replacement else { throw NativeWritingDocumentBrokerError.invalidRequest }
                } catch { throw NativeWritingDocumentBrokerError.invalidRequest }
            }
        }
    }
    private func cachedSnapshot(_ requestID: String, in lease: Lease) -> WritingSnapshot? {
        // Heartbeats replace the current scope; they never evict either explicit
        // selection. No automatic snapshot history is retained alongside it.
        lease.selectionSnapshots.first { $0.requestID == requestID }
            ?? lease.state?.scope?.snapshots.first { $0.requestID == requestID }
    }
    private func cacheSelection(_ snapshot: WritingSnapshot, in lease: inout Lease) {
        lease.selectionSnapshots.removeAll { $0.requestID == snapshot.requestID }
        lease.selectionSnapshots.append(snapshot)
        if lease.selectionSnapshots.count > 2 { lease.selectionSnapshots.removeFirst(lease.selectionSnapshots.count - 2) }
    }
    private static func sameContent(_ first: CapturedScope, _ second: CapturedScope) -> Bool {
        var first = first, second = second
        for index in first.snapshots.indices { first.snapshots[index].requestID = "" }
        for index in second.snapshots.indices { second.snapshots[index].requestID = "" }
        return first == second
    }
    private func logAcceptedExchange(sequence: Int, lease: Lease) {
        if let last = lastAcceptedDiagnosticAt, lease.touched >= last, lease.touched - last < 1 { return }
        lastAcceptedDiagnosticAt = lease.touched
        let sequence = NativeWritingDocumentDiagnostics.bounded(sequence, maximum: 1_000_000_000)
        let epoch = NativeWritingDocumentDiagnostics.bounded(lease.epoch, maximum: 1_000_000_000)
        let state = lease.state, status = state?.status.rawValue ?? "none", visibility = state?.visibility.rawValue ?? "none"
        let active = state?.active == true
        let issues = NativeWritingDocumentDiagnostics.bounded(state?.issues.count ?? 0, maximum: 128)
        let code = NativeWritingDocumentDiagnostics.stateError(state?.errorCode)
        let queued = NativeWritingDocumentDiagnostics.bounded(lease.queued.count, maximum: 8), delivered = lease.delivered != nil
        documentDiagnostic.info("event=exchange_accepted sequence=\(sequence, privacy: .public) epoch=\(epoch, privacy: .public) active=\(active, privacy: .public) status=\(status, privacy: .public) visibility=\(visibility, privacy: .public) issue_count=\(issues, privacy: .public) error_code=\(code.rawValue, privacy: .public) queued=\(queued, privacy: .public) delivered=\(delivered, privacy: .public)")
    }
    private func logNoActiveDocument() {
        let now = clock()
        let alive = NativeWritingDocumentDiagnostics.bounded(leases.count, maximum: 8)
        let active = NativeWritingDocumentDiagnostics.bounded(leases.values.filter { $0.state?.active == true && now - $0.touched < Self.ttl }.count, maximum: 8)
        let reason: NativeWritingDocumentDiagnostics.NoActiveReason = alive == 0 ? .noLease : active > 1 ? .ambiguous : .inactive
        let age = NativeWritingDocumentDiagnostics.ageBucket(leases.values.map { now - $0.touched }.max())
        let key = "\(reason.rawValue)|\(alive)|\(active)|\(age.rawValue)"
        guard key != lastNoActiveDiagnostic else { return }
        lastNoActiveDiagnostic = key
        documentDiagnostic.info("event=no_active_document reason=\(reason.rawValue, privacy: .public) alive=\(alive, privacy: .public) active=\(active, privacy: .public) age_bucket=\(age.rawValue, privacy: .public)")
    }
    private func uniqueActiveLeaseID() -> String? {
        let active = leases.filter { $0.value.state?.active == true && clock() - $0.value.touched < Self.ttl }
        return active.count == 1 ? active.first?.key : nil
    }
    private func purgeExpired() {
        let now = clock()
        for (id, lease) in leases {
            if now - lease.touched >= Self.ttl || now < lease.touched || lease.deliveredAt.map({ now - $0 >= 10 }) == true {
                revoke(id, reason: now - lease.touched >= Self.ttl || now < lease.touched ? .ttl : .commandTTL); continue
            }
        }
    }
    private func revoke(_ id: String, reason: NativeWritingDocumentDiagnostics.RevokeReason = .invalid,
                        waiterError: Error = NativeWritingDocumentBrokerError.unavailable) {
        if let waiter = exchangeWaiters.removeValue(forKey: id) {
            waiter.timer.cancel(); waiter.continuation?.resume(throwing: waiterError)
        }
        guard let lease = leases.removeValue(forKey: id) else { return }
        let age = NativeWritingDocumentDiagnostics.ageBucket(clock() - lease.touched)
        let alive = NativeWritingDocumentDiagnostics.bounded(leases.count, maximum: 8)
        documentDiagnostic.info("event=lease_revoked reason=\(reason.rawValue, privacy: .public) alive=\(alive, privacy: .public) age_bucket=\(age.rawValue, privacy: .public)")
        expireCommands(lease)
    }
    private func expireCommands(_ lease: Lease) {
        for command in lease.queued { record(.init(commandID: command.id, status: .expired, code: "document_lease_expired", scope: nil, prepared: nil)) }
        if let command = lease.delivered {
            record(.init(commandID: command.id, status: command.action == .apply ? .indeterminate : .expired,
                         code: command.action == .apply ? "apply_outcome_unknown" : "document_lease_expired", scope: nil, prepared: nil))
        }
    }
    private func record(_ completion: NativeWritingCommandCompletion) {
        completionOrder.removeAll { $0 == completion.commandID }
        completions[completion.commandID] = completion; completionOrder.append(completion.commandID)
        while completionOrder.count > 128 { completions.removeValue(forKey: completionOrder.removeFirst()) }
    }
    private static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 256 && id.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 }
    }
    private static func validHandle(_ handle: String) -> Bool {
        (16...128).contains(handle.utf8.count) && handle.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }
    private static func validCode(_ code: String) -> Bool {
        !code.isEmpty && code.utf8.count <= 64 && code.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }
}

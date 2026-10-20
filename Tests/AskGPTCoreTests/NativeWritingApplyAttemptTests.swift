import Foundation
import Testing
@testable import AskGPTCore

struct NativeWritingApplyAttemptTests {
    @Test func rejectedAckWithAdvancedEpochRetainsOnlyReadOnlyReceipt() async throws {
        let (broker, document, item) = try await fixture()
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        #expect(!attempt.permitsReceipt(document: document))
        let id = try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle); attempt.markEnqueued()
        _ = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 2, state: nil, result: nil))
        var advanced = document.state; advanced.epoch = 2; advanced.issues = []
        _ = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 3, state: advanced,
            result: .init(commandID: id, status: .rejected, code: "protectedRange", scope: nil, prepared: nil)))
        let completion = try #require(await broker.takeResult(commandID: id))
        let result = attempt.finish(status: completion.status, code: completion.code)
        let current = try #require(await broker.activeDocument())
        #expect(current.state.epoch == 2 && result.outcome == .rejected && result.retryCandidate == nil)
        #expect(attempt.permitsReceipt(document: current) && !attempt.awaitingReceipt)
        #expect(attempt.guardCode(document: current, candidate: item, foregroundAllowed: true, generationMatches: true, cancelled: false) == .epochChanged)
        #expect(await broker.issue(leaseID: document.leaseID, handle: item.handle) == nil)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle) }
        let (_, other, _) = try await fixture()
        #expect(!attempt.permitsReceipt(document: other))
    }
    @Test func expiredDeliveredApplyKeepsWaitThenUnknownReceiptWithoutWritePermission() async throws {
        let clock = ApplyAttemptClock()
        let (broker, document, item) = try await fixture(clock: clock)
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        let id = try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle); attempt.markEnqueued()
        _ = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 2, state: nil, result: nil))
        clock.advance(5)
        #expect(await broker.activeDocument() == nil)
        #expect(attempt.awaitingReceipt && attempt.permitsReceipt(document: nil))
        let completion = try #require(await broker.takeResult(commandID: id))
        let result = attempt.finish(status: completion.status, code: completion.code)
        #expect(result.outcome == .unknown && result.retryCandidate == nil && result.message?.contains("未确认") == true)
        #expect(!attempt.awaitingReceipt && attempt.permitsReceipt(document: nil))
        #expect(attempt.guardCode(document: nil, candidate: item, foregroundAllowed: true, generationMatches: true, cancelled: false) == .noActiveDocument)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle) }
    }
    @Test func fixedStaticPreviewReasonsDoNotClaimAnAttemptFailed() {
        for reason in ["暂无替换候选。", "受保护内容，仅预览。", "保留词典术语，仅预览。", "此候选会拆分字符，仅预览。", "此候选包含段落或控制字符，仅预览。"] {
            #expect(NativeWritingApplyAttempt.message(for: reason) == reason)
        }
    }
    @Test func onlyAcknowledgedAppliedCommandReportsCompleted() async throws {
        let (broker, document, item) = try await fixture()
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        #expect(attempt.finish(status: .completed, code: "applied").outcome != .completed)
        let id = try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle); attempt.markEnqueued()
        _ = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 2, state: nil, result: nil))
        _ = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 3, state: nil, result: .init(commandID: id, status: .completed, code: "applied", scope: nil, prepared: nil)))
        let completion = try #require(await broker.takeResult(commandID: id))
        let result = attempt.finish(status: completion.status, code: completion.code)
        #expect(result.outcome == .completed && result.message == nil && result.retryCandidate == nil)
        #expect(attempt.finish(status: .completed, code: "captured").outcome == .unknown)
    }
    @Test func freshAcceptanceBindsFullHandleEnvelopeAndLiveDocument() async throws {
        let (broker, document, item) = try await fixture()
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        let fresh = await broker.issue(leaseID: document.leaseID, handle: item.handle)
        #expect(attempt.guardCode(document: document, candidate: fresh, foregroundAllowed: true, generationMatches: true, cancelled: false) == nil)
        var changed = item; changed.envelope.issue.replacement = "outcomes"
        #expect(attempt.guardCode(document: document, candidate: changed, foregroundAllowed: true, generationMatches: true, cancelled: false) == .candidateChanged)
        #expect(attempt.guardCode(document: document, candidate: nil, foregroundAllowed: true, generationMatches: true, cancelled: false) == .candidateUnavailable)
        #expect(attempt.guardCode(document: nil, candidate: fresh, foregroundAllowed: true, generationMatches: true, cancelled: false) == .noActiveDocument)
        #expect(attempt.guardCode(document: document, candidate: fresh, foregroundAllowed: false, generationMatches: true, cancelled: false) == .foreground)
        #expect(attempt.guardCode(document: document, candidate: fresh, foregroundAllowed: true, generationMatches: false, cancelled: false) == .superseded)
        #expect(attempt.guardCode(document: document, candidate: fresh, foregroundAllowed: true, generationMatches: true, cancelled: true) == .cancelled)
    }
    @Test func failureBeforeDispatchRetainsOnlyFreshWritableCandidateForAnotherExplicitClick() async throws {
        let (broker, document, item) = try await fixture()
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        let candidate = await broker.issue(leaseID: document.leaseID, handle: item.handle)
        let failed = attempt.fail(code: "temporary_unavailable", cancelled: false, document: await broker.activeDocument(), candidate: candidate)
        #expect(!attempt.commandEnqueued)
        #expect(failed.retryCandidate == item)
        #expect(failed.outcome == .rejected)
        #expect(failed.message?.contains("重试") == true)
        // A refusal created no command or consumption. Only another explicit attempt can enqueue.
        #expect(try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 2, state: nil, result: nil)).commands.isEmpty)
        let next = NativeWritingApplyAttempt(document: document, candidate: try #require(failed.retryCandidate))
        #expect(next.guardCode(document: await broker.activeDocument(), candidate: await broker.issue(leaseID: document.leaseID, handle: item.handle), foregroundAllowed: true, generationMatches: true, cancelled: false) == nil)
        _ = try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle)
    }
    @Test func changedEpochOrLeaseNeverRestoresOldCandidate() async throws {
        let (broker, document, item) = try await fixture()
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        var nextState = document.state; nextState.epoch += 1
        _ = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 2, state: nextState, result: nil))
        let fresh = try #require(await broker.activeDocument())
        #expect(attempt.guardCode(document: fresh, candidate: item, foregroundAllowed: true, generationMatches: true, cancelled: false) == .epochChanged)
        #expect(attempt.fail(code: "epochChanged", cancelled: false, document: fresh, candidate: item).retryCandidate == nil)
        let (otherBroker, other, otherItem) = try await fixture()
        #expect(attempt.guardCode(document: other, candidate: otherItem, foregroundAllowed: true, generationMatches: true, cancelled: false) == .leaseChanged)
        #expect(attempt.fail(code: "leaseChanged", cancelled: false, document: other, candidate: otherItem).retryCandidate == nil)
        await otherBroker.shutdown()
    }
    @Test func dispatchedRejectedCommandCannotReuseConsumedHandle() async throws {
        let (broker, document, item) = try await fixture()
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        let id = try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle)
        attempt.markEnqueued()
        let delivered = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 2, state: nil, result: nil))
        #expect(delivered.commands.first?.id == id)
        _ = try await broker.exchange(.init(version: 1, leaseID: document.leaseID, sequence: 3, state: nil, result: .init(commandID: id, status: .rejected, code: "protectedRange", scope: nil, prepared: nil)))
        let completion = try #require(await broker.takeResult(commandID: id))
        let result = attempt.finish(status: completion.status, code: completion.code)
        #expect(attempt.commandEnqueued && result.outcome == .rejected)
        #expect(result.retryCandidate == nil && result.message?.contains("保护") == true)
        #expect(await broker.issue(leaseID: document.leaseID, handle: item.handle) == nil)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle) }
    }
    @Test func cancellationAfterDispatchIsUnknownAndNeverRetryable() async throws {
        let (broker, document, item) = try await fixture()
        let before = NativeWritingApplyAttempt(document: document, candidate: item)
        #expect(before.fail(code: "cancelled", cancelled: true, document: document, candidate: item).outcome == .cancelled)
        let after = NativeWritingApplyAttempt(document: document, candidate: item)
        _ = try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle); after.markEnqueued()
        let result = after.fail(code: "cancelled", cancelled: true, document: document, candidate: item)
        #expect(result.outcome == .unknown && result.retryCandidate == nil)
        #expect(result.message?.contains("未确认") == true)
    }
    @Test func unknownOrExpiredCompletionNeverClaimsSuccess() async throws {
        let (_, document, item) = try await fixture()
        for status in [NativeWritingCommandCompletion.Status.indeterminate, .expired, .failed] {
            let attempt = NativeWritingApplyAttempt(document: document, candidate: item); attempt.markEnqueued()
            let result = attempt.finish(status: status, code: "apply_outcome_unknown")
            #expect(result.outcome == .unknown && result.retryCandidate == nil)
            #expect(result.message?.contains("未确认") == true)
        }
    }
    @Test func legacyPendingAndProtectedPreviewCannotBecomeRetryCandidates() async throws {
        let (_, document, item) = try await fixture()
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        for reason in ["preparing", "protectedRange"] {
            var preview = item; preview.canApply = false; preview.reason = reason
            #expect(attempt.guardCode(document: document, candidate: preview, foregroundAllowed: true, generationMatches: true, cancelled: false) == .notApplicable)
            #expect(attempt.fail(code: reason, cancelled: false, document: document, candidate: preview).retryCandidate == nil)
            #expect(!NativeWritingApplyAttempt.message(for: reason).isEmpty)
        }
    }
    private func fixture(clock: ApplyAttemptClock? = nil) async throws -> (NativeWritingDocumentBroker, NativeWritingActiveDocument, NativeWritingDocumentIssue) {
        let broker = clock.map { value in NativeWritingDocumentBroker(clock: { value.now }) } ?? NativeWritingDocumentBroker()
        let lease = try await broker.register(.init(version: 1, documentSessionID: "doc", capabilities: .init(sharedRuntime: true, activeWindow: true, hiddenRuntime: true, safeReplace: true)))
        let snapshot = WritingSnapshot(requestID: "request", documentSessionID: "doc", blockID: "block", revision: "1", rawText: "The resuts agree.", scope: .activeParagraph)
        let issue = WritingIssue(id: "issue", category: "spelling", original: "resuts", replacement: "results", reason: "Spelling", range: .init(start: 4, length: 6), requiresAuthorConfirmation: false)
        let item = NativeWritingDocumentIssue(handle: "explicit-handle-01", envelope: .init(snapshot: snapshot, issue: issue), canApply: true, reason: "")
        let state = NativeWritingDocumentState(epoch: 1, active: true, visibility: .hidden, status: .ready, scope: .init(scope: .activeParagraph, pageIndices: [1], snapshots: [snapshot]), issues: [item], errorCode: nil)
        _ = try await broker.exchange(.init(version: 1, leaseID: lease.leaseID, sequence: 1, state: state, result: nil))
        return (broker, try #require(await broker.activeDocument()), item)
    }
}

private final class ApplyAttemptClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 100
    var now: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ delta: TimeInterval) { lock.lock(); defer { lock.unlock() }; value += delta }
}

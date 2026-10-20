import Foundation
import Testing
@testable import AskGPTCore

@Suite(.serialized)
struct NativeWritingDocumentBrokerTests {
    @Test func expandedScopeAcceptsNineteenAndSixtyFourSnapshotsAndPreparesBothEnds() async throws {
        for count in [19, 64] {
            let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
            var current = state(); current.scope = visibleScope(count)
            _ = try await broker.exchange(exchange(lease.leaseID, state: current))
            #expect(await broker.activeDocument()?.state.scope?.snapshots.count == count)
            var sequence = 1
            for index in [0, count - 1] {
                try await completePrepare(broker, lease: lease.leaseID, snapshot: current.scope!.snapshots[index], sequence: &sequence)
            }
        }
    }

    @Test func expandedScopeKeepsUTF16AndIdentityLimits() async throws {
        let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
        var exact = state(); exact.scope = visibleScope(64, rawLength: 250)
        _ = try await broker.exchange(exchange(lease.leaseID, state: exact))
        #expect(await broker.activeDocument()?.state.scope?.snapshots.count == 64)
        for kind in ["count", "utf16", "duplicate", "foreign"] {
            let rejected = NativeWritingDocumentBroker(), lease = try await rejected.register(registration())
            var invalid = state(); invalid.scope = visibleScope(kind == "count" ? 65 : 64, rawLength: kind == "utf16" ? 250 : nil)
            if kind == "utf16" {
                invalid.scope!.snapshots[63] = .init(requestID: "visible-63", documentSessionID: "doc", blockID: "visible-block-63", revision: "1", rawText: String(repeating: "a", count: 251), pageIndices: [2], scope: .visiblePages)
            } else if kind == "duplicate" { invalid.scope!.snapshots[63].requestID = invalid.scope!.snapshots[0].requestID }
            else if kind == "foreign" { invalid.scope!.snapshots[63].documentSessionID = "other-document" }
            await #expect(throws: NativeWritingDocumentBrokerError.invalidRequest) {
                _ = try await rejected.exchange(exchange(lease.leaseID, state: invalid))
            }
            #expect(await rejected.activeDocument() == nil)
        }
    }

    @Test func expandedScopeKeepsTwoExplicitSelectionsAcrossFreshHeartbeatRequestIDs() async throws {
        let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
        var current = state(); current.scope = visibleScope(16)
        _ = try await broker.exchange(exchange(lease.leaseID, state: current))
        var sequence = 1
        let selected = [selectionSnapshot("selection-a"), selectionSnapshot("selection-b")]
        for snapshot in selected { try await completeCapture(broker, lease: lease.leaseID, snapshot: snapshot, sequence: &sequence) }
        for generation in 1...3 {
            current.scope = visibleScope(16, generation: "heartbeat-\(generation)")
            sequence += 1
            _ = try await broker.exchange(exchange(lease.leaseID, sequence: sequence, state: current))
        }
        for snapshot in selected { try await completePrepare(broker, lease: lease.leaseID, snapshot: snapshot, sequence: &sequence) }
        try await completePrepare(broker, lease: lease.leaseID, snapshot: current.scope!.snapshots[0], sequence: &sequence)
        try await completePrepare(broker, lease: lease.leaseID, snapshot: current.scope!.snapshots[15], sequence: &sequence)
    }

    @Test func expandedScopeRetainsOnlyCurrentScopeAndNewestTwoSelectionsUntilEpochAdvance() async throws {
        let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
        var current = state(); current.scope = visibleScope(16)
        let historical = current.scope!.snapshots[15]
        _ = try await broker.exchange(exchange(lease.leaseID, state: current))
        var sequence = 1
        let selected = [selectionSnapshot("selection-a"), selectionSnapshot("selection-b"), selectionSnapshot("selection-c")]
        for snapshot in selected { try await completeCapture(broker, lease: lease.leaseID, snapshot: snapshot, sequence: &sequence) }
        await #expect(throws: NativeWritingDocumentBrokerError.stale) {
            _ = try await broker.enqueuePrepareSuggestions(leaseID: lease.leaseID, snapshotRequestID: selected[0].requestID, issues: [item().envelope.issue])
        }
        current.scope = visibleScope(16, generation: "fresh"); sequence += 1
        _ = try await broker.exchange(exchange(lease.leaseID, sequence: sequence, state: current))
        await #expect(throws: NativeWritingDocumentBrokerError.stale) {
            _ = try await broker.enqueuePrepareSuggestions(leaseID: lease.leaseID, snapshotRequestID: historical.requestID, issues: [item().envelope.issue])
        }
        for snapshot in selected.suffix(2) { try await completePrepare(broker, lease: lease.leaseID, snapshot: snapshot, sequence: &sequence) }
        current.epoch = 2; current.scope = visibleScope(16, generation: "epoch-two"); sequence += 1
        _ = try await broker.exchange(exchange(lease.leaseID, sequence: sequence, state: current))
        for snapshot in selected {
            await #expect(throws: NativeWritingDocumentBrokerError.stale) {
                _ = try await broker.enqueuePrepareSuggestions(leaseID: lease.leaseID, snapshotRequestID: snapshot.requestID, issues: [item().envelope.issue])
            }
        }
        try await completePrepare(broker, lease: lease.leaseID, snapshot: current.scope!.snapshots[0], sequence: &sequence)
    }

    private func visibleScope(_ count: Int, generation: String = "visible", rawLength: Int? = nil) -> CapturedScope {
        .init(scope: .visiblePages, pageIndices: [1, 2], snapshots: (0..<count).map { index in
            .init(requestID: "\(generation)-\(index)", documentSessionID: "doc", blockID: "visible-block-\(index)", revision: "1", rawText: rawLength.map { String(repeating: "a", count: $0) } ?? "The resuts agree.", pageIndices: [index % 2 + 1], scope: .visiblePages)
        })
    }
    private func selectionSnapshot(_ id: String) -> WritingSnapshot {
        .init(requestID: id, documentSessionID: "doc", blockID: id, revision: "1", rawText: "The resuts agree.", scope: .selection)
    }
    private func completeCapture(_ broker: NativeWritingDocumentBroker, lease: String, snapshot: WritingSnapshot, sequence: inout Int) async throws {
        let command = try await broker.enqueueCaptureSelection(leaseID: lease); sequence += 1
        let response = try await broker.exchange(exchange(lease, sequence: sequence))
        #expect(response.commands.first?.id == command)
        let result = NativeWritingDocumentResult(commandID: command, status: .completed, code: "captured", scope: .init(scope: .selection, pageIndices: [], snapshots: [snapshot]), prepared: nil)
        sequence += 1
        _ = try await broker.exchange(.init(version: 1, leaseID: lease, sequence: sequence, state: nil, result: result))
        #expect(await broker.takeResult(commandID: command)?.scope?.snapshots == [snapshot])
    }
    private func completePrepare(_ broker: NativeWritingDocumentBroker, lease: String, snapshot: WritingSnapshot, sequence: inout Int) async throws {
        var issue = item().envelope.issue; issue.category = "grammar"
        let command = try await broker.enqueuePrepareSuggestions(leaseID: lease, snapshotRequestID: snapshot.requestID, issues: [issue]); sequence += 1
        let response = try await broker.exchange(exchange(lease, sequence: sequence))
        #expect(response.commands.first?.snapshotRequestID == snapshot.requestID)
        let prepared = NativeWritingDocumentIssue(handle: UUID().uuidString, envelope: .init(snapshot: snapshot, issue: issue), canApply: true, reason: "")
        let result = NativeWritingDocumentResult(commandID: command, status: .completed, code: "prepared", scope: nil, prepared: [prepared]); sequence += 1
        _ = try await broker.exchange(.init(version: 1, leaseID: lease, sequence: sequence, state: nil, result: result))
        #expect(await broker.takeResult(commandID: command)?.prepared == [prepared])
    }

    @Test func applyTimingIsOptionalBoundedDiagnosticMetadata() throws {
        let valid: [String: Int] = ["queueMilliseconds": 12, "editMilliseconds": 240, "resultMilliseconds": 255]
        let result = NativeWritingDocumentResult(commandID: "command", status: .completed, code: "applied", scope: nil, prepared: nil)
        var payload = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
        payload["timing"] = valid
        let decoded = try JSONDecoder().decode(NativeWritingDocumentResult.self, from: JSONSerialization.data(withJSONObject: payload))
        let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any])
        #expect(encoded["timing"] as? [String: Int] == valid)
        for malformed: Any in [
            ["queueMilliseconds": -1, "editMilliseconds": 240, "resultMilliseconds": 255],
            ["queueMilliseconds": 241, "editMilliseconds": 240, "resultMilliseconds": 255],
            ["queueMilliseconds": 12, "editMilliseconds": 256, "resultMilliseconds": 255],
            ["queueMilliseconds": 12, "editMilliseconds": 240, "resultMilliseconds": 60_001],
            ["queueMilliseconds": 12, "editMilliseconds": 240],
            ["queueMilliseconds": 12, "editMilliseconds": 240, "resultMilliseconds": 255, "extra": 0],
            ["queueMilliseconds": "private text", "editMilliseconds": 240, "resultMilliseconds": 255],
            "private text"
        ] {
            payload["timing"] = malformed
            let decoded = try JSONDecoder().decode(NativeWritingDocumentResult.self, from: JSONSerialization.data(withJSONObject: payload))
            #expect(decoded.status == .completed && decoded.code == "applied")
            let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any])
            #expect(encoded["timing"] == nil)
        }
        payload.removeValue(forKey: "timing")
        let old = try JSONDecoder().decode(NativeWritingDocumentResult.self, from: JSONSerialization.data(withJSONObject: payload))
        #expect(old.code == "applied")
    }

    @Test func anonymousDiagnosticsNeverReflectUnknownStateCodes() {
        #expect(NativeWritingDocumentDiagnostics.stateError(nil) == .none)
        #expect(NativeWritingDocumentDiagnostics.stateError("document_inactive") == .document_inactive)
        #expect(NativeWritingDocumentDiagnostics.stateError("GeneralException") == .GeneralException)
        for unknown in ["private_document_identifier", String(repeating: "a", count: 64), "https://private.invalid/text", "secret manuscript", "document_inactive_secret", ""] {
            #expect(NativeWritingDocumentDiagnostics.stateError(unknown).rawValue == "other")
        }
    }
    @Test func anonymousDiagnosticsBoundCountersAndBucketOnlyClockMetadata() {
        #expect(NativeWritingDocumentDiagnostics.bounded(-1, maximum: 8) == 0)
        #expect(NativeWritingDocumentDiagnostics.bounded(4, maximum: 8) == 4)
        #expect(NativeWritingDocumentDiagnostics.bounded(.max, maximum: 128) == 128)
        #expect(NativeWritingDocumentDiagnostics.bounded(.max, maximum: 1_000_000_000) == 1_000_000_000)
        #expect(NativeWritingDocumentDiagnostics.ageBucket(nil) == .none)
        #expect(NativeWritingDocumentDiagnostics.ageBucket(.nan) == .other)
        #expect(NativeWritingDocumentDiagnostics.ageBucket(-1) == .clockMoved)
        #expect(NativeWritingDocumentDiagnostics.ageBucket(0.9) == .under1)
        #expect(NativeWritingDocumentDiagnostics.ageBucket(2.9) == .under3)
        #expect(NativeWritingDocumentDiagnostics.ageBucket(4.9) == .under5)
        #expect(NativeWritingDocumentDiagnostics.ageBucket(60_000) == .fivePlus)
    }

    @Test func registrationRequiresActuallyVerifiedCapabilitiesAndIsBounded() async throws {
        let broker = NativeWritingDocumentBroker()
        var request = registration()
        request.capabilities.activeWindow = false
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.register(request) }
        for index in 0..<8 { _ = try await broker.register(registration("doc-\(index)")) }
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.register(registration("ninth")) }
    }

    @Test func onlyOneFreshActiveDocumentCanBeObserved() async throws {
        let broker = NativeWritingDocumentBroker()
        let a = try await broker.register(registration("a")), b = try await broker.register(registration("b"))
        _ = try await broker.exchange(exchange(a.leaseID, state: state("a")))
        #expect(await broker.activeDocument()?.documentSessionID == "a")
        _ = try await broker.exchange(exchange(b.leaseID, state: state("b")))
        #expect(await broker.activeDocument() == nil)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueCaptureSelection(leaseID: a.leaseID) }
    }

    @Test func commandIsDeliveredOnlyOnceAndSequenceCannotReplay() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state()))
        let id = try await broker.enqueueCaptureSelection(leaseID: registration.leaseID)
        let response = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        #expect(response.commands.map(\.id) == [id])
        #expect(try await broker.exchange(exchange(registration.leaseID, sequence: 3)).commands.isEmpty)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.exchange(exchange(registration.leaseID, sequence: 3)) }
        #expect(await broker.activeDocument() == nil)
    }

    @Test func applyConsumesHandleAndUnknownDeliveryIsNeverRetried() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state(items: [item()])))
        let id = try await broker.enqueueApply(leaseID: registration.leaseID, handle: "opaque-handle-00001")
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: "opaque-handle-00001") }
        let response = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        #expect(response.commands.first?.action == .apply)
        try await broker.close(.init(version: 1, leaseID: registration.leaseID))
        #expect(await broker.takeResult(commandID: id)?.status == .indeterminate)
    }

    @Test func issueLookupRequiresUniqueFreshDocumentAndNeverReturnsConsumedHandles() async throws {
        let time = BrokerTestClock(), broker = NativeWritingDocumentBroker(clock: { time.now })
        let first = try await broker.register(registration())
        let value = item()
        _ = try await broker.exchange(exchange(first.leaseID, state: state(items: [value])))
        #expect(await broker.issue(leaseID: first.leaseID, handle: value.handle) == value)
        #expect(await broker.issue(leaseID: "other", handle: value.handle) == nil)
        _ = try await broker.enqueueIgnore(leaseID: first.leaseID, handle: value.handle)
        #expect(await broker.issue(leaseID: first.leaseID, handle: value.handle) == nil)
        var secondValue = value; secondValue.handle = "opaque-handle-00002"
        _ = try await broker.exchange(exchange(first.leaseID, sequence: 2, state: state(items: [secondValue])))
        #expect(await broker.issue(leaseID: first.leaseID, handle: secondValue.handle) == secondValue)
        let second = try await broker.register(registration("other-doc"))
        _ = try await broker.exchange(exchange(second.leaseID, state: state("other-doc")))
        #expect(await broker.issue(leaseID: first.leaseID, handle: secondValue.handle) == nil)
        try await broker.close(.init(version: 1, leaseID: second.leaseID))
        time.advance(5)
        #expect(await broker.issue(leaseID: first.leaseID, handle: secondValue.handle) == nil)
    }

    @Test func completedCaptureIsTypedAndSnapshotBelongsToRegisteredDocument() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state()))
        let id = try await broker.enqueueCaptureSelection(leaseID: registration.leaseID)
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        let result = NativeWritingDocumentResult(commandID: id, status: .completed, code: "captured", scope: scope(), prepared: nil)
        _ = try await broker.exchange(.init(version: 1, leaseID: registration.leaseID, sequence: 3, state: nil, result: result))
        #expect(await broker.takeResult(commandID: id)?.scope?.snapshots.first?.rawText == "The resuts agree.")
        #expect(await broker.takeResult(commandID: id) == nil)
    }

    @Test func forgedOrProtectedApplyItemsAndModelResultsInAutomaticStateAreRejected() async throws {
        for kind in 0..<4 {
            let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
            var value = item()
            if kind == 0 { value.envelope.issue.range.start = 0 }
            if kind == 1 { value.envelope.snapshot.snapshotHash = "forged" }
            if kind == 2 { value.envelope.issue.category = "grammar" }
            if kind == 3 { value.envelope.snapshot.protectedRanges = [.init(start: 4, length: 6)] }
            var data = state(items: [value]); data.scope?.snapshots = [value.envelope.snapshot]
            await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.exchange(exchange(registration.leaseID, state: data)) }
        }
    }

    @Test func protectedPreviewRetainsMarkButCanNeverApply() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        var value = item(); value.canApply = false; value.envelope.snapshot.protectedRanges = [.init(start: 4, length: 6)]
        var data = state(items: [value]); data.scope?.snapshots = [value.envelope.snapshot]
        _ = try await broker.exchange(exchange(registration.leaseID, state: data))
        #expect(await broker.activeDocument()?.state.issues.count == 1)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: value.handle) }
    }

    @Test func earlySpellingMarkCannotWriteUntilSameHandleIsProven() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        var early = item(); early.canApply = false; early.reason = "preparing"
        _ = try await broker.exchange(exchange(registration.leaseID, state: state(items: [early])))
        #expect(await broker.activeDocument()?.state.issues == [early])
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: early.handle) }
        let proven = item()
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2, state: state(items: [proven])))
        #expect(await broker.activeDocument()?.state.epoch == 1)
        #expect(await broker.activeDocument()?.state.issues == [proven])
        let command = try await broker.enqueueApply(leaseID: registration.leaseID, handle: early.handle)
        let delivered = try await broker.exchange(exchange(registration.leaseID, sequence: 3))
        #expect(delivered.commands.map(\.id) == [command])
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: early.handle) }
    }

    @Test func finalPreviewCannotBePromotedOrResetToPreparing() async throws {
        for reset in [false, true] {
            let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
            var early = item(); early.canApply = false; early.reason = "preparing"
            _ = try await broker.exchange(exchange(registration.leaseID, state: state(items: [early])))
            var preview = early; preview.reason = "protected"
            _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2, state: state(items: [preview])))
            await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: preview.handle) }
            let attempted = reset ? early : item()
            await #expect(throws: NativeWritingDocumentBrokerError.self) {
                try await broker.exchange(exchange(registration.leaseID, sequence: 3, state: state(items: [attempted])))
            }
            #expect(await broker.activeDocument() == nil)
        }
    }

    @Test func pendingEligibilityCannotChangeEnvelopeOrBypassProtectedRanges() async throws {
        for protected in [false, true] {
            let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
            var early = item(); early.canApply = false; early.reason = "preparing"
            if protected { early.envelope.snapshot.protectedRanges = [.init(start: 4, length: 6)] }
            var initial = state(items: [early]); initial.scope?.snapshots = [early.envelope.snapshot]
            _ = try await broker.exchange(exchange(registration.leaseID, state: initial))
            var changed = early; changed.canApply = true; changed.reason = ""
            if !protected { changed.envelope.issue.replacement = "outcomes" }
            var next = initial; next.issues = [changed]
            await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.exchange(exchange(registration.leaseID, sequence: 2, state: next)) }
        }
    }

    @Test func ignoredPendingMarkCannotBeResurrectedByLateEligibility() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        var early = item(); early.canApply = false; early.reason = "preparing"
        _ = try await broker.exchange(exchange(registration.leaseID, state: state(items: [early])))
        let ignored = try await broker.enqueueIgnore(leaseID: registration.leaseID, handle: early.handle)
        let response = try await broker.exchange(exchange(registration.leaseID, sequence: 2, state: state(items: [item()])))
        #expect(response.commands.map(\.id) == [ignored])
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: early.handle) }
    }

    @Test func preparingSentinelNeverAdvertisesAnApplicableItem() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        var invalid = item(); invalid.reason = "preparing"
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.exchange(exchange(registration.leaseID, state: state(items: [invalid]))) }
    }

    @Test func eligibilityCompletionCannotChangeTheEpochsWritingProfile() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        var early = item(); early.canApply = false; early.reason = "preparing"
        var initial = state(items: [early]); initial.profile = .init(spellingVariant: "en-US")
        _ = try await broker.exchange(exchange(registration.leaseID, state: initial))
        var changed = initial; changed.issues = [item()]; changed.profile = .init(spellingVariant: "en-GB")
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.exchange(exchange(registration.leaseID, sequence: 2, state: changed)) }
    }

    @Test func epochChangeInvalidatesPreparedHandlesAndPendingCommands() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state(items: [item()])))
        let id = try await broker.enqueueCaptureSelection(leaseID: registration.leaseID)
        var next = state(); next.epoch = 2
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2, state: next))
        #expect(await broker.takeResult(commandID: id)?.status == .expired)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: "opaque-handle-00001") }
    }

    @Test func malformedScopeResultAndOversizedPayloadFailClosed() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        var invalid = state(); invalid.scope?.snapshots[0].documentSessionID = "other"
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.exchange(exchange(registration.leaseID, state: invalid)) }
        #expect(await broker.activeDocument() == nil)
    }

    @Test func leaseAndUnacknowledgedCommandExpireDespiteHeartbeat() async throws {
        let time = BrokerTestClock(), broker = NativeWritingDocumentBroker(clock: { time.now })
        let registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state()))
        let id = try await broker.enqueueCaptureSelection(leaseID: registration.leaseID)
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        time.advance(4)
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 3))
        time.advance(4)
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 4))
        time.advance(2)
        #expect(await broker.takeResult(commandID: id)?.status == .expired)
        #expect(await broker.activeDocument() == nil)
        let next = try await broker.register(self.registration("new"))
        _ = try await broker.exchange(exchange(next.leaseID, state: state("new")))
        time.advance(5)
        #expect(await broker.activeDocument() == nil)
    }

    @Test func preparedResultMatchesRequestedIssueAndIsConsumable() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state()))
        var issue = item().envelope.issue; issue.category = "grammar"
        let id = try await broker.enqueuePrepareSuggestions(leaseID: registration.leaseID, snapshotRequestID: "request", issues: [issue])
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        var prepared = item(); prepared.envelope.issue = issue; prepared.handle = "prepared-handle-01"
        let result = NativeWritingDocumentResult(commandID: id, status: .completed, code: "prepared", scope: nil, prepared: [prepared])
        _ = try await broker.exchange(.init(version: 1, leaseID: registration.leaseID, sequence: 3, state: nil, result: result))
        #expect(await broker.takeResult(commandID: id)?.prepared?.first?.handle == prepared.handle)
        #expect(try await broker.enqueueApply(leaseID: registration.leaseID, handle: prepared.handle).isEmpty == false)
    }

    @Test func successfulApplyAcknowledgementSurvivesSameExchangeEpochAdvance() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state(items: [item()])))
        let id = try await broker.enqueueApply(leaseID: registration.leaseID, handle: "opaque-handle-00001")
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        var next = state(); next.epoch = 2
        let result = NativeWritingDocumentResult(commandID: id, status: .completed, code: "applied", scope: nil, prepared: nil)
        _ = try await broker.exchange(.init(version: 1, leaseID: registration.leaseID, sequence: 3, state: next, result: result))
        #expect(await broker.takeResult(commandID: id)?.status == .completed)
        #expect(await broker.activeDocument()?.state.epoch == 2)
    }

    @Test func shutdownRevokesDocumentsAndPendingNativeRequests() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state()))
        let id = try await broker.enqueueCaptureSelection(leaseID: registration.leaseID)
        await broker.shutdown()
        #expect(await broker.activeDocument() == nil)
        #expect(await broker.takeResult(commandID: id)?.status == .expired)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.register(self.registration("new")) }
    }

    @Test func preparedResultCannotSubstituteAnotherModelIssue() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state()))
        let id = try await broker.enqueuePrepareSuggestions(leaseID: registration.leaseID, snapshotRequestID: "request", issues: [item().envelope.issue])
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        var forged = item(); forged.envelope.issue.replacement = "outcomes"
        let result = NativeWritingDocumentResult(commandID: id, status: .completed, code: "prepared", scope: nil, prepared: [forged])
        await #expect(throws: NativeWritingDocumentBrokerError.self) {
            try await broker.exchange(.init(version: 1, leaseID: registration.leaseID, sequence: 3, state: nil, result: result))
        }
        #expect(await broker.activeDocument() == nil)
    }

    @Test func stablePassageHandleRemainsUsableWhileLeaseIsFresh() async throws {
        let time = BrokerTestClock(), broker = NativeWritingDocumentBroker(clock: { time.now })
        let registration = try await broker.register(registration())
        let data = state(items: [item()])
        _ = try await broker.exchange(exchange(registration.leaseID, state: data))
        for sequence in 2...9 {
            time.advance(4)
            _ = try await broker.exchange(exchange(registration.leaseID, sequence: sequence, state: data))
        }
        #expect(try await broker.enqueueApply(leaseID: registration.leaseID, handle: "opaque-handle-00001").isEmpty == false)
    }

    @Test func reviewOnlyContextCanBePreparedButCannotBecomeWritable() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        _ = try await broker.exchange(exchange(registration.leaseID, state: state()))
        var value = item(); value.envelope.issue.category = "context"
        value.envelope.issue.replacement = value.envelope.issue.original
        value.canApply = false
        let id = try await broker.enqueuePrepareSuggestions(leaseID: registration.leaseID, snapshotRequestID: "request", issues: [value.envelope.issue])
        _ = try await broker.exchange(exchange(registration.leaseID, sequence: 2))
        let result = NativeWritingDocumentResult(commandID: id, status: .completed, code: "prepared", scope: nil, prepared: [value])
        _ = try await broker.exchange(.init(version: 1, leaseID: registration.leaseID, sequence: 3, state: nil, result: result))
        #expect(await broker.takeResult(commandID: id)?.prepared?.first?.canApply == false)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: registration.leaseID, handle: value.handle) }
    }

    @Test func activeProfilePreservesBritishSpellingAndBoundsCustomTerms() async throws {
        let broker = NativeWritingDocumentBroker(), registration = try await broker.register(registration())
        var data = state(); data.profile = .init(spellingVariant: "en-GB", style: "clarity", customTerms: ["TNF"])
        _ = try await broker.exchange(exchange(registration.leaseID, state: data))
        #expect(await broker.activeDocument()?.state.profile?.spellingVariant == "en-GB")
        data.profile?.customTerms = Array(repeating: "term", count: 129)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.exchange(exchange(registration.leaseID, sequence: 2, state: data)) }
        #expect(await broker.activeDocument() == nil)
    }

    @Test func idleLongPollTimesOutWithCapabilityAfterOneBoundedWait() async throws {
        let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
        let start = ProcessInfo.processInfo.systemUptime
        let response = try await broker.exchange(exchange(lease.leaseID, state: state()), waitForCommands: true)
        let elapsed = ProcessInfo.processInfo.systemUptime - start
        #expect(response.commands.isEmpty)
        #expect(elapsed >= 0.9 && elapsed < 2.5)
        #expect(try idleCapability(response) == 1000)
    }

    @Test func enqueueLongPollWakesImmediatelyAndDeliversExactlyOnce() async throws {
        let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
        _ = try await broker.exchange(exchange(lease.leaseID, state: state()))
        let pending = try await waitingPoll(broker, lease: lease.leaseID)
        let start = ProcessInfo.processInfo.systemUptime
        let id = try await broker.enqueueCaptureSelection(leaseID: lease.leaseID)
        let response = try await pending.value
        #expect(response.commands.map(\.id) == [id])
        #expect(ProcessInfo.processInfo.systemUptime - start < 0.5)
        #expect(try idleCapability(response) == 1000)
        #expect(try await broker.exchange(exchange(lease.leaseID, sequence: 3)).commands.isEmpty)
    }

    @Test func ambiguousActiveLongPollWakesWithoutCapabilityOrStaleCommand() async throws {
        let broker = NativeWritingDocumentBroker(), a = try await broker.register(registration()), b = try await broker.register(registration("other"))
        _ = try await broker.exchange(exchange(a.leaseID, state: state()))
        let pending = try await waitingPoll(broker, lease: a.leaseID)
        _ = try await broker.exchange(exchange(b.leaseID, state: state("other")))
        let response = try await pending.value
        #expect(response.commands.isEmpty)
        #expect(try idleCapability(response) == nil)
        #expect(await broker.activeDocument() == nil)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueCaptureSelection(leaseID: a.leaseID) }
    }

    @Test func concurrentSequenceOrEpochLongPollRevokesBothRequests() async throws {
        for sequence in [2, 3] {
            let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
            _ = try await broker.exchange(exchange(lease.leaseID, state: state()))
            let pending = try await waitingPoll(broker, lease: lease.leaseID)
            var next = state(); next.epoch = 3
            await #expect(throws: NativeWritingDocumentBrokerError.self) {
                try await broker.exchange(exchange(lease.leaseID, sequence: sequence, state: next), waitForCommands: true)
            }
            await #expect(throws: NativeWritingDocumentBrokerError.self) { try await pending.value }
            #expect(await broker.activeDocument() == nil)
        }
    }

    @Test func closeShutdownAndReregisterLongPollClearWaitersWithoutDelivery() async throws {
        for operation in 0..<3 {
            let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
            _ = try await broker.exchange(exchange(lease.leaseID, state: state()))
            let pending = try await waitingPoll(broker, lease: lease.leaseID)
            if operation == 0 { try await broker.close(.init(version: 1, leaseID: lease.leaseID)) }
            if operation == 1 { await broker.shutdown() }
            if operation == 2 { _ = try await broker.register(registration()) }
            await #expect(throws: NativeWritingDocumentBrokerError.self) { try await pending.value }
            await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueCaptureSelection(leaseID: lease.leaseID) }
        }
    }

    @Test func cancellationLongPollRevokesLeaseAndCannotDeliverAnApplyLater() async throws {
        let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
        _ = try await broker.exchange(exchange(lease.leaseID, state: state(items: [item()])))
        let pending = try await waitingPoll(broker, lease: lease.leaseID, items: [item()])
        pending.cancel()
        await #expect(throws: CancellationError.self) { try await pending.value }
        #expect(await broker.activeDocument() == nil)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await broker.enqueueApply(leaseID: lease.leaseID, handle: "opaque-handle-00001") }
    }

    @Test func leaseExpiryLongPollDoesNotRenewItsFiveSecondDeadline() async throws {
        let time = BrokerTestClock(), broker = NativeWritingDocumentBroker(clock: { time.now }), lease = try await broker.register(registration())
        _ = try await broker.exchange(exchange(lease.leaseID, state: state()))
        let pending = try await waitingPoll(broker, lease: lease.leaseID)
        time.advance(5)
        #expect(await broker.activeDocument() == nil)
        await #expect(throws: NativeWritingDocumentBrokerError.self) { try await pending.value }
    }

    @Test func resultAndDeliveredHeartbeatLongPollReturnImmediatelyWithoutCapability() async throws {
        let broker = NativeWritingDocumentBroker(), lease = try await broker.register(registration())
        _ = try await broker.exchange(exchange(lease.leaseID, state: state()))
        let id = try await broker.enqueueCaptureSelection(leaseID: lease.leaseID)
        _ = try await broker.exchange(exchange(lease.leaseID, sequence: 2))
        let start = ProcessInfo.processInfo.systemUptime
        let heartbeat = try await broker.exchange(exchange(lease.leaseID, sequence: 3), waitForCommands: true)
        let result = NativeWritingDocumentResult(commandID: id, status: .completed, code: "captured", scope: scope(), prepared: nil)
        let ack = try await broker.exchange(.init(version: 1, leaseID: lease.leaseID, sequence: 4, state: nil, result: result), waitForCommands: true)
        #expect(ProcessInfo.processInfo.systemUptime - start < 0.5)
        #expect(try idleCapability(heartbeat) == nil)
        #expect(try idleCapability(ack) == nil)
        #expect(await broker.takeResult(commandID: id)?.status == .completed)
    }

    private func waitingPoll(_ broker: NativeWritingDocumentBroker, lease: String, items: [NativeWritingDocumentIssue] = []) async throws -> Task<NativeWritingDocumentExchangeResponse, Error> {
        var next = state(items: items); next.epoch = 2
        let request = exchange(lease, sequence: 2, state: next)
        let pending = Task { try await broker.exchange(request, waitForCommands: true) }
        for _ in 0..<200 {
            if await broker.activeDocument()?.state.epoch == 2 { return pending }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        pending.cancel()
        Issue.record("The pending exchange did not publish its accepted epoch")
        return pending
    }
    private func idleCapability(_ response: NativeWritingDocumentExchangeResponse) throws -> Int? {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
        return object?["idleWaitMilliseconds"] as? Int
    }

    private func registration(_ id: String = "doc") -> NativeWritingDocumentRegistration {
        .init(version: 1, documentSessionID: id, capabilities: .init(sharedRuntime: true, activeWindow: true, hiddenRuntime: true, safeReplace: true))
    }
    private func scope(_ doc: String = "doc") -> CapturedScope {
        .init(scope: .selection, pageIndices: [], snapshots: [.init(requestID: "request", documentSessionID: doc, blockID: "block", revision: "1", rawText: "The resuts agree.", scope: .selection)])
    }
    private func item() -> NativeWritingDocumentIssue {
        .init(handle: "opaque-handle-00001", envelope: .init(snapshot: scope().snapshots[0], issue: .init(id: "issue", category: "spelling", original: "resuts", replacement: "results", reason: "Spelling", range: .init(start: 4, length: 6), requiresAuthorConfirmation: false)), canApply: true, reason: "")
    }
    private func state(_ doc: String = "doc", items: [NativeWritingDocumentIssue] = []) -> NativeWritingDocumentState {
        .init(epoch: 1, active: true, visibility: .hidden, status: .ready, scope: scope(doc), issues: items, errorCode: nil)
    }
    private func exchange(_ id: String, sequence: Int = 1, state: NativeWritingDocumentState? = nil) -> NativeWritingDocumentExchange {
        .init(version: 1, leaseID: id, sequence: sequence, state: state, result: nil)
    }
}

private final class BrokerTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 100
    var now: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ delta: TimeInterval) { lock.lock(); defer { lock.unlock() }; value += delta }
}

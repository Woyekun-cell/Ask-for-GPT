import Foundation
import Testing
@testable import AskGPTCore

struct WritingServiceTests {
    @Test func spellingNeverCreatesRemoteSessionAndMergesDefaultTerms() async throws {
        let backend = WritingBackendFixture()
        let service = WritingService(skill: try writingTestSkill(), spellProvider: FixedWritingSpellProvider(findings: [.init(range: .init(start: 0, length: 3), replacement: "Ran")]), backend: backend)
        let result = try await service.check(writingSnapshot("RNA-seq"), mode: .spelling, profile: .init())
        #expect(result.status == .completed && result.issues.isEmpty)
        #expect(result.skillVersion == "local-1")
        #expect(await backend.instructions.isEmpty)
        #expect(await backend.shutdownCount == 0)
        await service.shutdown()
    }

    @Test func newRevisionCancelsOlderRequestAndWaitsForCleanupBeforeNextSession() async throws {
        let backend = WritingBackendFixture(holdFirst: true)
        let service = WritingService(skill: try writingTestSkill(), spellProvider: FixedWritingSpellProvider(), backend: backend)
        let first = Task { try await service.check(writingSnapshot("Older text", requestID: "old"), mode: .polish, profile: .init()) }
        await backend.waitForFirstSend()
        let second = try await service.check(writingSnapshot("Newer text", requestID: "new", revision: "2"), mode: .polish, profile: .init())
        #expect(try await first.value.status == .stale)
        #expect(second.status == .completed && second.requestID == "new")
        let events = await backend.events
        let released = try #require(events.firstIndex(of: "release-writing-1"))
        let started = try #require(events.firstIndex(of: "start-2"))
        #expect(released < started)
        await service.shutdown()
    }

    @Test func cancelWaitsForCleanupAndReturnsCancelledWithoutPartialIssues() async throws {
        let backend = WritingBackendFixture(holdFirst: true)
        let service = WritingService(skill: try writingTestSkill(), spellProvider: FixedWritingSpellProvider(), backend: backend)
        let task = Task { try await service.check(writingSnapshot("Cancel text"), mode: .polish, profile: .init()) }
        await backend.waitForFirstSend()
        await service.cancel(requestID: "request-1")
        let result = try await task.value
        #expect(result.status == .cancelled && result.issues.isEmpty)
        #expect(await backend.released == ["writing-1"])
        #expect(await backend.cleanupCancelled == [false])
        await service.shutdown()
    }

    @Test func shutdownCancelsPendingWorkAndRejectsNewWork() async throws {
        let backend = WritingBackendFixture(holdFirst: true)
        let service = WritingService(skill: try writingTestSkill(), spellProvider: FixedWritingSpellProvider(), backend: backend)
        let task = Task { try await service.check(writingSnapshot("Shutdown text"), mode: .polish, profile: .init()) }
        await backend.waitForFirstSend()
        await service.shutdown()
        #expect(try await task.value.status == .cancelled)
        do { _ = try await service.check(writingSnapshot("New text"), mode: .polish, profile: .init()); Issue.record("Shutdown service reused") }
        catch { #expect(error is WritingServiceError) }
    }

    @Test func sameSnapshotLocalModeDoesNotWaitForOrCancelHealthyPolishWithSameRequestID() async throws {
        let backend = WritingBackendFixture(holdFirst: true)
        let service = WritingService(skill: try writingTestSkill(), spellProvider: FixedWritingSpellProvider(), backend: backend)
        let snapshot = writingSnapshot("Identical text", requestID: "shared")
        let polish = Task { try await service.check(snapshot, mode: .polish, profile: .init()) }
        await backend.waitForFirstSend()
        let local = try await service.check(snapshot, mode: .spelling, profile: .init())
        #expect(local.status == .completed && local.skillVersion == "local-1")
        #expect(await backend.released.isEmpty)
        await service.cancel(requestID: "shared")
        #expect(try await polish.value.status == .cancelled)
        await service.shutdown()
    }

    @Test func invalidEmptyArraySnapshotStillFailsPreflight() async throws {
        let service = WritingService(skill: try writingTestSkill(), spellProvider: FixedWritingSpellProvider(), backend: WritingBackendFixture())
        var snapshot = writingSnapshot("clean")
        snapshot.contextBefore = String(repeating: "a", count: 2001)
        snapshot.contextHash = WritingSnapshot.hash(contextBefore: snapshot.contextBefore, contextAfter: "")
        do { _ = try await service.check(snapshot, mode: .spelling, profile: .init()); Issue.record("Oversized input accepted") }
        catch { #expect(error is WritingServiceError) }
        await service.shutdown()
    }
}

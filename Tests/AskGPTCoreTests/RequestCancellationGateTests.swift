import Foundation
import Testing
@testable import AskGPTCore

@MainActor struct RequestCancellationGateTests {
    @Test func immediateCancellationBeforeFirstTaskRunsDoesNotCreateWaitCycle() async {
        let gate = RequestCancellationGate()
        let state = TransitionTrace()
        let old = Task { @MainActor in
            await gate.settle()
            guard !Task.isCancelled else { return }
            state.entries.append("old-started")
        }
        gate.cancel(task: old) {}
        let waiting = Task { @MainActor in await gate.settle(); state.entries.append("settled") }
        try? await Task.sleep(nanoseconds: 150_000_000)
        #expect(state.entries.contains("settled"))
        #expect(!state.entries.contains("old-started"))
        waiting.cancel()
    }

    @Test func newRequestWaitsForCancelledTaskCleanup() async {
        let gate = RequestCancellationGate()
        let state = TransitionTrace()
        let old = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch {}
            await uncancellableCleanupDelay()
            state.entries.append("old-finished")
        }
        await Task.yield()
        gate.cancel(task: old) { state.entries.append("interrupt") }
        await gate.settle()
        state.entries.append("new-started")
        #expect(state.entries.last == "new-started")
        #expect(state.entries.contains("interrupt"))
        #expect(state.entries.firstIndex(of: "old-finished")! < state.entries.firstIndex(of: "new-started")!)
    }

    @Test func rapidReplacementsDoNotSkipEarlierCancellation() async {
        let gate = RequestCancellationGate()
        let state = TransitionTrace()
        let first = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch {}
            await uncancellableCleanupDelay()
            state.entries.append("first-finished")
        }
        await Task.yield()
        gate.cancel(task: first) { state.entries.append("first-interrupt") }
        let second = Task { @MainActor in
            await gate.settle()
            guard !Task.isCancelled else { state.entries.append("second-cancelled"); return }
            state.entries.append("second-started")
        }
        await Task.yield()
        gate.cancel(task: second) { state.entries.append("second-interrupt") }
        await gate.settle()
        #expect(!state.entries.contains("second-started"))
        #expect(state.entries.first == "first-interrupt")
        #expect(state.entries.contains("second-cancelled"))
    }
}

@MainActor private final class TransitionTrace { var entries: [String] = [] }

private func uncancellableCleanupDelay() async {
    await withCheckedContinuation { continuation in
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { continuation.resume() }
    }
}

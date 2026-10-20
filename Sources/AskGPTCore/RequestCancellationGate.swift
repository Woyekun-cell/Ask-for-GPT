import Foundation

/// Serializes cancellation cleanup before a single-turn backend is reused.
@MainActor public final class RequestCancellationGate {
    private var pending: Task<Void, Never>?
    public init() {}

    public func cancel(task: Task<Void, Never>?, interrupt: @escaping @MainActor () async -> Void) {
        let previous = pending
        task?.cancel()
        pending = Task {
            await previous?.value
            await interrupt()
            await task?.value
        }
    }

    public func settle() async {
        // A task canceled before it first runs must not wait on a newer barrier
        // which is already waiting for that task to finish.
        guard !Task.isCancelled else { return }
        let current = pending
        await current?.value
    }
}

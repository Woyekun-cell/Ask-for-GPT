import Foundation
import Dispatch
import Darwin

/// The private PDF helper must release its independently grouped CLI before it
/// exits. Signal callbacks run while the main JSONL loop is awaiting a model.
public final class TranslationHelperLifecycle: @unchecked Sendable {
    private let lock = NSLock()
    private let parentPID: pid_t
    private let cleanup: @Sendable () async -> Void
    private var signals: [DispatchSourceSignal] = []
    private var parentTimer: DispatchSourceTimer?
    private var cleanupTask: Task<Void, Never>?
    private var exitRequested = false

    public init(cleanup: @escaping @Sendable () async -> Void) {
        parentPID = getppid()
        self.cleanup = cleanup
    }

    public var isShuttingDown: Bool {
        lock.lock(); defer { lock.unlock() }
        return cleanupTask != nil
    }

    public func start() {
        lock.lock(); defer { lock.unlock() }
        guard signals.isEmpty, parentTimer == nil, cleanupTask == nil else { return }
        // Broken response pipes must not bypass awaited CLI cleanup.
        signal(SIGPIPE, SIG_IGN)
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            source.setEventHandler { [weak self] in _ = self?.beginShutdown(exiting: true) }
            signals.append(source)
            source.resume()
        }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            guard let self, getppid() != self.parentPID else { return }
            _ = self.beginShutdown(exiting: true)
        }
        parentTimer = timer
        timer.resume()
    }

    private func beginShutdown(exiting: Bool) -> Task<Void, Never> {
        lock.lock(); defer { lock.unlock() }
        exitRequested = exitRequested || exiting
        if let cleanupTask { return cleanupTask }
        let task = Task.detached { [self] in
            await cleanup()
            if shouldExitAfterCleanup() { Darwin.exit(EXIT_SUCCESS) }
        }
        cleanupTask = task
        return task
    }

    private func shouldExitAfterCleanup() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return exitRequested
    }

    /// Normal EOF and external termination join the same cleanup operation.
    /// This prevents a second shutdown from exiting while the first still owns
    /// an asynchronous TERM-to-KILL grace period.
    public func shutdownAndWait() async {
        await beginShutdown(exiting: false).value
        stopMonitoring()
    }

    private func stopMonitoring() {
        lock.lock(); let savedSignals = signals; signals = []
        let savedTimer = parentTimer; parentTimer = nil; lock.unlock()
        for source in savedSignals { source.cancel() }
        savedTimer?.cancel()
    }

    deinit { stopMonitoring() }
}

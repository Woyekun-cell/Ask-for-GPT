import AppKit

/// A selection is publishable only after two consecutive equal samples; coordinates do not define identity.
struct StableSelectionGate {
    private var pendingIdentity: String?
    private var lastEmittedIdentity: String?

    mutating func observe(_ selection: CapturedSelection?) -> CapturedSelection? {
        guard let selection else {
            reset()
            return nil
        }
        let identity = selection.excerpt.identity
        guard identity != lastEmittedIdentity else {
            pendingIdentity = nil
            return nil
        }
        guard identity == pendingIdentity else {
            pendingIdentity = identity
            return nil
        }
        pendingIdentity = nil
        lastEmittedIdentity = identity
        return selection
    }

    mutating func beginGesture() { pendingIdentity = nil }

    mutating func reset() {
        pendingIdentity = nil
        lastEmittedIdentity = nil
    }
}

@MainActor
public final class SelectionWatcher {
    private let capture: SelectionCapture
    private let onSelection: (CapturedSelection) -> Void
    private var monitor: Any?
    private var pendingTask: Task<Void, Never>?
    private var gate = StableSelectionGate()
    private var generation: UInt64 = 0

    public init(capture: SelectionCapture, onSelection: @escaping (CapturedSelection) -> Void) {
        self.capture = capture
        self.onSelection = onSelection
    }

    public func start() {
        guard monitor == nil else { return }
        gate.reset()
        generation &+= 1
        let currentGeneration = generation
        // Only mouse-up in other applications is observed; there is no keyboard or clipboard listener.
        monitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.generation == currentGeneration else { return }
                self.selectionGestureEnded()
            }
        }
    }

    public func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        pendingTask?.cancel()
        pendingTask = nil
        gate.reset()
        generation &+= 1
    }

    private func selectionGestureEnded() {
        guard monitor != nil else { return }
        pendingTask?.cancel()
        // Defer the first sample by one main-actor turn so the source app can update its selection.
        pendingTask = Task { @MainActor [weak self] in
            await Task.yield()
            guard let self, self.monitor != nil, !Task.isCancelled else { return }
            // An interrupted gesture cannot supply one of the next gesture's two stable samples.
            self.gate.beginGesture()
            _ = self.gate.observe(self.capture.capture())
            for _ in 0..<2 {
                do { try await Task.sleep(nanoseconds: 500_000_000) }
                catch { return }
                guard self.monitor != nil, !Task.isCancelled else { return }
                if let selected = self.gate.observe(self.capture.capture()) {
                    self.onSelection(selected)
                    return
                }
            }
        }
    }

    deinit {
        pendingTask?.cancel()
        if let monitor { NSEvent.removeMonitor(monitor) }
    }
}

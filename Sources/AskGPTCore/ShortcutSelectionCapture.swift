import AppKit
import ApplicationServices
import Carbon

enum ShortcutSelectionPolicy {
    private static let pdfApplications: Set<String> = [
        "org.zotero.zotero", "com.apple.Preview", "com.adobe.Reader", "com.adobe.Acrobat.Pro"
    ]
    static func permitsCopyFallback(bundleID: String?, trusted: Bool, secureInput: Bool) -> Bool {
        guard let bundleID else { return false }
        return pdfApplications.contains(bundleID) && trusted && !secureInput
    }

    static func isPlainCopy(identifier: String?) -> Bool { identifier == "copy:" }
}

struct ShortcutPasteboardSnapshot: Equatable {
    struct Item: Equatable {
        let types: [String]
        let data: [String: Data]
    }
    let items: [Item]
}

/// Pure ownership rules: never accept the old clipboard or restore over a newer write.
struct ShortcutPasteboardTransaction {
    let original: ShortcutPasteboardSnapshot
    let initialChangeCount: Int
    private(set) var copyChangeCount: Int?
    private(set) var superseded = false

    mutating func observe(changeCount: Int, plainText: String?) -> String? {
        guard !superseded, changeCount != initialChangeCount else { return nil }
        if let copyChangeCount, changeCount != copyChangeCount {
            superseded = true
            return nil
        }
        copyChangeCount = changeCount
        return plainText.flatMap(SelectionPolicy.normalizedText)
    }

    func snapshotToRestore(currentChangeCount: Int) -> ShortcutPasteboardSnapshot? {
        guard !superseded, let copyChangeCount, currentChangeCount == copyChangeCount else { return nil }
        return original
    }
}

@MainActor private final class ShortcutCaptureCoordinator {
    static let shared = ShortcutCaptureCoordinator()
    private var active: Task<CapturedSelection?, Never>?
    private var generation = UUID()

    func run(_ operation: @escaping @MainActor () async -> CapturedSelection?) async -> CapturedSelection? {
        let earlier = active
        earlier?.cancel()
        let ticket = UUID()
        generation = ticket
        let task = Task { @MainActor in
            _ = await earlier?.value
            guard !Task.isCancelled else { return nil as CapturedSelection? }
            return await operation()
        }
        active = task
        let result = await withTaskCancellationHandler {
            await task.value
        } onCancel: { task.cancel() }
        if generation == ticket { active = nil }
        return Task.isCancelled ? nil : result
    }
}

extension SelectionCapture {
    /// Explicit user shortcuts only. Background selection watching must keep using capture().
    public func captureForShortcut() async -> CapturedSelection? {
        guard !Task.isCancelled else { return nil }
        if let selected = capture() { return selected }
        guard let source = NSWorkspace.shared.frontmostApplication,
              ShortcutSelectionPolicy.permitsCopyFallback(bundleID: source.bundleIdentifier,
                trusted: isTrusted, secureInput: IsSecureEventInputEnabled()),
              !Task.isCancelled else { return nil }
        return await ShortcutCaptureCoordinator.shared.run {
            await PDFShortcutCopy(source: source).capture()
        }
    }
}

@MainActor private struct PDFShortcutCopy {
    let source: NSRunningApplication
    private let pasteboard = NSPasteboard.general
    init(source: NSRunningApplication) { self.source = source }

    func capture() async -> CapturedSelection? {
        let application = AXUIElementCreateApplication(source.processIdentifier)
        guard let focus = element(application, kAXFocusedUIElementAttribute),
              contextIsCurrent(application: application, focus: focus),
              !secureFocus(focus), !Task.isCancelled else { return nil }
        let initialCount = pasteboard.changeCount
        guard let snapshot = snapshot(), pasteboard.changeCount == initialCount,
              contextIsCurrent(application: application, focus: focus), !Task.isCancelled else { return nil }
        var transaction = ShortcutPasteboardTransaction(original: snapshot, initialChangeCount: initialCount)
        defer {
            if let original = transaction.snapshotToRestore(currentChangeCount: pasteboard.changeCount) {
                restore(original)
            }
        }

        let copy = copyMenuItem(application)
        guard contextIsCurrent(application: application, focus: focus),
              pasteboard.changeCount == initialCount, !Task.isCancelled else { return nil }
        switch copy {
        case .disabled: return nil
        case .item(let item):
            guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { return nil }
        case .unavailable:
            guard sendCopyShortcut() else { return nil }
        }
        // Claim a synchronous menu write before the first suspension/cancellation point.
        _ = transaction.observe(changeCount: pasteboard.changeCount, plainText: nil)

        let deadline = ProcessInfo.processInfo.systemUptime + 0.4
        while ProcessInfo.processInfo.systemUptime < deadline {
            guard !Task.isCancelled, contextIsCurrent(application: application, focus: focus) else { return nil }
            let count = pasteboard.changeCount
            if let text = transaction.observe(changeCount: count, plainText: pasteboard.string(forType: .string)) {
                guard pasteboard.changeCount == count,
                      contextIsCurrent(application: application, focus: focus), !Task.isCancelled else { return nil }
                return CapturedSelection(excerpt: SelectedExcerpt(text: text,
                    sourceBundleID: source.bundleIdentifier ?? "pid:\(source.processIdentifier)",
                    sourceName: source.localizedName ?? "PDF 阅读器"))
            }
            if transaction.superseded { return nil }
            do { try await Task.sleep(nanoseconds: 10_000_000) }
            catch { return nil }
        }
        return nil
    }

    private func contextIsCurrent(application: AXUIElement, focus: AXUIElement) -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == source.processIdentifier,
              !IsSecureEventInputEnabled(), AXIsProcessTrusted(),
              let current = element(application, kAXFocusedUIElementAttribute), CFEqual(current, focus),
              !secureFocus(current) else { return false }
        return true
    }

    private func secureFocus(_ focused: AXUIElement) -> Bool {
        var current: AXUIElement? = focused
        for _ in 0..<8 {
            guard let item = current else { return false }
            guard let role = value(item, kAXRoleAttribute) as? String else { return true }
            if SelectionPolicy.isSecureInput(role: role, subrole: value(item, kAXSubroleAttribute) as? String) { return true }
            current = element(item, kAXParentAttribute)
        }
        return false
    }

    private enum CopyMenu { case item(AXUIElement), disabled, unavailable }
    private func copyMenuItem(_ application: AXUIElement) -> CopyMenu {
        guard let menu = element(application, kAXMenuBarAttribute) else { return .unavailable }
        var queue = [(menu, 0)], offset = 0
        let deadline = ProcessInfo.processInfo.systemUptime + 0.25
        while offset < queue.count, offset < 120, ProcessInfo.processInfo.systemUptime < deadline {
            let (item, depth) = queue[offset]; offset += 1
            let identifier = value(item, kAXIdentifierAttribute) as? String
            if ShortcutSelectionPolicy.isPlainCopy(identifier: identifier) {
                return (value(item, kAXEnabledAttribute) as? Bool) == true ? .item(item) : .disabled
            }
            if depth < 4, let children = value(item, kAXChildrenAttribute) as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(120 - offset).map { ($0, depth + 1) })
            }
        }
        // Prefer the standard copy: action. Never guess a citation/export menu command.
        return .unavailable
    }

    private func sendCopyShortcut() -> Bool {
        guard let eventSource = CGEventSource(stateID: .combinedSessionState),
              let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 8, keyDown: true),
              let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 8, keyDown: false) else { return false }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.postToPid(source.processIdentifier); up.postToPid(source.processIdentifier)
        return true
    }

    private func value(_ item: AXUIElement, _ attribute: String) -> CFTypeRef? {
        _ = AXUIElementSetMessagingTimeout(item, 0.03)
        var output: CFTypeRef?
        guard AXUIElementCopyAttributeValue(item, attribute as CFString, &output) == .success else { return nil }
        return output
    }

    private func element(_ item: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let result = value(item, attribute), CFGetTypeID(result) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(result, to: AXUIElement.self)
    }

    private func snapshot() -> ShortcutPasteboardSnapshot? {
        var result: [ShortcutPasteboardSnapshot.Item] = []
        for item in pasteboard.pasteboardItems ?? [] {
            var data: [String: Data] = [:]
            for type in item.types {
                guard let value = item.data(forType: type) else { return nil }
                data[type.rawValue] = value
            }
            result.append(.init(types: item.types.map(\.rawValue), data: data))
        }
        return .init(items: result)
    }

    private func restore(_ snapshot: ShortcutPasteboardSnapshot) {
        let items = snapshot.items.map { saved in
            let item = NSPasteboardItem()
            for type in saved.types {
                if let data = saved.data[type] { item.setData(data, forType: .init(type)) }
            }
            return item
        }
        pasteboard.clearContents()
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }
}

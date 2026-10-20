import AppKit
import ApplicationServices
import Carbon
import os

public struct CapturedSelection: Equatable {
    public let excerpt: SelectedExcerpt
    /// Accessibility global coordinates, with the origin at the primary screen's top left.
    public let anchor: CGRect?

    public init(excerpt: SelectedExcerpt, anchor: CGRect? = nil) {
        self.excerpt = excerpt
        self.anchor = anchor
    }
}

enum SelectionPolicy {
    static func normalizedText(_ raw: String) -> String? {
        let text = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    static func shouldIgnoreSource(bundleID: String, ownBundleID: String?) -> Bool {
        bundleID == ownBundleID || bundleID == "com.izual.Easydict" || bundleID.hasPrefix("com.izual.Easydict.")
    }

    static func isSecureInput(role: String?, subrole: String?) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }
}

struct AXResolvedSelectionText: Equatable {
    enum Source: Equatable { case nativeText, nativeRange, textMarker }
    let text: String
    let source: Source
}

// Each callback can read only a selection. There is deliberately no whole-value
// or document-text fallback when an application exposes no selected range.
enum AXSelectionTextResolver {
    static func resolve(nativeText: () throws -> String?, rangeText: () throws -> String?,
        markerText: () throws -> String?) -> AXResolvedSelectionText? {
        if let raw = try? nativeText(), let text = SelectionPolicy.normalizedText(raw) {
            return AXResolvedSelectionText(text: text, source: .nativeText)
        }
        if let raw = try? rangeText(), let text = SelectionPolicy.normalizedText(raw) {
            return AXResolvedSelectionText(text: text, source: .nativeRange)
        }
        if let raw = try? markerText(), let text = SelectionPolicy.normalizedText(raw) {
            return AXResolvedSelectionText(text: text, source: .textMarker)
        }
        return nil
    }
}

// Depth-first traversal reaches nested reader documents before enumerating all
// page siblings. Runtime AX deadlines remain enforced by the caller.
enum AXSelectionTraversal {
    static func find<Element, Selection>(roots: [Element], equals: (Element, Element) -> Bool,
        isExpired: () -> Bool, isSecure: (Element) -> Bool,
        selection: (Element) -> Selection?, children: (Element) -> [Element]) -> Selection? {
        var stack = roots.reversed().map { ($0, 0) }
        var visited: [Element] = []
        while let (current, depth) = stack.popLast(), visited.count < 128, !isExpired() {
            guard !visited.contains(where: { equals($0, current) }) else { continue }
            visited.append(current)
            guard !isSecure(current) else { continue }
            if let selected = selection(current) { return selected }
            guard depth < 16 else { continue }
            stack.append(contentsOf: children(current).prefix(128 - visited.count).reversed().map { ($0, depth + 1) })
        }
        return nil
    }
}

/// Captures only the foreground application's selected text. It never copies or reads the clipboard.
@MainActor
public final class SelectionCapture {
    private let diagnostic = Logger(subsystem: "local.askgpt.reader", category: "selection")
    public init() {}

    public var isTrusted: Bool { AXIsProcessTrusted() }

    public func requestPermission() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    public func capture() -> CapturedSelection? {
        guard isTrusted else { diagnostic.debug("Capture rejected: permission"); return nil }
        guard !IsSecureEventInputEnabled() else { diagnostic.debug("Capture rejected: secure input"); return nil }
        // A floating window may retain keyWindow while another app is foreground.
        // The actual foreground PID below determines the only readable source.
        guard let source = NSWorkspace.shared.frontmostApplication,
              source.processIdentifier != ProcessInfo.processInfo.processIdentifier else {
            diagnostic.debug("Capture rejected: own or absent foreground app"); return nil
        }
        let bundleID = source.bundleIdentifier ?? "pid:\(source.processIdentifier)"
        guard !SelectionPolicy.shouldIgnoreSource(bundleID: bundleID, ownBundleID: Bundle.main.bundleIdentifier) else { return nil }

        let reader = AXSelectionReader()
        let application = AXUIElementCreateApplication(source.processIdentifier)
        let focused = reader.element(application, kAXFocusedUIElementAttribute)
        let focusedWindow = reader.element(application, kAXFocusedWindowAttribute)
        guard let ancestors = reader.ancestors(from: focused) else { return nil }

        // A PDF selection need not move keyboard focus to its text leaf. Hit
        // testing the pointer's source-app element gives its inner web area
        // without walking through every page or annotation in the window.
        var pointerAncestors: [AXUIElement] = []
        if bundleID == "org.zotero.zotero", let focusedWindow,
           let top = NSScreen.screens.first?.frame.maxY {
            let mouse = NSEvent.mouseLocation
            if let hit = reader.element(at: CGPoint(x: mouse.x, y: top - mouse.y), in: application) {
                guard let path = reader.ancestors(from: hit) else { return nil }
                let hitWindow = reader.element(hit, kAXWindowAttribute)
                if path.contains(where: { CFEqual($0, focusedWindow) }) ||
                    hitWindow.map({ CFEqual($0, focusedWindow) }) == true {
                    pointerAncestors = path
                }
            }
        }

        // Inner web areas come first, so nested PDF.js selection is read before
        // any outer reader document without scanning the whole page.
        for element in reader.prioritized(pointerAncestors + ancestors) {
            if let selection = reader.selection(element) {
                return result(selection, source: source, bundleID: bundleID)
            }
        }
        var roots: [AXUIElement] = []
        if let focused { roots.append(focused) }
        if let focusedWindow { roots.append(focusedWindow) }
        if let selection = reader.search(roots: roots) {
            return result(selection, source: source, bundleID: bundleID)
        }
        diagnostic.debug("Capture found no exposed selection")
        return nil
    }

    private func result(_ selection: (text: String, anchor: CGRect?), source: NSRunningApplication, bundleID: String) -> CapturedSelection? {
        // Discard an AX result if the foreground app changed while its tree was being queried.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == source.processIdentifier else { return nil }
        diagnostic.debug("Capture accepted")
        return CapturedSelection(
            excerpt: SelectedExcerpt(text: selection.text, sourceBundleID: bundleID, sourceName: source.localizedName ?? "当前应用"),
            anchor: selection.anchor
        )
    }
}

private final class AXSelectionReader {
    private let deadline = ProcessInfo.processInfo.systemUptime + 0.25
    private struct Metadata { let element: AXUIElement; let role: String?; let subrole: String? }
    private var metadata: [Metadata] = []
    var isExpired: Bool { ProcessInfo.processInfo.systemUptime >= deadline }

    private func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        guard prepare(element) else { return nil }
        var output: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &output) == .success else { return nil }
        return output
    }

    private func parameterizedValue(_ element: AXUIElement, _ attribute: String, parameter: CFTypeRef) -> CFTypeRef? {
        guard prepare(element) else { return nil }
        var output: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, attribute as CFString, parameter, &output) == .success else { return nil }
        return output
    }

    private func prepare(_ element: AXUIElement) -> Bool {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { return false }
        _ = AXUIElementSetMessagingTimeout(element, Float(min(remaining, 0.05)))
        return true
    }

    func element(_ parent: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let output = value(parent, attribute), CFGetTypeID(output) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(output, to: AXUIElement.self)
    }

    func element(at point: CGPoint, in application: AXUIElement) -> AXUIElement? {
        guard prepare(application) else { return nil }
        var found: AXUIElement?
        guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &found) == .success,
              let found else { return nil }
        var expectedPID: pid_t = 0, foundPID: pid_t = 0
        guard AXUIElementGetPid(application, &expectedPID) == .success,
              AXUIElementGetPid(found, &foundPID) == .success, foundPID == expectedPID else { return nil }
        return found
    }

    func ancestors(from element: AXUIElement?) -> [AXUIElement]? {
        var path: [AXUIElement] = []
        var current = element
        for _ in 0..<12 {
            guard let element = current, !isExpired else { break }
            if isSecure(element) { return nil }
            path.append(element)
            current = self.element(element, kAXParentAttribute)
        }
        return path
    }

    private func attributes(_ element: AXUIElement) -> Metadata {
        if let cached = metadata.first(where: { CFEqual($0.element, element) }) { return cached }
        var values: CFArray?
        let result: Metadata
        // One IPC for both security and traversal metadata. Missing attributes
        // are returned as null/error entries and never become document content.
        if prepare(element),
           AXUIElementCopyMultipleAttributeValues(element,
               [kAXRoleAttribute, kAXSubroleAttribute] as CFArray,
               AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
           let entries = values as? [Any], entries.count == 2 {
            result = Metadata(element: element, role: entries[0] as? String,
                subrole: entries[1] as? String)
        } else {
            result = Metadata(element: element, role: value(element, kAXRoleAttribute) as? String,
                subrole: value(element, kAXSubroleAttribute) as? String)
        }
        metadata.append(result)
        return result
    }

    func prioritized(_ elements: [AXUIElement]) -> [AXUIElement] {
        var unique: [(element: AXUIElement, rank: Int, offset: Int)] = []
        for element in elements where !isExpired {
            guard !unique.contains(where: { CFEqual($0.element, element) }) else { continue }
            let role = attributes(element).role
            let rank: Int
            switch role {
            case "AXWebArea": rank = 0
            case "AXScrollArea", "AXSplitGroup", "AXGroup", "AXLayoutArea": rank = 1
            default: rank = 2
            }
            unique.append((element, rank, unique.count))
        }
        return unique.sorted { $0.rank == $1.rank ? $0.offset < $1.offset : $0.rank < $1.rank }.map(\.element)
    }

    func isSecure(_ element: AXUIElement) -> Bool {
        let attributes = attributes(element)
        return SelectionPolicy.isSecureInput(role: attributes.role, subrole: attributes.subrole)
    }

    func selection(_ element: AXUIElement) -> (text: String, anchor: CGRect?)? {
        guard !isExpired, !isSecure(element) else { return nil }
        var rangeValue: CFTypeRef?
        var markerRange: CFTypeRef?
        let selected = AXSelectionTextResolver.resolve(nativeText: {
            self.value(element, kAXSelectedTextAttribute) as? String
        }, rangeText: {
            rangeValue = self.value(element, kAXSelectedTextRangeAttribute)
            if let rangeValue, CFGetTypeID(rangeValue) == AXValueGetTypeID() {
                let range = unsafeBitCast(rangeValue, to: AXValue.self)
                var selectedRange = CFRange()
                if AXValueGetType(range) == .cfRange,
                   AXValueGetValue(range, .cfRange, &selectedRange), selectedRange.length > 0 {
                    return self.parameterizedValue(element, kAXStringForRangeParameterizedAttribute, parameter: range) as? String
                }
            }
            return nil
        }, markerText: {
            markerRange = self.value(element, "AXSelectedTextMarkerRange")
            guard let markerRange else { return nil }
            return self.parameterizedValue(element, "AXStringForTextMarkerRange", parameter: markerRange) as? String
        })
        guard let selected else { return nil }
        let anchor: CGRect?
        if selected.source == .textMarker, let markerRange {
            anchor = bounds(element, attribute: "AXBoundsForTextMarkerRange", range: markerRange)
        } else {
            if rangeValue == nil { rangeValue = value(element, kAXSelectedTextRangeAttribute) }
            anchor = rangeValue.flatMap { bounds(element, attribute: kAXBoundsForRangeParameterizedAttribute, range: $0) }
        }
        return (selected.text, anchor)
    }

    private func bounds(_ element: AXUIElement, attribute: String, range: CFTypeRef) -> CGRect? {
        guard let bounds = parameterizedValue(element, attribute, parameter: range),
              CFGetTypeID(bounds) == AXValueGetTypeID() else { return nil }
        let value = unsafeBitCast(bounds, to: AXValue.self)
        var rect = CGRect.zero
        if AXValueGetType(value) == .cgRect, AXValueGetValue(value, .cgRect, &rect),
           rect.origin.x.isFinite, rect.origin.y.isFinite, rect.width.isFinite, rect.height.isFinite,
           rect.width > 0, rect.height > 0 { return rect }
        return nil
    }

    func search(roots: [AXUIElement]) -> (text: String, anchor: CGRect?)? {
        AXSelectionTraversal.find(roots: roots, equals: { CFEqual($0, $1) }, isExpired: { self.isExpired },
            isSecure: { self.isSecure($0) }, selection: { self.selection($0) }, children: { element in
                var priority: [AXUIElement] = []
                if let focused = self.element(element, kAXFocusedUIElementAttribute) { priority.append(focused) }
                priority.append(contentsOf: (self.value(element, kAXSelectedChildrenAttribute) as? [AXUIElement]) ?? [])
                let visible = (self.value(element, kAXVisibleChildrenAttribute) as? [AXUIElement]) ?? []
                let children = visible.isEmpty ? ((self.value(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []) : visible
                return priority + self.prioritized(Array(children.prefix(128)))
            })
    }
}

import AppKit
import ApplicationServices
import Carbon
import Foundation

/// Only the caller holds source text. Diagnostics deliberately contain no text or document metadata.
public struct WordInlineProbeInput: Sendable {
    public let expectedParagraph: String
    public let issueStartUTF16: Int
    public let issueLengthUTF16: Int
    public let original: String
    public init(expectedParagraph: String, issueStartUTF16: Int, issueLengthUTF16: Int, original: String) {
        self.expectedParagraph = expectedParagraph; self.issueStartUTF16 = issueStartUTF16
        self.issueLengthUTF16 = issueLengthUTF16; self.original = original
    }
}

enum WordInlineGeometryFailure: String, Error {
    case invalidBatch = "invalid_batch", viewportChanged = "viewport_changed"
    case invalidInput = "invalid_input", invalidRange = "invalid_utf16_range", originalMismatch = "original_mismatch"
    case tooLong = "text_too_long", ambiguous = "ambiguous_visible_match", noMatch = "paragraph_not_found"
    case invalidBounds = "invalid_bounds", offscreen = "offscreen_or_clipped", multiline = "multiline_or_unverifiable"
}
struct WordInlineRangeMatch: Equatable { let paragraph: NSRange; let issue: NSRange }
struct WordInlineViewportStamp: Equatable {
    let sourceHash: String
    let visibleRange: NSRange?
    let clip: CGRect
    let windowFrame: CGRect
}
struct WordInlineChildrenPlan: Equatable {
    enum Source { case visible, all }
    let source: Source?
    let count: Int
    let complete: Bool
}
enum WordInlineGeometryPolicy {
    /// Candidate-local failures never count as evidence for that item. A shared
    /// source/viewport barrier must still succeed before any subset can escape.
    @MainActor static func verifiedBatchSubset<Candidate, Proof>(_ candidates: [Candidate],
        prove: (Candidate) throws -> Proof, finalBarrier: () async throws -> Void) async throws -> [Proof] {
        var verified: [Proof] = []
        for candidate in candidates {
            try Task.checkCancellation()
            // The complete AX traversal and all input validation precede this
            // loop. Stop only candidate proofs; the shared barrier still runs.
            if verified.count == WordInlineGeometry.maximumMarkerCount { break }
            do { verified.append(try prove(candidate)) }
            catch let error as WordInlineGeometryFailure where [.ambiguous, .noMatch, .offscreen, .multiline, .invalidBounds].contains(error) { continue }
            catch let error as WordInlineProbeFailure where ["bounds_unavailable", "single_line_unverifiable"].contains(error.code) { continue }
        }
        try await finalBarrier()
        try Task.checkCancellation()
        return verified
    }
    static func batchGroups(_ items: [WordInlineBatchItem]) throws -> [[Int]] {
        guard !items.isEmpty, items.count <= WordInlineGeometry.maximumCandidateCount, Set(items.map(\.id)).count == items.count,
              items.allSatisfy({ !$0.id.isEmpty && $0.id.utf8.count <= 128 && $0.id.utf8.allSatisfy {
                  (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,58,95].contains($0)
              } }) else { throw WordInlineGeometryFailure.invalidBatch }
        var keys: [Data] = [], groups: [[Int]] = []
        for (index, item) in items.enumerated() {
            try validate(item.input)
            let key = Data(item.input.expectedParagraph.utf8)
            if let existing = keys.firstIndex(of: key) { groups[existing].append(index) }
            else { keys.append(key); groups.append([index]) }
        }
        return groups
    }
    static func requireSameViewport(_ initial: WordInlineViewportStamp, _ current: WordInlineViewportStamp) throws {
        guard initial == current else { throw WordInlineGeometryFailure.viewportChanged }
    }
    static func leafTextIsUnverified(characterCount: Int?, actualChildCount: Int?, inLayout: Bool) -> Bool {
        inLayout && actualChildCount == 0 && characterCount != 0
    }
    static func childrenPlan(visibleCount: Int?, visibleUnavailable: Bool, actualChildCount: Int?, childAttributesDeclared: Bool?) -> WordInlineChildrenPlan {
        if let visibleCount {
            guard visibleCount >= 0, actualChildCount.map({ $0 >= visibleCount }) != false else { return .init(source: nil, count: 0, complete: false) }
            return .init(source: .visible, count: visibleCount, complete: true)
        }
        guard visibleUnavailable else { return .init(source: nil, count: 0, complete: false) }
        if let actualChildCount { return .init(source: .all, count: actualChildCount, complete: true) }
        return .init(source: nil, count: 0, complete: childAttributesDeclared == false)
    }
    static func canReadLayoutLeaf(characterCount: Int?, actualChildCount: Int?, inLayout: Bool, hasFrame: Bool) -> Bool {
        inLayout && hasFrame && actualChildCount == 0 && characterCount.map { $0 >= 0 && $0 <= 16000 } == true
    }
    static func permitsRole(_ role: String?, subrole: String?) -> Bool {
        role != nil && !SelectionPolicy.isSecureInput(role: role, subrole: subrole)
    }
    static func validate(_ input: WordInlineProbeInput) throws {
        let count = input.expectedParagraph.utf16.count
        guard count > 0 else { throw WordInlineGeometryFailure.invalidInput }
        guard count <= 4000, input.original.utf16.count <= 256 else { throw WordInlineGeometryFailure.tooLong }
        let (end, overflow) = input.issueStartUTF16.addingReportingOverflow(input.issueLengthUTF16)
        let boundaries = WritingSnapshotPreflight.graphemeBoundaries(input.expectedParagraph)
        guard !overflow, input.issueStartUTF16 >= 0, input.issueLengthUTF16 > 0, end <= count,
              boundaries.contains(input.issueStartUTF16), boundaries.contains(end) else { throw WordInlineGeometryFailure.invalidRange }
        let original = (input.expectedParagraph as NSString).substring(with: NSRange(location: input.issueStartUTF16, length: input.issueLengthUTF16))
        guard original.utf8.elementsEqual(input.original.utf8) else { throw WordInlineGeometryFailure.originalMismatch }
        guard !input.original.unicodeScalars.contains(where: { CharacterSet.newlines.contains($0) }) else { throw WordInlineGeometryFailure.multiline }
    }
    static func matches(_ input: WordInlineProbeInput, in fragment: String, baseUTF16: Int) throws -> [WordInlineRangeMatch] {
        try validate(input)
        let text = fragment as NSString
        guard text.length <= 16000 else { throw WordInlineGeometryFailure.tooLong }
        let (_, overflow) = baseUTF16.addingReportingOverflow(text.length)
        guard baseUTF16 >= 0, !overflow else { throw WordInlineGeometryFailure.invalidRange }
        var boundaries: Set<Int>?
        var result: [WordInlineRangeMatch] = [], cursor = 0
        while cursor < text.length {
            let range = text.range(of: input.expectedParagraph, options: .literal, range: NSRange(location: cursor, length: text.length - cursor))
            guard range.location != NSNotFound else { break }
            // Absent paragraphs need no fragment segmentation. Matching groups
            // still validate every exact source boundary before any AX proof.
            if boundaries == nil { boundaries = WritingSnapshotPreflight.graphemeBoundaries(fragment) }
            guard boundaries?.contains(range.location) == true, boundaries?.contains(range.location + range.length) == true else { throw WordInlineGeometryFailure.invalidRange }
            result.append(WordInlineRangeMatch(paragraph: NSRange(location: baseUTF16 + range.location, length: range.length),
                issue: NSRange(location: baseUTF16 + range.location + input.issueStartUTF16, length: input.issueLengthUTF16)))
            cursor = range.location + 1 // Count overlapping occurrences; never guess which duplicate is intended.
        }
        return result
    }
    static func validateBounds(_ bounds: CGRect, graphemeBounds: [CGRect], clip: CGRect, screens: [CGRect]) throws {
        guard validRect(bounds), validRect(clip), graphemeBounds.allSatisfy(validRect) else { throw WordInlineGeometryFailure.invalidBounds }
        guard clip.contains(bounds), screens.contains(where: { validRect($0) && $0.contains(bounds) }) else { throw WordInlineGeometryFailure.offscreen }
        guard let first = graphemeBounds.first else { throw WordInlineGeometryFailure.multiline }
        guard graphemeBounds.allSatisfy({ abs($0.minY - first.minY) <= 1 && abs($0.maxY - first.maxY) <= 1 }) else { throw WordInlineGeometryFailure.multiline }
        let union = graphemeBounds.dropFirst().reduce(first) { $0.union($1) }
        guard abs(union.minX - bounds.minX) <= 1, abs(union.maxX - bounds.maxX) <= 1,
              abs(union.minY - bounds.minY) <= 1, abs(union.maxY - bounds.maxY) <= 1 else { throw WordInlineGeometryFailure.multiline }
    }
    static func validRect(_ rect: CGRect) -> Bool {
        [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height].allSatisfy(\.isFinite) && rect.size.width > 0 && rect.size.height > 0 && !rect.isNull && !rect.isInfinite
    }
    static func requireUniqueMatch(_ count: Int) throws {
        guard count > 0 else { throw WordInlineGeometryFailure.noMatch }
        guard count == 1 else { throw WordInlineGeometryFailure.ambiguous }
    }
}

public struct WordInlineProbeFormat: Encodable, Sendable {
    public internal(set) var textVerified = false
    public internal(set) var fontUniform: Bool?
    public internal(set) var sizeUniform: Bool?
    public internal(set) var traitsUniform: Bool?
    public internal(set) var allAttributesUniform: Bool?
    public internal(set) var attributeKeys: [String] = []
    public internal(set) var unknownAttributeKeyCount = 0
}
enum WordInlineFormatInspection {
    private struct Font { let name: String; let size: Double; let traits: UInt32? }
    static func inspect(_ text: NSAttributedString, original: String) -> WordInlineProbeFormat {
        var result = WordInlineProbeFormat()
        guard text.length > 0, text.string.utf8.elementsEqual(original.utf8) else { return result }
        result.textVerified = true
        let known: Set<String> = [NSAttributedString.Key.font.rawValue, NSAttributedString.Key.foregroundColor.rawValue,
            NSAttributedString.Key.backgroundColor.rawValue, NSAttributedString.Key.underlineStyle.rawValue,
            NSAttributedString.Key.strikethroughStyle.rawValue, kAXFontTextAttribute.takeUnretainedValue() as String,
            kAXForegroundColorTextAttribute.takeUnretainedValue() as String, kAXBackgroundColorTextAttribute.takeUnretainedValue() as String,
            kAXUnderlineTextAttribute.takeUnretainedValue() as String, kAXStrikethroughTextAttribute.takeUnretainedValue() as String,
            kAXMisspelledTextAttribute.takeUnretainedValue() as String, kAXMarkedMisspelledTextAttribute.takeUnretainedValue() as String]
        var keys: Set<String> = [], unknown: Set<String> = [], first: [NSAttributedString.Key: Any]?
        var fonts: [Font] = [], missingFont = false, equal = true
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, _, _ in
            for key in attributes.keys {
                if known.contains(key.rawValue) { keys.insert(key.rawValue) } else { unknown.insert(key.rawValue) }
            }
            if let first { equal = equal && NSDictionary(dictionary: first).isEqual(to: attributes) }
            else { first = attributes }
            if let font = attributes[.font] as? NSFont {
                fonts.append(Font(name: font.fontName, size: Double(font.pointSize), traits: font.fontDescriptor.symbolicTraits.rawValue))
            } else if let font = attributes[NSAttributedString.Key(kAXFontTextAttribute.takeUnretainedValue() as String)] as? [String: Any],
                      let name = font[kAXFontNameKey.takeUnretainedValue() as String] as? String,
                      let size = font[kAXFontSizeKey.takeUnretainedValue() as String] as? NSNumber, size.doubleValue.isFinite, size.doubleValue > 0 {
                fonts.append(Font(name: name, size: size.doubleValue, traits: NSFont(name: name, size: CGFloat(size.doubleValue))?.fontDescriptor.symbolicTraits.rawValue))
            } else { missingFont = true }
        }
        result.attributeKeys = keys.sorted(); result.unknownAttributeKeyCount = unknown.count; result.allAttributesUniform = equal
        if !missingFont, let first = fonts.first {
            result.fontUniform = fonts.allSatisfy { $0.name == first.name }
            result.sizeUniform = fonts.allSatisfy { $0.size == first.size }
            if fonts.allSatisfy({ $0.traits != nil }) { result.traitsUniform = fonts.allSatisfy { $0.traits == first.traits } }
        }
        return result
    }
}

public struct WordInlineProbeRect: Encodable, Equatable, Sendable {
    public let x: Double, y: Double, width: Double, height: Double
    init(_ rect: CGRect) { x = Double(rect.minX); y = Double(rect.minY); width = Double(rect.width); height = Double(rect.height) }
}
public struct WordInlineBatchItem: Sendable {
    public let id: String
    public let input: WordInlineProbeInput
    public init(id: String, input: WordInlineProbeInput) { self.id = id; self.input = input }
}
public struct WordInlineBatchMarker: Encodable, Sendable {
    public let id: String
    public let bounds: WordInlineProbeRect
}
public struct WordInlineBatchResult: Encodable, Sendable {
    public internal(set) var status = "rejected"
    public internal(set) var errorCode: String?
    public internal(set) var markers: [WordInlineBatchMarker] = []
    public internal(set) var elapsedMilliseconds: Double = 0
}
public struct WordInlineProbeNodeDiagnostic: Encodable, Sendable {
    public internal(set) var role: String
    public internal(set) var depth: Int
    public internal(set) var attributes: [String] = []
    public internal(set) var parameterizedAttributes: [String] = []
    public internal(set) var characterCount: Int?
    public internal(set) var readUTF16Count: Int?
    public internal(set) var textSource: String?
    public internal(set) var matchCount = 0
    public internal(set) var selectedTextSettable: Bool?
    public internal(set) var selectedTextRangeSettable: Bool?
    public internal(set) var errorCode: String?
    public internal(set) var axError: Int?
}
public struct WordInlineProbeDiagnostic: Encodable, Sendable {
    public internal(set) var status = "rejected"
    public internal(set) var errorCode: String?
    public internal(set) var axError: Int?
    public internal(set) var trusted = false
    public internal(set) var frontmostWord = false
    public internal(set) var visitedNodeCount = 0
    public internal(set) var traversalComplete = false
    public internal(set) var matchCount = 0
    public internal(set) var duplicateRectangleCount = 0
    public internal(set) var paragraphVerified: Bool?
    public internal(set) var originalVerified: Bool?
    public internal(set) var singleLineVerified: Bool?
    public internal(set) var selectionUnchanged: Bool?
    public internal(set) var environmentUnchanged: Bool?
    public internal(set) var bounds: WordInlineProbeRect?
    public internal(set) var format: WordInlineProbeFormat?
    public internal(set) var attributedStringSupported: Bool?
    public internal(set) var formatReadError: String?
    public internal(set) var elapsedMilliseconds: Double = 0
    public internal(set) var nodes: [WordInlineProbeNodeDiagnostic] = []
}

/// Read-only capability probe. This never requests permission, changes a selection, or creates an overlay.
@MainActor public enum WordInlineGeometry {
    nonisolated public static let maximumCandidateCount = 128
    nonisolated public static let maximumMarkerCount = 8

    public static func probeBatch(_ items: [WordInlineBatchItem]) async -> WordInlineBatchResult {
        // The controller must hide old marks before calling and compare its generation after this await.
        // Keep AppKit/AX state on its existing actor; these yields let queued invalidations run.
        await Task.yield()
        let start = ProcessInfo.processInfo.systemUptime
        var result = WordInlineBatchResult(), diagnostic = WordInlineProbeDiagnostic()
        diagnostic.trusted = AXIsProcessTrusted()
        guard diagnostic.trusted else { result.errorCode = "untrusted"; result.elapsedMilliseconds = (ProcessInfo.processInfo.systemUptime - start) * 1000; return result }
        let reader = WordInlineAXReader(start: start)
        var prepared: [WordInlineBatchMarker] = []
        do {
            try Task.checkCancellation()
            let groups = try WordInlineGeometryPolicy.batchGroups(items)
            try reader.perform(items[0].input, diagnostic: &diagnostic, diagnosticDetails: false, captureOnly: true)
            prepared = try await reader.prepareBatch(items, groups: groups)
        } catch let error as WordInlineGeometryFailure { diagnostic.errorCode = error.rawValue }
        catch let error as WordInlineProbeFailure { diagnostic.errorCode = error.code }
        catch is CancellationError { diagnostic.errorCode = "cancelled" }
        catch { diagnostic.errorCode = "probe_failed" }
        reader.verifyUnchanged(diagnostic: &diagnostic)
        result.elapsedMilliseconds = (ProcessInfo.processInfo.systemUptime - start) * 1000
        if diagnostic.errorCode == nil, diagnostic.selectionUnchanged == true, diagnostic.environmentUnchanged == true,
           !prepared.isEmpty, !Task.isCancelled {
            result.status = "geometry_verified"; result.markers = prepared
        } else { result.errorCode = diagnostic.errorCode ?? (Task.isCancelled ? "cancelled" : prepared.isEmpty ? "no_verified_candidates" : "batch_unverifiable") }
        return result
    }
    public static func probe(_ input: WordInlineProbeInput) -> WordInlineProbeDiagnostic {
        let start = ProcessInfo.processInfo.systemUptime
        var result = WordInlineProbeDiagnostic()
        result.trusted = AXIsProcessTrusted()
        guard result.trusted else { result.errorCode = "untrusted"; result.elapsedMilliseconds = (ProcessInfo.processInfo.systemUptime - start) * 1000; return result }
        let reader = WordInlineAXReader(start: start)
        do { try reader.perform(input, diagnostic: &result) }
        catch let error as WordInlineGeometryFailure { result.errorCode = error.rawValue }
        catch let error as WordInlineProbeFailure { result.errorCode = error.code; result.axError = error.axError }
        catch { result.errorCode = "probe_failed" }
        reader.verifyUnchanged(diagnostic: &result)
        result.elapsedMilliseconds = (ProcessInfo.processInfo.systemUptime - start) * 1000
        if result.errorCode == nil, result.selectionUnchanged == true, result.environmentUnchanged == true { result.status = "geometry_verified" }
        return result
    }
}

private struct WordInlineProbeFailure: Error {
    let code: String
    let axError: Int?
    init(_ code: String, _ axError: Int? = nil) { self.code = code; self.axError = axError }
}

@MainActor private final class WordInlineAXReader {
    private struct Selection: Equatable { let range: NSRange; let hash: String }
    private struct Match { let element: AXUIElement; let mapping: WordInlineRangeMatch; let clip: CGRect; let nodeIndex: Int }
    private struct FrameStamp { let element: AXUIElement; let rect: CGRect }
    private enum TextSource { case visible(NSRange), leaf(count: Int, shared: NSRange?) }
    private struct Container {
        let element: AXUIElement; let fragment: String; let base: Int; let clip: CGRect
        let frames: [FrameStamp]; let source: TextSource; let characterCount: Int?; let nodeIndex: Int
    }
    private struct PreparedRange { let element: AXUIElement; let range: NSRange; let bounds: CGRect }
    private let deadline: TimeInterval
    private var lastAXError: Int?
    private var application: AXUIElement?
    private var window: AXUIElement?
    private var focused: AXUIElement?
    private var selectionElement: AXUIElement?
    private var baseline: Selection?
    private var pid: pid_t?
    private var initialWindowFrame: CGRect?
    private var containers: [Container] = []
    private var preparedRanges: [PreparedRange] = []
    private let knownAttributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXValueAttribute, kAXNumberOfCharactersAttribute, kAXChildrenAttribute, kAXVisibleChildrenAttribute,
        kAXVisibleCharacterRangeAttribute, kAXSharedCharacterRangeAttribute, kAXSelectedTextAttribute, kAXSelectedTextRangeAttribute]
    private let knownParameters = [kAXStringForRangeParameterizedAttribute, kAXBoundsForRangeParameterizedAttribute,
        kAXAttributedStringForRangeParameterizedAttribute, kAXLineForIndexParameterizedAttribute, kAXRangeForLineParameterizedAttribute]
    init(start: TimeInterval) { deadline = start + 0.25 }
    private var expired: Bool { ProcessInfo.processInfo.systemUptime >= deadline }

    private func prepare(_ element: AXUIElement) -> Bool {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { lastAXError = nil; return false }
        _ = AXUIElementSetMessagingTimeout(element, Float(min(remaining, 0.05)))
        return true
    }
    private func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        guard prepare(element) else { return nil }
        var result: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, name as CFString, &result)
        lastAXError = error == .success ? nil : Int(error.rawValue)
        return error == .success ? result : nil
    }
    private func parameter(_ element: AXUIElement, _ name: String, range: NSRange) -> CFTypeRef? {
        guard prepare(element) else { return nil }
        var range = CFRange(location: range.location, length: range.length)
        guard let argument = AXValueCreate(.cfRange, &range) else { return nil }
        var result: CFTypeRef?
        let error = AXUIElementCopyParameterizedAttributeValue(element, name as CFString, argument, &result)
        lastAXError = error == .success ? nil : Int(error.rawValue)
        return error == .success ? result : nil
    }
    private func element(_ parent: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = value(parent, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    private func range(_ output: CFTypeRef?) -> NSRange? {
        guard let output, CFGetTypeID(output) == AXValueGetTypeID() else { return nil }
        let ax = unsafeBitCast(output, to: AXValue.self); var range = CFRange()
        guard AXValueGetType(ax) == .cfRange, AXValueGetValue(ax, .cfRange, &range), range.location >= 0, range.length >= 0,
              !range.location.addingReportingOverflow(range.length).overflow else { return nil }
        return NSRange(location: range.location, length: range.length)
    }
    private func rect(_ output: CFTypeRef?) -> CGRect? {
        guard let output, CFGetTypeID(output) == AXValueGetTypeID() else { return nil }
        let ax = unsafeBitCast(output, to: AXValue.self); var rect = CGRect.zero
        guard AXValueGetType(ax) == .cgRect, AXValueGetValue(ax, .cgRect, &rect), WordInlineGeometryPolicy.validRect(rect) else { return nil }
        return rect
    }
    private func frame(_ element: AXUIElement) -> CGRect? {
        guard let position = value(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = value(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        let p = unsafeBitCast(position, to: AXValue.self), s = unsafeBitCast(size, to: AXValue.self)
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetType(p) == .cgPoint, AXValueGetValue(p, .cgPoint, &point), AXValueGetType(s) == .cgSize, AXValueGetValue(s, .cgSize, &dimensions) else { return nil }
        let result = CGRect(origin: point, size: dimensions)
        return WordInlineGeometryPolicy.validRect(result) ? result : nil
    }
    private func selection(_ element: AXUIElement) -> Selection? {
        guard let selectedRange = range(value(element, kAXSelectedTextRangeAttribute)), selectedRange.length <= 4000 else { return nil }
        let text: String
        if selectedRange.length == 0 { text = "" }
        else if let selected = value(element, kAXSelectedTextAttribute) as? String, selected.utf16.count == selectedRange.length { text = selected }
        else if let selected = parameter(element, kAXStringForRangeParameterizedAttribute, range: selectedRange) as? String,
                selected.utf16.count == selectedRange.length { text = selected }
        else { return nil }
        return Selection(range: selectedRange, hash: WritingSnapshot.hash(rawText: text))
    }
    private func attributeNames(_ element: AXUIElement, parameterized: Bool) -> [String] {
        guard prepare(element) else { return [] }
        var names: CFArray?
        let error = parameterized ? AXUIElementCopyParameterizedAttributeNames(element, &names) : AXUIElementCopyAttributeNames(element, &names)
        lastAXError = error == .success ? nil : Int(error.rawValue)
        let allowlist = parameterized ? knownParameters : knownAttributes
        return ((names as? [String]) ?? []).filter { allowlist.contains($0) }.sorted()
    }
    private func settable(_ element: AXUIElement, _ name: String) -> Bool? {
        guard prepare(element) else { return nil }
        var answer = DarwinBoolean(false)
        let error = AXUIElementIsAttributeSettable(element, name as CFString, &answer)
        lastAXError = error == .success ? nil : Int(error.rawValue)
        return error == .success ? answer.boolValue : nil
    }
    private func children(_ parent: AXUIElement, remaining: Int) -> (items: [AXUIElement], count: Int, actualChildCount: Int?, complete: Bool) {
        func count(_ name: String) -> (value: Int?, unavailable: Bool) {
            guard prepare(parent) else { return (nil, false) }
            var count: CFIndex = 0
            let error = AXUIElementGetAttributeValueCount(parent, name as CFString, &count)
            lastAXError = error == .success ? nil : Int(error.rawValue)
            return (error == .success && count >= 0 ? count : nil, error == .attributeUnsupported || error == .noValue)
        }
        let visible = count(kAXVisibleChildrenAttribute), actual = count(kAXChildrenAttribute)
        var declared: Bool?
        if visible.value == nil, visible.unavailable, actual.value == nil, actual.unavailable {
            let names = attributeNames(parent, parameterized: false)
            if !expired, lastAXError == nil { declared = names.contains(kAXChildrenAttribute) || names.contains(kAXVisibleChildrenAttribute) }
        }
        let plan = WordInlineGeometryPolicy.childrenPlan(visibleCount: visible.value, visibleUnavailable: visible.unavailable,
            actualChildCount: actual.value, childAttributesDeclared: declared)
        guard plan.complete, let source = plan.source, plan.count > 0 else { return ([], plan.count, actual.value, plan.complete) }
        guard prepare(parent), remaining > 0 else { return ([], plan.count, actual.value, false) }
        var result: CFArray?
        let requested = min(plan.count, remaining)
        let error = AXUIElementCopyAttributeValues(parent, (source == .visible ? kAXVisibleChildrenAttribute : kAXChildrenAttribute) as CFString, 0, requested, &result)
        lastAXError = error == .success ? nil : Int(error.rawValue)
        guard error == .success, let children = result as? [AXUIElement], children.count == requested else { return ([], plan.count, actual.value, false) }
        return (children, plan.count, actual.value, true)
    }
    private func failure(_ code: String) -> WordInlineProbeFailure { WordInlineProbeFailure(expired ? "deadline_exceeded" : code, lastAXError) }

    func perform(_ input: WordInlineProbeInput, diagnostic: inout WordInlineProbeDiagnostic, diagnosticDetails: Bool = true, captureOnly: Bool = false) throws {
        guard !IsSecureEventInputEnabled() else { throw failure("secure_input") }
        guard let source = NSWorkspace.shared.frontmostApplication, source.bundleIdentifier == "com.microsoft.Word" else { throw failure("foreground_not_word") }
        diagnostic.frontmostWord = true; pid = source.processIdentifier
        try WordInlineGeometryPolicy.validate(input)
        let application = AXUIElementCreateApplication(source.processIdentifier); self.application = application
        guard let window = element(application, kAXFocusedWindowAttribute), let windowFrame = frame(window),
              (value(window, kAXMinimizedAttribute) as? Bool) != true,
              let focused = element(application, kAXFocusedUIElementAttribute) else { throw failure("document_window_unavailable") }
        self.window = window; self.focused = focused; initialWindowFrame = windowFrame
        var current: AXUIElement? = focused
        for _ in 0..<12 {
            guard let node = current, !expired else { break }
            guard WordInlineGeometryPolicy.permitsRole(value(node, kAXRoleAttribute) as? String,
                subrole: value(node, kAXSubroleAttribute) as? String) else { throw failure("secure_or_unknown_focused_role") }
            if let selected = selection(node) { selectionElement = node; baseline = selected; break }
            current = element(node, kAXParentAttribute)
        }
        guard baseline != nil else { throw failure("selection_unverifiable") }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let screens = NSScreen.screens.map { CGRect(x: $0.frame.minX, y: primaryTop - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
        guard screens.contains(where: { $0.intersects(windowFrame) }) else { throw failure("window_offscreen") }
        var stack: [(AXUIElement, Int, CGRect, Bool, [FrameStamp])] = [(window, 0, windowFrame, false, [])]
        var visited: [AXUIElement] = [], matches: [Match] = [], truncated = false, unverifiedSubtree = false
        while let (node, depth, parentClip, inLayout, parentFrames) = stack.popLast(), !expired {
            if visited.contains(where: { CFEqual($0, node) }) { continue }
            guard visited.count < 128 else { truncated = true; break }; visited.append(node)
            let rawRole = value(node, kAXRoleAttribute) as? String
            let subrole = value(node, kAXSubroleAttribute) as? String
            guard WordInlineGeometryPolicy.permitsRole(rawRole, subrole: subrole) else { continue }
            let ownFrame = frame(node), clip = ownFrame.map { $0.intersection(parentClip) } ?? parentClip
            guard WordInlineGeometryPolicy.validRect(clip), screens.contains(where: { $0.intersects(clip) }) else { continue }
            let frames = parentFrames + (ownFrame.map { [FrameStamp(element: node, rect: $0)] } ?? [])
            let childList = children(node, remaining: 128 - visited.count)
            if !childList.complete { unverifiedSubtree = true }
            if childList.items.count < childList.count || (depth >= 16 && childList.count > 0) { truncated = true }
            let layout = inLayout || rawRole == "AXLayoutArea" || rawRole == "AXLayoutItem"
            if depth < 16 { stack.append(contentsOf: childList.items.reversed().map { ($0, depth + 1, clip, layout, frames) }) }
            guard ["AXTextArea", "AXStaticText", "AXLayoutArea", "AXLayoutItem"].contains(rawRole ?? "") else { continue }
            var record = WordInlineProbeNodeDiagnostic(role: rawRole!, depth: depth)
            record.attributes = attributeNames(node, parameterized: false)
            record.parameterizedAttributes = attributeNames(node, parameterized: true)
            if let count = value(node, kAXNumberOfCharactersAttribute) as? NSNumber, CFGetTypeID(count) != CFBooleanGetTypeID(), count.intValue >= 0, Double(count.intValue) == count.doubleValue {
                record.characterCount = count.intValue
            }
            let index = diagnostic.nodes.count
            defer { diagnostic.nodes.append(record) }
            guard record.parameterizedAttributes.contains(kAXStringForRangeParameterizedAttribute), record.parameterizedAttributes.contains(kAXBoundsForRangeParameterizedAttribute) else {
                record.errorCode = "required_range_api_unavailable"
                if WordInlineGeometryPolicy.leafTextIsUnverified(characterCount: record.characterCount, actualChildCount: childList.actualChildCount, inLayout: layout) { unverifiedSubtree = true }
                continue
            }
            var fragment: String?, base = 0, source: TextSource?
            let visibleValue = value(node, kAXVisibleCharacterRangeAttribute), visibleError = lastAXError
            let visibleRange = range(visibleValue)
            let rangeUnavailable = [Int(AXError.attributeUnsupported.rawValue), Int(AXError.noValue.rawValue)].contains(visibleError ?? 0)
            if (visibleValue != nil && visibleRange == nil) || (visibleValue == nil && !rangeUnavailable) {
                record.errorCode = "visible_range_type_or_read_failed"; record.axError = visibleError; unverifiedSubtree = true; continue
            }
            if let visible = visibleRange {
                guard visible.length <= 16000, record.characterCount.map({ visible.location + visible.length <= $0 }) != false else { record.errorCode = "visible_range_too_long_or_invalid"; unverifiedSubtree = true; continue }
                fragment = visible.length == 0 ? "" : parameter(node, kAXStringForRangeParameterizedAttribute, range: visible) as? String; base = visible.location
                source = .visible(visible)
                record.textSource = "visible_range"
                if fragment?.utf16.count != visible.length { record.errorCode = "visible_range_roundtrip_failed"; record.axError = lastAXError; unverifiedSubtree = true; continue }
            } else if WordInlineGeometryPolicy.canReadLayoutLeaf(characterCount: record.characterCount, actualChildCount: childList.actualChildCount, inLayout: layout, hasFrame: ownFrame != nil), let count = record.characterCount {
                // Never read an application's root AXValue or an unbounded document value.
                // A leaf in a layout/page subtree must first advertise a bounded character count.
                let sharedValue = value(node, kAXSharedCharacterRangeAttribute), sharedError = lastAXError
                let sharedRange = range(sharedValue)
                if (sharedValue != nil && sharedRange == nil) || (sharedValue == nil && ![Int(AXError.attributeUnsupported.rawValue), Int(AXError.noValue.rawValue)].contains(sharedError ?? 0)) {
                    record.errorCode = "shared_text_range_type_or_read_failed"; record.axError = sharedError; unverifiedSubtree = true; continue
                }
                if let shared = sharedRange, shared.location != 0 || shared.length != count {
                    record.errorCode = "shared_text_index_unverifiable"; unverifiedSubtree = true; continue
                }
                fragment = value(node, kAXValueAttribute) as? String
                source = .leaf(count: count, shared: sharedRange)
                record.textSource = "bounded_layout_leaf"
                if fragment?.utf16.count != count { record.errorCode = "leaf_value_roundtrip_failed"; record.axError = lastAXError; unverifiedSubtree = true; continue }
            } else {
                record.errorCode = "no_bounded_visible_text"
                if WordInlineGeometryPolicy.leafTextIsUnverified(characterCount: record.characterCount, actualChildCount: childList.actualChildCount, inLayout: layout) { unverifiedSubtree = true }
                continue
            }
            guard let fragment else { record.errorCode = "text_unavailable"; record.axError = lastAXError; unverifiedSubtree = true; continue }
            record.readUTF16Count = fragment.utf16.count
            if !diagnosticDetails, let source { containers.append(Container(element: node, fragment: fragment, base: base,
                clip: clip, frames: frames, source: source, characterCount: record.characterCount, nodeIndex: index)) }
            let found = try WordInlineGeometryPolicy.matches(input, in: fragment, baseUTF16: base)
            record.matchCount = found.count
            if !found.isEmpty {
                if diagnosticDetails {
                    record.selectedTextSettable = settable(node, kAXSelectedTextAttribute)
                    record.selectedTextRangeSettable = settable(node, kAXSelectedTextRangeAttribute)
                }
                matches.append(contentsOf: found.map { Match(element: node, mapping: $0, clip: clip, nodeIndex: index) })
            }
        }
        diagnostic.visitedNodeCount = visited.count; diagnostic.matchCount = matches.count
        diagnostic.traversalComplete = !expired && !truncated && !unverifiedSubtree && stack.isEmpty
        guard !expired else { throw failure("deadline_exceeded") }
        guard !unverifiedSubtree else { throw failure("visible_text_or_tree_unverifiable") }
        guard diagnostic.traversalComplete else { throw failure("traversal_limit") }
        if captureOnly { return }
        if matches.count > 1 {
            var seen: [CGRect] = []
            for match in matches.prefix(8) {
                if let bounds = rect(parameter(match.element, kAXBoundsForRangeParameterizedAttribute, range: match.mapping.issue)) {
                    if seen.contains(bounds) { diagnostic.duplicateRectangleCount += 1 }; seen.append(bounds)
                }
            }
        }
        try WordInlineGeometryPolicy.requireUniqueMatch(matches.count)
        let match = matches[0]
        let paragraph = parameter(match.element, kAXStringForRangeParameterizedAttribute, range: match.mapping.paragraph) as? String
        diagnostic.paragraphVerified = paragraph?.utf8.elementsEqual(input.expectedParagraph.utf8) == true
        guard diagnostic.paragraphVerified == true else { throw failure("paragraph_roundtrip_failed") }
        let original = parameter(match.element, kAXStringForRangeParameterizedAttribute, range: match.mapping.issue) as? String
        diagnostic.originalVerified = original?.utf8.elementsEqual(input.original.utf8) == true
        guard diagnostic.originalVerified == true else { throw failure("original_roundtrip_failed") }
        guard let bounds = rect(parameter(match.element, kAXBoundsForRangeParameterizedAttribute, range: match.mapping.issue)) else { throw failure("bounds_unavailable") }
        var offset = match.mapping.issue.location, glyphs: [CGRect] = []
        for character in input.original {
            let length = String(character).utf16.count
            guard let glyph = rect(parameter(match.element, kAXBoundsForRangeParameterizedAttribute, range: NSRange(location: offset, length: length))) else { throw failure("single_line_unverifiable") }
            glyphs.append(glyph); offset += length
        }
        try WordInlineGeometryPolicy.validateBounds(bounds, graphemeBounds: glyphs, clip: match.clip, screens: screens)
        diagnostic.singleLineVerified = true
        diagnostic.attributedStringSupported = diagnosticDetails ? diagnostic.nodes[match.nodeIndex].parameterizedAttributes.contains(kAXAttributedStringForRangeParameterizedAttribute) : nil
        if diagnostic.attributedStringSupported == true {
            if let attributed = parameter(match.element, kAXAttributedStringForRangeParameterizedAttribute, range: match.mapping.issue) as? NSAttributedString {
                diagnostic.format = WordInlineFormatInspection.inspect(attributed, original: input.original)
            } else { diagnostic.formatReadError = "attributed_string_unavailable" }
        }
        let finalParagraph = parameter(match.element, kAXStringForRangeParameterizedAttribute, range: match.mapping.paragraph) as? String
        guard finalParagraph?.utf8.elementsEqual(input.expectedParagraph.utf8) == true else { throw failure("paragraph_changed") }
        guard let finalBounds = rect(parameter(match.element, kAXBoundsForRangeParameterizedAttribute, range: match.mapping.issue)), finalBounds == bounds else { throw failure("geometry_changed") }
        diagnostic.bounds = WordInlineProbeRect(bounds)
    }

    func prepareBatch(_ items: [WordInlineBatchItem], groups: [[Int]]) async throws -> [WordInlineBatchMarker] {
        var groupForIndex: [Int: Int] = [:], paragraphs: [Int: Match] = [:]
        var rejectedParagraphs: [Int: WordInlineGeometryFailure] = [:]
        for group in groups {
            guard let representative = group.first else { throw failure("batch_unverifiable") }
            for index in group { groupForIndex[index] = representative }
        }
        return try await WordInlineGeometryPolicy.verifiedBatchSubset(Array(items.indices), prove: { index in
            guard !self.expired else { throw self.failure("deadline_exceeded") }
            guard let representative = groupForIndex[index] else { throw self.failure("batch_unverifiable") }
            let item = items[index], input = item.input
            let paragraph: Match
            if let rejected = rejectedParagraphs[representative] { throw rejected }
            if let cached = paragraphs[representative] { paragraph = cached }
            else {
                var found: [Match] = []
                for container in self.containers {
                    guard !self.expired else { throw self.failure("deadline_exceeded") }
                    found.append(contentsOf: try WordInlineGeometryPolicy.matches(input, in: container.fragment, baseUTF16: container.base).map {
                        Match(element: container.element, mapping: $0, clip: container.clip, nodeIndex: container.nodeIndex)
                    })
                }
                do { try WordInlineGeometryPolicy.requireUniqueMatch(found.count) }
                catch let error as WordInlineGeometryFailure where [.ambiguous, .noMatch].contains(error) {
                    // Negative results belong only to this reader/capture, so a
                    // repeated absent paragraph cannot spend the AX budget again.
                    rejectedParagraphs[representative] = error; throw error
                }
                paragraph = found[0]
                let text = self.parameter(paragraph.element, kAXStringForRangeParameterizedAttribute, range: paragraph.mapping.paragraph) as? String
                guard text?.utf8.elementsEqual(input.expectedParagraph.utf8) == true else { throw self.failure("paragraph_roundtrip_failed") }
                paragraphs[representative] = paragraph
            }
            let range = NSRange(location: paragraph.mapping.paragraph.location + input.issueStartUTF16, length: input.issueLengthUTF16)
            let bounds = try self.issueBounds(input, element: paragraph.element, range: range, clip: paragraph.clip)
            self.preparedRanges.append(PreparedRange(element: paragraph.element, range: range, bounds: bounds))
            return WordInlineBatchMarker(id: item.id, bounds: WordInlineProbeRect(bounds))
        }, finalBarrier: {
            await Task.yield()
            try Task.checkCancellation()
            try self.verifyBatchBarrier()
        })
    }

    private func issueBounds(_ input: WordInlineProbeInput, element: AXUIElement, range: NSRange, clip: CGRect) throws -> CGRect {
        guard !expired else { throw failure("deadline_exceeded") }
        guard let bounds = rect(parameter(element, kAXBoundsForRangeParameterizedAttribute, range: range)) else { throw failure("bounds_unavailable") }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let screens = NSScreen.screens.map { CGRect(x: $0.frame.minX, y: primaryTop - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
        guard WordInlineGeometryPolicy.validRect(bounds), WordInlineGeometryPolicy.validRect(clip) else { throw WordInlineGeometryFailure.invalidBounds }
        guard clip.contains(bounds), screens.contains(where: { $0.contains(bounds) }) else { throw WordInlineGeometryFailure.offscreen }
        let original = parameter(element, kAXStringForRangeParameterizedAttribute, range: range) as? String
        guard original?.utf8.elementsEqual(input.original.utf8) == true else { throw failure("original_roundtrip_failed") }
        var offset = range.location, glyphs: [CGRect] = []
        for character in input.original {
            let length = String(character).utf16.count
            guard let glyph = rect(parameter(element, kAXBoundsForRangeParameterizedAttribute, range: NSRange(location: offset, length: length))) else { throw failure("single_line_unverifiable") }
            glyphs.append(glyph); offset += length
        }
        try WordInlineGeometryPolicy.validateBounds(bounds, graphemeBounds: glyphs, clip: clip, screens: screens)
        return bounds
    }

    private func optionalRange(_ element: AXUIElement, _ name: String) throws -> NSRange? {
        let raw = value(element, name), error = lastAXError
        if let raw, let range = range(raw) { return range }
        guard raw == nil, [Int(AXError.attributeUnsupported.rawValue), Int(AXError.noValue.rawValue)].contains(error ?? 0) else { throw failure("range_state_unverifiable") }
        return nil
    }

    func verifyBatchBarrier() throws {
        guard let window, let initialWindowFrame, let currentWindow = frame(window), currentWindow == initialWindowFrame, !expired else { throw failure("window_or_deadline_changed") }
        var checkedFrames: [FrameStamp] = []
        for container in containers {
            try Task.checkCancellation()
            var currentClip = currentWindow
            for stamp in container.frames {
                if let old = checkedFrames.first(where: { CFEqual($0.element, stamp.element) }) {
                    guard old.rect == stamp.rect else { throw WordInlineGeometryFailure.viewportChanged }
                    currentClip = currentClip.intersection(old.rect)
                } else {
                    guard let now = frame(stamp.element), now == stamp.rect else { throw WordInlineGeometryFailure.viewportChanged }
                    checkedFrames.append(FrameStamp(element: stamp.element, rect: now)); currentClip = currentClip.intersection(now)
                }
            }
            let fragment: String?, currentVisible: NSRange?
            switch container.source {
            case .visible(let expected):
                currentVisible = try optionalRange(container.element, kAXVisibleCharacterRangeAttribute)
                guard currentVisible == expected else { throw WordInlineGeometryFailure.viewportChanged }
                if let count = container.characterCount {
                    guard let now = value(container.element, kAXNumberOfCharactersAttribute) as? NSNumber,
                          CFGetTypeID(now) != CFBooleanGetTypeID(), now.intValue == count, Double(now.intValue) == now.doubleValue else { throw WordInlineGeometryFailure.viewportChanged }
                }
                fragment = expected.length == 0 ? "" : parameter(container.element, kAXStringForRangeParameterizedAttribute, range: expected) as? String
                guard try optionalRange(container.element, kAXVisibleCharacterRangeAttribute) == expected else { throw WordInlineGeometryFailure.viewportChanged }
            case .leaf(let count, let expectedShared):
                currentVisible = try optionalRange(container.element, kAXVisibleCharacterRangeAttribute)
                guard currentVisible == nil, try optionalRange(container.element, kAXSharedCharacterRangeAttribute) == expectedShared,
                      let now = value(container.element, kAXNumberOfCharactersAttribute) as? NSNumber,
                      CFGetTypeID(now) != CFBooleanGetTypeID(), now.intValue == count, Double(now.intValue) == now.doubleValue,
                      prepare(container.element) else { throw WordInlineGeometryFailure.viewportChanged }
                var childCount: CFIndex = 0
                guard AXUIElementGetAttributeValueCount(container.element, kAXChildrenAttribute as CFString, &childCount) == .success,
                      childCount == 0 else { throw WordInlineGeometryFailure.viewportChanged }
                fragment = value(container.element, kAXValueAttribute) as? String
            }
            guard let fragment, fragment.utf16.count == container.fragment.utf16.count else { throw failure("visible_text_roundtrip_failed") }
            let initialRange: NSRange?
            if case .visible(let range) = container.source { initialRange = range } else { initialRange = nil }
            try WordInlineGeometryPolicy.requireSameViewport(
                WordInlineViewportStamp(sourceHash: WritingSnapshot.hash(rawText: container.fragment), visibleRange: initialRange, clip: container.clip, windowFrame: initialWindowFrame),
                WordInlineViewportStamp(sourceHash: WritingSnapshot.hash(rawText: fragment), visibleRange: currentVisible, clip: currentClip, windowFrame: currentWindow))
        }
        for item in preparedRanges {
            guard let current = rect(parameter(item.element, kAXBoundsForRangeParameterizedAttribute, range: item.range)), current == item.bounds else { throw failure("geometry_changed") }
        }
        guard let finalWindow = frame(window), finalWindow == initialWindowFrame, !expired else { throw failure("window_or_deadline_changed") }
    }

    func verifyUnchanged(diagnostic: inout WordInlineProbeDiagnostic) {
        guard let application, let window, let focused else { return }
        let samePID = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        let finalWindow = element(application, kAXFocusedWindowAttribute), finalFocus = element(application, kAXFocusedUIElementAttribute)
        diagnostic.environmentUnchanged = samePID && finalWindow.map { CFEqual($0, window) } == true && finalFocus.map { CFEqual($0, focused) } == true && !IsSecureEventInputEnabled()
        if let selectionElement, let baseline, let finalSelection = selection(selectionElement) { diagnostic.selectionUnchanged = finalSelection == baseline }
        if diagnostic.errorCode == nil {
            if expired { diagnostic.errorCode = "deadline_exceeded" }
            else if diagnostic.environmentUnchanged != true { diagnostic.errorCode = "environment_changed" }
            else if diagnostic.selectionUnchanged != true { diagnostic.errorCode = "selection_changed_or_unverifiable" }
        }
        if diagnostic.errorCode != nil { diagnostic.bounds = nil }
    }
}

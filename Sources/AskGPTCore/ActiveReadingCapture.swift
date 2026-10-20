import AppKit
import ApplicationServices
import Carbon
import Foundation

public enum ActiveReadingSource: Sendable, Equatable {
    /// A physical, zero-based page index, only when explicitly exposed by AX or #page=.
    case pdf(url: URL, pageIndex: Int?)
    case webpage(title: String, url: URL?, text: String)
}

public enum ActiveReadingCaptureLimit: String, Sendable, Equatable {
    case nodes, depth, text, time
}

public enum ActiveReadingCaptureError: Error, LocalizedError, Sendable, Equatable {
    case unsupportedApplication, accessibilityUnavailable, secureInput, sourceChanged
    case noReadableContent, unsupportedDocument
    case limitExceeded(ActiveReadingCaptureLimit)

    public var errorDescription: String? {
        switch self {
        case .unsupportedApplication:
            return "当前应用未提供受支持的页面入口，请打开 PDF 文件。"
        case .accessibilityUnavailable:
            return "无法读取当前窗口的辅助功能信息，请检查已有的辅助功能授权，或直接打开 PDF 文件。"
        case .secureInput:
            return "当前处于安全输入状态，未读取页面；请退出安全输入后重试。"
        case .sourceChanged:
            return "读取期间当前应用或文档窗口已切换，请回到原页面重试。"
        case .noReadableContent:
            return "当前窗口没有暴露可读取的网页正文；PDF 请使用“打开 PDF 文件”。"
        case .unsupportedDocument:
            return "阅读器未公开本机 PDF 地址，无法自动定位文件；请使用“打开 PDF 文件”。"
        case .limitExceeded(let limit):
            switch limit {
            case .time: return "页面读取超过 3 秒，未返回不完整正文；请重试或打开 PDF 文件。"
            case .nodes, .depth: return "页面结构超过本机读取上限，未返回不完整正文；请打开 PDF 文件。"
            case .text: return "页面正文超过 1 MB，未返回不完整正文；请分段阅读或打开 PDF 文件。"
            }
        }
    }
}

/// An explicit whole-page entry point. SelectionCapture and SelectionWatcher do
/// not call this reader. It uses only AX on one captured application's current
/// focused/main window, with no clipboard, script, network, or library lookup.
public final class ActiveReadingCapture: @unchecked Sendable {
    public init() {}

    public func capture() async throws -> ActiveReadingSource? {
        try await captureTarget(processID: nil)
    }

    /// The caller may retain the last external foreground PID before activating
    /// its own panel. An unrelated foreground application invalidates that PID.
    public func capture(processID: pid_t) async throws -> ActiveReadingSource? {
        try await captureTarget(processID: processID)
    }

    private func captureTarget(processID: pid_t?) async throws -> ActiveReadingSource? {
        try Task.checkCancellation()
        let target: ActiveReadingTarget? = try await MainActor.run {
            let ownPID = ProcessInfo.processInfo.processIdentifier
            guard let foreground = NSWorkspace.shared.frontmostApplication else { return nil }
            let pid = processID ?? foreground.processIdentifier
            guard ActiveReadingApplicationPolicy.acceptsForeground(sourcePID: pid,
                foregroundPID: foreground.processIdentifier, ownPID: ownPID, explicit: processID != nil) else {
                if processID == nil { return nil }
                throw ActiveReadingCaptureError.sourceChanged
            }
            guard let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated,
                  let bundleID = application.bundleIdentifier,
                  let kind = ActiveReadingApplicationPolicy.kind(bundleID: bundleID) else {
                throw ActiveReadingCaptureError.unsupportedApplication
            }
            return ActiveReadingTarget(pid: pid, bundleID: bundleID, kind: kind,
                launchDate: application.launchDate, explicit: processID != nil)
        }
        guard let target else { return nil }
        try Task.checkCancellation()
        // All synchronous AX IPC, including messaging timeouts, stays off the UI
        // actor. Each request owns a reader; a slow old request cannot queue a
        // newer request behind a shared serial worker.
        let result: ActiveReadingSource = try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    guard AXIsProcessTrusted() else { throw ActiveReadingCaptureError.accessibilityUnavailable }
                    guard !IsSecureEventInputEnabled() else { throw ActiveReadingCaptureError.secureInput }
                    continuation.resume(returning: try ActiveReadingAXReader().capture(target))
                } catch { continuation.resume(throwing: error) }
            }
        }
        try Task.checkCancellation()
        let unchanged = await MainActor.run {
            guard let foreground = NSWorkspace.shared.frontmostApplication,
                  let source = NSRunningApplication(processIdentifier: target.pid), !source.isTerminated,
                  source.bundleIdentifier == target.bundleID, source.launchDate == target.launchDate else { return false }
            return ActiveReadingApplicationPolicy.acceptsForeground(sourcePID: target.pid,
                foregroundPID: foreground.processIdentifier, ownPID: ProcessInfo.processInfo.processIdentifier,
                explicit: target.explicit)
        }
        guard unchanged else { throw ActiveReadingCaptureError.sourceChanged }
        return result
    }
}

private struct ActiveReadingTarget: Sendable {
    let pid: pid_t
    let bundleID: String
    let kind: ActiveReadingApplicationPolicy.Kind
    let launchDate: Date?
    let explicit: Bool
}

enum ActiveReadingApplicationPolicy {
    enum Kind: Sendable { case browser, pdfReader }

    static func kind(bundleID: String) -> Kind? {
        let browsers: Set<String> = ["com.apple.Safari", "com.apple.SafariTechnologyPreview",
            "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
            "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
            "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
            "com.brave.Browser", "company.thebrowser.Browser"]
        let readers: Set<String> = ["com.apple.Preview", "com.adobe.Reader", "com.adobe.Acrobat.Pro",
            "com.adobe.Acrobat", "org.zotero.zotero", "com.kingsoft.wpsoffice.mac"]
        if browsers.contains(bundleID) { return .browser }
        if readers.contains(bundleID) { return .pdfReader }
        return nil
    }

    static func acceptsForeground(sourcePID: pid_t, foregroundPID: pid_t, ownPID: pid_t, explicit: Bool) -> Bool {
        sourcePID > 0 && sourcePID != ownPID &&
            (foregroundPID == sourcePID || (explicit && foregroundPID == ownPID))
    }
}

struct ActiveReadingPDFReference: Equatable {
    let url: URL
    let pageIndex: Int?
}

enum ActiveReadingURLPolicy {
    /// Preview exposes the current physical page as window metadata on macOS,
    /// rather than AXPageNumber. Require its exact source filename and the
    /// localized page suffix; never infer a page from article text/thumbnails.
    static func previewWindowPage(title: String?, documentURL: URL) -> Int? {
        guard let title, title.utf8.count <= 4_096 else { return nil }
        let filename = NSRegularExpression.escapedPattern(for: documentURL.lastPathComponent)
        let pattern = "^" + filename + #"\s*[–—-]\s*(?:页码\s*[:：]\s*([1-9][0-9]*)\s*/\s*([1-9][0-9]*)|Page\s+([1-9][0-9]*)\s+of\s+([1-9][0-9]*))$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) else { return nil }
        let offset = match.range(at: 1).location == NSNotFound ? 3 : 1
        guard let pageRange = Range(match.range(at: offset), in: title),
              let countRange = Range(match.range(at: offset + 1), in: title),
              let page = Int(title[pageRange]), let count = Int(title[countRange]),
              (1...2_000).contains(count), (1...count).contains(page) else { return nil }
        return page - 1
    }

    static func pageIndex(_ value: String?) -> Int? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.allSatisfy({ (48...57).contains($0) }),
              let page = Int(trimmed), (1...1_000_000).contains(page) else { return nil }
        return page - 1
    }

    static func pdfReference(_ raw: String) -> ActiveReadingPDFReference? {
        let raw = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let candidate: URL
        if raw.hasPrefix("/") { candidate = URL(fileURLWithPath: raw) }
        else {
            guard let url = URL(string: raw) else { return nil }
            candidate = url
        }
        guard candidate.isFileURL, candidate.path.hasPrefix("/"),
              candidate.host == nil || candidate.host == "" || candidate.host?.lowercased() == "localhost",
              candidate.user == nil, candidate.password == nil, candidate.query == nil,
              candidate.pathExtension.lowercased() == "pdf",
              var components = URLComponents(url: candidate, resolvingAgainstBaseURL: false) else { return nil }
        let page = components.fragment.flatMap { fragment in
            fragment.split(separator: "&").compactMap { pair -> Int? in
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard parts.count == 2, parts[0].lowercased() == "page" else { return nil }
                return pageIndex(String(parts[1]))
            }.first
        }
        components.fragment = nil
        components.host = nil
        guard let parsed = components.url else { return nil }
        // URLComponents may spell an authority-less local URL as file:/path.
        // Rebuild from the decoded filesystem path so equality, escaping, and
        // downstream PDF opening use Foundation's canonical local file form.
        let url = URL(fileURLWithPath: parsed.path)
        return ActiveReadingPDFReference(url: url, pageIndex: page)
    }

    static func webURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return url
    }
}

struct ActiveReadingLimits: Sendable {
    var maximumNodes: Int = 12_000
    var maximumDepth: Int = 40
    var maximumUTF8Bytes: Int = 1_000_000
}

struct ActiveReadingNodeMetadata: Equatable {
    let role: String
    var subrole: String? = nil
    var isHidden: Bool = false

    var isExcluded: Bool {
        if isHidden || SelectionPolicy.isSecureInput(role: role, subrole: subrole) { return true }
        let excluded: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXForm",
            "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXStepper",
            "AXMenu", "AXMenuBar", "AXMenuItem", "AXToolbar", "AXTabGroup", "AXTabButton",
            "AXNavigation", "AXLandmarkNavigation", "AXLandmarkSearch", "AXLandmarkForm"]
        return excluded.contains(role) || subrole.map(excluded.contains) == true
    }

    var isMain: Bool { role == "AXLandmarkMain" || subrole == "AXLandmarkMain" }
    var isArticle: Bool { role == "AXArticle" || role == "AXDocumentArticle" || subrole == "AXDocumentArticle" }
    var isParagraph: Bool {
        ["AXParagraph", "AXHeading", "AXListItem", "AXBlockQuote"].contains(role) || subrole == "AXParagraph"
    }
}

struct ActiveReadingTextNode: Equatable {
    let metadata: ActiveReadingNodeMetadata
    let text: String?
    let children: [ActiveReadingTextNode]
}

/// The production traversal is injectable without any AX or desktop access.
/// Security is checked before asking for a value or expanding descendants.
enum ActiveReadingTreeSnapshot {
    static func read<Element>(root: Element, limits: ActiveReadingLimits = .init(), isExpired: () -> Bool = { false },
        metadata: (Element) throws -> ActiveReadingNodeMetadata, children: (Element) throws -> [Element],
        staticText: (Element) throws -> String?, identity: (Element) -> Int,
        equals: (Element, Element) -> Bool) throws -> ActiveReadingTextNode {
        var count = 0, bytes = 0
        var visited: [Int: [Element]] = [:]
        func visit(_ element: Element, depth: Int) throws -> ActiveReadingTextNode? {
            guard !isExpired() else { throw ActiveReadingCaptureError.limitExceeded(.time) }
            let hash = identity(element)
            if visited[hash]?.contains(where: { equals($0, element) }) == true { return nil }
            guard count < limits.maximumNodes else { throw ActiveReadingCaptureError.limitExceeded(.nodes) }
            guard depth <= limits.maximumDepth else { throw ActiveReadingCaptureError.limitExceeded(.depth) }
            count += 1
            visited[hash, default: []].append(element)
            let info = try metadata(element)
            guard !info.isExcluded else { return nil }
            let childElements = try children(element)
            guard childElements.count <= limits.maximumNodes - count else {
                throw ActiveReadingCaptureError.limitExceeded(.nodes)
            }
            // Read only static leaves. A container's mirrored value could also
            // contain a form child's value which its subtree correctly skips.
            let text = info.role == "AXStaticText" && childElements.isEmpty ? try staticText(element) : nil
            bytes += text?.utf8.count ?? 0
            guard bytes <= limits.maximumUTF8Bytes else { throw ActiveReadingCaptureError.limitExceeded(.text) }
            var childNodes: [ActiveReadingTextNode] = []
            for child in childElements {
                if let node = try visit(child, depth: depth + 1) { childNodes.append(node) }
            }
            guard !isExpired() else { throw ActiveReadingCaptureError.limitExceeded(.time) }
            return ActiveReadingTextNode(metadata: info, text: text, children: childNodes)
        }
        return try visit(root, depth: 0) ?? ActiveReadingTextNode(metadata: .init(role: "AXGroup"), text: nil, children: [])
    }
}

enum ActiveReadingTextPolicy {
    static func text(in root: ActiveReadingTextNode, maximumUTF8Bytes: Int = 1_000_000) throws -> String {
        func semanticRoots(_ node: ActiveReadingTextNode, matching: (ActiveReadingNodeMetadata) -> Bool) -> [ActiveReadingTextNode] {
            guard !node.metadata.isExcluded else { return [] }
            if matching(node.metadata) { return [node] }
            return node.children.flatMap { semanticRoots($0, matching: matching) }
        }
        func paragraphs(_ node: ActiveReadingTextNode) -> [String] {
            guard !node.metadata.isExcluded else { return [] }
            let children = node.children.flatMap(paragraphs)
            // Some AX implementations mirror a parent's text in child leaves.
            // Prefer leaves, while never deduplicating equal text in siblings.
            if !children.isEmpty {
                return node.metadata.isParagraph ? [children.joined(separator: " ")] : children
            }
            guard node.metadata.role == "AXStaticText", let raw = node.text else { return [] }
            let text = raw.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? [] : [text]
        }
        let main = semanticRoots(root, matching: { $0.isMain })
        let article = main.isEmpty ? semanticRoots(root, matching: { $0.isArticle }) : []
        let roots = !main.isEmpty ? main : (!article.isEmpty ? article : [root])
        let text = roots.flatMap(paragraphs).joined(separator: "\n\n")
        guard text.utf8.count <= maximumUTF8Bytes else { throw ActiveReadingCaptureError.limitExceeded(.text) }
        return text
    }
}

private final class ActiveReadingAXReader {
    private let limits = ActiveReadingLimits()
    private let deadline = ProcessInfo.processInfo.systemUptime + 3
    private var metadataCache: [Int: [(AXUIElement, ActiveReadingNodeMetadata)]] = [:]
    private var inspected = 0
    private var sourceBundleID: String?
    private var expired: Bool { ProcessInfo.processInfo.systemUptime >= deadline }

    func capture(_ target: ActiveReadingTarget) throws -> ActiveReadingSource {
        sourceBundleID = target.bundleID
        let application = AXUIElementCreateApplication(target.pid)
        guard let window = try currentWindow(application), try belongs(window, to: target.pid) else {
            throw ActiveReadingCaptureError.noReadableContent
        }
        let focus = try element(application, kAXFocusedUIElementAttribute)
        let path = try focusedPath(from: focus, in: window)
        let context = path + [window]
        if let pdf = try pdfReference(in: context) {
            try validate(window: window, application: application, pid: target.pid)
            return .pdf(url: pdf.url, pageIndex: pdf.pageIndex)
        }

        let webArea = try currentWebArea(window: window, focusedPath: path)
        if let webArea {
            if let pdf = try pdfReference(in: [webArea] + context) {
                try validate(window: window, application: application, pid: target.pid)
                return .pdf(url: pdf.url, pageIndex: pdf.pageIndex)
            }
            // A Zotero item URL is not a file URL. Looking inside this current
            // document may find an exposed local inner PDF.js document, but no
            // library, attachment directory, or browser tab is searched.
            if target.kind == .pdfReader {
                if let pdf = try findPDF(in: webArea) {
                    try validate(window: window, application: application, pid: target.pid)
                    return .pdf(url: pdf.url, pageIndex: pdf.pageIndex)
                }
                throw ActiveReadingCaptureError.unsupportedDocument
            }
            let documentURL = try string(webArea, kAXURLAttribute) ?? string(webArea, kAXDocumentAttribute)
            if let documentURL, URL(string: documentURL)?.pathExtension.lowercased() == "pdf" {
                throw ActiveReadingCaptureError.unsupportedDocument
            }
            let tree = try ActiveReadingTreeSnapshot.read(root: webArea, limits: limits, isExpired: { self.expired },
                metadata: { try self.metadata($0) }, children: { try self.children($0) },
                staticText: { try self.string($0, kAXValueAttribute) },
                identity: { Int(bitPattern: CFHash($0)) }, equals: { CFEqual($0, $1) })
            let text = try ActiveReadingTextPolicy.text(in: tree, maximumUTF8Bytes: limits.maximumUTF8Bytes)
            guard !text.isEmpty else { throw ActiveReadingCaptureError.noReadableContent }
            let title = try string(webArea, kAXTitleAttribute) ?? string(window, kAXTitleAttribute) ?? "当前网页"
            try validate(window: window, application: application, pid: target.pid,
                webArea: webArea, documentURL: documentURL)
            return .webpage(title: title, url: ActiveReadingURLPolicy.webURL(documentURL), text: text)
        }
        if target.kind == .pdfReader, let pdf = try findPDF(in: window) {
            try validate(window: window, application: application, pid: target.pid)
            return .pdf(url: pdf.url, pageIndex: pdf.pageIndex)
        }
        throw target.kind == .pdfReader ? ActiveReadingCaptureError.unsupportedDocument : .noReadableContent
    }

    private func prepare(_ element: AXUIElement) throws {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { throw ActiveReadingCaptureError.limitExceeded(.time) }
        _ = AXUIElementSetMessagingTimeout(element, Float(min(remaining, 0.08)))
    }

    private func value(_ element: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
        try prepare(element)
        var output: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &output)
        try check(status)
        return status == .success ? output : nil
    }

    private func check(_ status: AXError) throws {
        if expired { throw ActiveReadingCaptureError.limitExceeded(.time) }
        switch status {
        case .success, .attributeUnsupported, .noValue, .notImplemented: return
        case .apiDisabled, .cannotComplete: throw ActiveReadingCaptureError.accessibilityUnavailable
        case .invalidUIElement: throw ActiveReadingCaptureError.sourceChanged
        default: throw ActiveReadingCaptureError.noReadableContent
        }
    }

    private func string(_ element: AXUIElement, _ attribute: String) throws -> String? {
        guard let output = try value(element, attribute) else { return nil }
        if let string = output as? String { return string }
        if CFGetTypeID(output) == CFURLGetTypeID() { return (output as! URL).absoluteString }
        return nil
    }

    private func element(_ parent: AXUIElement, _ attribute: String) throws -> AXUIElement? {
        guard let output = try value(parent, attribute), CFGetTypeID(output) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(output, to: AXUIElement.self)
    }

    private func currentWindow(_ application: AXUIElement) throws -> AXUIElement? {
        try element(application, kAXFocusedWindowAttribute) ?? element(application, kAXMainWindowAttribute)
    }

    private func belongs(_ element: AXUIElement, to pid: pid_t) throws -> Bool {
        try prepare(element)
        var actual: pid_t = 0
        return AXUIElementGetPid(element, &actual) == .success && actual == pid
    }

    private func focusedPath(from focused: AXUIElement?, in window: AXUIElement) throws -> [AXUIElement] {
        var path: [AXUIElement] = []
        var current = focused
        for _ in 0...limits.maximumDepth {
            guard let node = current else { return [] }
            if path.contains(where: { CFEqual($0, node) }) { return [] }
            path.append(node)
            if CFEqual(node, window) { return path }
            current = try element(node, kAXParentAttribute)
        }
        return []
    }

    private func metadata(_ element: AXUIElement) throws -> ActiveReadingNodeMetadata {
        let hash = Int(bitPattern: CFHash(element))
        if let cached = metadataCache[hash]?.first(where: { CFEqual($0.0, element) }) { return cached.1 }
        guard inspected < limits.maximumNodes else { throw ActiveReadingCaptureError.limitExceeded(.nodes) }
        inspected += 1
        try prepare(element)
        var output: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(element,
            [kAXRoleAttribute, kAXSubroleAttribute, "AXHidden"] as CFArray,
            AXCopyMultipleAttributeOptions(rawValue: 0), &output)
        try check(status)
        let info: ActiveReadingNodeMetadata
        if status == .success, let values = output as? [Any], values.count == 3 {
            guard let role = values[0] as? String else { throw ActiveReadingCaptureError.noReadableContent }
            info = .init(role: role, subrole: values[1] as? String,
                isHidden: values[2] as? Bool == true)
        } else {
            guard let role = try string(element, kAXRoleAttribute) else {
                throw ActiveReadingCaptureError.noReadableContent
            }
            info = .init(role: role, subrole: try string(element, kAXSubroleAttribute),
                isHidden: try value(element, "AXHidden") as? Bool == true)
        }
        metadataCache[hash, default: []].append((element, info))
        return info
    }

    private func children(_ element: AXUIElement) throws -> [AXUIElement] {
        try prepare(element)
        var count: CFIndex = 0
        let countStatus = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        try check(countStatus)
        guard countStatus == .success else { return [] }
        guard count <= limits.maximumNodes else { throw ActiveReadingCaptureError.limitExceeded(.nodes) }
        guard count > 0 else { return [] }
        try prepare(element)
        var output: CFArray?
        let status = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, count, &output)
        try check(status)
        guard status == .success, let values = output as? [AnyObject], values.count == count else {
            throw ActiveReadingCaptureError.noReadableContent
        }
        return try values.map {
            guard CFGetTypeID($0) == AXUIElementGetTypeID() else { throw ActiveReadingCaptureError.noReadableContent }
            return unsafeBitCast($0, to: AXUIElement.self)
        }
    }

    private func currentWebArea(window: AXUIElement, focusedPath: [AXUIElement]) throws -> AXUIElement? {
        // The outermost focused web area represents the page rather than just
        // an inner iframe. Only ancestors proven to reach this window qualify.
        var focusedWebAreas: [AXUIElement] = []
        for node in focusedPath {
            let info = try metadata(node)
            if !info.isExcluded, info.role == "AXWebArea" { focusedWebAreas.append(node) }
        }
        if let focused = focusedWebAreas.last { return focused }
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        var candidates: [AXUIElement] = []
        var visited: [Int: [AXUIElement]] = [:]
        while let (node, depth) = stack.popLast() {
            let hash = Int(bitPattern: CFHash(node))
            if visited[hash]?.contains(where: { CFEqual($0, node) }) == true { continue }
            visited[hash, default: []].append(node)
            let info = try metadata(node)
            guard !info.isExcluded else { continue }
            if info.role == "AXWebArea" {
                candidates.append(node)
                // Multiple page roots without a focused path are ambiguous;
                // never select a potentially background document by position.
                if candidates.count > 1 { throw ActiveReadingCaptureError.noReadableContent }
                continue
            }
            let descendants = try children(node)
            if depth >= limits.maximumDepth, !descendants.isEmpty { throw ActiveReadingCaptureError.limitExceeded(.depth) }
            stack.append(contentsOf: descendants.reversed().map { ($0, depth + 1) })
        }
        return candidates.first
    }

    private func pdfReference(in elements: [AXUIElement], useAXPageNumber: Bool = true) throws -> ActiveReadingPDFReference? {
        for node in elements {
            let info = try metadata(node)
            guard !info.isExcluded else { continue }
            let document = try string(node, kAXDocumentAttribute)
            let isDocument = ["AXWindow", "AXWebArea", "AXDocument", "AXPDF"].contains(info.role)
            let url = isDocument ? try string(node, kAXURLAttribute) : nil
            for raw in [document, url].compactMap({ $0 }) {
                if let reference = ActiveReadingURLPolicy.pdfReference(raw) {
                    var page = useAXPageNumber ? try explicitPage(in: elements) ?? reference.pageIndex : reference.pageIndex
                    if page == nil, useAXPageNumber, sourceBundleID == "com.apple.Preview" {
                        for candidate in elements where try metadata(candidate).role == "AXWindow" {
                            if let previewPage = ActiveReadingURLPolicy.previewWindowPage(
                                title: try string(candidate, kAXTitleAttribute), documentURL: reference.url) {
                                page = previewPage; break
                            }
                        }
                    }
                    return ActiveReadingPDFReference(url: reference.url, pageIndex: page)
                }
            }
        }
        return nil
    }

    private func explicitPage(in elements: [AXUIElement]) throws -> Int? {
        for node in elements {
            guard !(try metadata(node)).isExcluded,
                  let value = try value(node, "AXPageNumber") else { continue }
            if let string = value as? String, let page = ActiveReadingURLPolicy.pageIndex(string) { return page }
            if CFGetTypeID(value) != CFBooleanGetTypeID(), let number = value as? NSNumber,
               let page = ActiveReadingURLPolicy.pageIndex(number.stringValue) { return page }
        }
        return nil
    }

    private func findPDF(in root: AXUIElement) throws -> ActiveReadingPDFReference? {
        var stack: [(AXUIElement, Int)] = [(root, 0)]
        var visited: [Int: [AXUIElement]] = [:]
        while let (node, depth) = stack.popLast() {
            let hash = Int(bitPattern: CFHash(node))
            if visited[hash]?.contains(where: { CFEqual($0, node) }) == true { continue }
            visited[hash, default: []].append(node)
            let info = try metadata(node)
            guard !info.isExcluded else { continue }
            // Static leaf values, filenames, page labels and link destinations
            // are never read to infer a file or a current page number.
            if info.role == "AXStaticText" || info.role == "AXLink" { continue }
            // A discovered descendant may be a thumbnail, not the active page.
            // Its AXPageNumber is not evidence of the current physical page.
            if let reference = try pdfReference(in: [node], useAXPageNumber: false) { return reference }
            let descendants = try children(node)
            if depth >= limits.maximumDepth, !descendants.isEmpty { throw ActiveReadingCaptureError.limitExceeded(.depth) }
            stack.append(contentsOf: descendants.reversed().map { ($0, depth + 1) })
        }
        return nil
    }

    private func validate(window: AXUIElement, application: AXUIElement, pid: pid_t,
                          webArea: AXUIElement? = nil, documentURL: String? = nil) throws {
        guard try belongs(window, to: pid), let current = try currentWindow(application), CFEqual(window, current) else {
            throw ActiveReadingCaptureError.sourceChanged
        }
        if let webArea {
            let focused = try element(application, kAXFocusedUIElementAttribute)
            let path = try focusedPath(from: focused, in: window)
            guard let currentArea = try currentWebArea(window: window, focusedPath: path), CFEqual(webArea, currentArea),
                  try (string(currentArea, kAXURLAttribute) ?? string(currentArea, kAXDocumentAttribute)) == documentURL else {
                throw ActiveReadingCaptureError.sourceChanged
            }
        }
        guard !IsSecureEventInputEnabled() else { throw ActiveReadingCaptureError.secureInput }
    }
}

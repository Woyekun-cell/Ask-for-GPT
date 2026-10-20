import AppKit
import UniformTypeIdentifiers
import AskGPTCore

/// Delivers real, layout-preserving PDF copies to the app that owns the source.
/// It never creates an Ask for GPT PDF window or changes the original document.
@MainActor final class NativePDFTranslationController: NSObject {
    private let capture: ActiveReadingCapture
    private let store: NativePDFTranslationStore
    private var task: Task<Void, Never>?
    private var cancellationTask: Task<Void, Never>?
    private var translationTasks: [UUID: Task<Void, Never>] = [:]
    private var translationOperations: Set<UUID> = []
    private var documentOperations: [String: UUID] = [:]
    private var documentModes: [String: PDFLayoutOutputMode] = [:]
    private var operation = UUID()
    private var workspaceObserver: NSObjectProtocol?
    private var shortcutMonitor: Any?
    private var lastExternalPID: pid_t?
    private var panel: NSOpenPanel?
    private var stopped = false
    private var latestResult: NativePDFTranslationResult?
    private var latestSourcePID: pid_t?
    private(set) var selectedMode: PDFLayoutOutputMode = .mono
    private(set) var sourceLanguage = "en"
    private(set) var targetLanguage = "zh-Hans"
    var isTranslating: Bool { !translationOperations.isEmpty }
    var hasTranslation: Bool { latestResult != nil }

    var supportsCurrentReader: Bool {
        guard let application = sourceApplication(), !application.isTerminated,
              let bundleID = application.bundleIdentifier else { return false }
        return NativePDFReaderPolicy.supports(bundleID: bundleID)
    }

    init(capture: ActiveReadingCapture = ActiveReadingCapture(), store: NativePDFTranslationStore = NativePDFTranslationStore()) {
        self.capture = capture; self.store = store
        super.init()
    }

    func start() {
        guard workspaceObserver == nil, !stopped else { return }
        remember(NSWorkspace.shared.frontmostApplication)
        Task { [weak self, store] in
            let latest = await store.latestResult()
            guard let self, !stopped, latestResult == nil else { return }
            latestResult = latest
        }
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            Task { @MainActor [weak self] in self?.remember(app) }
        }
        shortcutMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // Read only this shortcut in the two explicitly supported readers.
            // The event is observed, never swallowed or registered globally.
            guard !event.isARepeat, let app = NSWorkspace.shared.frontmostApplication,
                  let bundleID = app.bundleIdentifier,
                  NativePDFReaderPolicy.matchesShortcut(bundleID: bundleID, keyCode: event.keyCode,
                    modifiers: event.modifierFlags.rawValue) else { return }
            let pid = app.processIdentifier
            Task { @MainActor [weak self] in self?.translateCurrent(processID: pid, whole: false) }
        }
    }

    func showCurrentPage() { translateCurrent(processID: sourcePID(), whole: false) }
    func showWholeDocument() { translateCurrent(processID: sourcePID(), whole: true) }

    func setOutputMode(_ mode: PDFLayoutOutputMode) {
        selectedMode = mode
        useCurrentOutput(mode: mode, original: false)
    }

    func setDirection(source: String, target: String) {
        guard ["en", "zh-Hans"].contains(source), ["en", "zh-Hans"].contains(target), source != target else { return }
        sourceLanguage = source; targetLanguage = target
    }

    func restoreOriginal() { useCurrentOutput(mode: selectedMode, original: true) }

    func showLatestTranslation() { presentLatest(original: false) }

    private func presentLatest(original: Bool) {
        guard let result = latestResult, !stopped else { return }
        cancelPresentation()
        let token = operation
        let pendingCancellation = cancellationTask
        task = Task { [weak self] in
            guard let self else { return }
            do {
                await pendingCancellation?.value
                let url = original ? result.originalURL : try await store.output(result, mode: selectedMode)
                try check(token)
                try await open(url, applicationURL: result.applicationURL, sourcePID: latestSourcePID, token: token)
            } catch is CancellationError {} catch {
                if operation == token { showError(error.localizedDescription) }
            }
            if operation == token { task = nil }
        }
    }

    func openPDF() { chooseFile(preferredApp: sourceApplication(), whole: false) }

    func cancel() {
        let app = sourceApplication()
        let candidates = documentOperations
        let previous = cancellationTask
        cancellationTask = Task { [weak self] in
            await previous?.value
            guard let self, !stopped else { return }
            if let app, let bundleID = app.bundleIdentifier,
               NativePDFReaderPolicy.supports(bundleID: bundleID),
               case .pdf(let url, _) = try? await capture.capture(processID: app.processIdentifier) {
                let prior = await store.result(forOutputURL: url)
                let key = documentKey(url: prior?.originalURL ?? url, bundleID: bundleID)
                if let token = candidates[key] { await cancelTranslation(token) }
            }
        }
    }

    private func cancelPresentation() {
        operation = UUID(); task?.cancel(); task = nil
        panel?.cancel(nil); panel = nil
    }

    private func cancelTranslation(_ token: UUID) async {
        translationTasks[token]?.cancel()
        finishTranslation(token)
        await store.cancel(operationID: token)
    }

    private func beginTranslation() -> UUID {
        let token = UUID()
        translationOperations.insert(token)
        return token
    }

    private func documentKey(url: URL, bundleID: String) -> String {
        bundleID + "\n" + url.standardizedFileURL.path
    }

    private func bindTranslation(_ token: UUID, url: URL, bundleID: String, mode: PDFLayoutOutputMode) -> String? {
        let key = documentKey(url: url, bundleID: bundleID)
        guard documentOperations[key] == nil || documentOperations[key] == token else { return nil }
        documentOperations[key] = token
        documentModes[key] = mode
        return key
    }

    private func finishTranslation(_ token: UUID) {
        translationOperations.remove(token)
        translationTasks.removeValue(forKey: token)
        for key in documentOperations.keys where documentOperations[key] == token { documentModes.removeValue(forKey: key) }
        documentOperations = documentOperations.filter { $0.value != token }
    }

    func shutdown() async {
        stopped = true
        if let workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver) }
        workspaceObserver = nil
        if let shortcutMonitor { NSEvent.removeMonitor(shortcutMonitor) }
        shortcutMonitor = nil
        cancelPresentation()
        let pending = Array(translationTasks.values)
        for task in pending { task.cancel() }
        translationTasks.removeAll(); translationOperations.removeAll(); documentOperations.removeAll()
        await store.cancel()
        for task in pending { await task.value }
        await cancellationTask?.value
    }

    private func remember(_ application: NSRunningApplication?) {
        guard let application, application.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              application.activationPolicy == .regular else { return }
        lastExternalPID = application.processIdentifier
    }

    private func sourcePID() -> pid_t? {
        remember(NSWorkspace.shared.frontmostApplication)
        return lastExternalPID
    }

    private func sourceApplication() -> NSRunningApplication? {
        sourcePID().flatMap(NSRunningApplication.init(processIdentifier:))
    }

    private func translateCurrent(processID: pid_t?, whole: Bool) {
        guard !stopped, let processID, let application = NSRunningApplication(processIdentifier: processID),
              let bundleID = application.bundleIdentifier, NativePDFReaderPolicy.supports(bundleID: bundleID),
              let appURL = application.bundleURL else {
            showError(NativePDFTranslationError.unsupportedReader.localizedDescription)
            return
        }
        let token = beginTranslation()
        let source = sourceLanguage, target = targetLanguage, mode = selectedMode
        translationTasks[token] = Task { [weak self] in
            guard let self else { return }
            defer { finishTranslation(token) }
            do {
                try check(token)
                let captured: ActiveReadingSource?
                do { captured = try await capture.capture(processID: processID) }
                catch let error as ActiveReadingCaptureError where [.unsupportedDocument, .noReadableContent].contains(error) {
                    try check(token)
                    chooseFile(preferredApp: application, whole: whole)
                    return
                }
                guard case .pdf(let capturedURL, let exposedPage) = captured else {
                    throw NativePDFTranslationError.unsupportedReader
                }
                try check(token)
                let prior = await store.result(forOutputURL: capturedURL)
                let originalURL = prior?.originalURL ?? capturedURL
                let document = try await PDFTranslationDocument.open(url: originalURL)
                try check(token)
                // Generated copies contain selected pages only. Map the current
                // physical page back to the original before making another job.
                let page: Int?
                if let prior, let exposedPage, prior.sourcePages.indices.contains(exposedPage) {
                    page = prior.sourcePages[exposedPage]
                } else if let prior, prior.sourcePages.count == 1 { page = prior.sourcePages.first }
                else { page = exposedPage }
                let scope: NativePDFTranslationScope
                if whole { scope = .wholeDocument }
                else if let page, (0..<document.pageCount).contains(page) { scope = .page(page) }
                else if document.pageCount == 1 { scope = .page(0) }
                else {
                    guard let chosen = chooseScope(count: document.pageCount) else { return }
                    try check(token)
                    scope = chosen
                }
                guard let key = bindTranslation(token, url: originalURL, bundleID: bundleID, mode: mode) else { return }
                let request = NativePDFTranslationRequest(sourceURL: originalURL, applicationURL: appURL,
                    applicationBundleID: bundleID, scope: scope, sourceLanguage: source, targetLanguage: target)
                let result = try await store.translate(request, mode: mode, operationID: token)
                try check(token)
                latestResult = result; latestSourcePID = processID
                let output = try await store.output(result, mode: documentModes[key] ?? mode)
                try check(token)
                try await open(output, applicationURL: appURL, sourcePID: processID,
                    token: token, expectedDocument: capturedURL)
            } catch is CancellationError {} catch {
                if translationOperations.contains(token) { showError(error.localizedDescription) }
            }
        }
    }

    private func useCurrentOutput(mode: PDFLayoutOutputMode, original: Bool) {
        guard !stopped else { return }
        guard let app = sourceApplication(), let id = app.bundleIdentifier,
              NativePDFReaderPolicy.supports(bundleID: id) else {
            presentLatest(original: original)
            return
        }
        cancelPresentation()
        let token = operation
        let pendingCancellation = cancellationTask
        task = Task { [weak self] in
            guard let self else { return }
            do {
                await pendingCancellation?.value
                try check(token)
                let result: NativePDFTranslationResult?
                var expectedDocument: URL?
                do {
                    if case .pdf(let url, _) = try await capture.capture(processID: app.processIdentifier) {
                        expectedDocument = url
                        let prior = await store.result(forOutputURL: url)
                        let originalURL = prior?.originalURL ?? url
                        let key = documentKey(url: originalURL, bundleID: id)
                        if documentOperations[key] != nil { documentModes[key] = mode }
                        if let prior { result = prior }
                        else { result = await store.latestResult(applicationBundleID: id, originalURL: originalURL) }
                    } else { result = nil }
                } catch is CancellationError { throw CancellationError() }
                catch { result = nil }
                guard let result, result.applicationBundleID == id else { return }
                try check(token)
                let destination = original ? result.originalURL : try await store.output(result, mode: mode)
                try check(token)
                try await open(destination, applicationURL: result.applicationURL, sourcePID: app.processIdentifier,
                    token: token, expectedDocument: expectedDocument)
            } catch is CancellationError {} catch {
                if operation == token { showError(error.localizedDescription) }
            }
            if operation == token { task = nil }
        }
    }

    private func chooseFile(preferredApp: NSRunningApplication?, whole: Bool) {
        cancelPresentation()
        let token = operation
        let openPanel = NSOpenPanel()
        openPanel.title = "在原阅读器打开保版译文"
        openPanel.prompt = "翻译"
        openPanel.allowedContentTypes = [.pdf]
        openPanel.allowsMultipleSelection = false; openPanel.canChooseDirectories = false
        let readers = ["com.apple.Preview", "com.kingsoft.wpsoffice.mac"].compactMap { bundleID -> (String, URL)? in
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return nil }
            return (bundleID, url)
        }
        let choices = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 240, height: 28))
        choices.addItems(withTitles: readers.map { $0.0 == "com.apple.Preview" ? "预览" : "WPS" })
        choices.setAccessibilityLabel("阅读器")
        if let index = readers.firstIndex(where: { $0.0 == preferredApp?.bundleIdentifier }) { choices.selectItem(at: index) }
        openPanel.accessoryView = choices
        openPanel.isAccessoryViewDisclosed = true
        panel = openPanel
        NSApp.activate(ignoringOtherApps: true)
        openPanel.begin { [weak self] response in
            Task { @MainActor [weak self] in
                guard let self, operation == token else { return }
                panel = nil
                guard response == .OK, let url = openPanel.url, readers.indices.contains(choices.indexOfSelectedItem) else { return }
                let reader = readers[choices.indexOfSelectedItem]
                let sourcePID = preferredApp?.bundleIdentifier == reader.0 ? preferredApp?.processIdentifier : nil
                let translationToken = beginTranslation()
                let source = sourceLanguage, target = targetLanguage, mode = selectedMode
                translationTasks[translationToken] = Task { [weak self] in
                    guard let self else { return }
                    defer { finishTranslation(translationToken) }
                    do {
                        let document = try await PDFTranslationDocument.open(url: url)
                        try check(translationToken)
                        let scope: NativePDFTranslationScope
                        if whole { scope = .wholeDocument }
                        else if document.pageCount == 1 { scope = .page(0) }
                        else {
                            guard let selected = chooseScope(count: document.pageCount) else { return }
                            try check(translationToken); scope = selected
                        }
                        guard let key = bindTranslation(translationToken, url: url, bundleID: reader.0, mode: mode) else { return }
                        let result = try await store.translate(.init(sourceURL: url, applicationURL: reader.1,
                            applicationBundleID: reader.0, scope: scope, sourceLanguage: source,
                            targetLanguage: target), mode: mode, operationID: translationToken)
                        try check(translationToken)
                        latestResult = result; latestSourcePID = sourcePID
                        let output = try await store.output(result, mode: documentModes[key] ?? mode)
                        try check(translationToken)
                        // File choice explicitly requests delivery to this app.
                        // Open in the background when focus has moved elsewhere.
                        try await open(output, applicationURL: reader.1, sourcePID: sourcePID, token: translationToken)
                    } catch is CancellationError {} catch {
                        if translationOperations.contains(translationToken) { showError(error.localizedDescription) }
                    }
                }
            }
        }
    }

    private func chooseScope(count: Int) -> NativePDFTranslationScope? {
        let alert = NSAlert()
        alert.messageText = "选择翻译范围"
        alert.informativeText = "共 \(count) 页。选择一页，或直接翻译整份。"
        let pages = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 240, height: 28))
        pages.addItems(withTitles: (1...count).map { "第 \($0) 页" })
        pages.setAccessibilityLabel("翻译页码")
        alert.accessoryView = pages
        alert.addButton(withTitle: "翻译此页")
        alert.addButton(withTitle: "翻译整份")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = pages
        switch alert.runModal() {
        case .alertFirstButtonReturn: return .page(pages.indexOfSelectedItem)
        case .alertSecondButtonReturn: return .wholeDocument
        default: return nil
        }
    }

    private func check(_ token: UUID) throws {
        try Task.checkCancellation()
        guard !stopped, token == operation || translationOperations.contains(token) else { throw CancellationError() }
    }

    private func open(_ url: URL, applicationURL: URL, sourcePID: pid_t?, token: UUID,
                      expectedDocument: URL? = nil) async throws {
        if let expectedDocument {
            guard let sourcePID else { return }
            let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let ownPID = ProcessInfo.processInfo.processIdentifier
            guard foreground == sourcePID || foreground == ownPID else { return }
            let observed: URL?
            do {
                if case .pdf(let current, _) = try await capture.capture(processID: sourcePID) { observed = current }
                else { observed = nil }
            } catch is CancellationError { throw CancellationError() }
            catch { return }
            try check(token)
            guard NativePDFPresentationPolicy.mayPresent(sourcePID: sourcePID,
                foregroundPID: NSWorkspace.shared.frontmostApplication?.processIdentifier, ownPID: ownPID,
                expectedDocument: expectedDocument, observedDocument: observed) else { return }
        }
        try check(token)
        let config = NSWorkspace.OpenConfiguration()
        let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        // A slow whole-document job must not steal focus from another app.
        config.activates = foreground == sourcePID || foreground == ProcessInfo.processInfo.processIdentifier
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            NSWorkspace.shared.open([url], withApplicationAt: applicationURL, configuration: config) { _, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    private func showError(_ message: String) {
        guard !stopped else { return }
        let alert = NSAlert(); alert.messageText = "PDF 翻译"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

import AppKit
import SwiftUI
import UniformTypeIdentifiers
import AskGPTCore
import os

/// Owns only the explicit page/document workflow. Selection watching never calls
/// this controller, and choosing a file never changes the original PDF.
@MainActor final class DocumentReadingController: NSObject, NSWindowDelegate {
    let store: DocumentReadingStore
    private let capture: ActiveReadingCapture
    private var window: NSWindow?
    private var captureTask: Task<Void, Never>?
    private var captureGeneration = UUID()
    private var openPanel: NSOpenPanel?
    private var workspaceObserver: NSObjectProtocol?
    private var lastExternalPID: pid_t?
    private var localClickMonitor: Any?
    private var globalClickMonitor: Any?
    private var clickMonitorGeneration = UUID()
    private let windowLog = Logger(subsystem: "local.askgpt.reader", category: "window")

    init(settingsProvider: @escaping @MainActor () -> CodexSettings,
         capture: ActiveReadingCapture = ActiveReadingCapture()) {
        self.store = DocumentReadingStore(settingsProvider: settingsProvider)
        self.capture = capture
        super.init()
        remember(NSWorkspace.shared.frontmostApplication)
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            Task { @MainActor [weak self] in self?.remember(application) }
        }
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

    private func showWindow() {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 650),
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "页面与全文翻译"
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.isMovable = true
            window.isMovableByWindowBackground = true
            window.titlebarAppearsTransparent = true
            window.backgroundColor = .clear
            window.isOpaque = false
            window.contentView = NSHostingView(rootView: DocumentReadingView(store: store,
                onOpenPDF: { [weak self] in self?.openPDF() },
                onCapture: { [weak self] in self?.showCurrentPage() }))
            window.contentMinSize = NSSize(width: 600, height: 420)
            window.setContentSize(NSSize(width: 760, height: 650))
            window.center()
            self.window = window
        }
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        startClickMonitors()
    }

    @discardableResult func restoreWindow() -> Bool {
        guard window != nil else { return false }
        showWindow()
        return true
    }

    func showCurrentPage() {
        // Capture the source PID before our own window takes focus. A click from
        // this app uses the last external app, never this window's translated text.
        let pid = sourcePID()
        cancelCapture()
        store.stop()
        showWindow()
        guard let pid else {
            store.reportSourceError("请先在浏览器或 PDF 阅读器打开原文，再读取当前页；也可以直接打开 PDF。")
            return
        }
        let generation = captureGeneration
        store.capturingSource = true
        store.sourceNote = ""
        let capture = capture
        captureTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if captureGeneration == generation {
                    captureTask = nil
                    store.capturingSource = false
                }
            }
            do {
                guard let source = try await capture.capture(processID: pid) else {
                    throw ReadingSourceError.notFound
                }
                try Task.checkCancellation()
                guard captureGeneration == generation else { return }
                switch source {
                case .pdf(let url, let pageIndex):
                    let document = try await PDFTranslationDocument.open(url: url)
                    let data = await document.originalPDFData()
                    try Task.checkCancellation()
                    guard captureGeneration == generation else { return }
                    let validPage = pageIndex.flatMap { (0..<document.pageCount).contains($0) ? $0 : nil }
                    store.load(document, currentPageIndex: validPage ?? 0, pdfData: data)
                    if validPage == nil {
                        store.sourceNote = "阅读器未提供页码，已从第1页打开；可在上方调整。"
                    }
                case .webpage(let title, let url, let text):
                    let document = try WebTranslationDocument(text: text, title: title, url: url)
                    guard captureGeneration == generation else { return }
                    store.load(document, currentPageIndex: 0)
                }
            } catch is CancellationError {
                // Closing or choosing another source owns the next UI state.
            } catch {
                if captureGeneration == generation { store.reportSourceError(error.localizedDescription) }
            }
        }
    }

    func openPDF() {
        cancelCapture()
        showWindow()
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.title = "打开 PDF 对照翻译"
        panel.prompt = "打开"
        panel.allowedContentTypes = [.pdf]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        openPanel = panel
        let generation = captureGeneration
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor [weak self] in
                guard let self, captureGeneration == generation, self.window?.isVisible == true else { return }
                openPanel = nil
                loadPDF(url)
            }
        }
    }

    private func loadPDF(_ url: URL) {
        cancelCapture()
        store.stop()
        store.capturingSource = true
        store.sourceNote = ""
        let generation = captureGeneration
        captureTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if captureGeneration == generation {
                    captureTask = nil
                    store.capturingSource = false
                }
            }
            do {
                let document = try await PDFTranslationDocument.open(url: url)
                let data = await document.originalPDFData()
                try Task.checkCancellation()
                guard captureGeneration == generation else { return }
                store.load(document, currentPageIndex: 0, pdfData: data)
            } catch is CancellationError {} catch {
                if captureGeneration == generation { store.reportSourceError(error.localizedDescription) }
            }
        }
    }

    private func cancelCapture() {
        captureGeneration = UUID()
        openPanel?.cancel(nil)
        openPanel = nil
        captureTask?.cancel()
        captureTask = nil
        store.capturingSource = false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        stopClickMonitors()
        cancelCapture()
        store.stop()
        return true
    }

    private func dismissWindow() {
        stopClickMonitors()
        cancelCapture()
        store.stop()
        window?.orderOut(nil)
        windowLog.info("Document window hidden after outside click; visible=\(self.window?.isVisible ?? false, privacy: .public)")
    }

    private func startClickMonitors() {
        stopClickMonitors()
        guard let window, window.isVisible, !window.isMiniaturized else { return }
        let generation = clickMonitorGeneration
        let events: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: events) { [weak self] event in
            let windowNumber = event.windowNumber
            // Menu-bar events have no ordinary target; popup/context menus use
            // menu-level windows. Snapshot that before their tracking ends.
            let isMenuWindow = (event.window?.level.rawValue ?? 0) >= NSWindow.Level.mainMenu.rawValue
            if event.window != nil, windowNumber > 0, !isMenuWindow {
                Task { @MainActor [weak self] in
                    self?.handleMouseDown(windowNumber: windowNumber, generation: generation)
                }
            }
            return event
        }
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: events) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleMouseDown(windowNumber: nil, generation: generation)
            }
        }
    }

    private func handleMouseDown(windowNumber: Int?, generation: UUID) {
        guard generation == clickMonitorGeneration else { return }
        guard let window, window.isVisible, !window.isMiniaturized else {
            stopClickMonitors()
            return
        }
        // The native file picker belongs to this reader, including its popups.
        guard window.attachedSheet == nil, NSApp.modalWindow == nil else { return }
        guard windowNumber != window.windowNumber else { return }
        dismissWindow()
    }

    private func stopClickMonitors() {
        clickMonitorGeneration = UUID()
        if let localClickMonitor { NSEvent.removeMonitor(localClickMonitor) }
        if let globalClickMonitor { NSEvent.removeMonitor(globalClickMonitor) }
        localClickMonitor = nil
        globalClickMonitor = nil
    }

    func windowDidMiniaturize(_ notification: Notification) { stopClickMonitors() }
    func windowDidDeminiaturize(_ notification: Notification) { startClickMonitors() }

    func shutdown() async {
        stopClickMonitors()
        cancelCapture()
        if let workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver)
            self.workspaceObserver = nil
        }
        await store.shutdown()
    }

    deinit {
        if let localClickMonitor { NSEvent.removeMonitor(localClickMonitor) }
        if let globalClickMonitor { NSEvent.removeMonitor(globalClickMonitor) }
    }
}

private enum ReadingSourceError: LocalizedError {
    case notFound
    var errorDescription: String? {
        "未读到当前网页正文或 PDF 地址。请切回原文重试，或选择“打开 PDF”。"
    }
}

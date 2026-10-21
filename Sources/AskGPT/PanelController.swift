import AppKit
import SwiftUI
import AskGPTCore
import os

final class ReaderPanel: NSPanel {
    var onClose: (() -> Void)?
    private let windowLog = Logger(subsystem: "local.askgpt.reader", category: "window")
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { !styleMask.contains(.nonactivatingPanel) }
    override func cancelOperation(_ sender: Any?) { close() }
    override func close() {
        onClose?()
        orderOut(nil)
        windowLog.info("Window hidden; visible=\(self.isVisible, privacy: .public)")
    }
}

@MainActor final class PanelController: NSObject, NSToolbarDelegate, NSWindowDelegate {
    var onOpenDocument: (() -> Void)?
    private let store: ReaderStore
    private let capture: SelectionCapture
    private var reader: ReaderPanel!
    private var settings: NSWindow?
    private var translation: ReaderPanel?
    private var translationLocalClickMonitor: Any?
    private var translationGlobalClickMonitor: Any?
    private var translationMonitorGeneration = UUID()
    private var translationTrackingMenus = Set<ObjectIdentifier>()
    private var shortcutCaptureTask: Task<Void, Never>?
    private var shortcutCaptureGeneration = UUID()
    private let windowLog = Logger(subsystem: "local.askgpt.reader", category: "window")

    init(store: ReaderStore, capture: SelectionCapture) {
        self.store = store; self.capture = capture
        super.init()
        reader = ReaderPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 490),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        reader.title = "Ask ChatGPT"
        reader.isReleasedWhenClosed = false
        reader.delegate = self
        reader.onClose = { [weak self] in self?.cancelPendingShortcutCapture() }
        reader.level = .floating
        reader.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let toolbar = NSToolbar(identifier: "AskGPTReader.toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        reader.toolbarStyle = .unifiedCompact
        reader.toolbar = toolbar
        let readerContent = NSHostingView(rootView: ReaderView(store: store))
        readerContent.sizingOptions = [.minSize]
        reader.contentView = readerContent
        reader.contentMinSize = NSSize(width: 380, height: 400)
        applyGlass(to: reader)
        reader.setContentSize(NSSize(width: 400, height: 490))
        NotificationCenter.default.addObserver(self, selector: #selector(translationMenuDidBeginTracking(_:)),
            name: NSMenu.didBeginTrackingNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(translationMenuDidEndTracking(_:)),
            name: NSMenu.didEndTrackingNotification, object: nil)
    }

    func showQuestion(with explicit: CapturedSelection? = nil) {
        cancelPendingShortcutCapture()
        let selection = explicit ?? capture.capture() ?? store.automaticExcerpt.map {
            CapturedSelection(excerpt: $0, anchor: nil)
        }
        presentQuestion(selection)
    }

    func showShortcutQuestion() { beginShortcutCapture(question: true) }
    func showShortcutTranslation() { beginShortcutCapture(question: false) }

    private func beginShortcutCapture(question: Bool) {
        cancelPendingShortcutCapture()
        let generation = shortcutCaptureGeneration
        shortcutCaptureTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let selected = await capture.captureForShortcut()
            guard !Task.isCancelled, generation == shortcutCaptureGeneration else { return }
            // Presentation dismisses the old translation panel. Clear the task
            // first so that dismissal cannot cancel this successful capture.
            shortcutCaptureTask = nil
            if question {
                let selection = selected ?? store.automaticExcerpt.map { CapturedSelection(excerpt: $0) }
                presentQuestion(selection)
            } else { presentManualTranslation(selected) }
        }
    }

    private func cancelPendingShortcutCapture() {
        shortcutCaptureGeneration = UUID()
        shortcutCaptureTask?.cancel()
        shortcutCaptureTask = nil
    }

    private func presentQuestion(_ selection: CapturedSelection?) {
        dismissTranslation()
        if let selection { store.adopt(selection.excerpt) }
        if reader.isMiniaturized { reader.deminiaturize(nil) }
        place(reader, anchor: selection?.anchor)
        NSApp.activate(ignoringOtherApps: true)
        reader.makeKeyAndOrderFront(nil)
        store.refreshPermission()
    }

    func showSettings() {
        cancelPendingShortcutCapture()
        if settings == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 544, height: 472), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Ask for GPT · 设置"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: SettingsView(store: store))
            applyGlass(to: window)
            window.center(); settings = window
        }
        NSApp.activate(ignoringOtherApps: true)
        if settings?.isMiniaturized == true { settings?.deminiaturize(nil) }
        settings?.makeKeyAndOrderFront(nil)
    }

    func showAutomatic(_ selection: CapturedSelection) {
        guard store.automaticEnabled else { return }
        store.translateAutomatic(selection.excerpt)
        presentTranslation(anchor: selection.anchor)
    }

    func showTranslation(with explicit: CapturedSelection? = nil) {
        cancelPendingShortcutCapture()
        let selection = explicit ?? capture.capture()
        presentManualTranslation(selection)
    }

    private func presentManualTranslation(_ selection: CapturedSelection?) {
        if let selection { store.translateSelection(selection.excerpt) }
        else { store.prepareManualTranslationInput() }
        presentTranslation(anchor: selection?.anchor)
        if selection == nil {
            NSApp.activate(ignoringOtherApps: true)
            translation?.makeKeyAndOrderFront(nil)
        }
    }

    private func presentTranslation(anchor: CGRect?) {
        if translation == nil {
            let panel = ReaderPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 250), styleMask: [.nonactivatingPanel, .titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            panel.title = "划词翻译"
            panel.isMovable = true
            panel.isMovableByWindowBackground = true
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.isReleasedWhenClosed = false
            panel.delegate = self
            panel.onClose = { [weak self] in self?.dismissTranslation() }
            let translationContent = NSHostingView(rootView: AutomaticTranslationView(store: store,
                ask: { [weak self] in self?.askAboutTranslation() },
                openDocument: { [weak self] in self?.onOpenDocument?() }))
            translationContent.sizingOptions = [.minSize]
            panel.contentView = translationContent
            panel.contentMinSize = NSSize(width: 320, height: 200)
            applyGlass(to: panel)
            panel.setContentSize(NSSize(width: 360, height: 250))
            translation = panel
        }
        if translation?.isMiniaturized == true { translation?.deminiaturize(nil) }
        place(translation!, anchor: anchor)
        translation?.orderFrontRegardless()
        startTranslationClickMonitors()
    }

    func askAboutTranslation() {
        guard let excerpt = store.automaticExcerpt else { return }
        showQuestion(with: CapturedSelection(excerpt: excerpt, anchor: nil))
    }

    func hideAutomatic() { dismissTranslation() }

    private func dismissTranslation() {
        cancelPendingShortcutCapture()
        stopTranslationClickMonitors()
        translation?.orderOut(nil)
        store.cancelAutomatic()
    }

    private func startTranslationClickMonitors() {
        stopTranslationClickMonitors()
        guard let translation, translation.isVisible, !translation.isMiniaturized else { return }
        let generation = translationMonitorGeneration
        let events: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        translationLocalClickMonitor = NSEvent.addLocalMonitorForEvents(matching: events) { [weak self] event in
            // AppKit runs both monitors on the main thread. Classify before
            // dispatch can enter a drag/menu loop and move the window.
            MainActor.assumeIsolated {
                self?.handleTranslationMouseDown(event, isGlobal: false, generation: generation)
            }
            // Observe the click while allowing the original target to receive it.
            return event
        }
        translationGlobalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: events) { [weak self] event in
            MainActor.assumeIsolated {
                self?.handleTranslationMouseDown(event, isGlobal: true, generation: generation)
            }
        }
    }

    static func translationContainsMouseDown(_ event: NSEvent, panel: NSWindow, isGlobal: Bool,
                                             menuIsTracking: Bool = false) -> Bool {
        if event.windowNumber == panel.windowNumber { return true }
        if let target = event.window ?? NSApp.window(withWindowNumber: event.windowNumber) {
            var ancestor: NSWindow? = target
            while let window = ancestor {
                if window === panel { return true }
                ancestor = window.parent ?? window.sheetParent
            }
            if !isGlobal && target.level.rawValue >= NSWindow.Level.mainMenu.rawValue { return true }
            // A known different app window remains outside even if it overlaps.
            return false
        }
        // Native menus may be hosted outside this process and have no NSWindow.
        if menuIsTracking { return true }
        // For a windowless mouse event, locationInWindow is a screen point.
        return panel.frame.contains(event.locationInWindow)
    }

    @objc private func translationMenuDidBeginTracking(_ notification: Notification) {
        guard translation?.isVisible == true, let menu = notification.object as? NSMenu else { return }
        translationTrackingMenus.insert(ObjectIdentifier(menu))
    }

    @objc private func translationMenuDidEndTracking(_ notification: Notification) {
        guard let menu = notification.object as? NSMenu else { return }
        translationTrackingMenus.remove(ObjectIdentifier(menu))
    }

    private func handleTranslationMouseDown(_ event: NSEvent, isGlobal: Bool, generation: UUID) {
        guard generation == translationMonitorGeneration else { return }
        guard let translation, translation.isVisible, !translation.isMiniaturized else {
            stopTranslationClickMonitors()
            return
        }
        if Self.translationContainsMouseDown(event, panel: translation, isGlobal: isGlobal,
                                             menuIsTracking: !translationTrackingMenus.isEmpty) { return }
        dismissTranslation()
    }

    private func stopTranslationClickMonitors() {
        translationMonitorGeneration = UUID()
        translationTrackingMenus.removeAll()
        if let translationLocalClickMonitor { NSEvent.removeMonitor(translationLocalClickMonitor) }
        if let translationGlobalClickMonitor { NSEvent.removeMonitor(translationGlobalClickMonitor) }
        translationLocalClickMonitor = nil
        translationGlobalClickMonitor = nil
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        shortcutCaptureTask?.cancel()
        if let translationLocalClickMonitor { NSEvent.removeMonitor(translationLocalClickMonitor) }
        if let translationGlobalClickMonitor { NSEvent.removeMonitor(translationGlobalClickMonitor) }
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .init("AskGPTReader.settings")]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .init("AskGPTReader.settings")]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard identifier.rawValue == "AskGPTReader.settings" else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = "设置"
        item.toolTip = "设置"
        item.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: "设置")
        item.target = self
        item.action = #selector(openSettingsFromToolbar)
        return item
    }

    @objc private func openSettingsFromToolbar() { showSettings() }

    private func applyGlass(to window: NSWindow) {
        window.isOpaque = false
        window.backgroundColor = .clear
        window.titlebarAppearsTransparent = false
        window.titleVisibility = .visible
        window.titlebarSeparatorStyle = .automatic
        window.hasShadow = true
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(type)?.isHidden = false
            let mask: NSWindow.StyleMask = type == .closeButton ? .closable : (type == .miniaturizeButton ? .miniaturizable : .resizable)
            window.standardWindowButton(type)?.isEnabled = window.styleMask.contains(mask)
        }
        if let panel = window as? NSPanel { panel.hidesOnDeactivate = false }
    }

    // Fixed lifecycle events only; never log selections, questions, or responses.
    func windowDidMiniaturize(_ notification: Notification) {
        cancelPendingShortcutCapture()
        if let window = notification.object as? NSWindow, window === translation { stopTranslationClickMonitors() }
        windowLog.info("Window miniaturized")
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window === translation { startTranslationClickMonitors() }
        windowLog.info("Window restored from miniaturization")
    }

    private func place(_ window: NSWindow, anchor: CGRect?) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let screen else { return }
        let visible = screen.visibleFrame
        let top = NSScreen.screens.first?.frame.maxY ?? visible.maxY
        let point = anchor.map { NSPoint(x: $0.minX, y: top - $0.maxY) } ?? mouse
        let width = window.frame.width, height = window.frame.height
        let x = min(max(point.x + 12, visible.minX + 8), visible.maxX - width - 8)
        let y = min(max(point.y - height - 10, visible.minY + 8), visible.maxY - height - 8)
        window.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

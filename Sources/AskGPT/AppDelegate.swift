import AppKit
import AskGPTCore

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var store: ReaderStore!
    private var panels: PanelController!
    private var nativePDFs: NativePDFTranslationController!
    private var inlinePages: InlineIntegrationController!
    private var writing: WritingIntegrationController!
    private let capture = SelectionCapture()
    private let hotKey = GlobalHotKey()
    private let questionHotKey = GlobalHotKey()
    private var watcher: SelectionWatcher!
    private var menu: NSMenu!
    private var automaticItem: NSMenuItem!
    private var documentItem: NSMenuItem!
    private var registeredTranslationSpec: HotKeySpec?
    private var terminationReplied = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installApplicationMenu()
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AskGPTReader", isDirectory: true)
        let integration = EasydictIntegration(backupDirectory: directory.appendingPathComponent("EasydictBackup", isDirectory: true))
        store = ReaderStore(capture: capture, integration: integration)
        panels = PanelController(store: store, capture: capture)
        nativePDFs = NativePDFTranslationController()
        nativePDFs.start()
        inlinePages = InlineIntegrationController()
        inlinePages.start()
        writing = WritingIntegrationController(settingsProvider: { [weak store] in
            store?.appliedSettings ?? CodexSettings()
        })
        writing.start()
        panels.onOpenDocument = { [weak self] in self?.openPageTranslation() }
        watcher = SelectionWatcher(capture: capture) { [weak self] selection in
            guard let self else { return }
            if self.store.automaticEnabled { self.panels.showAutomatic(selection) }
            else { self.store.prefetchTranslation(selection.excerpt) }
        }
        store.onHotKeyChanged = { [weak self] spec in
            guard let self else { return }
            try self.registerTranslationShortcut(spec)
        }
        store.onAutomaticModeChanged = { [weak self] enabled in
            guard let self else { return }
            self.automaticItem.state = enabled ? .on : .off
            if enabled { self.watcher.start() }
            else { self.panels.hideAutomatic() }
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "text.bubble", accessibilityDescription: "Ask for GPT")
        menu = NSMenu()
        menu.delegate = self
        addMenu("翻译  \(store.hotKey.displayName)", action: #selector(openTranslation))
        addMenu("Ask ChatGPT  \(HotKeySpec.questionSpec.displayName)", action: #selector(openReader))
        documentItem = addMenu("页面内翻译…", action: #selector(openInlinePages))
        let pdfMenuItem = NSMenuItem(title: "PDF · 原阅读器", action: nil, keyEquivalent: "")
        pdfMenuItem.submenu = makeNativePDFMenu()
        menu.addItem(pdfMenuItem)
        addMenu("Word / WPS 写作检查…", action: #selector(openWriting))
        automaticItem = addMenu("选中即自动翻译", action: #selector(toggleAutomatic))
        addMenu("打开 Easydict", action: #selector(openEasydict))
        menu.addItem(.separator())
        addMenu("设置…", action: #selector(openSettings))
        addMenu("退出", action: #selector(quit))
        statusItem.menu = menu
        do { try questionHotKey.register(.questionSpec) { [weak self] in self?.panels.showShortcutQuestion() } }
        catch { store.errorMessage = error.localizedDescription }
        do { try registerTranslationShortcut(store.hotKey, restoringSavedShortcut: true) }
        catch { store.errorMessage = error.localizedDescription }
        watcher.start()
        store.connect()
        // A manual launch should provide an editable window even after first use.
        if !CommandLine.arguments.contains("--background") { panels.showTranslation() }
        if CommandLine.arguments.contains("--settings") { panels.showSettings() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.contains(where: { $0.absoluteString == "askgpt://connect" }) else { return }
        // A targeted background launch retries the existing local services;
        // it carries no document text and does not open a translation panel.
        inlinePages?.start()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Re-activating an already visible reader must not capture a different
        // selection or discard its current translation.
        if !flag { panels.showTranslation() }
        return true
    }

    // Accessory applications still need a main menu for Cocoa's standard key
    // equivalents. Without Edit, NSTextView cannot dispatch Command-V/C/A.
    private func installApplicationMenu() {
        let bar = NSMenu()
        let appItem = NSMenuItem()
        bar.addItem(appItem)
        let appMenu = NSMenu(title: "Ask for GPT")
        let settingsItem = appMenu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Ask for GPT", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Ask for GPT", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        bar.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let windowItem = NSMenuItem()
        bar.addItem(windowItem)
        let window = NSMenu(title: "窗口")
        let inlineItem = window.addItem(withTitle: "页面内翻译…", action: #selector(openInlinePages), keyEquivalent: "")
        inlineItem.target = self
        let writingItem = window.addItem(withTitle: "Word / WPS 写作检查…", action: #selector(openWriting), keyEquivalent: "")
        writingItem.target = self
        let pdfItem = NSMenuItem(title: "PDF · 原阅读器", action: nil, keyEquivalent: "")
        pdfItem.submenu = makeNativePDFMenu()
        window.addItem(pdfItem)
        window.addItem(.separator())
        window.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        window.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = window
        NSApp.mainMenu = bar
        NSApp.windowsMenu = window
    }

    private func registerTranslationShortcut(_ spec: HotKeySpec, restoringSavedShortcut: Bool = false) throws {
        guard spec != .questionSpec,
              restoringSavedShortcut || spec != .readingSpec || spec == registeredTranslationSpec else {
            throw ReaderError.message("\(spec.displayName) 已用于提问或页面对照，请选择其他翻译快捷键。")
        }
        try hotKey.register(spec) { [weak self] in self?.panels.showShortcutTranslation() }
        registeredTranslationSpec = spec
        menu?.items.first?.title = "翻译  \(spec.displayName)"
        // The foreground browser/Zotero addon owns Option+Shift+X so it can
        // obtain the current page's permission and render inside that page.
        // A saved custom selection shortcut still retains its existing priority.
        documentItem?.title = "页面内翻译…"
    }

    @discardableResult private func addMenu(_ title: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self; menu.addItem(item); return item
    }
    @objc private func openTranslation() { panels.showShortcutTranslation() }
    @objc private func openReader() { panels.showShortcutQuestion() }
    @objc private func openInlinePages() { inlinePages.showSetup() }
    private func openPageTranslation() {
        if nativePDFs.supportsCurrentReader { nativePDFs.showCurrentPage() }
        else { inlinePages.showSetup() }
    }
    @objc private func openWriting() { writing.showSetup() }
    @objc private func openDocument() { nativePDFs.showCurrentPage() }
    @objc private func openWholeDocument() { nativePDFs.showWholeDocument() }
    @objc private func openPDF() { nativePDFs.openPDF() }
    @objc private func showMonoPDF() { nativePDFs.setOutputMode(.mono) }
    @objc private func showDualPDF() { nativePDFs.setOutputMode(.dual) }
    @objc private func restoreOriginalPDF() { nativePDFs.restoreOriginal() }
    @objc private func cancelPDFTranslation() { nativePDFs.cancel() }
    @objc private func showLatestPDFTranslation() { nativePDFs.showLatestTranslation() }
    @objc private func translatePDFToChinese() { nativePDFs.setDirection(source: "en", target: "zh-Hans") }
    @objc private func translatePDFToEnglish() { nativePDFs.setDirection(source: "zh-Hans", target: "en") }

    private func makeNativePDFMenu() -> NSMenu {
        let result = NSMenu(title: "PDF · 原阅读器")
        result.autoenablesItems = false
        result.delegate = self
        for (title, action) in [("翻译本页  ⌥⇧X", #selector(openDocument)),
                                ("翻译整份", #selector(openWholeDocument)),
                                ("选择 PDF…", #selector(openPDF))] {
            result.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
        }
        result.addItem(.separator())
        for (title, action) in [("只看译文", #selector(showMonoPDF)), ("原文＋译文", #selector(showDualPDF)),
                                ("EN → 中", #selector(translatePDFToChinese)), ("中 → EN", #selector(translatePDFToEnglish))] {
            result.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
        }
        result.addItem(.separator())
        result.addItem(withTitle: "打开最近译文", action: #selector(showLatestPDFTranslation), keyEquivalent: "").target = self
        result.addItem(withTitle: "恢复原文", action: #selector(restoreOriginalPDF), keyEquivalent: "").target = self
        result.addItem(withTitle: "取消翻译", action: #selector(cancelPDFTranslation), keyEquivalent: "").target = self
        return result
    }

    func menuWillOpen(_ menu: NSMenu) {
        guard let nativePDFs else { return }
        for item in menu.items {
            if item.action == #selector(showMonoPDF) { item.state = nativePDFs.selectedMode == .mono ? .on : .off }
            if item.action == #selector(showDualPDF) { item.state = nativePDFs.selectedMode == .dual ? .on : .off }
            if item.action == #selector(cancelPDFTranslation) { item.isEnabled = nativePDFs.isTranslating }
            if item.action == #selector(showLatestPDFTranslation) { item.isEnabled = nativePDFs.hasTranslation }
            if item.action == #selector(translatePDFToChinese) { item.state = nativePDFs.sourceLanguage == "en" ? .on : .off }
            if item.action == #selector(translatePDFToEnglish) { item.state = nativePDFs.sourceLanguage == "zh-Hans" ? .on : .off }
        }
    }
    @objc private func openSettings() { panels.showSettings() }
    @objc private func toggleAutomatic() { store.setAutomatic(!store.automaticEnabled) }
    @objc private func openEasydict() { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Easydict.app")) }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        watcher.stop(); hotKey.unregister(); questionHotKey.unregister()
        panels.hideAutomatic()
        Task { [weak self] in
            guard let self else { return }
            async let selectionShutdown: Void = self.store.shutdown()
            async let documentShutdown: Void = self.nativePDFs.shutdown()
            async let inlineShutdown: Void = self.inlinePages.shutdown()
            async let writingShutdown: Void = self.writing.shutdown()
            _ = await (selectionShutdown, documentShutdown, inlineShutdown, writingShutdown)
            self.finishTermination()
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            self?.finishTermination()
        }
        return .terminateLater
    }
    private func finishTermination() {
        guard !terminationReplied else { return }
        terminationReplied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }
}

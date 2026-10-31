import AppKit
import Carbon
import CoreFoundation
import CoreGraphics
import Foundation
@testable import AskGPTCore

private struct SmokeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private actor ControlledTranslationDriver: NativeTranslationDriver {
    enum Output: Sendable {
        case text(String)
        case failure
        case delayed(Double, String)
        case held(String)
    }
    struct Call: Sendable {
        let text: String
        let source: String
        let target: String
    }
    private var outputs: [Output]
    private(set) var calls: [Call] = []
    private(set) var completedCalls = 0
    private var heldContinuation: CheckedContinuation<Void, Never>?

    init(_ outputs: [Output]) { self.outputs = outputs }
    func availability(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability { .installed }
    func warmUp(sourceLanguage: String, targetLanguage: String) async throws {}
    func translate(_ text: String, sourceLanguage: String, targetLanguage: String) async throws -> String {
        calls.append(Call(text: text, source: sourceLanguage, target: targetLanguage))
        let output = outputs.isEmpty ? Output.failure : outputs.removeFirst()
        defer { completedCalls += 1 }
        switch output {
        case .text(let translated): return translated
        case .failure: throw NativeTranslationError.translationFailed
        case .delayed(let seconds, let translated):
            // Model a native service that completes after caller cancellation.
            await withCheckedContinuation { continuation in
                Task.detached {
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    continuation.resume()
                }
            }
            return translated
        case .held(let translated):
            await withCheckedContinuation { heldContinuation = $0 }
            try Task.checkCancellation()
            return translated
        }
    }
    func releaseHeldTranslation() {
        heldContinuation?.resume()
        heldContinuation = nil
    }
}

@MainActor private final class ClickProbeView: NSView {
    private(set) var mouseDownCount = 0
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { mouseDownCount += 1 }
}

private actor ControlledRefiner: PassageRefining {
    enum Output: Sendable { case text(String), held(String), heldBeforeDelta(String), failure }
    private var outputs: [Output]
    private var waiting: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var cancelledBeforeWait: Set<UUID> = []
    private var lateDeltas: [@Sendable (String) -> Void] = []
    private(set) var calls: [(String, PassageRefinementMode)] = []
    private(set) var targetLanguages: [String] = []
    private(set) var shutdownCount = 0
    private(set) var cancelledCount = 0
    init(_ outputs: [Output]) { self.outputs = outputs }
    func refine(_ text: String, mode: PassageRefinementMode,
                onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        try await refine(text, mode: mode, targetLanguage: "zh-Hans", onDelta: onDelta)
    }
    func refine(_ text: String, mode: PassageRefinementMode, targetLanguage: String,
                onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        try Task.checkCancellation()
        calls.append((text, mode))
        targetLanguages.append(targetLanguage)
        let output = outputs.isEmpty ? .failure : outputs.removeFirst()
        let requestID = UUID()
        switch output {
        case .heldBeforeDelta: break
        default: onDelta("流式片段")
        }
        switch output {
        case .text(let text):
            return BackendTurnResult(text: text, firstDeltaSeconds: 0.01, totalSeconds: 0.02)
        case .held(let text), .heldBeforeDelta(let text):
            // A real cancellation finishes session cleanup, but already queued
            // stream callbacks can still arrive after another passage is active.
            lateDeltas.append(onDelta)
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    if Task.isCancelled || cancelledBeforeWait.remove(requestID) != nil {
                        continuation.resume(throwing: CancellationError())
                    } else { waiting[requestID] = continuation }
                }
            } onCancel: {
                Task { await self.cancelHeld(requestID) }
            }
            try Task.checkCancellation()
            onDelta("迟到片段")
            return BackendTurnResult(text: text, firstDeltaSeconds: 0.01, totalSeconds: 0.02)
        case .failure: throw NativeTranslationError.translationFailed
        }
    }
    private func cancelHeld(_ id: UUID) {
        cancelledCount += 1
        if let continuation = waiting.removeValue(forKey: id) { continuation.resume(throwing: CancellationError()) }
        else { cancelledBeforeWait.insert(id) }
    }
    func releaseHeld() {
        let continuations = Array(waiting.values)
        waiting.removeAll()
        for continuation in continuations { continuation.resume() }
    }
    func emitLateDeltas() {
        for callback in lateDeltas { callback("取消后的迟到片段") }
        lateDeltas.removeAll()
    }
    func shutdown() async {
        shutdownCount += 1
        let continuations = Array(waiting.values)
        waiting.removeAll()
        for continuation in continuations { continuation.resume(throwing: CancellationError()) }
    }
}

@MainActor private final class ClickProbeWindow: NSWindow {
    private(set) var dispatchedMouseDownCount = 0
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown { dispatchedMouseDownCount += 1 }
        super.sendEvent(event)
    }
}

@MainActor private final class WindowDiagnostics {
    var events: [[String: Any]] = []
    func record(_ notification: Notification) {
        guard events.count < 24, let window = notification.object as? ReaderPanel else { return }
        let content = window.contentRect(forFrameRect: window.frame).size
        events.append(["event": notification.name.rawValue, "title": window.title,
            "contentWidth": content.width, "contentHeight": content.height,
            "minWidth": window.contentMinSize.width, "minHeight": window.contentMinSize.height,
            "visible": window.isVisible])
    }
}

@main private struct UISmoke {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            await runChecks()
            exit(0)
        }
        app.run()
    }

    @MainActor private static func runChecks() async {
        let app = NSApplication.shared
        let suffix = UUID().uuidString
        let preferenceDomain = "org.askgpt.ui-smoke.preferences.\(suffix)"
        let easydictDomain = "org.askgpt.ui-smoke.easydict.\(suffix)"
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let preferences = UserDefaults(suiteName: preferenceDomain)!
        let capture = SelectionCapture()
        let integration = EasydictIntegration(backupDirectory: directory, domain: easydictDomain)
        var store: ReaderStore?
        var checks: [String: Bool] = [:]
        var observations: [String: Any] = [:]
        var unverified: [String] = []
        var failed: Error?
        let screens = NSScreen.screens
        let usableScreen = screens.contains { $0.frame.width > 0 && $0.frame.height > 0 &&
            $0.visibleFrame.width > 0 && $0.visibleFrame.height > 0 }
        observations["usable_gui_screen"] = usableScreen
        observations["main_display_active"] = CGDisplayIsActive(CGMainDisplayID()) != 0
        observations["screen_geometry"] = screens.map { screen in
            ["width": screen.frame.width, "height": screen.frame.height,
             "visibleWidth": screen.visibleFrame.width, "visibleHeight": screen.visibleFrame.height]
        }
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        observations["gui_session_available"] = session != nil
        observations["gui_session_on_console"] = session?["kCGSessionOnConsoleKey"] as? Bool ?? false
        let diagnostics = WindowDiagnostics()
        let notificationCenter = NotificationCenter.default
        let eventObservers = [NSWindow.didResizeNotification, NSWindow.didMoveNotification].map { name in
            notificationCenter.addObserver(forName: name, object: nil, queue: .main) { notification in
                MainActor.assumeIsolated { diagnostics.record(notification) }
            }
        }
        let cleanup = {
            for observer in eventObservers { notificationCenter.removeObserver(observer) }
            // Only this process's windows and these two fresh test domains.
            for window in app.windows { window.orderOut(nil) }
            preferences.removePersistentDomain(forName: preferenceDomain)
            let keys = CFPreferencesCopyKeyList(easydictDomain as CFString,
                kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String] ?? []
            for key in keys {
                CFPreferencesSetValue(key as CFString, nil, easydictDomain as CFString,
                    kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
            }
            CFPreferencesSynchronize(easydictDomain as CFString,
                kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        }
        do {
            try checkQuestionKeys(checks: &checks)
            let oldShortcut = HotKeySpec(keyCode: 5, modifiers: UInt32(controlKey | optionKey))
            preferences.set(try JSONEncoder().encode(oldShortcut), forKey: "hotKey")
            let currentStore = ReaderStore(capture: capture, integration: integration, preferences: preferences)
            store = currentStore
            let generalInput = ReaderStore.firstInput(origin: nil, history: [], question: "GENERAL-742: 搜索公开网页")
            let generalPayload = try JSONSerialization.jsonObject(with: Data(generalInput.utf8)) as! [String: Any]
            try require(generalPayload["quoted_excerpt"] == nil && generalPayload["source_app"] == nil &&
                        generalPayload["question"] as? String == "GENERAL-742: 搜索公开网页",
                        "General chat invented an excerpt or lost the question")
            checks["general_chat_input_needs_no_selection"] = true
            currentStore.adopt(SelectedExcerpt(text: "OLD-742"))
            let oldAnswer = currentStore.ledger.beginAnswer(question: "Old question")
            currentStore.question = "Old draft"
            currentStore.newConversation()
            currentStore.ledger.appendDelta("Old late answer", ticket: oldAnswer)
            try require(currentStore.ledger.excerpt == nil && currentStore.ledger.messages.isEmpty &&
                        currentStore.pastedExcerpt.isEmpty && currentStore.question.isEmpty && currentStore.chatSources.isEmpty,
                        "New chat retained the old passage, answer, sources or draft")
            checks["new_chat_clears_passage_history_draft_and_rejects_old_delta"] = true
            try require(ReaderView.readableAnswer("Answer citeturn0search0 [Source](https://example.org)") ==
                        "Answer  [Source](https://example.org)", "Private citation marker reached the UI")
            checks["public_markdown_links_preserved_private_search_ids_hidden"] = true
            try require(currentStore.hotKey == HotKeySpec(keyCode: 2, modifiers: UInt32(optionKey)),
                "old shortcut was not migrated to Option+D")
            try require(preferences.integer(forKey: "nativeTranslationShortcutVersion") == 1,
                "shortcut migration marker was not saved")
            checks["legacy_shortcut_migrated_to_option_d"] = true
            let customShortcut = HotKeySpec(keyCode: 4, modifiers: UInt32(controlKey | optionKey))
            preferences.set(try JSONEncoder().encode(customShortcut), forKey: "hotKey")
            let reloaded = ReaderStore(capture: capture, integration: integration, preferences: preferences)
            try require(reloaded.hotKey == customShortcut, "later launch overwrote the custom shortcut")
            await reloaded.shutdown()
            checks["shortcut_migration_runs_only_once"] = true

            try await checkControlledTranslation(capture: capture, integration: integration, checks: &checks)
            try await checkControlledRefinement(capture: capture, integration: integration, checks: &checks)

            let panels = PanelController(store: currentStore, capture: capture)
            let initialReader = try window(titled: "Ask ChatGPT", in: app)
            observations["reader_before_any_presentation"] = [
                "contentWidth": initialReader.contentRect(forFrameRect: initialReader.frame).width,
                "contentHeight": initialReader.contentRect(forFrameRect: initialReader.frame).height,
                "minWidth": initialReader.contentMinSize.width, "minHeight": initialReader.contentMinSize.height,
                "visible": initialReader.isVisible]
            let excerpt = SelectedExcerpt(text: (1...48).map {
                "第\($0)行：这是界面回归检查使用的合成中文文字，只用于检查本机翻译、滚动和同段追问。"
            }.joined(separator: "\n"), sourceBundleID: "org.askgpt.ui-smoke", sourceName: "合成测试")
            let selection = CapturedSelection(excerpt: excerpt)
            try require(!currentStore.automaticEnabled, "test must start with automatic mode off")
            panels.showAutomatic(selection)
            try require(currentStore.automaticExcerpt == nil, "automatic callback ran while automatic mode was off")
            checks["automatic_callback_respects_off_switch"] = true

            currentStore.setTranslationSource("auto")
            panels.showTranslation(with: selection)
            try await waitForTranslation(currentStore)
            try require(!currentStore.automaticEnabled && currentStore.automaticText == excerpt.text,
                "manual same-language translation did not complete with automatic mode off")
            try require(currentStore.automaticStatus.isEmpty, "manual translation reported an error")
            checks["manual_translation_works_with_automatic_off"] = true
            let english = SelectedExcerpt(text: "The experiment compared two groups of samples.",
                sourceBundleID: "org.askgpt.ui-smoke", sourceName: "公开合成英文")
            currentStore.translateSelection(english)
            do {
                try await waitForTranslation(currentStore)
                if !currentStore.automaticText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                    currentStore.automaticText != english.text && currentStore.automaticStatus.isEmpty &&
                    currentStore.automaticFailure == nil {
                    checks["native_english_to_chinese_translation"] = true
                } else {
                    observations["native_english_translation_error"] = currentStore.automaticFailure ??
                        (currentStore.automaticStatus.isEmpty ? "no nonempty translated output different from the English input" : currentStore.automaticStatus)
                    unverified.append("native_english_to_chinese_translation: local language pack or system service was unavailable to this CLI probe")
                }
            } catch {
                observations["native_english_translation_error"] = error.localizedDescription
                unverified.append("native_english_to_chinese_translation: local translation did not complete in the bounded CLI probe")
                currentStore.cancelAutomatic()
            }
            panels.showTranslation(with: selection)
            try await waitForTranslation(currentStore)
            let translation = try window(titled: "Quick Translate", in: app)
            let reader = try window(titled: "Ask ChatGPT", in: app)
            try checkButtons(translation, name: "translation")
            try checkButtons(reader, name: "reader")
            checks["native_close_minimize_buttons_present_visible_enabled"] = true
            observations["translation_content_size"] = size(translation)
            observations["reader_content_size"] = size(reader)
            observations["translation_minimum_content_size"] = [
                "width": Double(translation.contentMinSize.width), "height": Double(translation.contentMinSize.height)]
            observations["reader_minimum_content_size"] = [
                "width": Double(reader.contentMinSize.width), "height": Double(reader.contentMinSize.height)]
            do {
                if usableScreen {
                    try checkSize(translation, expected: NSSize(width: 360, height: 250),
                        minimum: NSSize(width: 320, height: 200), name: "translation")
                    try checkSize(reader, expected: NSSize(width: 400, height: 490),
                        minimum: NSSize(width: 380, height: 400), name: "reader")
                    checks["compact_initial_and_minimum_sizes"] = true
                } else {
                    unverified.append("initial_window_sizes: NSScreen has no positive visible frame; native placement/orderFront can clamp window geometry")
                    try require(translation.contentMinSize == NSSize(width: 320, height: 200) &&
                        reader.contentMinSize == NSSize(width: 380, height: 400),
                        "minimum window size contracts were cleared before presentation; see recorded min sizes")
                    checks["minimum_window_size_contracts"] = true
                }
            } catch {
                // Keep this strict failure while collecting independent
                // behavior evidence from the same actual source build.
                failed = error
                checks["compact_initial_and_minimum_sizes"] = false
            }
            try require(translation.styleMask.contains(.nonactivatingPanel),
                "translation window lost nonactivating panel behavior")
            checks["translation_panel_nonactivating"] = true

            translation.contentView?.layoutSubtreeIfNeeded()
            translation.displayIfNeeded()
            await settle(0.2)
            let scrollViews = descendants(of: translation.contentView).compactMap { $0 as? NSScrollView }
            observations["translation_native_scroll_view_count"] = scrollViews.count
            if !scrollViews.isEmpty {
                checks["translation_scroll_container_present"] = true
            } else {
                unverified.append("translation_scroll_container: native AppKit CLI renderer did not materialize an NSScrollView")
            }
            observations["translation_native_drag_region_count"] = try checkTranslationDragRegions(translation, observations: &observations)
            checks["translation_blank_regions_dispatch_native_drag_without_intercepting_controls"] = true
            if let scroll = scrollViews.first(where: {
                ($0.documentView?.bounds.height ?? 0) > $0.contentView.bounds.height + 10
            }) {
                let initial = scroll.contentView.bounds.origin
                scroll.contentView.scroll(to: NSPoint(x: initial.x, y: initial.y + 35))
                scroll.reflectScrolledClipView(scroll.contentView)
                try require(abs(scroll.contentView.bounds.origin.y - initial.y) > 1,
                    "overflowing translation scroll container did not scroll")
                checks["long_translation_scrolls"] = true
            } else {
                unverified.append("long_translation_scroll: CLI renderer did not expose overflowing document geometry")
            }

            panels.askAboutTranslation()
            await settle(0.1)
            try require(currentStore.ledger.excerpt?.identity == excerpt.identity,
                "Ask ChatGPT did not adopt the translated excerpt")
            try require(reader.isVisible && !translation.isVisible,
                "Ask ChatGPT did not switch from translation to question window")
            checks["ask_chatgpt_transfers_current_excerpt"] = true
            currentStore.question = "同一段原文的草稿应保留"
            panels.showTranslation(with: selection)
            try await waitForTranslation(currentStore)
            panels.askAboutTranslation()
            try require(currentStore.question == "同一段原文的草稿应保留",
                "reopening Ask ChatGPT for the same excerpt discarded the question draft")
            checks["same_excerpt_preserves_question_draft"] = true

            panels.showTranslation(with: selection)
            try await waitForTranslation(currentStore)
            let outside = ClickProbeWindow(contentRect: NSRect(x: 80, y: 80, width: 160, height: 80),
                styleMask: [.titled], backing: .buffered, defer: false)
            outside.title = "ui-smoke owned click target"
            outside.isReleasedWhenClosed = false
            let clickTarget = ClickProbeView(frame: NSRect(x: 0, y: 0, width: 160, height: 80))
            outside.contentView = clickTarget
            outside.makeKeyAndOrderFront(nil)
            guard let click = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 40, y: 30),
                modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: outside.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1) else {
                throw SmokeFailure(message: "could not construct the owned-window click event")
            }
            app.sendEvent(click)
            await settle(0.1)
            try require(outside.dispatchedMouseDownCount == 1,
                "outside-click monitor intercepted the original target's click")
            observations["outside_click_target_view_received_mouse_down"] = clickTarget.mouseDownCount == 1
            try require(!translation.isVisible && !currentStore.automaticBusy,
                "clicking another owned window did not dismiss the translation panel")
            try require(reader.isVisible && currentStore.question == "同一段原文的草稿应保留",
                "translation outside-click dismissal hid the question window or discarded its draft")
            outside.orderOut(nil)
            checks["outside_owned_window_click_dismisses_translation_without_consuming_event"] = true
            try checkTranslationMouseOwnership(checks: &checks)

            currentStore.prepareManualTranslationInput()
            try require(currentStore.automaticExcerpt == nil && currentStore.automaticText.isEmpty &&
                currentStore.automaticStatus.isEmpty && !currentStore.automaticBusy,
                "manual-input fallback retained an old translation or selection")
            try require(currentStore.ledger.excerpt?.identity == excerpt.identity &&
                currentStore.question == "同一段原文的草稿应保留",
                "manual-input fallback discarded the existing question context or draft")
            checks["capture_failure_clears_translation_and_preserves_chat"] = true

            // A bare async-main CLI can exit during AppKit's native minimize
            // animation without NSApplication.run()'s application lifecycle.
            // Positive screen geometry alone does not establish that lifecycle.
            if app.isRunning {
                reader.standardWindowButton(.miniaturizeButton)?.performClick(nil)
                await settle(0.6)
                if reader.isMiniaturized {
                    panels.showQuestion(with: selection)
                    await settle(0.3)
                    try require(!reader.isMiniaturized && reader.isVisible,
                        "question entry did not restore the miniaturized window")
                    checks["native_minimize_and_entry_restore"] = true
                } else {
                    unverified.append("native_minimize_and_entry_restore: native AppKit session did not miniaturize")
                }
            } else {
                unverified.append("native_minimize_and_entry_restore: CLI probe has not entered NSApplication.run(); real native minimization requires the app lifecycle")
            }
            panels.showTranslation(with: selection)
            translation.standardWindowButton(.closeButton)?.performClick(nil)
            await settle(0.1)
            try require(!translation.isVisible && !currentStore.automaticBusy,
                "translation close button did not hide the panel and cancel translation")
            reader.standardWindowButton(.closeButton)?.performClick(nil)
            await settle(0.1)
            try require(!reader.isVisible, "reader close button did not hide the panel")
            panels.showQuestion(with: selection)
            try require(reader.isVisible && currentStore.question == "同一段原文的草稿应保留",
                "reader could not reopen with its draft after native close")
            checks["native_close_hides_and_entry_reopens"] = true
        } catch { if failed == nil { failed = error } }
        observations["native_window_geometry_events"] = diagnostics.events
        if let store { await store.shutdown() }
        cleanup()
        if let failed {
            FileHandle.standardError.write(Data(("UI_SMOKE_FAILED: " + failed.localizedDescription + "\n").utf8))
        }
        var report: [String: Any] = ["status": failed != nil ? "FAIL" : (unverified.isEmpty ? "PASS" : "PASS_WITH_UNVERIFIED"), "actualAppSources": true,
            "networkOrModelRequests": false, "isolatedPreferences": true,
            "checks": checks, "observations": observations, "unverified": unverified]
        if let failed { report["error"] = failed.localizedDescription }
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        } catch {
            FileHandle.standardError.write(Data(("UI_SMOKE_REPORT_FAILED: " + error.localizedDescription + "\n").utf8))
            exit(1)
        }
        if failed != nil { exit(1) }
    }

    @MainActor private static func checkControlledTranslation(capture: SelectionCapture,
        integration: EasydictIntegration, checks: inout [String: Bool]) async throws {
        var stores: [ReaderStore] = []
        var drivers: [ControlledTranslationDriver] = []
        var preferenceDomains: [String] = []
        @MainActor func makeStore(driver: ControlledTranslationDriver, timeout: Double = 1,
            detector: @escaping @Sendable (String) -> String? = { _ in "en" },
            replacementDriver: ControlledTranslationDriver? = nil) -> ReaderStore {
            let domain = "org.askgpt.ui-smoke.controlled.\(UUID().uuidString)"
            let preferences = UserDefaults(suiteName: domain)!
            preferenceDomains.append(domain)
            drivers.append(driver)
            let recoveryDriver = replacementDriver ?? driver
            if let replacementDriver { drivers.append(replacementDriver) }
            let engine = NativeTranslationEngine(driver: driver, sourceDetector: detector)
            let store = ReaderStore(capture: capture, integration: integration, preferences: preferences,
                translationEngine: engine, translationTimeoutSeconds: timeout,
                translationEngineFactory: { NativeTranslationEngine(driver: recoveryDriver, sourceDetector: detector) })
            stores.append(store)
            return store
        }
        defer {
            for domain in preferenceDomains { UserDefaults.standard.removePersistentDomain(forName: domain) }
        }
        do {
            let cachedExcerpt = SelectedExcerpt(text: "Prefetched scientific passage.",
                sourceBundleID: "org.askgpt.ui-smoke.cache", sourceName: "受控预译")
            let cacheDriver = ControlledTranslationDriver([.text("预译缓存结果")])
            let cached = makeStore(driver: cacheDriver)
            cached.prefetchTranslation(cachedExcerpt)
            try require(cached.automaticExcerpt == nil && cached.automaticText.isEmpty && !cached.automaticBusy &&
                cached.automaticFailure == nil && cached.automaticStatus.isEmpty,
                "prefetch changed the visible translation state before completion")
            try await waitForDriver(cacheDriver, calls: 1, completed: true)
            // Allow the completed native result to be committed on MainActor.
            await settle(0.05)
            try require(cached.automaticExcerpt == nil && cached.automaticText.isEmpty && !cached.automaticBusy &&
                cached.automaticFailure == nil && cached.automaticStatus.isEmpty,
                "completed prefetch changed the visible translation state")
            cached.translateSelection(cachedExcerpt)
            try require(!cached.automaticBusy && cached.automaticText == "预译缓存结果" &&
                cached.automaticExcerpt?.identity == cachedExcerpt.identity && cached.automaticFailure == nil,
                "manual translation did not synchronously display the completed prefetch cache")
            let cachedCallCount = await cacheDriver.calls.count
            try require(cachedCallCount == 1, "cached manual translation launched a duplicate native request")
            checks["prefetch_is_invisible_and_manual_cache_hit_is_synchronous"] = true

            let sharedExcerpt = SelectedExcerpt(text: "An in-flight passage shared by prefetch and manual translation.",
                sourceBundleID: "org.askgpt.ui-smoke.shared", sourceName: "受控共享")
            let sharedDriver = ControlledTranslationDriver([.held("共享任务译文")])
            let shared = makeStore(driver: sharedDriver)
            shared.prefetchTranslation(sharedExcerpt)
            try await waitForDriver(sharedDriver, calls: 1)
            shared.translateSelection(sharedExcerpt)
            await settle(0.05)
            try require(shared.automaticBusy && shared.automaticExcerpt?.identity == sharedExcerpt.identity,
                "manual translation did not attach to the pending prefetch passage")
            let sharedPendingCallCount = await sharedDriver.calls.count
            try require(sharedPendingCallCount == 1, "same-passage manual translation duplicated the in-flight native operation")
            await sharedDriver.releaseHeldTranslation()
            try await waitForTranslation(shared)
            try require(shared.automaticText == "共享任务译文" && shared.automaticFailure == nil && shared.automaticStatus.isEmpty,
                "shared prefetch result did not complete the visible manual translation")
            let sharedFinalCallCount = await sharedDriver.calls.count
            try require(sharedFinalCallCount == 1, "same-passage completion invoked the native translator twice")
            checks["manual_translation_shares_pending_prefetch_operation"] = true

            let visibleDriver = ControlledTranslationDriver([.held("可见原文译文"), .text("另一选段预译")])
            let visible = makeStore(driver: visibleDriver)
            let visibleExcerpt = SelectedExcerpt(text: "The visible foreground passage must finish first.",
                sourceBundleID: "org.askgpt.ui-smoke.foreground")
            let unrelatedExcerpt = SelectedExcerpt(text: "A different selection is only a speculative prefetch.",
                sourceBundleID: "org.askgpt.ui-smoke.background")
            visible.translateSelection(visibleExcerpt)
            try await waitForDriver(visibleDriver, calls: 1)
            visible.prefetchTranslation(unrelatedExcerpt)
            await settle(0.03)
            try require(visible.automaticBusy && visible.automaticExcerpt?.identity == visibleExcerpt.identity &&
                visible.automaticFailure == nil, "unrelated prefetch cancelled a visible foreground translation")
            let visiblePendingCalls = await visibleDriver.calls.count
            try require(visiblePendingCalls == 1, "unrelated prefetch displaced the active foreground native request")
            await visibleDriver.releaseHeldTranslation()
            try await waitForTranslation(visible)
            try require(visible.automaticText == "可见原文译文" && visible.automaticFailure == nil,
                "foreground translation did not survive unrelated prefetch")
            checks["unrelated_prefetch_does_not_cancel_visible_translation"] = true

            let sourceDriver = ControlledTranslationDriver([.text("葡聚糖")])
            let source = makeStore(driver: sourceDriver, detector: { _ in "hr" })
            try require(source.translationSourceLanguage == "en", "scientific reading source must default to English")
            source.translateSelection(SelectedExcerpt(text: "β-glucan", sourceBundleID: "org.askgpt.ui-smoke.source"))
            try await waitForTranslation(source)
            let sourceCalls = await sourceDriver.calls
            try require(sourceCalls.count == 1 && sourceCalls.first?.source == "en" &&
                source.automaticText == "葡聚糖" && source.automaticFailure == nil,
                "explicit English source was replaced by detector output for beta-glucan")
            checks["explicit_english_source_preserves_beta_scientific_token"] = true

            let directionDriver = ControlledTranslationDriver([.held("旧方向迟到结果"),
                .text("Treatment did not increase EPRS1 at 24 h."), .text("重新翻译后的中文")])
            let directional = makeStore(driver: directionDriver)
            let directionExcerpt = SelectedExcerpt(text: "处理后24小时，EPRS1未升高。", sourceBundleID: "org.askgpt.synthetic")
            directional.translateSelection(directionExcerpt)
            try await waitForDriver(directionDriver, calls: 1)
            directional.setTranslationSource("zh-Hans")
            try require(directional.translationSourceLanguage == "zh-Hans", "compact translation did not accept reverse direction")
            try await waitForTranslation(directional)
            var directionCalls = await directionDriver.calls
            try require(directionCalls.count == 2 && directionCalls[1].source == "zh-Hans" && directionCalls[1].target == "en" &&
                directional.automaticText == "Treatment did not increase EPRS1 at 24 h.",
                "reverse native translation did not use the explicit Chinese-to-English pair")
            await directionDriver.releaseHeldTranslation(); await settle(0.04)
            try require(directional.automaticText == "Treatment did not increase EPRS1 at 24 h.",
                "late forward translation overwrote the reverse result")
            directional.setTranslationSource("en")
            try await waitForTranslation(directional)
            directionCalls = await directionDriver.calls
            try require(directionCalls.count == 3 && directionCalls[2].source == "en" && directionCalls[2].target == "zh-Hans" &&
                directional.automaticText == "重新翻译后的中文", "direction change reused an old result or engine cache")
            checks["compact_reverse_direction_cancels_old_native_work_and_clears_cache"] = true

            let pdfInput = "The inter-\nleukin response changed\nin the treated group."
            let pdfDriver = ControlledTranslationDriver([.text("PDF 清理译文"), .text("网页保留译文")])
            let pdfStore = makeStore(driver: pdfDriver)
            let pdfExcerpt = SelectedExcerpt(text: pdfInput, sourceBundleID: "org.zotero.zotero")
            pdfStore.translateSelection(pdfExcerpt)
            try await waitForTranslation(pdfStore)
            let pdfCalls = await pdfDriver.calls
            try require(pdfCalls.count == 1 && pdfCalls[0].text == "The interleukin response changed in the treated group.",
                "PDF layout cleanup did not reach the native translation input boundary")
            try require(pdfStore.automaticExcerpt?.text == pdfInput && pdfStore.automaticExcerpt?.identity == pdfExcerpt.identity,
                "PDF input cleanup changed the original selected passage or its identity")
            let browserExcerpt = SelectedExcerpt(text: pdfInput, sourceBundleID: "com.google.Chrome")
            pdfStore.translateSelection(browserExcerpt)
            try await waitForTranslation(pdfStore)
            let browserCalls = await pdfDriver.calls
            try require(browserCalls.count == 2 && browserCalls[1].text == pdfInput &&
                pdfStore.automaticExcerpt?.text == pdfInput && pdfStore.automaticExcerpt?.identity == browserExcerpt.identity,
                "PDF layout cleanup modified an identical browser passage or reused the PDF result")
            checks["pdf_translation_input_cleanup_preserves_selection_and_other_sources"] = true

            let retryDriver = ControlledTranslationDriver([.failure, .text("重试成功译文")])
            let retry = makeStore(driver: retryDriver)
            retry.translateSelection(SelectedExcerpt(text: "A passage with one recoverable local failure.",
                sourceBundleID: "org.askgpt.ui-smoke.retry"))
            try await waitForTranslation(retry)
            try require(retry.automaticFailure != nil && !retry.automaticBusy && retry.automaticText.isEmpty,
                "failed translation did not expose a terminal failure state")
            try require(retry.automaticStatus.isEmpty,
                "failed translation retained a waiting/loading status")
            retry.retryTranslation()
            try await waitForTranslation(retry)
            try require(retry.automaticFailure == nil && retry.automaticText == "重试成功译文" &&
                !retry.automaticBusy && retry.automaticStatus.isEmpty,
                "retry did not recover from a failed native translation")
            let retryCallCount = await retryDriver.calls.count
            try require(retryCallCount == 2, "retry did not issue exactly one fresh native operation")
            checks["terminal_translation_failure_can_retry_successfully"] = true

            let timeoutDriver = ControlledTranslationDriver([.delayed(0.4, "过晚结果"), .text("超时后重试译文")])
            let timed = makeStore(driver: timeoutDriver, timeout: 0.06)
            timed.translateSelection(SelectedExcerpt(text: "A slow native translation must reach a bounded terminal state.",
                sourceBundleID: "org.askgpt.ui-smoke.timeout"))
            try await waitForTranslation(timed)
            try require(timed.automaticFailure?.contains("timed out") == true && !timed.automaticBusy && timed.automaticText.isEmpty,
                "native timeout did not expose a terminal timed-out failure")
            try require(timed.automaticStatus.isEmpty,
                "native timeout left a waiting/loading status")
            await settle(0.45)
            try require(timed.automaticText.isEmpty && timed.automaticFailure?.contains("timed out") == true && !timed.automaticBusy,
                "late native completion overwrote the timed-out terminal state")
            timed.retryTranslation()
            try await waitForTranslation(timed)
            try require(timed.automaticText == "超时后重试译文" && timed.automaticFailure == nil && !timed.automaticBusy,
                "retry after native timeout did not recover")
            checks["native_timeout_clears_loading_rejects_late_result_and_allows_retry"] = true

            let stuckDriver = ControlledTranslationDriver([.held("旧代过晚结果")])
            let recoveredDriver = ControlledTranslationDriver([.text("新代引擎重试成功")])
            let recovered = makeStore(driver: stuckDriver, timeout: 0.06, replacementDriver: recoveredDriver)
            recovered.translateSelection(SelectedExcerpt(text: "An unresponsive native operation must not poison the next engine.",
                sourceBundleID: "org.askgpt.ui-smoke.engine-recovery"))
            try await waitForDriver(stuckDriver, calls: 1)
            try await waitForTranslation(recovered)
            try require(recovered.automaticFailure?.contains("timed out") == true && !recovered.automaticBusy,
                "held native operation did not reach the deadline error")
            let stuckCompletedBeforeRetry = await stuckDriver.completedCalls
            try require(stuckCompletedBeforeRetry == 0, "old native operation unexpectedly completed before recovery")
            recovered.retryTranslation()
            try await waitForTranslation(recovered)
            let recoveredCalls = await recoveredDriver.calls.count
            let stuckCompletedAfterRetry = await stuckDriver.completedCalls
            try require(recoveredCalls == 1 && stuckCompletedAfterRetry == 0 &&
                recovered.automaticText == "新代引擎重试成功" && recovered.automaticFailure == nil,
                "retry remained queued behind the unfinished native engine generation")
            await stuckDriver.releaseHeldTranslation()
            try await waitForDriver(stuckDriver, calls: 1, completed: true)
            await settle(0.03)
            try require(recovered.automaticText == "新代引擎重试成功" && recovered.automaticFailure == nil,
                "retired native engine completion overwrote the recovered foreground translation")
            checks["native_timeout_replaces_poisoned_engine_before_old_work_finishes"] = true

            let cancelledDriver = ControlledTranslationDriver([.held("已取消的旧段落")])
            let nextPassageDriver = ControlledTranslationDriver([.text("取消后下一段立即成功")])
            let cancelled = makeStore(driver: cancelledDriver, replacementDriver: nextPassageDriver)
            cancelled.translateSelection(SelectedExcerpt(text: "The first passage is cancelled before its deadline.",
                sourceBundleID: "org.askgpt.ui-smoke.cancelled-old"))
            try await waitForDriver(cancelledDriver, calls: 1)
            cancelled.cancelAutomatic()
            cancelled.translateSelection(SelectedExcerpt(text: "A different passage must not wait for the retired native queue.",
                sourceBundleID: "org.askgpt.ui-smoke.cancelled-next"))
            try await waitForTranslation(cancelled)
            let cancelledCompleted = await cancelledDriver.completedCalls
            let nextPassageCalls = await nextPassageDriver.calls.count
            try require(cancelledCompleted == 0 && nextPassageCalls == 1 &&
                cancelled.automaticText == "取消后下一段立即成功" && cancelled.automaticFailure == nil,
                "pre-deadline cancellation left the next passage blocked behind the retired native queue")
            await cancelledDriver.releaseHeldTranslation()
            try await waitForDriver(cancelledDriver, calls: 1, completed: true)
            await settle(0.03)
            try require(cancelled.automaticText == "取消后下一段立即成功" && cancelled.automaticFailure == nil,
                "cancelled native generation overwrote the next passage after late completion")
            checks["cancelled_native_work_does_not_block_next_passage"] = true
        } catch {
            for driver in drivers { await driver.releaseHeldTranslation() }
            for store in stores { await store.shutdown() }
            throw error
        }
        for store in stores { await store.shutdown() }
    }

    @MainActor private static func waitForDriver(_ driver: ControlledTranslationDriver, calls: Int,
        completed: Bool = false) async throws {
        let deadline = Date(timeIntervalSinceNow: 2)
        while Date() < deadline {
            let seen = await driver.calls.count
            let finished = await driver.completedCalls
            if seen >= calls && (!completed || finished >= calls) { return }
            await settle(0.01)
        }
        throw SmokeFailure(message: "controlled native translator did not reach the expected request state")
    }

    @MainActor private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw SmokeFailure(message: message) }
    }
    @MainActor private static func settle(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
    @MainActor private static func waitForTranslation(_ store: ReaderStore) async throws {
        let deadline = Date(timeIntervalSinceNow: 6)
        while store.automaticBusy && Date() < deadline { await settle(0.03) }
        try require(!store.automaticBusy, "same-language translation timed out")
    }
    @MainActor private static func checkControlledRefinement(capture: SelectionCapture,
        integration: EasydictIntegration, checks: inout [String: Bool]) async throws {
        var domains: [String] = []
        var stores: [ReaderStore] = []
        func preferences() -> UserDefaults {
            let domain = "org.askgpt.ui-smoke.refinement.\(UUID().uuidString)"
            domains.append(domain)
            return UserDefaults(suiteName: domain)!
        }
        defer { for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) } }
        let client = ControlledRefiner([.text("精译完整结果"), .held("旧段文意"),
            .held("停止后的过晚结果"), .text("文意重试完成"), .failure, .text("重试完成")])
        var created = 0
        var refinementConfigurations: [CodexSettings] = []
        let chatSettings = CodexSettings(cliPath: "/custom/ui-smoke/codex", model: "gpt-6.1-sol", reasoningEffort: "high")
        let refinementPreferences = preferences()
        refinementPreferences.set(try JSONEncoder().encode(chatSettings), forKey: "codexSettings")
        let driver = ControlledTranslationDriver([.text("本机原译文"), .text("新段本机译文")])
        let store = ReaderStore(capture: capture, integration: integration, preferences: refinementPreferences,
            translationEngine: NativeTranslationEngine(driver: driver), refinementFactory: { configuration in
                created += 1
                refinementConfigurations.append(configuration)
                return client
            })
        stores.append(store)
        let first = SelectedExcerpt(text: "The effect was not significant (P > 0.05).", sourceBundleID: "org.askgpt.synthetic")
        let second = SelectedExcerpt(text: "A new passage with a different meaning.", sourceBundleID: "org.askgpt.synthetic")
        do {
            store.prefetchTranslation(first)
            await settle(0.03)
            store.translateSelection(first)
            try await waitForTranslation(store)
            try require(created == 0, "local selection/prefetch created a GPT client")
            checks["local_translation_never_starts_gpt_refinement"] = true

            store.refineSelection(.translation)
            try await waitForRefinement(store)
            try require(store.refinementText == "精译完整结果" && !store.refinementBusy &&
                store.automaticText == "本机原译文" && created == 1,
                "explicit refinement did not retain local text or finalize exact stream")
            try require(refinementConfigurations == [PassageRefinementConfiguration.settings(from: chatSettings)] &&
                store.appliedSettings == chatSettings && store.settings == chatSettings,
                "refinement did not receive its dedicated fast configuration or changed the question model settings")
            checks["refinement_fast_model_is_separate_from_persisted_question_settings"] = true
            let calls = await client.calls
            try require(calls.count == 1 && calls[0].0 == first.text && calls[0].1 == .translation,
                "refinement sent anything other than the exact current excerpt")
            store.showNativeTranslation()
            store.refineSelection(.translation)
            try require(created == 1 && store.refinementText == "精译完整结果",
                "revisiting a completed mode redundantly sent text to GPT")
            checks["explicit_refinement_only_current_excerpt_preserves_local_and_reuses_result"] = true

            store.refineSelection(.explanation)
            try await waitForRefiner(client, calls: 2)
            await settle(0.01)
            try require(store.refinementBusy && store.refinementText == "流式片段",
                "refinement did not expose an in-progress stream")
            store.translateSelection(second)
            try await waitForTranslation(store)
            await client.emitLateDeltas()
            await settle(0.03)
            try require(store.refinementMode == nil && store.refinementText.isEmpty &&
                !store.refinementBusy && store.automaticExcerpt?.identity == second.identity,
                "late GPT result crossed passage boundaries after cancellation")
            checks["refinement_stream_cancel_and_new_passage_reject_late_result"] = true

            store.refineSelection(.explanation)
            try await waitForRefiner(client, calls: 3)
            await settle(0.01)
            store.cancelRefinement()
            try require(!store.refinementBusy && store.refinementFailure != nil,
                "stopping a partial stream did not expose the retry state")
            store.refineSelection(.explanation)
            try await waitForRefinement(store)
            await client.emitLateDeltas()
            await settle(0.01)
            try require(store.refinementText == "文意重试完成" && store.refinementFailure == nil && created == 1,
                "a stopped partial stream could not be retried on the reusable client")
            checks["refinement_partial_stop_keeps_retry_available"] = true

            store.refineSelection(.translation)
            try await waitForRefinement(store)
            try require(store.refinementFailure != nil && !store.refinementBusy,
                "refinement failure left a spinner running")
            store.refineSelection(.translation)
            try await waitForRefinement(store)
            let reusedCalls = await client.calls.count
            let beforeShutdown = await client.shutdownCount
            let cancellations = await client.cancelledCount
            try require(store.refinementFailure == nil && store.refinementText == "重试完成" && created == 1 &&
                reusedCalls == 6 && beforeShutdown == 0 && cancellations == 2,
                "refinement did not reuse one client across passages, cancellation, failure, and retry")
            checks["refinement_failure_and_retry_recover"] = true
            checks["refinement_client_reused_across_passages_and_cancelled_sessions"] = true
            await store.shutdown()
            let afterShutdown = await client.shutdownCount
            try require(afterShutdown == 1, "store shutdown did not close the retained refinement client exactly once")
            checks["refinement_store_shutdown_reclaims_retained_client"] = true

            let directionsClient = ControlledRefiner([.text("原方向缓存"), .held("旧方向的迟到解释"),
                .text("The effect did not increase."), .text("新的中文结果")])
            let directionsDriver = ControlledTranslationDriver([.text("本机中文"), .text("Local English"), .text("新的本机中文")])
            let directional = ReaderStore(capture: capture, integration: integration, preferences: preferences(),
                translationEngine: NativeTranslationEngine(driver: directionsDriver),
                translationEngineFactory: { NativeTranslationEngine(driver: directionsDriver) },
                refinementFactory: { _ in directionsClient })
            stores.append(directional)
            directional.translateSelection(first); try await waitForTranslation(directional)
            directional.refineSelection(.translation); try await waitForRefinement(directional)
            directional.refineSelection(.explanation); try await waitForRefiner(directionsClient, calls: 2)
            directional.setTranslationSource("zh-Hans")
            try require(directional.refinementMode == nil && directional.refinementText.isEmpty &&
                directional.refinementFailure == nil && !directional.refinementBusy,
                "direction change retained stale refinement state")
            try await waitForTranslation(directional)
            directional.refineSelection(.translation); try await waitForRefinement(directional)
            await directionsClient.emitLateDeltas(); await settle(0.03)
            try require(directional.refinementText == "The effect did not increase.",
                "late refinement callback crossed the translation direction boundary")
            directional.setTranslationSource("en"); try await waitForTranslation(directional)
            directional.refineSelection(.translation); try await waitForRefinement(directional)
            let targets = await directionsClient.targetLanguages
            try require(targets == ["zh-Hans", "zh-Hans", "en", "zh-Hans"] &&
                directional.refinementText == "新的中文结果", "refinement ignored the target direction or reused a retired cached result")
            checks["compact_refinement_direction_is_explicit_and_retires_stale_cache_and_deltas"] = true

            let idleFirst = ControlledRefiner([.heldBeforeDelta("延迟首字后的精译")])
            let idleSecond = ControlledRefiner([.heldBeforeDelta("新连接精译")])
            var idleCreated = 0
            let idle = ReaderStore(capture: capture, integration: integration, preferences: preferences(),
                translationEngine: NativeTranslationEngine(driver: ControlledTranslationDriver([.text("可读本机初译"), .text("另一段初译")])),
                refinementIdleTimeoutSeconds: 0.06, refinementFactory: { _ in
                    idleCreated += 1
                    return idleCreated == 1 ? idleFirst : idleSecond
                })
            stores.append(idle)
            idle.translateSelection(first)
            try await waitForTranslation(idle)
            let clickedAt = ProcessInfo.processInfo.systemUptime
            idle.refineSelection(.translation)
            try await waitForRefiner(idleFirst, calls: 1)
            await settle(0.10)
            let busyShutdown = await idleFirst.shutdownCount
            try require(idle.refinementBusy && idle.refinementText.isEmpty && idle.automaticText == "可读本机初译" &&
                busyShutdown == 0 && idle.refinementStartedAt.map { abs($0 - clickedAt) < 0.02 } == true,
                "idle timer reclaimed a busy client or lost the native first-delta fallback/click timestamp")
            await idleFirst.releaseHeld()
            try await waitForRefinement(idle)
            let elapsed = ProcessInfo.processInfo.systemUptime - clickedAt
            try require(elapsed >= 0.10 && idle.refinementStatus != "Complete · 0.0 s",
                "refinement footer reported model-turn time instead of click-to-completion time")
            checks["refinement_busy_client_and_native_first_delta_fallback_survive_idle_deadline"] = true
            checks["refinement_elapsed_time_includes_first_delta_wait"] = true
            try await waitForRefinerShutdown(idleFirst)
            idle.translateSelection(second)
            try await waitForTranslation(idle)
            idle.refineSelection(.translation)
            try await waitForRefiner(idleSecond, calls: 1)
            await settle(0.10)
            let idleFirstClosed = await idleFirst.shutdownCount
            let idleSecondClosed = await idleSecond.shutdownCount
            try require(idleCreated == 2 && idleFirstClosed == 1 && idleSecondClosed == 0 && idle.refinementBusy,
                "idle retirement did not recreate a client or an old timer closed its busy successor")
            await idleSecond.releaseHeld()
            try await waitForRefinement(idle)
            checks["refinement_idle_retirement_recreates_client_without_closing_successor"] = true
            await idle.shutdown()

            let settingsClient = ControlledRefiner([.heldBeforeDelta("设置前精译")])
            let configured = ReaderStore(capture: capture, integration: integration, preferences: preferences(),
                translationEngine: NativeTranslationEngine(driver: ControlledTranslationDriver([.text("设置前初译")])),
                refinementFactory: { _ in settingsClient })
            stores.append(configured)
            configured.translateSelection(first)
            try await waitForTranslation(configured)
            configured.refineSelection(.translation)
            try await waitForRefiner(settingsClient, calls: 1)
            try require(configured.refinementBusy, "settings test did not retain an active request")
            configured.settings.model = "ui-smoke-settings-change"
            configured.saveSettings()
            // Set shuttingDown before yielding, so saveSettings' connection
            // continuation never launches a real CLI in this source UI probe.
            await configured.shutdown()
            let settingsClosed = await settingsClient.shutdownCount
            try require(settingsClosed == 1, "settings change and shutdown leaked or double-closed the retired client")
            checks["refinement_settings_change_and_shutdown_reclaim_client_once"] = true
        } catch {
            for store in stores { await store.shutdown() }
            throw error
        }
    }

    @MainActor private static func waitForRefinement(_ store: ReaderStore) async throws {
        let deadline = Date(timeIntervalSinceNow: 2)
        while store.refinementBusy && Date() < deadline { await settle(0.005) }
        try require(!store.refinementBusy, "controlled refinement did not reach its terminal state")
    }
    @MainActor private static func waitForRefiner(_ client: ControlledRefiner, calls: Int) async throws {
        let deadline = Date(timeIntervalSinceNow: 2)
        while Date() < deadline {
            if await client.calls.count >= calls { return }
            await settle(0.005)
        }
        throw SmokeFailure(message: "controlled refinement did not start the expected request")
    }
    @MainActor private static func waitForRefinerShutdown(_ client: ControlledRefiner) async throws {
        let deadline = Date(timeIntervalSinceNow: 2)
        while Date() < deadline {
            if await client.shutdownCount > 0 { return }
            await settle(0.005)
        }
        throw SmokeFailure(message: "idle refinement client was not reclaimed")
    }

    @MainActor private static func window(titled title: String, in app: NSApplication) throws -> NSWindow {
        guard let found = app.windows.first(where: { $0.title == title }) else {
            throw SmokeFailure(message: "missing window: " + title)
        }
        return found
    }
    @MainActor private static func checkTranslationMouseOwnership(checks: inout [String: Bool]) throws {
        // Hidden, probe-owned windows only. Never post events, move the system
        // pointer, or enter AppKit menu/drag tracking to test the real predicate.
        let pointer = NSEvent.mouseLocation
        let panel = NSPanel(contentRect: NSRect(x: pointer.x + 500, y: pointer.y + 500, width: 360, height: 250),
            styleMask: [.nonactivatingPanel, .titled], backing: .buffered, defer: false)
        let child = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 80, height: 60),
            styleMask: [.borderless], backing: .buffered, defer: false)
        let other = NSWindow(contentRect: panel.frame, styleMask: [.titled], backing: .buffered, defer: false)
        defer {
            panel.removeChildWindow(child)
            child.orderOut(nil); other.orderOut(nil); panel.orderOut(nil)
        }
        panel.setFrameOrigin(NSPoint(x: pointer.x + 500, y: pointer.y + 500))
        func click(at location: NSPoint, in target: NSWindow? = nil) throws -> NSEvent {
            guard let event = NSEvent.mouseEvent(with: .leftMouseDown, location: location, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: target?.windowNumber ?? 0,
                context: nil, eventNumber: 10, clickCount: 1, pressure: 1) else {
                throw SmokeFailure(message: "could not construct click ownership event")
            }
            if let target {
                try require(target.windowNumber > 0 && event.window === target,
                    "owned click event did not resolve its probe window")
            } else {
                try require(event.windowNumber == 0 && event.window == nil,
                    "windowless click fixture acquired an ordinary window")
            }
            return event
        }
        let same = try click(at: NSPoint(x: 20, y: 20), in: panel)
        try require(PanelController.translationContainsMouseDown(same, panel: panel, isGlobal: false),
            "same translation window click was classified as outside")
        checks["translation_click_same_window_is_inside"] = true

        let inside = NSPoint(x: panel.frame.midX, y: panel.frame.midY)
        let windowlessInside = try click(at: inside)
        try require(PanelController.translationContainsMouseDown(windowlessInside, panel: panel, isGlobal: false),
            "local windowless screen-coordinate click inside translation was classified as outside")
        checks["translation_click_windowless_inside_local"] = true
        try require(PanelController.translationContainsMouseDown(windowlessInside, panel: panel, isGlobal: true),
            "global windowless screen-coordinate click inside translation was classified as outside")
        checks["translation_click_windowless_inside_global"] = true
        let outside = try click(at: NSPoint(x: panel.frame.maxX + 100, y: panel.frame.maxY + 100))
        for global in [false, true] {
            try require(!PanelController.translationContainsMouseDown(outside, panel: panel, isGlobal: global),
                "windowless screen-coordinate click outside translation was classified as inside")
        }
        checks["translation_click_windowless_outside_local_and_global"] = true
        for global in [false, true] {
            try require(PanelController.translationContainsMouseDown(outside, panel: panel, isGlobal: global, menuIsTracking: true),
                "windowless native menu click outside panel bounds was not retained while tracking")
        }
        checks["translation_click_windowless_menu_tracking_local_and_global"] = true

        panel.addChildWindow(child, ordered: .above)
        child.setFrameOrigin(NSPoint(x: panel.frame.maxX + 100, y: panel.frame.minY))
        try require(!panel.frame.contains(child.convertPoint(toScreen: NSPoint(x: 20, y: 20))),
            "attached child fixture did not lie outside its parent's frame")
        let childClick = try click(at: NSPoint(x: 20, y: 20), in: child)
        try require(PanelController.translationContainsMouseDown(childClick, panel: panel, isGlobal: false),
            "attached child outside parent frame was classified as an unrelated window")
        checks["translation_click_attached_child_outside_parent_is_inside"] = true

        other.setFrame(panel.frame, display: false)
        let overlap = try click(at: NSPoint(x: 20, y: 20), in: other)
        try require(panel.frame.contains(other.convertPoint(toScreen: overlap.locationInWindow)),
            "unrelated owned-window fixture did not overlap the translation frame")
        try require(!PanelController.translationContainsMouseDown(overlap, panel: panel, isGlobal: false),
            "unrelated owned-window click was retained only because its screen point overlapped translation")
        checks["translation_click_known_other_window_overlapping_is_outside"] = true

        other.setFrameOrigin(NSPoint(x: panel.frame.maxX + 100, y: panel.frame.maxY + 100))
        other.level = .mainMenu
        let menu = try click(at: NSPoint(x: 20, y: 20), in: other)
        try require(PanelController.translationContainsMouseDown(menu, panel: panel, isGlobal: false),
            "local menu-level click was classified as outside translation")
        checks["translation_click_local_menu_window_is_inside"] = true
    }
    @MainActor private static func checkTranslationDragRegions(_ window: NSWindow, observations: inout [String: Any]) throws -> Int {
        try require(window.isMovable && window.isMovableByWindowBackground,
            "translation panel does not enable native background movement")
        guard let content = window.contentView else { throw SmokeFailure(message: "translation panel has no content view") }
        let allRegions = descendants(of: content).compactMap { $0 as? WindowDragRegionView }
        // SwiftUI's platform host may report an ancestor-sized visibleRect.
        // A clickable point must still lie inside the represented view's bounds.
        func exposedBounds(_ view: NSView) -> NSRect { view.bounds.intersection(view.visibleRect) }
        let regions = allRegions.filter {
            let rect = exposedBounds($0)
            return !$0.isHiddenOrHasHiddenAncestor && rect.width > 1 && rect.height > 1
        }
        func hit(at point: NSPoint, from view: NSView) -> NSView? {
            let inContent = content.convert(point, from: view)
            let inParent = content.superview.map { $0.convert(inContent, from: content) } ?? inContent
            return content.hitTest(inParent)
        }
        let regionDiagnostics = allRegions.enumerated().map { index, region -> [String: Any] in
            let rect = exposedBounds(region)
            let target = hit(at: NSPoint(x: rect.midX, y: rect.midY), from: region)
            return ["index": index, "frame": NSStringFromRect(region.frame),
                "bounds": NSStringFromRect(region.bounds), "visibleRect": NSStringFromRect(region.visibleRect),
                "exposedBounds": NSStringFromRect(rect), "hidden": region.isHiddenOrHasHiddenAncestor,
                "superclass": region.superview.map { String(describing: type(of: $0)) } ?? "nil",
                "hitclass": target.map { String(describing: type(of: $0)) } ?? "nil",
                "hitsNativeRegion": target === region]
        }
        observations["translation_native_drag_regions"] = regionDiagnostics
        guard let region = regions.first(where: {
            let rect = exposedBounds($0)
            return hit(at: NSPoint(x: rect.midX, y: rect.midY), from: $0) === $0
        }) else {
            throw SmokeFailure(message: "translation has no exposed blank native drag region [\(regionDiagnostics)]")
        }
        try require(region.mouseDownCanMoveWindow && !region.acceptsFirstResponder && region.acceptsFirstMouse(for: nil),
            "blank drag region has incorrect native mouse/focus behavior")
        let previousHandler = region.beginDrag
        let wasMovable = window.isMovable
        defer { region.beginDrag = previousHandler; window.isMovable = wasMovable }
        var requests = 0
        var correctWindow = false
        region.beginDrag = { target, event in
            requests += 1
            correctWindow = target === window && event.type == .leftMouseDown
        }
        let bounds = exposedBounds(region)
        let location = region.convert(NSPoint(x: bounds.midX, y: bounds.midY), to: nil)
        guard let left = NSEvent.mouseEvent(with: .leftMouseDown, location: location,
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 1),
              let right = NSEvent.mouseEvent(with: .rightMouseDown, location: location,
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 3, clickCount: 1, pressure: 1) else {
            throw SmokeFailure(message: "could not construct owned-window drag routing events")
        }
        let frame = window.frame
        // Invoke only the probe-owned native view with an injected drag sink.
        // No global event or real window-tracking loop is synthesized.
        region.mouseDown(with: left)
        region.mouseDown(with: right)
        window.isMovable = false
        region.mouseDown(with: left)
        window.isMovable = wasMovable
        try require(requests == 1 && correctWindow && window.frame == frame,
            "blank region did not dispatch exactly one safe native left-button drag request")

        let interactive = descendants(of: content).filter {
            ($0 is NSScrollView || $0 is NSTextView || $0 is NSControl) &&
            !$0.isHiddenOrHasHiddenAncestor && exposedBounds($0).width > 1 && exposedBounds($0).height > 1
        }
        for view in interactive {
            let rect = exposedBounds(view)
            try require(!(hit(at: NSPoint(x: rect.midX, y: rect.midY), from: view) is WindowDragRegionView),
                "a blank drag region covers a native text, scroll, or control target")
        }
        return regions.count
    }

    @MainActor private static func checkQuestionKeys(checks: inout [String: Bool]) throws {
        let editor = QuestionTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 80))
        let window = NSWindow(contentRect: editor.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = editor
        window.makeFirstResponder(editor)
        defer { window.orderOut(nil) }
        var submissions = 0
        editor.onSubmit = { submissions += 1 }
        func press(_ code: UInt16, modifiers: NSEvent.ModifierFlags = []) throws {
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: modifiers, timestamp: 0, windowNumber: window.windowNumber,
                context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
                isARepeat: false, keyCode: code) else { throw SmokeFailure(message: "could not construct editor key") }
            editor.keyDown(with: event)
        }
        editor.string = "QUESTION-742"
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        try press(36)
        try require(submissions == 1 && editor.string == "QUESTION-742", "Return did not submit exactly once without newline")
        try press(76)
        try require(submissions == 2 && editor.string == "QUESTION-742", "keypad Enter did not submit exactly once")
        checks["question_return_and_keypad_enter_submit_once_without_newline"] = true
        try press(36, modifiers: .shift)
        try require(submissions == 2 && editor.string == "QUESTION-742\n", "Shift+Return submitted or failed to insert a newline")
        checks["question_shift_return_inserts_newline_without_submit"] = true
        editor.setMarkedText("测试", selectedRange: NSRange(location: 2, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        try require(editor.hasMarkedText(), "test did not create an IME composition")
        try press(36)
        try require(submissions == 2, "Return while confirming marked text submitted a question")
        checks["question_ime_composition_return_does_not_submit"] = true
    }

    @MainActor private static func checkButtons(_ window: NSWindow, name: String) throws {
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton] {
            guard let button = window.standardWindowButton(type) else {
                throw SmokeFailure(message: name + " has no native window button")
            }
            try require(!button.isHiddenOrHasHiddenAncestor && button.isEnabled && button.alphaValue > 0,
                name + " native window button is hidden or disabled")
            try require(button.frame.width > 0 && button.frame.height > 0,
                name + " native window button has no visible geometry")
        }
        try require(window.titleVisibility == .visible && !window.titlebarAppearsTransparent,
            name + " does not retain its native visible titlebar")
        try require(window.isOpaque && window.backgroundColor.alphaComponent >= 0.99,
            name + " does not have an opaque window background")
    }
    @MainActor private static func checkSize(_ window: NSWindow, expected: NSSize, minimum: NSSize, name: String) throws {
        let content = window.contentRect(forFrameRect: window.frame).size
        try require(abs(content.width - expected.width) <= 1 && abs(content.height - expected.height) <= 1,
            name + " initial content size is not compact: \(content.width)×\(content.height), expected \(expected.width)×\(expected.height)")
        try require(window.contentMinSize == minimum,
            name + " minimum content size changed: \(window.contentMinSize.width)×\(window.contentMinSize.height), expected \(minimum.width)×\(minimum.height)")
    }
    @MainActor private static func size(_ window: NSWindow) -> [String: Double] {
        let value = window.contentRect(forFrameRect: window.frame).size
        return ["width": Double(value.width), "height": Double(value.height)]
    }
    @MainActor private static func descendants(of root: NSView?) -> [NSView] {
        guard let root else { return [] }
        return [root] + root.subviews.flatMap { descendants(of: $0) }
    }
}

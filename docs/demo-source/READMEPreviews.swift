import AppKit
import SwiftUI
@testable import AskGPTCore

/// In-memory app preferences: no standard/suite preference values or files.
private final class DemoDefaults: UserDefaults {
    private var values: [String: Any] = [:]
    override func object(forKey key: String) -> Any? { values[key] }
    override func set(_ value: Any?, forKey key: String) { values[key] = value }
    override func string(forKey key: String) -> String? { values[key] as? String }
    override func data(forKey key: String) -> Data? { values[key] as? Data }
    override func integer(forKey key: String) -> Int { values[key] as? Int ?? 0 }
    override func bool(forKey key: String) -> Bool { values[key] as? Bool ?? false }
    override func dictionaryRepresentation() -> [String: Any] { values }
}

private struct DemoTranslationDriver: NativeTranslationDriver {
    func availability(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability { .installed }
    func warmUp(sourceLanguage: String, targetLanguage: String) async throws {}
    func translate(_ text: String, sourceLanguage: String, targetLanguage: String) async throws -> String { "证据" }
}

private struct DemoWordProvider: WordLookupProviding {
    func entry(for word: String) async throws -> WordEntry? {
        WordEntry(headword: "evidence", phonetic: "/ˈevɪdəns/",
            senses: [WordSense(partOfSpeech: "n.", meanings: ["证据", "依据"])])
    }
}

@main private struct READMEPreviews {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.accessory)
        Task { @MainActor in
            do { try await render(); exit(0) }
            catch { fputs("README_PREVIEW_FAILED: \(error)\n", stderr); exit(1) }
        }
        NSApplication.shared.run()
    }

    @MainActor private static func capture<V: View>(_ view: V, name: String,
        width: CGFloat, height: CGFloat?, directory: URL) async throws {
        let host = NSHostingView(rootView: view.frame(width: width, height: height))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height ?? 260),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = host
        // Render only this process's own offscreen view; never capture a desktop.
        host.layoutSubtreeIfNeeded()
        if height == nil { window.setContentSize(NSSize(width: width, height: ceil(host.fittingSize.height))) }
        try await Task.sleep(nanoseconds: 250_000_000)
        host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw NSError(domain: "READMEPreviews", code: 1)
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "READMEPreviews", code: 2)
        }
        try data.write(to: directory.appendingPathComponent(name + ".png"))
        window.orderOut(nil)
    }

    @MainActor private static func render() async throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let temporary = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        let preferences = DemoDefaults()
        preferences.set("blue", forKey: "compactTranslationColor")
        preferences.set("en", forKey: "translationSourceLanguage")
        preferences.set(1, forKey: "nativeTranslationShortcutVersion")
        preferences.set(try JSONEncoder().encode(HotKeySpec.defaultSpec), forKey: "hotKey")
        preferences.set(try JSONEncoder().encode(CodexSettings()), forKey: "codexSettings")
        preferences.set(String(repeating: "d", count: 64), forKey: "localBridgeToken")
        let integration = EasydictIntegration(backupDirectory: temporary,
            domain: "org.askgpt.readme-demo.unused")
        let store = ReaderStore(capture: SelectionCapture(), integration: integration,
            preferences: preferences, translationEngine: NativeTranslationEngine(driver: DemoTranslationDriver()),
            wordLookupEngine: WordLookupEngine(provider: DemoWordProvider()),
            translationEngineFactory: { NativeTranslationEngine(driver: DemoTranslationDriver()) })
        // Only deterministic injected fixture providers run. No Apple translation,
        // model, listeners, hotkeys, document access, or permission requests.
        store.translateSelection(SelectedExcerpt(text: "evidence"))
        for _ in 0..<50 {
            if store.wordEntry != nil && !store.automaticBusy { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        guard store.wordEntry?.headword == "evidence", store.automaticText == "证据" else {
            throw NSError(domain: "READMEPreviews", code: 3)
        }
        try await capture(AutomaticTranslationView(store: store, ask: {}, openDocument: {})
            .defaultAppStorage(preferences), name: "translation", width: 420, height: 240,
            directory: output)
        try await capture(SettingsView(store: store).defaultAppStorage(preferences),
            name: "settings", width: 544, height: 472, directory: output)
        let issue = WritingIssue(id: "demo-spelling", category: "spelling",
            original: "writting", replacement: "writing", reason: "拼写错误",
            range: .init(start: 0, length: 8), requiresAuthorConfirmation: true)
        try await capture(WordWritingPopoverView(content: .spelling(issue), canApply: true,
            palette: .amber, onPalette: { _ in }, onApply: {}, onIgnore: {},
            onAddTerm: {}, onStop: {}), name: "writing", width: 390, height: nil,
            directory: output)
        print("CURRENT_SOURCE_README_PREVIEWS_RENDERED")
    }
}

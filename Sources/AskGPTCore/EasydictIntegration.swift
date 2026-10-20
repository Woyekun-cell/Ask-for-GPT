import AppKit
import CoreFoundation
import Foundation

public enum EasydictIntegrationError: LocalizedError, Equatable {
    case applicationIsRunning
    case unsupportedBackendIsolation
    case invalidBridgeConfiguration
    case ownedServiceConflict
    case invalidPreferences(String)
    case invalidBackup
    case synchronizationFailed

    public var errorDescription: String? {
        switch self {
        case .applicationIsRunning:
            return "请先自行退出 Easydict，再配置阅读翻译；配置后重新打开 Easydict。AskGPT 不会强制退出或清空已有内容。"
        case .unsupportedBackendIsolation:
            return "Easydict 现成 CLI 会继承全局指令和工具。请通过本机转接配置阅读翻译。"
        case .invalidBridgeConfiguration:
            return "本机转接配置无效，未修改 Easydict。"
        case .ownedServiceConflict:
            return "Ask for GPT 的 Easydict 服务已被外部修改或存在标识冲突，未覆盖现有设置。请在 Easydict 中检查这个本机服务。"
        case .invalidPreferences(let key):
            return "Easydict 设置格式不兼容，未继续修改：\(key)"
        case .invalidBackup:
            return "Easydict 恢复记录格式不匹配，未覆盖现有设置。"
        case .synchronizationFailed:
            return "无法同步 Easydict 偏好设置，请检查本机权限后重试。"
        }
    }
}

/// Changes only reading preferences and this app's private CustomOpenAI instance.
/// Existing vendor credentials are never read or backed up. The only credential
/// saved here is the bridge's generated local token, in an owner-readable journal.
/// CFPreferences provides durable cross-process storage; it does not prove that
/// an already-open Easydict window has refreshed its cached service objects.
@MainActor
public final class EasydictIntegration {
    public static let preferencesDomain = "com.izual.Easydict"
    public let backupURL: URL
    private let domain: String
    private static let iconKey = "EZConfiguration_kAutoSelectTextKey"
    static let bridgeServiceUUID = "4D369398-046B-4EF4-9247-372916527937"
    private static let bridgeServiceID = "CustomOpenAI#\(bridgeServiceUUID)"
    private static let bridgeConfigurationParts = [
        "Name", "API", "EndPoint", "Model", "AvailableModels", "ValidModels",
        "EnableStreaming", "EnableCustomPrompt", "Translation", "Sentence",
        "Dictionary", "ServiceUsageStatus"
    ]
    private static func bridgeKey(_ part: String) -> String {
        "EZCustomOpenAI\(part)_\(bridgeServiceUUID)_Key"
    }
    private static func bridgeInfoKey(_ window: Int) -> String {
        "kServiceInfoStorageKey-CustomOpenAI-\(bridgeServiceUUID)-\(window)"
    }
    private static let bridgeKeys: Set<String> = Set(bridgeConfigurationParts.map(bridgeKey))
        .union([bridgeInfoKey(1), bridgeInfoKey(2)])
    private static let legacyAndReadingKeys: Set<String> = [
        iconKey, "EZConfiguration_kClickQueryKey", "EZConfiguration_kHideMainWindowKey",
        "EZConfiguration_kAutoQuerySelectedTextKey",
        "EZConfiguration_kAutoPlayAudioKey",
        "EZConfiguration_kAllowAnalyticsKey",
        "EZConfiguration_kMouseSelectTranslateWindowTypeKey",
        "EZConfiguration_kShortcutSelectTranslateWindowTypeKey",
        "EZCodexCLIModelKey", "EZCodexCLIReasoningEffortKey",
        "EZCodexCLIEnableCustomPromptKey", "EZCodexCLITranslationKey",
        "EZCodexCLISentenceKey", "EZCodexCLIDictionaryKey", "EZCodexCLIServiceUsageStatusKey",
        "kAllServiceTypesKey-1", "kAllServiceTypesKey-2",
        "kServiceInfoStorageKey-CodexCLI-1", "kServiceInfoStorageKey-CodexCLI-2"
    ]
    // Legacy non-secret keys remain accepted solely to restore old journals and
    // exercise the legacy protocol in isolated test domains.
    private static let allowedKeys = legacyAndReadingKeys.union(bridgeKeys)

    public convenience init(backupDirectory: URL) {
        self.init(backupDirectory: backupDirectory, domain: Self.preferencesDomain)
    }

    // A domain is injectable so the same preference protocol can be validated
    // against an isolated suite without touching the user's application.
    init(backupDirectory: URL, domain: String) {
        self.domain = domain
        self.backupURL = backupDirectory.appendingPathComponent("easydict-preferences-backup.plist")
    }

    public func prepareClickTranslation() throws {
        // Easy 2.22's built-in exec runner inherits global AGENTS, MCP, skills,
        // and login-shell API keys. Do not configure that route on this machine.
        // Isolated test suites still exercise the narrow backup/restore protocol.
        guard domain != Self.preferencesDomain else {
            throw EasydictIntegrationError.unsupportedBackendIsolation
        }
        try requireApplicationClosed()
        try synchronize()
        var changes: [String: Any] = [
            Self.iconKey: true,
            "EZConfiguration_kClickQueryKey": true,
            "EZConfiguration_kHideMainWindowKey": true,
            "EZConfiguration_kAutoQuerySelectedTextKey": true,
            "EZConfiguration_kAutoPlayAudioKey": false,
            "EZConfiguration_kAllowAnalyticsKey": false,
            "EZConfiguration_kMouseSelectTranslateWindowTypeKey": 2,
            "EZConfiguration_kShortcutSelectTranslateWindowTypeKey": 2,
            "EZCodexCLIModelKey": "gpt-6.1-sol",
            "EZCodexCLIReasoningEffortKey": "low",
            "EZCodexCLIEnableCustomPromptKey": false,
            "EZCodexCLITranslationKey": "1",
            "EZCodexCLISentenceKey": "0",
            "EZCodexCLIDictionaryKey": "0",
            "EZCodexCLIServiceUsageStatusKey": "2"
        ]
        // Main window 0 and its service cards stay outside the reading profile.
        // Restricting the two reading lists prevents dispatch to another vendor
        // without exporting or modifying any vendor's credentials/metadata.
        for window in [1, 2] {
            let listKey = "kAllServiceTypesKey-\(window)"
            if let existing = read(listKey), !(existing is [String]) {
                throw EasydictIntegrationError.invalidPreferences(listKey)
            }
            changes[listKey] = ["CodexCLI"]
            let infoKey = "kServiceInfoStorageKey-CodexCLI-\(window)"
            changes[infoKey] = try enabledCodexMetadata(key: infoKey, window: window)
        }

        try applyConfiguration(changes, journal: loadJournal())
    }

    /// Routes only the two reading windows through this app's authenticated
    /// loopback bridge. No global Ollama, CodexCLI, or existing CustomOpenAI
    /// configuration is consulted or modified.
    public func prepareClickTranslation(bridge: LocalBridgeConfiguration) throws {
        try requireApplicationClosed()
        guard !bridge.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !bridge.token.contains("\r"), !bridge.token.contains("\n"),
              bridge.endpoint.absoluteString == "http://127.0.0.1:43791/v1/chat/completions",
              LocalBridgeConfiguration.modelAlias == "apple-local" else {
            throw EasydictIntegrationError.invalidBridgeConfiguration
        }
        try synchronize()
        let journal = try loadJournal()
        try validateOwnedInstance(journal: journal)
        var changes: [String: Any] = [
            Self.iconKey: true,
            "EZConfiguration_kClickQueryKey": true,
            "EZConfiguration_kHideMainWindowKey": true,
            "EZConfiguration_kAutoQuerySelectedTextKey": true,
            "EZConfiguration_kAutoPlayAudioKey": false,
            "EZConfiguration_kAllowAnalyticsKey": false,
            "EZConfiguration_kMouseSelectTranslateWindowTypeKey": 2,
            "EZConfiguration_kShortcutSelectTranslateWindowTypeKey": 2,
            Self.bridgeKey("Name"): "本机翻译",
            Self.bridgeKey("API"): bridge.token,
            Self.bridgeKey("EndPoint"): bridge.endpoint.absoluteString,
            Self.bridgeKey("Model"): LocalBridgeConfiguration.modelAlias,
            Self.bridgeKey("AvailableModels"): LocalBridgeConfiguration.modelAlias,
            Self.bridgeKey("ValidModels"): [LocalBridgeConfiguration.modelAlias],
            Self.bridgeKey("EnableStreaming"): false,
            Self.bridgeKey("EnableCustomPrompt"): false,
            Self.bridgeKey("Translation"): "1",
            Self.bridgeKey("Sentence"): "0",
            Self.bridgeKey("Dictionary"): "0",
            Self.bridgeKey("ServiceUsageStatus"): "2"
        ]
        for window in [1, 2] {
            let listKey = "kAllServiceTypesKey-\(window)"
            if let existing = read(listKey) {
                guard let types = existing as? [String] else {
                    throw EasydictIntegrationError.invalidPreferences(listKey)
                }
                if types.contains(Self.bridgeServiceID), Set(journal.configuration.keys).isDisjoint(with: Self.bridgeKeys) {
                    throw EasydictIntegrationError.ownedServiceConflict
                }
            }
            changes[listKey] = [Self.bridgeServiceID]
            changes[Self.bridgeInfoKey(window)] = try JSONEncoder.sorted.encode(
                OwnedServiceMetadata(uuid: Self.bridgeServiceUUID, type: "CustomOpenAI",
                                     enabled: true, enabledQuery: true, windowType: window)
            )
        }
        try applyConfiguration(changes, journal: journal)
    }

    private func applyConfiguration(_ changes: [String: Any], journal initialJournal: Journal) throws {
        var journal = initialJournal
        if journal.selectionIcon != nil {
            try restoreSelectionIcon()
            journal = try loadJournal()
        }
        var writes: [String: Snapshot] = [:]
        for (key, value) in changes {
            let current = try currentSnapshot(for: key)
            let applied = try snapshot(value)
            guard current != applied else { continue }
            let original = journal.configuration[key]?.original ?? current
            journal.configuration[key] = Entry(original: original, applied: applied)
            writes[key] = applied
        }
        // Record originals before any preference write, so interrupted setup can
        // be undone. Never replace the first original on repeated preparation.
        try saveJournal(journal)
        for (key, value) in writes { try write(key, value) }
        try synchronize()
        for (key, value) in writes {
            guard try currentSnapshot(for: key) == value else {
                throw EasydictIntegrationError.synchronizationFailed
            }
        }
    }

    public func setAutomaticTranslationEnabled(_ enabled: Bool) throws {
        guard enabled else {
            try restoreSelectionIcon()
            return
        }
        try synchronize()
        var journal = try loadJournal()
        let current = try snapshot(read(Self.iconKey))
        let applied = try snapshot(false)
        guard current != applied || journal.selectionIcon != nil else { return }
        let original = journal.selectionIcon?.original ?? current
        journal.selectionIcon = Entry(original: original, applied: applied)
        try saveJournal(journal)
        try write(Self.iconKey, applied)
        try synchronize()
        guard try snapshot(read(Self.iconKey)) == applied else {
            throw EasydictIntegrationError.synchronizationFailed
        }
    }

    /// Only reverses the temporary icon suppression, including after a crash.
    /// Long-term reading configuration remains in place.
    public func restoreSelectionIcon() throws {
        try synchronize()
        var journal = try loadJournal()
        guard let entry = journal.selectionIcon else { return }
        if try snapshot(read(Self.iconKey)) == entry.applied {
            try write(Self.iconKey, entry.original)
            try synchronize()
        }
        journal.selectionIcon = nil
        try saveJournal(journal)
    }

    /// Fully undoes this integration's owned changes. If another writer changed
    /// a key since we applied it, that key is preserved and ownership is dropped.
    public func restoreConfiguration() throws {
        try requireApplicationClosed()
        try restoreSelectionIcon()
        var journal = try loadJournal()
        for (key, entry) in journal.configuration {
            try synchronize()
            // An unknown or malformed externally edited metadata record is
            // preserved, just like any other value that differs from ours.
            if let current = try? currentSnapshot(for: key), current == entry.applied {
                try write(key, entry.original)
            }
        }
        try synchronize()
        journal.configuration = [:]
        try saveJournal(journal)
    }

    private func requireApplicationClosed() throws {
        guard domain != Self.preferencesDomain ||
            NSRunningApplication.runningApplications(withBundleIdentifier: domain).isEmpty else {
            throw EasydictIntegrationError.applicationIsRunning
        }
    }

    private func validateOwnedInstance(journal: Journal) throws {
        // Inspect names, never values, until the private instance's ownership is
        // established. A UUID collision must not copy somebody else's API key.
        let names = Set(CFPreferencesCopyKeyList(domain as CFString, kCFPreferencesCurrentUser,
                                               kCFPreferencesAnyHost) as? [String] ?? [])
        let namespace = names.filter {
            ($0.hasPrefix("EZCustomOpenAI") && $0.hasSuffix("_\(Self.bridgeServiceUUID)_Key")) ||
                $0.hasPrefix("kServiceInfoStorageKey-CustomOpenAI-\(Self.bridgeServiceUUID)-")
        }
        guard namespace.isSubset(of: Self.bridgeKeys) else {
            throw EasydictIntegrationError.ownedServiceConflict
        }
        for key in Self.bridgeKeys where names.contains(key) {
            guard let entry = journal.configuration[key], entry.original.encodedValue == nil else {
                throw EasydictIntegrationError.ownedServiceConflict
            }
        }
        for key in Self.bridgeKeys {
            if let entry = journal.configuration[key] {
                guard let current = try? currentSnapshot(for: key), current == entry.applied else {
                    throw EasydictIntegrationError.ownedServiceConflict
                }
            }
        }
    }

    private struct OwnedServiceMetadata: Codable {
        let uuid: String
        let type: String
        let enabled: Bool
        let enabledQuery: Bool
        let windowType: Int
    }

    private func currentSnapshot(for key: String) throws -> Snapshot {
        let value = read(key)
        guard [Self.bridgeInfoKey(1), Self.bridgeInfoKey(2)].contains(key), let value else {
            return try snapshot(value)
        }
        guard let data = value as? Data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["uuid", "type", "enabled", "enabledQuery", "windowType"],
              let metadata = try? JSONDecoder().decode(OwnedServiceMetadata.self, from: data) else {
            throw EasydictIntegrationError.ownedServiceConflict
        }
        // Easy can re-encode JSON with another key order during normal use.
        // Compare the decoded fields, so cosmetic re-encoding is not an edit.
        return try snapshot(JSONEncoder.sorted.encode(metadata))
    }

    private func enabledCodexMetadata(key: String, window: Int) throws -> Data {
        let permittedFields: Set<String> = ["uuid", "type", "enabled", "enabledQuery", "windowType"]
        var metadata: [String: Any] = ["uuid": "", "type": "CodexCLI", "windowType": window]
        if let existing = read(key) {
            guard let data = existing as? Data,
                  let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(decoded.keys).isSubset(of: permittedFields),
                  (decoded["uuid"] as? String ?? "").isEmpty,
                  (decoded["type"] as? String ?? "CodexCLI") == "CodexCLI",
                  (decoded["windowType"] as? Int ?? window) == window else {
                throw EasydictIntegrationError.invalidPreferences(key)
            }
            metadata = decoded
            metadata["uuid"] = ""
            metadata["type"] = "CodexCLI"
            metadata["windowType"] = window
        }
        metadata["enabled"] = true
        metadata["enabledQuery"] = true
        return try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
    }

    private func synchronize() throws {
        guard CFPreferencesSynchronize(domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else {
            throw EasydictIntegrationError.synchronizationFailed
        }
    }

    private func read(_ key: String) -> Any? {
        CFPreferencesCopyValue(key as CFString, domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
    }

    private func write(_ key: String, _ snapshot: Snapshot) throws {
        guard Self.allowedKeys.contains(key) else { throw EasydictIntegrationError.invalidBackup }
        CFPreferencesSetValue(key as CFString, try snapshot.value() as CFPropertyList?, domain as CFString,
                              kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
    }

    private struct Snapshot: Codable, Equatable {
        let encodedValue: Data?
        func value() throws -> Any? {
            guard let encodedValue else { return nil }
            guard let wrapper = try PropertyListSerialization.propertyList(from: encodedValue, format: nil) as? [Any],
                  wrapper.count == 1 else { throw EasydictIntegrationError.invalidBackup }
            return wrapper[0]
        }
    }

    private func snapshot(_ value: Any?) throws -> Snapshot {
        guard let value else { return Snapshot(encodedValue: nil) }
        return Snapshot(encodedValue: try PropertyListSerialization.data(fromPropertyList: [value], format: .binary, options: 0))
    }

    private struct Entry: Codable {
        let original: Snapshot
        let applied: Snapshot
    }
    private struct Journal: Codable {
        var version = 1
        let domain: String
        var configuration: [String: Entry] = [:]
        var selectionIcon: Entry?
    }

    private func loadJournal() throws -> Journal {
        guard FileManager.default.fileExists(atPath: backupURL.path) else { return Journal(domain: domain) }
        let journal = try PropertyListDecoder().decode(Journal.self, from: Data(contentsOf: backupURL))
        guard journal.version == 1, journal.domain == domain,
              Set(journal.configuration.keys).isSubset(of: Self.allowedKeys),
              journal.configuration.filter({ Self.bridgeKeys.contains($0.key) })
                .allSatisfy({ $0.value.original.encodedValue == nil }) else {
            throw EasydictIntegrationError.invalidBackup
        }
        return journal
    }

    private func saveJournal(_ journal: Journal) throws {
        if journal.configuration.isEmpty && journal.selectionIcon == nil {
            if FileManager.default.fileExists(atPath: backupURL.path) {
                try FileManager.default.removeItem(at: backupURL)
            }
            return
        }
        try FileManager.default.createDirectory(at: backupURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        try encoder.encode(journal).write(to: backupURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backupURL.path)
    }
}

private extension JSONEncoder {
    static var sorted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

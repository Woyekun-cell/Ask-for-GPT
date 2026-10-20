import Foundation
import CoreFoundation
import Testing
@testable import AskGPTCore

@Suite("Easydict narrow preferences integration")
struct EasydictIntegrationTests {
    @Test @MainActor
    func bridgeDisablesAnalyticsAndRestoresPreviousEnabledValue() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("EZConfiguration_kAllowAnalyticsKey", true)
        fixture.set("EZConfiguration_kAllowCrashLogKey", true)
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))
        #expect(fixture.value("EZConfiguration_kAllowAnalyticsKey") as? Bool == false)
        #expect(fixture.value("EZConfiguration_kAllowCrashLogKey") as? Bool == true)
        try integration.restoreConfiguration()
        #expect(fixture.value("EZConfiguration_kAllowAnalyticsKey") as? Bool == true)
        #expect(fixture.value("EZConfiguration_kAllowCrashLogKey") as? Bool == true)
        fixture.set("EZConfiguration_kAllowAnalyticsKey", false)
        try integration.restoreConfiguration()
        #expect(fixture.value("EZConfiguration_kAllowAnalyticsKey") as? Bool == false)
    }

    @Test @MainActor
    func analyticsOriginalDisabledValueAndExternalDifferentValueRemainUntouched() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("EZConfiguration_kAllowAnalyticsKey", false)
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))
        try integration.restoreConfiguration()
        #expect(fixture.value("EZConfiguration_kAllowAnalyticsKey") as? Bool == false)
        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))
        fixture.set("EZConfiguration_kAllowAnalyticsKey", true)
        try integration.restoreConfiguration()
        #expect(fixture.value("EZConfiguration_kAllowAnalyticsKey") as? Bool == true)
    }

    @Test @MainActor
    func bridgeProfileUsesOwnedInstanceAndPreservesMainAndOtherServiceSecrets() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        let ownID = "CustomOpenAI#\(bridgeUUID)"
        let otherID = "CustomOpenAI#other-user-instance"
        let mainServices = ["Ollama", otherID, "CodexCLI"]
        let otherInfo = try fixture.info(type: "CustomOpenAI", window: 0, uuid: "other-user-instance")
        fixture.set("kAllServiceTypesKey-0", mainServices)
        fixture.set("kServiceInfoStorageKey-CustomOpenAI-other-user-instance-0", otherInfo)
        fixture.set("kAllServiceTypesKey-1", ["Youdao", otherID])
        fixture.set("kAllServiceTypesKey-2", ["DeepL"])
        fixture.set("EZCustomOpenAIAPI_other-user-instance_Key", "other-private-key")
        fixture.set("EZCustomOpenAIAPIKey", "base-private-key")
        fixture.set("EZOllamaEndPointKey", "http://localhost:11434/v1/chat/completions")
        fixture.set("EZOllamaModelKey", "existing-local-model")
        fixture.set("EZCodexCLIModelKey", "existing-cli-model")
        fixture.set("EZSelectionShortcutKey_keyHolder", Data("existing-hotkey".utf8))
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)

        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))

        #expect(fixture.value("kAllServiceTypesKey-0") as? [String] == mainServices)
        #expect(fixture.value("kServiceInfoStorageKey-CustomOpenAI-other-user-instance-0") as? Data == otherInfo)
        #expect(fixture.value("EZCustomOpenAIAPI_other-user-instance_Key") as? String == "other-private-key")
        #expect(fixture.value("EZCustomOpenAIAPIKey") as? String == "base-private-key")
        #expect(fixture.value("EZOllamaModelKey") as? String == "existing-local-model")
        #expect(fixture.value("EZOllamaEndPointKey") as? String == "http://localhost:11434/v1/chat/completions")
        #expect(fixture.value("EZCodexCLIModelKey") as? String == "existing-cli-model")
        #expect(fixture.value("EZSelectionShortcutKey_keyHolder") as? Data == Data("existing-hotkey".utf8))
        #expect(fixture.value(bridgeKey("API")) as? String == "local-fixture-token")
        #expect(fixture.value(bridgeKey("EndPoint")) as? String == "http://127.0.0.1:43791/v1/chat/completions")
        #expect(fixture.value(bridgeKey("Model")) as? String == "apple-local")
        #expect(fixture.value(bridgeKey("AvailableModels")) as? String == "apple-local")
        #expect(fixture.value(bridgeKey("ValidModels")) as? [String] == ["apple-local"])
        #expect(fixture.value(bridgeKey("Name")) as? String == "本机翻译")
        #expect(fixture.value(bridgeKey("EnableStreaming")) as? Bool == false)
        #expect(fixture.value(bridgeKey("EnableCustomPrompt")) as? Bool == false)
        #expect(fixture.value(bridgeKey("Translation")) as? String == "1")
        #expect(fixture.value(bridgeKey("Sentence")) as? String == "0")
        #expect(fixture.value(bridgeKey("Dictionary")) as? String == "0")
        #expect(fixture.value(bridgeKey("ServiceUsageStatus")) as? String == "2")
        for window in [1, 2] {
            #expect(fixture.value("kAllServiceTypesKey-\(window)") as? [String] == [ownID])
            let data = try #require(fixture.value(bridgeInfoKey(window)) as? Data)
            let info = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(Set(info.keys) == ["uuid", "type", "enabled", "enabledQuery", "windowType"])
            #expect(info["uuid"] as? String == bridgeUUID)
            #expect(info["type"] as? String == "CustomOpenAI")
            #expect(info["windowType"] as? Int == window)
            #expect(info["enabled"] as? Bool == true)
            #expect(info["enabledQuery"] as? Bool == true)
        }
        let backup = try Data(contentsOf: integration.backupURL)
        #expect(backup.range(of: Data("other-private-key".utf8)) == nil)
        #expect(backup.range(of: Data("base-private-key".utf8)) == nil)
        #expect(backup.range(of: Data("EZCustomOpenAIAPI_other-user-instance_Key".utf8)) == nil)
        let attributes = try FileManager.default.attributesOfItem(atPath: integration.backupURL.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test @MainActor
    func bridgeRestoreRemovesOwnedValuesAndPreservesExternalEdits() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("kAllServiceTypesKey-1", ["Youdao"])
        fixture.set("kAllServiceTypesKey-2", ["DeepL"])
        fixture.set("EZConfiguration_kAutoPlayAudioKey", true)
        fixture.set("EZConfiguration_kDefaultTTSServiceTypeKey", "Youdao")
        fixture.set("EZOpenAIAPIKey", "private-api-fixture")
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))
        fixture.set(bridgeKey("Model"), "external-user-model")
        fixture.set("kAllServiceTypesKey-2", ["external-service-choice"])
        try integration.restoreConfiguration()
        #expect(fixture.value(bridgeKey("Model")) as? String == "external-user-model")
        #expect(fixture.value(bridgeKey("API")) == nil)
        #expect(fixture.value(bridgeKey("EndPoint")) == nil)
        #expect(fixture.value(bridgeInfoKey(1)) == nil)
        #expect(fixture.value(bridgeInfoKey(2)) == nil)
        #expect(fixture.value("kAllServiceTypesKey-1") as? [String] == ["Youdao"])
        #expect(fixture.value("kAllServiceTypesKey-2") as? [String] == ["external-service-choice"])
        #expect(fixture.value("EZConfiguration_kAutoPlayAudioKey") as? Bool == true)
        #expect(fixture.value("EZConfiguration_kDefaultTTSServiceTypeKey") as? String == "Youdao")
        #expect(fixture.value("EZOpenAIAPIKey") as? String == "private-api-fixture")
        #expect(!FileManager.default.fileExists(atPath: integration.backupURL.path))
    }

    @Test @MainActor
    func bridgePreparationSurvivesNewProcessAndUpdatesOnlyOwnedLocalToken() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("kAllServiceTypesKey-1", ["original-reader"])
        let first = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try first.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-first-token"))
        let next = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try next.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-rotated-token"))
        #expect(fixture.value(bridgeKey("API")) as? String == "local-rotated-token")
        try next.setAutomaticTranslationEnabled(true)
        let afterCrash = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try afterCrash.restoreSelectionIcon()
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") as? Bool == true)
        #expect(fixture.value(bridgeKey("API")) as? String == "local-rotated-token")
        try afterCrash.restoreConfiguration()
        #expect(fixture.value(bridgeKey("API")) == nil)
        #expect(fixture.value("kAllServiceTypesKey-1") as? [String] == ["original-reader"])
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") == nil)
    }

    @Test @MainActor
    func unknownOwnedUUIDCollisionIsRejectedWithoutSavingExistingSecret() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set(bridgeKey("API"), "unexpected-existing-secret")
        fixture.set("kAllServiceTypesKey-1", ["Youdao"])
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        #expect(throws: EasydictIntegrationError.ownedServiceConflict) {
            try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "new-local-token"))
        }
        #expect(fixture.value(bridgeKey("API")) as? String == "unexpected-existing-secret")
        #expect(fixture.value("kAllServiceTypesKey-1") as? [String] == ["Youdao"])
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") == nil)
        #expect(!FileManager.default.fileExists(atPath: integration.backupURL.path))
    }

    @Test @MainActor
    func externallyChangedOwnedInstanceIsRejectedBeforeAnyMutation() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))
        try integration.setAutomaticTranslationEnabled(true)
        fixture.set(bridgeKey("EndPoint"), "https://external-user-endpoint.invalid/v1/chat/completions")
        let backup = try Data(contentsOf: integration.backupURL)
        #expect(throws: EasydictIntegrationError.ownedServiceConflict) {
            try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "rotated-local-token"))
        }
        #expect(fixture.value(bridgeKey("EndPoint")) as? String == "https://external-user-endpoint.invalid/v1/chat/completions")
        #expect(fixture.value(bridgeKey("API")) as? String == "local-fixture-token")
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") as? Bool == false)
        #expect(try Data(contentsOf: integration.backupURL) == backup)
    }

    @Test @MainActor
    func ownedMetadataReencodingDoesNotCauseAFalseConflict() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))
        let reformatted = "{ \"enabledQuery\": true, \"enabled\": true, \"type\": \"CustomOpenAI\", \"windowType\": 1, \"uuid\": \"\(bridgeUUID)\" }"
        fixture.set(bridgeInfoKey(1), Data(reformatted.utf8))
        try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: "local-fixture-token"))
        try integration.restoreConfiguration()
        #expect(fixture.value(bridgeInfoKey(1)) == nil)
    }

    @Test @MainActor
    func emptyBridgeTokenFailsBeforeAnyMutation() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        #expect(throws: EasydictIntegrationError.invalidBridgeConfiguration) {
            try integration.prepareClickTranslation(bridge: LocalBridgeConfiguration(token: ""))
        }
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") == nil)
        #expect(fixture.value(bridgeKey("EndPoint")) == nil)
        #expect(!FileManager.default.fileExists(atPath: integration.backupURL.path))
    }

    @Test @MainActor
    func nativeCodexRouteIsBlockedBeforeTouchingActualPreferences() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let integration = EasydictIntegration(backupDirectory: directory)
        do {
            try integration.prepareClickTranslation()
            Issue.record("Unisolated native CLI route must not be configured")
        } catch {
            #expect(error as? EasydictIntegrationError == .unsupportedBackendIsolation)
        }
        #expect(!FileManager.default.fileExists(atPath: integration.backupURL.path))
    }

    @Test @MainActor
    func automaticOnlineSpeechIsDisabledAndRestoresWithoutTouchingTTSOrAPIConfiguration() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("EZConfiguration_kAutoPlayAudioKey", true)
        fixture.set("EZConfiguration_kDefaultTTSServiceTypeKey", "Youdao")
        fixture.set("EZOpenAIAPIKey", "private-api-fixture")
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation()
        #expect(fixture.value("EZConfiguration_kAutoPlayAudioKey") as? Bool == false)
        #expect(fixture.value("EZConfiguration_kDefaultTTSServiceTypeKey") as? String == "Youdao")
        #expect(fixture.value("EZOpenAIAPIKey") as? String == "private-api-fixture")
        try integration.restoreConfiguration()
        #expect(fixture.value("EZConfiguration_kAutoPlayAudioKey") as? Bool == true)
        #expect(fixture.value("EZConfiguration_kDefaultTTSServiceTypeKey") as? String == "Youdao")
        #expect(fixture.value("EZOpenAIAPIKey") as? String == "private-api-fixture")
    }

    @Test @MainActor
    func readingWindowsUseCodexWithoutChangingMainWindowOrSecrets() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("kAllServiceTypesKey-0", ["Youdao", "OpenAI"])
        fixture.set("kAllServiceTypesKey-1", ["Youdao", "DeepL", "CodexCLI"])
        fixture.set("kAllServiceTypesKey-2", ["BuiltInAI", "CodexCLI"])
        fixture.set("EZOpenAIAPIKey", "fixture-secret-do-not-back-up")
        fixture.set("EZSelectionShortcutKey_keyHolder", Data("shortcut-preserved".utf8))
        let mainInfo = try fixture.info(type: "Youdao", window: 0)
        fixture.set("kServiceInfoStorageKey-Youdao-0", mainInfo)
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)

        try integration.prepareClickTranslation()

        #expect(fixture.value("kAllServiceTypesKey-0") as? [String] == ["Youdao", "OpenAI"])
        #expect(fixture.value("kAllServiceTypesKey-1") as? [String] == ["CodexCLI"])
        #expect(fixture.value("kAllServiceTypesKey-2") as? [String] == ["CodexCLI"])
        #expect(fixture.value("kServiceInfoStorageKey-Youdao-0") as? Data == mainInfo)
        #expect(fixture.value("EZOpenAIAPIKey") as? String == "fixture-secret-do-not-back-up")
        #expect(fixture.value("EZSelectionShortcutKey_keyHolder") as? Data == Data("shortcut-preserved".utf8))
        #expect(fixture.value("EZCodexCLIModelKey") as? String == "gpt-6.1-sol")
        #expect(fixture.value("EZCodexCLIReasoningEffortKey") as? String == "low")
        #expect(fixture.value("EZConfiguration_kClickQueryKey") as? Bool == true)
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") as? Bool == true)
        for window in [1, 2] {
            let data = try #require(fixture.value("kServiceInfoStorageKey-CodexCLI-\(window)") as? Data)
            let info = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(info["enabled"] as? Bool == true)
            #expect(info["enabledQuery"] as? Bool == true)
            #expect(info["windowType"] as? Int == window)
        }
        let backup = try Data(contentsOf: integration.backupURL)
        #expect(backup.range(of: Data("fixture-secret-do-not-back-up".utf8)) == nil)
        #expect(backup.range(of: Data("EZOpenAIAPIKey".utf8)) == nil)
    }

    @Test @MainActor
    func restoreRetainsMissingStateAndPreservesOtherWriters() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("EZCodexCLIModelKey", "previous-model")
        fixture.set("kAllServiceTypesKey-2", ["DeepL"])
        let originalInfo = try fixture.info(type: "CodexCLI", window: 2, enabled: false)
        fixture.set("kServiceInfoStorageKey-CodexCLI-2", originalInfo)
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation()
        fixture.set("EZCodexCLIModelKey", "external-user-choice")
        fixture.set("unrelated-user-setting", "changed-while-running")
        try integration.restoreConfiguration()
        #expect(fixture.value("EZCodexCLIModelKey") as? String == "external-user-choice")
        #expect(fixture.value("EZCodexCLIReasoningEffortKey") == nil)
        #expect(fixture.value("kAllServiceTypesKey-2") as? [String] == ["DeepL"])
        #expect(fixture.value("kServiceInfoStorageKey-CodexCLI-2") as? Data == originalInfo)
        #expect(fixture.value("unrelated-user-setting") as? String == "changed-while-running")
    }

    @Test @MainActor
    func repeatedPreparationAndNewProcessKeepFirstBackup() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("EZCodexCLIModelKey", "first-original")
        let first = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try first.prepareClickTranslation()
        let second = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try second.prepareClickTranslation()
        try second.restoreConfiguration()
        #expect(fixture.value("EZCodexCLIModelKey") as? String == "first-original")
    }

    @Test @MainActor
    func automaticIconRestoresAfterCrashWithoutUndoingLongTermConfiguration() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation()
        try integration.setAutomaticTranslationEnabled(true)
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") as? Bool == false)
        let afterCrash = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try afterCrash.restoreSelectionIcon()
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") as? Bool == true)
        #expect(fixture.value("EZCodexCLIModelKey") as? String == "gpt-6.1-sol")
        try afterCrash.restoreConfiguration()
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") == nil)
    }

    @Test @MainActor
    func iconRestoreDoesNotOverwriteAnExternalEdit() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("EZConfiguration_kAutoSelectTextKey", false)
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.setAutomaticTranslationEnabled(true)
        fixture.set("EZConfiguration_kAutoSelectTextKey", true)
        try integration.setAutomaticTranslationEnabled(false)
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") as? Bool == true)
    }

    @Test @MainActor
    func malformedServiceMetadataFailsBeforeAnyPreferenceMutation() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("kServiceInfoStorageKey-CodexCLI-1", Data("malformed".utf8))
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        #expect(throws: EasydictIntegrationError.invalidPreferences("kServiceInfoStorageKey-CodexCLI-1")) {
            try integration.prepareClickTranslation()
        }
        #expect(fixture.value("EZCodexCLIModelKey") == nil)
        #expect(fixture.value("EZConfiguration_kAutoSelectTextKey") == nil)
    }

    @Test @MainActor
    func crossProcessChangeIsRefreshedBeforeRestore() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        fixture.set("EZCodexCLIModelKey", "before-configuration")
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        try integration.prepareClickTranslation()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
        process.arguments = ["write", fixture.domain, "EZCodexCLIModelKey", "-string", "external-process-model"]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        try integration.restoreConfiguration()
        #expect(fixture.value("EZCodexCLIModelKey") as? String == "external-process-model")
    }

    @Test @MainActor
    func unexpectedMetadataFieldsAreNeverBackedUp() throws {
        let fixture = try PreferenceFixture()
        defer { fixture.cleanUp() }
        let data = try JSONSerialization.data(withJSONObject: ["type": "CodexCLI", "token": "fixture-private-value"])
        fixture.set("kServiceInfoStorageKey-CodexCLI-1", data)
        let integration = EasydictIntegration(backupDirectory: fixture.directory, domain: fixture.domain)
        #expect(throws: EasydictIntegrationError.invalidPreferences("kServiceInfoStorageKey-CodexCLI-1")) {
            try integration.prepareClickTranslation()
        }
        #expect(!FileManager.default.fileExists(atPath: integration.backupURL.path))
        #expect(fixture.value("kServiceInfoStorageKey-CodexCLI-1") as? Data == data)
    }
}

private let bridgeUUID = "4D369398-046B-4EF4-9247-372916527937"
private func bridgeKey(_ part: String) -> String { "EZCustomOpenAI\(part)_\(bridgeUUID)_Key" }
private func bridgeInfoKey(_ window: Int) -> String { "kServiceInfoStorageKey-CustomOpenAI-\(bridgeUUID)-\(window)" }

private struct PreferenceFixture {
    let domain = "org.askgpt.tests.easydict.\(UUID().uuidString)"
    let directory: URL
    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("AskGPT-Easydict-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    func set(_ key: String, _ value: Any?) {
        CFPreferencesSetValue(key as CFString, value as CFPropertyList?, domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        CFPreferencesSynchronize(domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
    }
    func value(_ key: String) -> Any? {
        CFPreferencesSynchronize(domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        return CFPreferencesCopyValue(key as CFString, domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
    }
    func info(type: String, window: Int, enabled: Bool = true, uuid: String = "") throws -> Data {
        try JSONSerialization.data(withJSONObject: ["uuid": uuid, "type": type, "enabled": enabled, "enabledQuery": true, "windowType": window], options: [.sortedKeys])
    }
    func cleanUp() {
        let keys = CFPreferencesCopyKeyList(domain as CFString, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String] ?? []
        for key in keys { set(key, nil) }
        try? FileManager.default.removeItem(at: directory)
    }
}

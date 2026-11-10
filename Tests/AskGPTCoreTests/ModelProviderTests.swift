import Foundation
import Testing
@testable import AskGPTCore

struct ModelProviderTests {
    @Test func oldSettingsDecodeWithoutProviderAndRoundTripNewProfile() throws {
        let legacy = Data(#"{"cliPath":"/test/codex","model":"legacy","reasoningEffort":"low"}"#.utf8)
        var settings = try JSONDecoder().decode(CodexSettings.self, from: legacy)
        #expect(settings.model == "legacy")
        #expect(settings.apiProfile == nil)

        settings.apiProfile = APIProviderProfile(kind: .gemini)
        let encoded = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(CodexSettings.self, from: encoded) == settings)
    }

    @Test func catalogAndEffortRoundTripWithoutLosingPerModelChoices() throws {
        let oldProfile = Data(#"{"id":"1D577EE9-92A0-40C4-B9C6-587054D39BA9","kind":"openAI","name":"","baseURL":"https://api.openai.com/v1","model":"gpt-6.1-sol"}"#.utf8)
        var profile = try JSONDecoder().decode(APIProviderProfile.self, from: oldProfile)
        #expect(profile.availableModels == nil && profile.effectiveReasoningEffort == nil)
        profile.availableModels = [" gpt-6-luna ", "gpt-6.1-sol", "", "gpt-6-luna"]
        profile.recentModels = ["custom-model"]
        profile.modelReasoningEfforts = [
            "gpt-6.1-sol": "high", "gpt-6-luna": "none", "gpt-6-astra": "none", "gpt-4o": "high"
        ]
        var restored = try JSONDecoder().decode(APIProviderProfile.self, from: JSONEncoder().encode(profile.validated()))
        #expect(restored.selectableModels == ["gpt-6.1-sol", "custom-model", "gpt-6-luna"])
        #expect(restored.effectiveReasoningEffort == "high")
        #expect(!restored.reasoningEffortOptions.contains("none"))
        #expect(restored.modelReasoningEfforts == ["gpt-6.1-sol": "high", "gpt-6-luna": "none"])
        restored.model = "gpt-6-luna"
        #expect(restored.effectiveReasoningEffort == "none")
        restored.baseURL = "https://gateway.example/v1"
        #expect(restored.reasoningEffortOptions.isEmpty && restored.effectiveReasoningEffort == nil)
    }

    @Test func presetsAndFullEndpointsResolveToTheCorrectPaths() throws {
        var gemini = APIProviderProfile(kind: .gemini)
        #expect(try gemini.endpoint("models").absoluteString ==
                "https://generativelanguage.googleapis.com/v1beta/openai/models")
        gemini.baseURL = " https://example.com/gateway/v1/chat/completions/ "
        gemini.name = "  Team gateway "
        gemini.model = " model-id "
        let normalized = try gemini.validated()
        #expect(normalized.baseURL == "https://example.com/gateway/v1")
        #expect(normalized.displayName == "Team gateway")
        #expect(normalized.model == "model-id")
        #expect(try normalized.endpoint("chat/completions").absoluteString ==
                "https://example.com/gateway/v1/chat/completions")
        var claude = APIProviderProfile(kind: .anthropic)
        claude.baseURL = "https://api.anthropic.com/v1/messages"
        #expect(try claude.endpoint("messages").path == "/v1/messages")
        #expect(try claude.endpoint("models").path == "/v1/models")

        var ollama = APIProviderProfile(kind: .ollama)
        #expect(try ollama.endpoint("models").absoluteString == "http://127.0.0.1:11434/v1/models")
        ollama.baseURL = "http://[::1]:11434/v1"
        #expect(try ollama.endpoint("models").absoluteString == "http://[::1]:11434/v1/models")
    }

    @Test(arguments: [
        "http://example.com/v1", "http://localhost/v1", "http://127.0.0.1.example.com/v1",
        "http://%31%32%37.0.0.1/v1", "https://user:pass@example.com/v1", "https://example.com/v1?token=x",
        "https://example.com/v1#", "https://example.com:65536/v1", "file:///tmp", "/v1"
    ])
    func rejectsUntrustedEndpointSyntax(_ baseURL: String) throws {
        var profile = APIProviderProfile(kind: .custom)
        profile.baseURL = baseURL
        profile.model = "fixture"
        #expect(throws: APIProviderError.self) { try profile.validated() }
    }

    @Test func keyStoreWritesPrivateFilesAndRejectsUnsafeInputs() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = APIProviderKeyStore(directory: root)
        defer { try? FileManager.default.removeItem(at: root) }
        var profile = APIProviderProfile(kind: .openAI)

        #expect(try store.read(for: profile) == nil)
        #expect(throws: APIProviderError.self) { try store.write("key\r\ninjected", for: profile) }
        try store.write(" fixture-key \n", for: profile)
        #expect(try store.read(for: profile) == "fixture-key")

        let directory = try FileManager.default.attributesOfItem(atPath: root.path)
        let keyURL = try #require(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        let key = try FileManager.default.attributesOfItem(atPath: keyURL.path)
        #expect((directory[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        #expect((key[.posixPermissions] as? NSNumber)?.intValue == 0o600)


        profile.model = "another-model"
        #expect(try store.read(for: profile) == "fixture-key")
        var otherEndpoint = profile
        otherEndpoint.baseURL = "https://other.example/v1"
        #expect(throws: APIProviderError.self) { try store.read(for: otherEndpoint) }
        var otherTransport = profile
        otherTransport.kind = .anthropic
        #expect(throws: APIProviderError.self) { try store.read(for: otherTransport) }

        try store.write("replacement-key", for: profile)
        #expect(try store.read(for: profile) == "replacement-key")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: keyURL.path)
        #expect(throws: APIProviderError.self) { try store.read(for: profile) }
        try store.remove(profile.id)
        #expect(try store.read(for: profile) == nil)
    }

    @Test func keyStoreDoesNotFollowSymlinks() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("keys")
        let store = APIProviderKeyStore(directory: directory)
        let profile = APIProviderProfile(kind: .openAI)
        try store.write("fixture-key", for: profile)
        let keyURL = try #require(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let target = root.appendingPathComponent("original")
        try FileManager.default.moveItem(at: keyURL, to: target)
        try FileManager.default.createSymbolicLink(at: keyURL, withDestinationURL: target)
        #expect(throws: APIProviderError.self) { try store.read(for: profile) }
        try store.write("new-key", for: profile)
        let hardLink = root.appendingPathComponent("hard-link")
        try FileManager.default.linkItem(at: keyURL, to: hardLink)
        #expect(throws: APIProviderError.self) { try store.read(for: profile) }
        try FileManager.default.removeItem(at: hardLink)
        #expect(try String(contentsOf: target, encoding: .utf8).contains("fixture-key"))
        #expect(try store.read(for: profile) == "new-key")

        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: directory)
        let aliasStore = APIProviderKeyStore(directory: alias)
        #expect(throws: APIProviderError.self) { try aliasStore.read(for: profile) }
        #expect(throws: APIProviderError.self) { try aliasStore.write("new-key", for: profile) }
    }
}

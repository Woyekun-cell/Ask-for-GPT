public protocol ModelBackend: PassageRefinementBackend {
    func validateConnection() async throws -> BackendConnectionInfo
    func send(threadID: String, text: String, onActivity: (@Sendable (CodexActivity) -> Void)?,
              onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult
    func interrupt(threadID: String) async
    func diagnostics() async -> [String: Int]
}

public extension ModelBackend {
    func diagnostics() async -> [String: Int] { [:] }
}

public enum ModelBackendFactory {
    public static func make(settings: CodexSettings, capabilities: CodexCapabilities = .textOnly) -> any ModelBackend {
        if let profile = settings.apiProfile { return APIModelBackend(profile: profile) }
        return CodexBackend(settings: settings, capabilities: capabilities)
    }
}

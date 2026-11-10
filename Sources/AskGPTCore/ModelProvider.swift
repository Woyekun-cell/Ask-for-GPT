import Darwin
import Foundation

public enum APITransport: String, Codable, Sendable {
    case openAI, anthropic
}

public enum APIProviderKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case openAI, anthropic, gemini, deepSeek, qwen, kimi, zhipu, openRouter, custom, ollama

    public var id: String { rawValue }
    public var title: String { preset.title }
    public var defaultBaseURL: String { preset.baseURL }
    public var suggestedModels: [String] { preset.models }
    public var transport: APITransport { self == .anthropic ? .anthropic : .openAI }
    public var requiresKey: Bool { self != .ollama && self != .custom }

    private var preset: (title: String, baseURL: String, models: [String]) {
        switch self {
        case .openAI:
            ("OpenAI", "https://api.openai.com/v1", ["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"])
        case .anthropic:
            ("Anthropic", "https://api.anthropic.com/v1", ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"])
        case .gemini:
            ("Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", ["gemini-3.5-flash-lite", "gemini-3.8-flash"])
        case .deepSeek:
            ("DeepSeek", "https://api.deepseek.com", ["deepseek-flash", "deepseek-v4-pro"])
        case .qwen:
            ("Qwen (DashScope)", "https://dashscope.aliyuncs.com/compatible-mode/v1", ["qwen-plus", "qwen-turbo", "qwen-max"])
        case .kimi:
            ("Kimi (Moonshot AI)", "https://api.moonshot.cn/v1", ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"])
        case .zhipu:
            ("Zhipu AI", "https://open.bigmodel.cn/api/paas/v4", ["glm-4.7", "glm-4.5-flash"])
        case .openRouter:
            ("OpenRouter", "https://openrouter.ai/api/v1", ["openai/gpt-5-mini", "anthropic/claude-sonnet-4.6"])
        case .custom:
            ("OpenAI-compatible", "", [])
        case .ollama:
            ("Ollama", "http://127.0.0.1:11434/v1", [])
        }
    }
}

public enum APIProviderError: LocalizedError {
    case invalidEndpoint, invalidModel, invalidName, invalidKey, keyStorage, credentialMismatch

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            "Enter an HTTPS base URL without credentials, a query, or a fragment. HTTP is allowed for 127.0.0.1 or [::1]."
        case .invalidModel:
            "Enter or select a valid model ID."
        case .invalidName:
            "Enter a profile name of up to 120 characters without line breaks."
        case .invalidKey:
            "Enter a valid API key without spaces or line breaks."
        case .keyStorage:
            "The local API key store could not be accessed securely."
        case .credentialMismatch:
            "The saved API key belongs to a different endpoint. Enter a key for this endpoint."
        }
    }
}

public struct APIProviderProfile: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var kind: APIProviderKind
    public var name: String
    public var baseURL: String
    public var model: String
    public var recentModels: [String]?
    public var availableModels: [String]?
    public var modelReasoningEfforts: [String: String]?

    public init(kind: APIProviderKind) {
        self.init(kind: kind, name: "", baseURL: kind.defaultBaseURL, model: kind.suggestedModels.first ?? "")
    }

    public init(id: UUID = UUID(), kind: APIProviderKind, name: String, baseURL: String, model: String,
                recentModels: [String]? = nil, availableModels: [String]? = nil,
                modelReasoningEfforts: [String: String]? = nil) {
        self.id = id
        self.kind = kind
        self.name = name
        self.baseURL = baseURL
        self.model = model
        self.recentModels = recentModels
        self.availableModels = availableModels
        self.modelReasoningEfforts = modelReasoningEfforts
    }

    public var displayName: String { name.isEmpty ? kind.title : name }

    public var selectableModels: [String] {
        Self.normalizedModelIDs([model] + (recentModels ?? []) + (availableModels ?? kind.suggestedModels))
    }

    public var reasoningEffortOptions: [String] {
        guard let model = Self.normalizedModelID(model), let base = try? normalizedBase().url?.absoluteString else { return [] }
        return reasoningOptions(model: model, base: base)
    }

    public var effectiveReasoningEffort: String? {
        guard let model = Self.normalizedModelID(model), let effort = modelReasoningEfforts?[model],
              reasoningEffortOptions.contains(effort) else { return nil }
        return effort
    }

    public func validated() throws -> Self {
        var profile = self
        guard let url = try normalizedBase().url else { throw APIProviderError.invalidEndpoint }
        profile.baseURL = url.absoluteString
        profile.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let model = Self.normalizedModelID(model) else { throw APIProviderError.invalidModel }
        profile.model = model
        guard profile.name.count <= 120, profile.name.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw APIProviderError.invalidName
        }
        profile.availableModels = availableModels.map(Self.normalizedModelIDs)
        if let modelReasoningEfforts {
            let supported = modelReasoningEfforts.filter { modelID, effort in
                Self.normalizedModelID(modelID) == modelID &&
                    reasoningOptions(model: modelID, base: profile.baseURL).contains(effort)
            }
            profile.modelReasoningEfforts = supported.isEmpty ? nil : supported
        }
        return profile
    }

    static func normalizedModelID(_ raw: String) -> String? {
        let model = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty, model.utf8.count <= 256,
              model.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return model
    }

    private static func normalizedModelIDs(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap(normalizedModelID).filter { seen.insert($0).inserted }
    }

    private func reasoningOptions(model: String, base: String) -> [String] {
        // Compatible gateways may implement only the basic chat fields. Use effort
        // on the exact vendor endpoint with an explicitly documented model family.
        let common = ["low", "medium", "high"]
        switch kind {
        case .openAI where base == kind.defaultBaseURL:
            let family = model.replacingOccurrences(of: #"-20[0-9]{2}-[0-9]{2}-[0-9]{2}$"#, with: "", options: .regularExpression)
            switch family {
            case "gpt-6-astra", "gpt-6.1-sol":
                return common + ["xhigh", "max"]
            case "gpt-6-sol", "gpt-6.1-terra", "gpt-6-luna",
                 "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna":
                return ["none"] + common + ["xhigh", "max"]
            case "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5":
                return ["none"] + common + ["xhigh"]
            case "gpt-5.1":
                return ["none"] + common
            case "gpt-5":
                return ["minimal"] + common
            case "gpt-5-mini", "gpt-5-nano":
                return common
            default:
                return []
            }
        case .deepSeek where base == kind.defaultBaseURL || base == kind.defaultBaseURL + "/v1":
            return ["deepseek-flash", "deepseek-v4-pro"].contains(model) ? ["none", "low", "high", "max"] : []
        case .anthropic where base == kind.defaultBaseURL:
            switch model {
            case "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5":
                return common + ["xhigh", "max"]
            case "claude-opus-4-6", "claude-sonnet-4-6":
                return common + ["max"]
            default:
                return []
            }
        case .gemini where base == kind.defaultBaseURL:
            let id = model.hasPrefix("models/") ? String(model.dropFirst(7)) : model
            switch id {
            case "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-pro-preview",
                 "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite":
                return common
            case "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview":
                return ["minimal"] + common
            default:
                return []
            }
        default:
            return []
        }
    }

    public func endpoint(_ operation: String) throws -> URL {
        guard Self.operations.contains(operation) else { throw APIProviderError.invalidEndpoint }
        var components = try normalizedBase()
        components.percentEncodedPath += "/" + operation
        guard let url = components.url else { throw APIProviderError.invalidEndpoint }
        return url
    }

    private static let operations = ["chat/completions", "messages", "models"]

    fileprivate func normalizedBase() throws -> URLComponents {
        let raw = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.utf8.count <= 2048, !raw.contains("\\"),
              raw.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
              var components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
              !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port.map({ (1...65535).contains($0) }) ?? true,
              scheme == "https" || (scheme == "http" &&
                  ["127.0.0.1", "[::1]"].contains(components.percentEncodedHost ?? "")) else {
            throw APIProviderError.invalidEndpoint
        }
        components.scheme = scheme
        components.host = host
        if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) {
            components.port = nil
        }
        let completionPath = kind.transport == .anthropic ? "/messages" : "/chat/completions"
        var path = components.percentEncodedPath
        while path.hasSuffix("/") || path.hasSuffix(completionPath) {
            path.removeLast(path.hasSuffix("/") ? 1 : completionPath.count)
        }
        components.percentEncodedPath = path
        return components
    }
}

public struct APIProviderKeyStore: Sendable {
    private let directory: URL
    private static let maximumKeyLength = 16_384
    private static let maximumRecordLength = 65_536

    public init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.init(directory: support.appendingPathComponent("AskGPTReader/ModelProviderKeys", isDirectory: true))
    }

    public init(directory: URL) { self.directory = directory }

    public func read(for profile: APIProviderProfile) throws -> String? {
        let identity = try EndpointIdentity(profile)
        guard let folder = try openDirectory(create: false) else { return nil }
        defer { close(folder) }
        let descriptor = openat(folder, profile.id.uuidString, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw APIProviderError.keyStorage }

        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        let data: Data
        do {
            var info = stat()
            guard fstat(descriptor, &info) == 0,
                  info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  info.st_uid == geteuid(), info.st_mode & 0o777 == 0o600, info.st_nlink == 1,
                  info.st_size > 0, info.st_size <= Self.maximumRecordLength, Self.hasNoACL(descriptor),
                  let bytes = try handle.read(upToCount: Self.maximumRecordLength + 1),
                  bytes.count <= Self.maximumRecordLength else { throw APIProviderError.keyStorage }
            data = bytes
        } catch {
            throw APIProviderError.keyStorage
        }
        guard let record = try? JSONDecoder().decode(KeyRecord.self, from: data),
              Self.isValidKey(record.key) else { throw APIProviderError.keyStorage }
        guard record.endpoint == identity else { throw APIProviderError.credentialMismatch }
        return record.key
    }

    public func write(_ key: String, for profile: APIProviderProfile) throws {
        let value = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidKey(value) else { throw APIProviderError.invalidKey }
        let record = KeyRecord(endpoint: try EndpointIdentity(profile), key: value)
        guard let folder = try openDirectory(create: true) else { throw APIProviderError.keyStorage }
        defer { close(folder) }
        let temporaryName = "." + UUID().uuidString
        let descriptor = openat(folder, temporaryName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw APIProviderError.keyStorage }
        defer { unlinkat(folder, temporaryName, 0) }

        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        guard fchmod(descriptor, 0o600) == 0, Self.hasNoACL(descriptor) else { throw APIProviderError.keyStorage }
        do {
            try handle.write(contentsOf: JSONEncoder().encode(record))
            try handle.synchronize()
        } catch {
            throw APIProviderError.keyStorage
        }
        guard renameat(folder, temporaryName, folder, profile.id.uuidString) == 0 else {
            throw APIProviderError.keyStorage
        }
    }

    public func remove(_ id: UUID) throws {
        guard let folder = try openDirectory(create: false) else { return }
        defer { close(folder) }
        guard unlinkat(folder, id.uuidString, 0) == 0 || errno == ENOENT else {
            throw APIProviderError.keyStorage
        }
    }

    private func openDirectory(create: Bool) throws -> Int32? {
        if create {
            do {
                try FileManager.default.createDirectory(at: directory.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
            } catch { throw APIProviderError.keyStorage }
            guard mkdir(directory.path, mode_t(0o700)) == 0 || errno == EEXIST else {
                throw APIProviderError.keyStorage
            }
        }
        let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT && !create { return nil }
        guard descriptor >= 0 else { throw APIProviderError.keyStorage }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == geteuid(),
              info.st_mode & 0o777 == 0o700, Self.hasNoACL(descriptor) else {
            close(descriptor)
            throw APIProviderError.keyStorage
        }
        return descriptor
    }

    private static func hasNoACL(_ descriptor: Int32) -> Bool {
        guard let acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) else { return errno == ENOENT }
        acl_free(UnsafeMutableRawPointer(acl))
        return false
    }

    private static func isValidKey(_ key: String) -> Bool {
        !key.isEmpty && key.utf8.count <= maximumKeyLength && key.utf8.allSatisfy { (33...126).contains($0) }
    }

    private struct EndpointIdentity: Codable, Equatable {
        let baseURL: String
        let transport: APITransport

        init(_ profile: APIProviderProfile) throws {
            guard let url = try profile.normalizedBase().url else { throw APIProviderError.invalidEndpoint }
            baseURL = url.absoluteString
            transport = profile.kind.transport
        }
    }

    private struct KeyRecord: Codable {
        let endpoint: EndpointIdentity
        let key: String
    }
}

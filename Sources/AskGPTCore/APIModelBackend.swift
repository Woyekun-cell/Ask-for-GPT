import Foundation

/// Sessions and their successful turns live in memory. API routes offer text only.
public actor APIModelBackend: ModelBackend {
    private struct Session {
        let instructions: String
        var history: [[String: String]] = []
    }

    private let profile: Result<APIProviderProfile, Error>
    private let keyStore: APIProviderKeyStore
    private let configuration: URLSessionConfiguration
    private var sessions: [String: Session] = [:]
    private var active: (thread: String, token: UUID, task: Task<BackendTurnResult, Error>)?

    public init(profile: APIProviderProfile) {
        self.init(profile: profile, keyStore: APIProviderKeyStore(), configuration: .ephemeral)
    }

    init(profile: APIProviderProfile, keyStore: APIProviderKeyStore, configuration: URLSessionConfiguration) {
        self.profile = Result { try profile.validated() }
        self.keyStore = keyStore
        self.configuration = configuration
    }

    /// Checks local configuration and credentials. Test connection runs a real model turn.
    public func validateConnection() async throws -> BackendConnectionInfo {
        let profile = try profile.get()
        _ = try Self.request(profile, operation: "models", apiKey: nil, keyStore: keyStore)
        return BackendConnectionInfo(authMode: profile.displayName, cliVersion: "")
    }

    public func startSession(instructions: String) async throws -> String {
        try Task.checkCancellation()
        _ = try await validateConnection()
        let id = UUID().uuidString
        sessions[id] = Session(instructions: instructions)
        return id
    }

    public func send(threadID: String, text: String, onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        try await sendTurn(threadID: threadID, text: text, schema: nil, onDelta: onDelta)
    }

    public func send(threadID: String, text: String, onActivity: (@Sendable (CodexActivity) -> Void)?,
                     onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        try await send(threadID: threadID, text: text, onDelta: onDelta)
    }

    public func sendStructured(threadID: String, text: String, schema: RPCObject,
                               onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        try await sendTurn(threadID: threadID, text: text, schema: schema, onDelta: onDelta)
    }

    private func sendTurn(threadID: String, text: String, schema: RPCObject?,
                          onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        try Task.checkCancellation()
        guard let thread = sessions[threadID] else { throw CodexBackendError.unknownThread }
        guard active == nil else { throw CodexBackendError.busy }
        let profile = try profile.get()
        let transport = profile.kind.transport
        let user = ["role": "user", "content": text]
        let messages = thread.history + [user]
        var instructions = thread.instructions
        if let schema {
            let data = try JSONSerialization.data(withJSONObject: schema.value, options: [.sortedKeys])
            instructions += "\n\nReturn one JSON object matching this JSON Schema. Omit Markdown fences and commentary.\n"
            instructions += String(decoding: data, as: UTF8.self)
        }
        var body: [String: Any] = ["model": profile.model, "stream": true]
        let effort = profile.effectiveReasoningEffort
        switch transport {
        case .openAI:
            body["messages"] = [["role": "system", "content": instructions]] + messages
            if let effort {
                if profile.kind == .deepSeek {
                    body["thinking"] = ["type": effort == "none" ? "disabled" : "enabled"]
                }
                if profile.kind != .deepSeek || effort != "none" {
                    body["reasoning_effort"] = effort
                }
            }
        case .anthropic:
            body["system"] = instructions
            body["messages"] = messages
            body["max_tokens"] = effort == nil ? 4096 : 16_384
            if let effort { body["output_config"] = ["effort": effort] }
        }
        let operation = transport == .anthropic ? "messages" : "chat/completions"
        var request = try Self.request(profile, operation: operation, apiKey: nil, keyStore: keyStore)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream, application/json", forHTTPHeaderField: "Accept")
        let requestData = try JSONSerialization.data(withJSONObject: body)
        guard requestData.count <= 2 * 1024 * 1024 else { throw ModelAPIError.requestTooLarge }
        request.httpBody = requestData

        let token = UUID()
        let task = Task {
            try await Self.complete(request, transport: transport, configuration: configuration, onDelta: onDelta)
        }
        active = (threadID, token, task)
        defer { if active?.token == token { active = nil } }
        let result = try await withTaskCancellationHandler {
            try await task.value
        } onCancel: { task.cancel() }
        try Task.checkCancellation()
        guard active?.token == token, !task.isCancelled, sessions[threadID] != nil else { throw CancellationError() }
        sessions[threadID]?.history = messages + [["role": "assistant", "content": result.text]]
        return result
    }

    public func interrupt(threadID: String) async {
        guard let active, active.thread == threadID else { return }
        active.task.cancel()
        _ = await active.task.result
        if self.active?.token == active.token { self.active = nil }
    }

    public func releaseSession(threadID: String) async {
        sessions.removeValue(forKey: threadID)
        await interrupt(threadID: threadID)
    }

    public func shutdown() async {
        let pending = active?.task
        active = nil
        sessions.removeAll()
        pending?.cancel()
        _ = await pending?.result
    }

    /// Discovers model IDs without generating a response. An absent draft key uses the bound saved key.
    public static func listModels(profile: APIProviderProfile, apiKey: String?) async throws -> [String] {
        try await listModels(profile: profile, apiKey: apiKey, keyStore: APIProviderKeyStore(), configuration: .ephemeral)
    }

    static func listModels(profile: APIProviderProfile, apiKey: String?, keyStore: APIProviderKeyStore,
                           configuration: URLSessionConfiguration) async throws -> [String] {
        var request = try request(profile, operation: "models", apiKey: apiKey, keyStore: keyStore)
        let baseURL = request.url
        var models = Set<String>()
        var cursors = Set<String>()
        repeat {
            let root = try await exchange(request, configuration: configuration) { _, bytes in
                try await readJSON(bytes)
            }
            guard let page = root["data"] as? [[String: Any]] else { throw ModelAPIError.response }
            for row in page {
                if let raw = row["id"] as? String, let id = APIProviderProfile.normalizedModelID(raw) {
                    models.insert(id)
                }
            }
            guard profile.kind.transport == .anthropic, root["has_more"] as? Bool == true else {
                return models.sorted()
            }
            guard let cursor = root["last_id"] as? String, !cursor.isEmpty, cursors.count < 20,
                  cursors.insert(cursor).inserted,
                  let baseURL, var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
                throw ModelAPIError.response
            }
            parts.queryItems = [URLQueryItem(name: "after_id", value: cursor)]
            request.url = parts.url
        } while true
    }

    private static func request(_ profile: APIProviderProfile, operation: String, apiKey: String?,
                                keyStore: APIProviderKeyStore) throws -> URLRequest {
        let endpoint = try profile.endpoint(operation)
        let storedOrDraft = try apiKey ?? keyStore.read(for: profile)
        let key = storedOrDraft?.trimmingCharacters(in: .whitespacesAndNewlines)
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25)
        if let key, !key.isEmpty {
            guard key.utf8.count <= 16_384,
                  key.utf8.allSatisfy({ (0x21...0x7E).contains($0) }) else { throw ModelAPIError.invalidKey }
            switch profile.kind.transport {
            case .openAI: request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
            case .anthropic: request.setValue(key, forHTTPHeaderField: "x-api-key")
            }
        } else if profile.kind.requiresKey {
            throw ModelAPIError.missingKey
        }
        if profile.kind.transport == .anthropic {
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        }
        return request
    }

    private static func complete(_ request: URLRequest, transport: APITransport, configuration: URLSessionConfiguration,
                                 onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        let began = ProcessInfo.processInfo.systemUptime
        return try await exchange(request, configuration: configuration) { response, bytes in
            var text = ""
            var firstDelta: Double?
            func append(_ delta: String) {
                guard !delta.isEmpty, !Task.isCancelled else { return }
                if firstDelta == nil { firstDelta = ProcessInfo.processInfo.systemUptime - began }
                text += delta
                onDelta(delta)
            }
            if response.mimeType?.lowercased() == "text/event-stream" {
                try await readEvents(bytes, transport: transport, append: append)
            } else {
                let root = try await readJSON(bytes)
                append(try fullText(root, transport: transport))
            }
            try Task.checkCancellation()
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ModelAPIError.response }
            return BackendTurnResult(text: text, firstDeltaSeconds: firstDelta,
                                     totalSeconds: ProcessInfo.processInfo.systemUptime - began)
        }
    }

    private static let responseLimit = 8 * 1024 * 1024

    private static func exchange<Result>(_ request: URLRequest, configuration: URLSessionConfiguration,
                                         read: (HTTPURLResponse, URLSession.AsyncBytes) async throws -> Result) async throws -> Result {
        let configuration = configuration.copy() as! URLSessionConfiguration
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForResource = request.timeoutInterval
        let session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw ModelAPIError.transport }
            guard (200...299).contains(http.statusCode) else { throw ModelAPIError.http(http.statusCode) }
            guard http.expectedContentLength <= responseLimit else { throw ModelAPIError.responseTooLarge }
            return try await read(http, bytes)
        } catch {
            try Task.checkCancellation()
            if let error = error as? ModelAPIError { throw error }
            if let error = error as? URLError, error.code == .timedOut { throw ModelAPIError.timeout }
            throw ModelAPIError.transport
        }
    }

    private static func readJSON(_ bytes: URLSession.AsyncBytes) async throws -> [String: Any] {
        var data = Data()
        for try await byte in bytes {
            guard data.count < responseLimit else { throw ModelAPIError.responseTooLarge }
            data.append(byte)
        }
        return try object(data)
    }

    private static func object(_ data: Data) throws -> [String: Any] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["error"] == nil || root["error"] is NSNull else { throw ModelAPIError.response }
        return root
    }

    private static func fullText(_ root: [String: Any], transport: APITransport) throws -> String {
        switch transport {
        case .openAI:
            guard let choice = (root["choices"] as? [[String: Any]])?.first,
                  let message = choice["message"] as? [String: Any],
                  let text = message["content"] as? String else { throw ModelAPIError.response }
            try checkStop(choice["finish_reason"] as? String)
            try rejectToolCall(message)
            return text
        case .anthropic:
            guard let blocks = root["content"] as? [[String: Any]],
                  !blocks.contains(where: { $0["type"] as? String == "tool_use" }) else { throw ModelAPIError.response }
            try checkStop(root["stop_reason"] as? String)
            return blocks.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined()
        }
    }

    private static func checkStop(_ reason: String?) throws {
        if reason == "length" || reason == "max_tokens" || reason == "model_context_window_exceeded" {
            throw ModelAPIError.truncated
        }
        if let reason, !["stop", "end_turn", "stop_sequence"].contains(reason) { throw ModelAPIError.response }
    }

    private static func rejectToolCall(_ message: [String: Any]) throws {
        if let calls = message["tool_calls"], !(calls is NSNull), (calls as? [Any])?.isEmpty != true {
            throw ModelAPIError.response
        }
        if let call = message["function_call"], !(call is NSNull) { throw ModelAPIError.response }
    }

    /// SSE deltas can cross network packets and UTF-8 byte boundaries. Only complete data events are decoded.
    private static func readEvents(_ bytes: URLSession.AsyncBytes, transport: APITransport,
                                   append: (String) -> Void) async throws {
        var count = 0
        var line = Data()
        var event: [String] = []
        var completed = false
        for try await byte in bytes {
            count += 1
            guard count <= responseLimit else { throw ModelAPIError.responseTooLarge }
            guard byte == 0x0A else {
                line.append(byte)
                continue
            }
            if line.last == 0x0D { line.removeLast() }
            if line.isEmpty, !event.isEmpty {
                if try readEvent(event.joined(separator: "\n"), transport: transport,
                                 completed: &completed, append: append) { return }
                event.removeAll(keepingCapacity: true)
            } else if line.starts(with: Data("data:".utf8)) {
                let data = line.dropFirst(5)
                event.append(String(decoding: data.first == 0x20 ? data.dropFirst() : data, as: UTF8.self))
            }
            line.removeAll(keepingCapacity: true)
        }
        if !event.isEmpty {
            if try readEvent(event.joined(separator: "\n"), transport: transport,
                             completed: &completed, append: append) { return }
        }
        guard completed, line.isEmpty else { throw ModelAPIError.truncated }
    }

    /// True signals a terminal event. A finish reason also permits providers that omit the terminal sentinel.
    private static func readEvent(_ data: String, transport: APITransport, completed: inout Bool,
                                  append: (String) -> Void) throws -> Bool {
        if data == "[DONE]" { return true }
        let root = try object(Data(data.utf8))
        switch transport {
        case .openAI:
            guard let choices = root["choices"] as? [[String: Any]] else { throw ModelAPIError.response }
            guard let choice = choices.first else { return false }
            if let delta = choice["delta"] as? [String: Any] {
                try rejectToolCall(delta)
                if let text = delta["content"] as? String { append(text) }
            }
            if let reason = choice["finish_reason"] as? String {
                try checkStop(reason)
                completed = true
            }
        case .anthropic:
            switch root["type"] as? String {
            case "content_block_start":
                let block = root["content_block"] as? [String: Any]
                if block?["type"] as? String == "tool_use" { throw ModelAPIError.response }
                if block?["type"] as? String == "text", let text = block?["text"] as? String { append(text) }
            case "content_block_delta":
                let delta = root["delta"] as? [String: Any]
                if delta?["type"] as? String == "text_delta", let text = delta?["text"] as? String { append(text) }
            case "message_delta":
                let delta = root["delta"] as? [String: Any]
                if let reason = delta?["stop_reason"] as? String {
                    try checkStop(reason)
                    completed = true
                }
            case "message_stop": return true
            case "error": throw ModelAPIError.response
            default: break
            }
        }
        return false
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private enum ModelAPIError: LocalizedError {
    case missingKey, invalidKey, requestTooLarge, responseTooLarge, transport, timeout, http(Int), response, truncated

    var errorDescription: String? {
        switch self {
        case .missingKey: return "Add an API key for this provider in Settings."
        case .invalidKey: return "Enter a single API key without spaces or line breaks."
        case .requestTooLarge: return "The conversation is too long for this request. Start a new conversation or shorten the input."
        case .responseTooLarge: return "The API response exceeded the size limit."
        case .transport: return "Could not reach the API. Check the provider address and network."
        case .timeout: return "The API request timed out."
        case .http(let code) where code == 401 || code == 403:
            return "The API denied access (HTTP \(code)). Check the key and its permissions."
        case .http(404): return "The API could not find the endpoint or model (HTTP 404). Check the address and model ID."
        case .http(429): return "The API rate limit or quota was reached (HTTP 429)."
        case .http(let code): return "The API returned HTTP \(code). Check the provider settings or try again later."
        case .response: return "The API did not return a supported text response."
        case .truncated: return "The API response ended before completion."
        }
    }
}

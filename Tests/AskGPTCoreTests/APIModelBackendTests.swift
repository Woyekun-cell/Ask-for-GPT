import Foundation
import Testing
@testable import AskGPTCore

@Suite(.serialized)
struct APIModelBackendTests {
    @Test func chatStreamsTextAndCarriesSuccessfulHistory() async throws {
        let fixture = try Fixture(kind: .openAI)
        defer { fixture.remove() }
        APIProtocolFixture.handler = { request in
            #expect(request.url?.path == "/v1/chat/completions")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-key")
            let body = try Self.body(request)
            let messages = try #require(body["messages"] as? [[String: String]])
            #expect(body["model"] as? String == "fixture-model")
            #expect(body["stream"] as? Bool == true)
            let question = try #require(messages.last?["content"])
            if question == "first" {
                #expect(messages.map { $0["content"] } == ["Read the excerpt", "first"])
            } else {
                #expect(messages.map { $0["content"] } == ["Read the excerpt", "first", "你好", "second"])
            }
            return (200, "text/event-stream", """
            data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}

            data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}

            data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

            data: [DONE]


            """)
        }
        let client = fixture.backend()
        let thread = try await client.startSession(instructions: "Read the excerpt")
        let first = try await client.send(threadID: thread, text: "first", onDelta: { _ in })
        #expect(first.text == "你好")
        let second = try await client.send(threadID: thread, text: "second", onDelta: { _ in })
        #expect(second.text == "你好")
        #expect(second.firstDeltaSeconds != nil)
        await client.shutdown()
        _ = try await client.startSession(instructions: "reconnected")
    }

    @Test func claudeUsesNativeMessagesAndStructuredInstructions() async throws {
        let fixture = try Fixture(kind: .anthropic)
        defer { fixture.remove() }
        APIProtocolFixture.handler = { request in
            #expect(request.url?.path == "/v1/messages")
            #expect(request.value(forHTTPHeaderField: "x-api-key") == "fixture-key")
            #expect(request.value(forHTTPHeaderField: "anthropic-version") == "2023-06-01")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            let body = try Self.body(request)
            let system = try #require(body["system"] as? String)
            #expect(system.hasPrefix("Translate the quoted input"))
            #expect(system.contains("\"required\":[\"translation\"]"))
            #expect(body["messages"] as? [[String: String]] == [["role": "user", "content": "paper excerpt"]])
            return (200, "application/json", """
            {"type":"message","content":[{"type":"text","text":"{\\"translation\\":\\"译文\\"}"}],"stop_reason":"end_turn"}
            """)
        }
        let client = fixture.backend()
        let thread = try await client.startSession(instructions: "Translate the quoted input")
        let result = try await client.sendStructured(threadID: thread, text: "paper excerpt",
            schema: RPCObject(["type": "object", "required": ["translation"]]), onDelta: { _ in })
        #expect(result.text == "{\"translation\":\"译文\"}")
    }

    @Test func modelDiscoveryUsesDraftCredentialAndDoesNotGenerate() async throws {
        let fixture = try Fixture(kind: .openAI)
        defer { fixture.remove() }
        APIProtocolFixture.handler = { request in
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path == "/v1/models")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer draft-key")
            return (200, "application/json", """
            {"object":"list","data":[{"id":"z-model","object":"model"},{"id":"a-model","object":"model"},{"id":"z-model","object":"model"}]}
            """)
        }
        var draft = fixture.profile
        draft.model = ""
        let models = try await APIModelBackend.listModels(profile: draft, apiKey: "draft-key",
            keyStore: fixture.keyStore, configuration: fixture.configuration)
        #expect(models == ["a-model", "z-model"])
    }

    @Test func httpFailureDoesNotLeakResponseOrEnterHistory() async throws {
        let fixture = try Fixture(kind: .openAI)
        defer { fixture.remove() }
        APIProtocolFixture.handler = { request in
            let body = try Self.body(request)
            let messages = try #require(body["messages"] as? [[String: String]])
            if messages.last?["content"] == "failing" {
                return (401, "application/json", "{\"error\":\"remote fixture-key echo\"}")
            }
            #expect(messages.map { $0["content"] } == ["System", "retry"])
            return (200, "application/json", """
            {"choices":[{"message":{"role":"assistant","content":"Recovered"},"finish_reason":"stop"}]}
            """)
        }
        let client = fixture.backend()
        let thread = try await client.startSession(instructions: "System")
        do {
            _ = try await client.send(threadID: thread, text: "failing", onDelta: { _ in })
            Issue.record("An HTTP 401 was accepted")
        } catch {
            #expect(error.localizedDescription.contains("401"))
            #expect(!error.localizedDescription.contains("fixture-key"))
        }
        let result = try await client.send(threadID: thread, text: "retry", onDelta: { _ in })
        #expect(result.text == "Recovered")
    }

    @Test(.timeLimit(.minutes(1))) func interruptCancelsStreamingTurnAndLeavesSessionReusable() async throws {
        let fixture = try Fixture(kind: .openAI)
        defer { fixture.remove() }
        APIProtocolFixture.holdOpen = true
        APIProtocolFixture.handler = { _ in
            (200, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
        }
        let client = fixture.backend()
        let thread = try await client.startSession(instructions: "System")
        let (deltas, continuation) = AsyncStream.makeStream(of: String.self)
        let turn = Task {
            try await client.send(threadID: thread, text: "cancel me", onDelta: { continuation.yield($0) })
        }
        defer { turn.cancel(); continuation.finish() }
        var iterator = deltas.makeAsyncIterator()
        #expect(await iterator.next() == "partial")
        await client.interrupt(threadID: thread)
        do {
            _ = try await turn.value
            Issue.record("Interrupted turn completed")
        } catch is CancellationError {}

        APIProtocolFixture.holdOpen = false
        APIProtocolFixture.handler = { request in
            let body = try Self.body(request)
            let messages = try #require(body["messages"] as? [[String: String]])
            #expect(messages.map { $0["content"] } == ["System", "retry"])
            return (200, "application/json", """
            {"choices":[{"message":{"role":"assistant","content":"Recovered"},"finish_reason":"stop"}]}
            """)
        }
        let result = try await client.send(threadID: thread, text: "retry", onDelta: { _ in })
        #expect(result.text == "Recovered")
    }

    @Test func requestsOnlyForwardEffortForSupportedOfficialModel() async throws {
        let scenarios: [(kind: APIProviderKind, model: String, effort: String?, reasoning: String?,
                         thinking: String?, anthropic: String?, official: Bool)] = [
            (.openAI, "gpt-6.1-sol", "high", "high", nil, nil, true),
            (.openAI, "gpt-6.1-sol", "none", nil, nil, nil, true),
            (.openAI, "gpt-6.1-sol", "high", nil, nil, nil, false),
            (.custom, "gpt-6.1-sol", "high", nil, nil, nil, false),
            (.gemini, "gemini-3.8-flash", "medium", "medium", nil, nil, true),
            (.deepSeek, "deepseek-v4-pro", "max", "max", "enabled", nil, true),
            (.deepSeek, "deepseek-flash", "none", nil, "disabled", nil, true),
            (.deepSeek, "deepseek-flash", nil, nil, nil, nil, true),
            (.anthropic, "claude-sonnet-5-5", "high", nil, nil, "high", true),
        ]
        for (kind, model, effort, expectedEffort, thinking, anthropicEffort, official) in scenarios {
            var profile = APIProviderProfile(kind: kind)
            profile.model = model
            if let effort { profile.modelReasoningEfforts = [model: effort] }
            if !official { profile.baseURL = "https://fixture.example/v1" }
            let fixture = try Fixture(profile: profile)
            defer { fixture.remove() }
            APIProtocolFixture.handler = { request in
                let body = try Self.body(request)
                #expect(body["model"] as? String == model)
                #expect(body["reasoning_effort"] as? String == expectedEffort)
                #expect((body["thinking"] as? [String: String])?["type"] == thinking)
                #expect((body["output_config"] as? [String: String])?["effort"] == anthropicEffort)
                if kind == .anthropic {
                    return (200, "application/json", #"{"content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}"#)
                }
                return (200, "application/json", #"{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}"#)
            }
            let client = fixture.backend()
            let thread = try await client.startSession(instructions: "Fixture")
            let result = try await client.send(threadID: thread, text: "Test", onDelta: { _ in })
            #expect(result.text == "OK")
        }
    }

    private static func body(_ request: URLRequest) throws -> [String: Any] {
        if let bytes = request.httpBody { return try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any]) }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        return try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }

    private struct Fixture {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let profile: APIProviderProfile
        var keyStore: APIProviderKeyStore { APIProviderKeyStore(directory: directory) }
        var configuration: URLSessionConfiguration {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [APIProtocolFixture.self]
            return configuration
        }

        init(kind: APIProviderKind) throws {
            var profile = APIProviderProfile(kind: kind)
            profile.baseURL = "https://fixture.example/v1"
            profile.model = "fixture-model"
            try self.init(profile: profile)
        }

        init(profile: APIProviderProfile) throws {
            self.profile = profile
            try keyStore.write("fixture-key", for: profile)
        }

        func backend() -> APIModelBackend {
            APIModelBackend(profile: profile, keyStore: keyStore, configuration: configuration)
        }

        func remove() {
            APIProtocolFixture.handler = nil
            APIProtocolFixture.holdOpen = false
            try? FileManager.default.removeItem(at: directory)
        }
    }
}

private final class APIProtocolFixture: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, String, String))?
    static var holdOpen = false

    override class func canInit(with request: URLRequest) -> Bool {
        // Every HTTP request in this fixture is intercepted, including official vendor URLs.
        ["https", "http"].contains(request.url?.scheme ?? "")
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let handler = try #require(Self.handler)
            let (status, type, body) = try handler(request)
            let response = try #require(HTTPURLResponse(url: request.url!, statusCode: status,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type]))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            let bytes = Data(body.utf8)
            client?.urlProtocol(self, didLoad: bytes.prefix(bytes.count / 2))
            client?.urlProtocol(self, didLoad: bytes.dropFirst(bytes.count / 2))
            if !Self.holdOpen { client?.urlProtocolDidFinishLoading(self) }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

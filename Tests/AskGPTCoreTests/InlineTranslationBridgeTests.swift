import Darwin
import Foundation
import Network
import Testing
@testable import AskGPTCore

@Suite(.serialized)
struct InlineTranslationBridgeTests {
    private let extensionID = "ofcbkomnacejiphoifjmkmkpjcjddmfj"
    private let token = String(repeating: "x", count: 64)
    private var origin: String { "chrome-extension://" + extensionID }

    @Test func connectionFileIsPrivateStableAndUsesIndependentEndpoint() throws {
        let folder = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("private/connection.local.json")
        let first = try InlineConnectionConfiguration.loadOrCreate(at: file, extensionID: extensionID)
        let second = try InlineConnectionConfiguration.loadOrCreate(at: file, extensionID: extensionID)
        #expect(first.version == 1)
        #expect(first.endpoint == "http://127.0.0.1:43792")
        #expect(first.extensionID == extensionID)
        #expect(first.token == second.token)
        #expect(first.token.utf8.count >= 32)
        #expect(first.token.utf8.allSatisfy { (33...126).contains($0) })
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let directory = try FileManager.default.attributesOfItem(atPath: file.deletingLastPathComponent().path)
        #expect((directory[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        let object = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        #expect(Set(object.keys) == Set(["version", "endpoint", "token", "extensionID"]))
    }

    @Test func connectionFileRejectsUnpairedUnsafeAndMalformedFiles() throws {
        let folder = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("connection.json")
        _ = try InlineConnectionConfiguration.loadOrCreate(at: file, extensionID: extensionID)
        #expect(throws: InlineBridgeFailure.self) {
            try InlineConnectionConfiguration.loadOrCreate(at: file, extensionID: String(repeating: "a", count: 32))
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        #expect(throws: InlineBridgeFailure.self) {
            try InlineConnectionConfiguration.loadOrCreate(at: file, extensionID: extensionID)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let link = folder.appendingPathComponent("linked.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        #expect(throws: InlineBridgeFailure.self) {
            try InlineConnectionConfiguration.loadOrCreate(at: link, extensionID: extensionID)
        }
        for patch: [String: Any] in [["version": 2], ["endpoint": "http://localhost:43792"], ["token": "short"]] {
            var object: [String: Any] = ["version": 1, "endpoint": InlineConnectionConfiguration.baseEndpoint,
                "token": token, "extensionID": extensionID]
            object.merge(patch) { _, next in next }
            try JSONSerialization.data(withJSONObject: object).write(to: file)
            #expect(throws: InlineBridgeFailure.self) {
                try InlineConnectionConfiguration.loadOrCreate(at: file, extensionID: extensionID)
            }
        }
        #expect(throws: InlineBridgeFailure.self) { try InlineConnectionConfiguration(extensionID: "arbitrary") }
        #expect(throws: InlineBridgeFailure.self) {
            try InlineConnectionConfiguration.loadOrCreate(at: URL(string: "https://example.com/config")!, extensionID: extensionID)
        }
    }

    @Test func productionNativePathTranslatesExactEnglishWithoutGPT() async throws {
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration)
        let response = await bridge.handleRequest(request(text: "glucan", port: 43792))
        #expect(response.status == 200)
        #expect(try json(response)["translation"] as? String == "葡聚糖")
        #expect(try json(response)["id"] as? String == "paragraph-1")
        await bridge.shutdown()
    }

    @Test func healthRequiresBearerAndNeverReturnsCredentials() async throws {
        let calls = InlineTestCalls()
        let bridge = try makeBridge { text in await calls.record(text); return "unused" }
        let rejected = await bridge.handleRequest(request(method: "GET", path: "/v1/inline/health", headers: ["authorization": "Bearer incorrect"]))
        #expect(rejected.status == 401)
        let ready = await bridge.handleRequest(request(method: "GET", path: "/v1/inline/health"))
        #expect(ready.status == 200)
        let object = try json(ready)
        #expect(object["status"] as? String == "ready")
        #expect(object["protocolVersion"] as? Int == 1)
        #expect(object["token"] == nil)
        #expect(!String(decoding: ready.wireData, as: UTF8.self).contains(token))
        #expect(ready.headers["Access-Control-Allow-Origin"] == nil)
        #expect(await calls.texts.isEmpty)
        await bridge.shutdown()
    }

    @Test func strictHostAndPairedOriginAreEnforcedBeforeTranslation() async throws {
        let calls = InlineTestCalls()
        let bridge = try makeBridge { text in await calls.record(text); return "译文" }
        for host in ["localhost:0", "127.0.0.1", "127.0.0.1:43791", "attacker.example:0"] {
            #expect(await bridge.handleRequest(request(headers: ["host": host])).status == 403)
        }
        for hostileOrigin in ["https://example.com", "null", "chrome-extension://" + String(repeating: "a", count: 32), origin + "/"] {
            let response = await bridge.handleRequest(request(headers: ["origin": hostileOrigin]))
            #expect(response.status == 403)
            #expect(response.headers["Access-Control-Allow-Origin"] == nil)
        }
        #expect(await calls.texts.isEmpty)
        let approved = await bridge.handleRequest(request(headers: ["origin": origin]))
        #expect(approved.status == 200)
        #expect(approved.headers["Access-Control-Allow-Origin"] == origin)
        let zotero = await bridge.handleRequest(request(text: "Zotero paragraph."))
        #expect(zotero.status == 200)
        #expect(zotero.headers["Access-Control-Allow-Origin"] == nil)
        #expect(await calls.texts.count == 2)
        await bridge.shutdown()
    }

    @Test func preflightAllowsOnlyPairedExtensionAndBoundedHeaders() async throws {
        let bridge = try makeBridge { _ in "unused" }
        let goodHeaders = ["origin": origin, "authorization": "", "access-control-request-method": "POST",
            "access-control-request-headers": "Authorization, Content-Type", "access-control-request-private-network": "true"]
        let response = await bridge.handleRequest(request(method: "OPTIONS", headers: goodHeaders))
        #expect(response.status == 204)
        #expect(response.body.isEmpty)
        #expect(response.headers["Access-Control-Allow-Private-Network"] == "true")
        #expect(response.headers["Access-Control-Allow-Headers"] == "Authorization, Content-Type")
        for patch in [["origin": "https://example.com"], ["origin": "null"], ["access-control-request-method": "DELETE"],
                      ["access-control-request-headers": "Authorization, X-Anything"], ["access-control-request-private-network": "false"]] {
            var headers = goodHeaders; headers.merge(patch) { _, next in next }
            #expect(await bridge.handleRequest(request(method: "OPTIONS", headers: headers)).status != 204)
        }
        #expect(await bridge.handleRequest(request(method: "OPTIONS", headers: ["access-control-request-method": "POST"])).status == 403)
        #expect(await bridge.handleRequest(request(method: "OPTIONS", path: "/v1/chat/completions", headers: goodHeaders)).status == 403)
        await bridge.shutdown()
    }

    @Test func translationPreservesExactParagraphAndRequestID() async throws {
        let calls = InlineTestCalls()
        let bridge = try makeBridge { text in await calls.record(text); return "n = 8；未升高。" }
        let text = "  EPRS1 did not increase at 24 h (n = 8 tanks).\nThe dose was 2.5 mg/L.  "
        let response = await bridge.handleRequest(request(id: "page-7:block-3", text: text))
        #expect(response.status == 200)
        #expect(try json(response)["id"] as? String == "page-7:block-3")
        #expect(try json(response)["translation"] as? String == "n = 8；未升高。")
        #expect(await calls.texts == [text])
        await bridge.shutdown()
    }

    @Test func reverseDirectionAcceptsOnlyExplicitSimplifiedChineseToEnglish() async throws {
        let calls = InlineTestCalls()
        let bridge = try makeBridge { text in await calls.record(text); return "EPRS1 did not increase at 24 h (n = 8 tanks)." }
        let original = "处理后24小时，EPRS1未升高（n = 8个水槽）。"
        let response = await bridge.handleRequest(request(id: "reverse:p1", text: original, source: "zh-Hans", target: "en"))
        #expect(response.status == 200)
        #expect(try json(response)["id"] as? String == "reverse:p1")
        #expect(try json(response)["translation"] as? String == "EPRS1 did not increase at 24 h (n = 8 tanks).")
        #expect(await calls.texts == [original])
        await bridge.shutdown()
    }

    @Test func nativeDirectionAndCacheRemainBoundToTextAndPairInsteadOfRequestID() async throws {
        let driver = InlineNativeDirectionSpy()
        let engine = NativeTranslationEngine(driver: driver)
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration, port: 0,
            translatorFactory: InlineTranslationBridge.nativeTranslatorFactory(engineFactory: { engine }))
        let forward = await bridge.handleRequest(request(id: "same-block", text: "RNA-742."))
        let reverse = await bridge.handleRequest(request(id: "same-block", text: "RNA-742.", source: "zh-Hans", target: "en"))
        let cached = await bridge.handleRequest(request(id: "same-block", text: "RNA-742."))
        let changed = await bridge.handleRequest(request(id: "same-block", text: "RNA-743."))
        #expect([forward, reverse, cached, changed].allSatisfy { $0.status == 200 })
        #expect(try json(forward)["translation"] as? String == "en>zh-Hans:RNA-742.")
        #expect(try json(reverse)["translation"] as? String == "zh-Hans>en:RNA-742.")
        #expect(try json(cached)["translation"] as? String == "en>zh-Hans:RNA-742.")
        #expect(try json(changed)["translation"] as? String == "en>zh-Hans:RNA-743.")
        #expect(await driver.calls == [
            .init(text: "RNA-742.", source: "en", target: "zh-Hans"),
            .init(text: "RNA-742.", source: "zh-Hans", target: "en"),
            .init(text: "RNA-743.", source: "en", target: "zh-Hans")
        ])
        await bridge.shutdown()
    }

    @Test func onlyTheTwoExactLanguagePairsReachTranslator() async throws {
        let calls = InlineTestCalls()
        let bridge = try makeBridge { text in await calls.record(text); return "unused" }
        for pair in [("en", "en"), ("zh-Hans", "zh-Hans"), ("auto", "en"), ("zh", "en"),
                     ("zh-CN", "en"), ("zh-Hant", "en"), ("en-US", "zh-Hans"), ("fr", "en"),
                     ("en", "ja"), ("", "en"), (" en", "zh-Hans")] {
            let response = await bridge.handleRequest(request(source: pair.0, target: pair.1))
            #expect(response.status == 400)
            #expect(try errorCode(response) == "invalid_request")
        }
        #expect(await calls.texts.isEmpty)
        await bridge.shutdown()
    }

    @Test func schemaLanguageAndScalarLimitsRejectBeforeTranslation() async throws {
        let calls = InlineTestCalls()
        let bridge = try makeBridge { text in await calls.record(text); return "译文" }
        let accepted = await bridge.handleRequest(request(id: String(repeating: "A", count: 80), text: String(repeating: "🧬", count: 1800)))
        #expect(accepted.status == 200)
        #expect(await bridge.handleRequest(request(text: String(repeating: "a", count: 1801))).status == 413)
        #expect(await bridge.handleRequest(request(text: String(repeating: "e\u{301}", count: 901))).status == 413)
        for id in ["", "  ", String(repeating: "a", count: 81), "中文", "line\nsecond"] {
            #expect(await bridge.handleRequest(request(id: id)).status == 400)
        }
        for patch: [String: Any] in [["source": "auto"], ["source": "zh-Hans"], ["target": "en"],
                                   ["text": "\n\t "], ["text": 1], ["unexpected": "extra"]] {
            var object: [String: Any] = ["id": "p1", "text": "An English paragraph.", "source": "en", "target": "zh-Hans"]
            object.merge(patch) { _, next in next }
            #expect(await bridge.handleRequest(request(body: try JSONSerialization.data(withJSONObject: object))).status == 400)
        }
        #expect(await bridge.handleRequest(request(body: Data("{}".utf8))).status == 400)
        #expect(await bridge.handleRequest(request(body: Data(repeating: 32, count: 16_385))).status == 413)
        #expect(await bridge.handleRequest(request(headers: ["content-type": "text/plain"])).status == 415)
        #expect(await calls.texts.count == 1)
        await bridge.shutdown()
    }

    @Test func parserHandlesSplitUnicodeAndRejectsSmugglingEarly() throws {
        let body = request(text: "β-glucan was not elevated.").body
        let head = Data("POST /v1/inline/translate HTTP/1.1\r\nHost: 127.0.0.1:0\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
        var parser = InlineHTTPParser()
        #expect(try parser.append(head.prefix(8)) == nil)
        #expect(try parser.append(head.dropFirst(8)) == nil)
        #expect(try parser.append(body.prefix(5)) == nil)
        let complete = try parser.append(body.dropFirst(5))
        let parsed = try #require(complete)
        #expect(parsed.body == body)
        #expect(parsed.headers["host"] == "127.0.0.1:0")
        for field in ["Content-Length: 1\r\nContent-Length: 1", "Content-Length: 1\r\nTransfer-Encoding: chunked",
                      "Content-Length: -1", "Content-Length: 16385", "Content-Length: 9999999999999999999999999",
                      "Content-Length : 0", " Folded: no"] {
            var parser = InlineHTTPParser()
            #expect(throws: InlineBridgeFailure.self) {
                try parser.append(Data("POST /v1/inline/translate HTTP/1.1\r\n\(field)\r\n\r\n".utf8))
            }
        }
        var missingLength = InlineHTTPParser()
        #expect(throws: InlineBridgeFailure.self) { try missingLength.append(Data("POST / HTTP/1.1\r\n\r\n".utf8)) }
        var pipelined = InlineHTTPParser()
        #expect(throws: InlineBridgeFailure.self) { try pipelined.append(Data("GET / HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\n\r\n".utf8)) }
        var oversizedHeaders = InlineHTTPParser()
        #expect(throws: InlineBridgeFailure.self) { try oversizedHeaders.append(Data(repeating: 65, count: 16_385)) }
    }

    @Test func busyRequestCannotMixOrQueueParagraphs() async throws {
        let gate = InlineTestGate()
        let bridge = try makeBridge { text in await gate.wait(); return "translated: " + text }
        let first = Task { await bridge.handleRequest(request(id: "first", text: "First paragraph.")) }
        try await waitFor { await gate.started }
        let rejected = await bridge.handleRequest(request(id: "second", text: "Second paragraph."))
        #expect(rejected.status == 503)
        #expect(try errorCode(rejected) == "translation_busy")
        await gate.release()
        let response = await first.value
        #expect(response.status == 200)
        #expect(try json(response)["id"] as? String == "first")
        #expect(try json(response)["translation"] as? String == "translated: First paragraph.")
        await bridge.shutdown()
    }

    @Test func timeoutDoesNotWaitForUncancellableOperationAndRotatesGeneration() async throws {
        let gate = InlineTestGate(), generations = InlineTestGenerations()
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration, port: 0, translationTimeout: 0.05,
            translatorFactory: generations.factory(gate: gate))
        let start = ProcessInfo.processInfo.systemUptime
        let timeout = await bridge.handleRequest(request())
        #expect(timeout.status == 504)
        #expect(try errorCode(timeout) == "translation_timeout")
        #expect(ProcessInfo.processInfo.systemUptime - start < 0.8)
        #expect(await gate.started)
        let next = await bridge.handleRequest(request(id: "fresh", text: "Next paragraph."))
        #expect(next.status == 200)
        #expect(try json(next)["translation"] as? String == "fresh: Next paragraph.")
        #expect(generations.count == 2)
        await gate.release()
        #expect(try json(next)["id"] as? String == "fresh")
        await bridge.shutdown()
    }

    @Test func cancellationImmediatelyReleasesBusySlotDespiteUncancellableWork() async throws {
        let gate = InlineTestGate(), generations = InlineTestGenerations()
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration, port: 0, translationTimeout: 5,
            translatorFactory: generations.factory(gate: gate))
        let first = Task { await bridge.handleRequest(request()) }
        try await waitFor { await gate.started }
        let start = ProcessInfo.processInfo.systemUptime
        first.cancel()
        #expect(await first.value.status == 499)
        #expect(ProcessInfo.processInfo.systemUptime - start < 0.8)
        #expect(await bridge.handleRequest(request(text: "New paragraph.")).status == 200)
        #expect(generations.count == 2)
        await gate.release()
        await bridge.shutdown()
    }

    @Test func backendErrorsAreSanitizedAndNeverReturnSuccessOrInput() async throws {
        let bridge = try makeBridge { _ in throw InlineFixtureFailure.failed }
        let response = await bridge.handleRequest(request(text: "PRIVATE_SYNTHETIC_MARKER"))
        #expect(response.status == 502)
        #expect(try errorCode(response) == "translation_failed")
        #expect(try json(response)["translation"] == nil)
        let serialized = String(decoding: response.body, as: UTF8.self)
        #expect(!serialized.contains("PRIVATE_SYNTHETIC_MARKER"))
        #expect(!serialized.contains(token))
        await bridge.shutdown()
    }

    @Test func actualLoopbackEnforcesAuthenticationOriginAndRequestContract() async throws {
        let calls = InlineTestCalls()
        let bridge = try makeBridge { text in await calls.record(text); return "本机译文" }
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var query = socketRequest(port: port)
        query.setValue(nil, forHTTPHeaderField: "Authorization")
        let (_, denied) = try await session.data(for: query)
        #expect((denied as? HTTPURLResponse)?.statusCode == 401)
        query.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        query.setValue("https://example.com", forHTTPHeaderField: "Origin")
        let (_, foreign) = try await session.data(for: query)
        #expect((foreign as? HTTPURLResponse)?.statusCode == 403)
        query.setValue(origin, forHTTPHeaderField: "Origin")
        let (data, response) = try await session.data(for: query)
        let http = try #require(response as? HTTPURLResponse)
        #expect(http.statusCode == 200)
        #expect(http.value(forHTTPHeaderField: "Access-Control-Allow-Origin") == origin)
        #expect((try JSONSerialization.jsonObject(with: data) as? [String: String])?["translation"] == "本机译文")
        #expect(await calls.texts.count == 1)
        await bridge.shutdown()
    }

    @Test func actualLoopbackContinuesAfterMoreThanSixteenCompletedRequests() async throws {
        let bridge = try makeBridge { _ in "译文" }
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        for _ in 0..<20 {
            let (_, response) = try await session.data(for: socketRequest(port: port))
            #expect((response as? HTTPURLResponse)?.statusCode == 200)
        }
        await bridge.shutdown()
    }

    @Test func seventeenthConcurrentSocketIsClosedWithoutExpandingClientLimit() async throws {
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration, port: 0, readTimeout: 5,
            translatorFactory: { { _, _, _ in "unused" } })
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        var occupied: [NWConnection] = []
        defer { for socket in occupied { socket.cancel() } }
        for index in 0..<16 {
            let socket = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
            socket.start(queue: DispatchQueue(label: "inline.tests.occupied.\(index)"))
            try await send(Data("GET /v1/inline/health HTTP/1.1\r\n".utf8), socket: socket)
            occupied.append(socket)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        let extra = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        extra.start(queue: DispatchQueue(label: "inline.tests.extra"))
        defer { extra.cancel() }
        // Sending can already fail when the listener closes the accepted socket.
        try? await send(Data("GET /v1/inline/health HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nAuthorization: Bearer \(token)\r\n\r\n".utf8), socket: extra)
        let start = ProcessInfo.processInfo.systemUptime
        let timer = Task { try? await Task.sleep(nanoseconds: 1_000_000_000); if !Task.isCancelled { extra.cancel() } }
        let rejected = await withCheckedContinuation { continuation in
            extra.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
                continuation.resume(returning: (complete || error != nil) && (data?.isEmpty ?? true))
            }
        }
        timer.cancel()
        #expect(rejected)
        #expect(ProcessInfo.processInfo.systemUptime - start < 0.8)
        await bridge.shutdown()
    }

    @Test func actualSocketTimeoutReturnsErrorAndNextParagraphUsesFreshEngine() async throws {
        let gate = InlineTestGate(), generations = InlineTestGenerations()
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration, port: 0, translationTimeout: 0.05,
            translatorFactory: generations.factory(gate: gate))
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: socketRequest(port: port))
        #expect((response as? HTTPURLResponse)?.statusCode == 504)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect((object["error"] as? [String: String])?["code"] == "translation_timeout")
        let (_, next) = try await session.data(for: socketRequest(port: port))
        #expect((next as? HTTPURLResponse)?.statusCode == 200)
        #expect(generations.count == 2)
        await gate.release()
        await bridge.shutdown()
    }

    @Test func disconnectAbandonsOldGenerationAndAllowsNewParagraph() async throws {
        let gate = InlineTestGate(), generations = InlineTestGenerations()
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration, port: 0, translationTimeout: 5,
            translatorFactory: generations.factory(gate: gate))
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        let socket = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        socket.start(queue: DispatchQueue(label: "inline.tests.disconnect"))
        let body = request().body
        var wire = Data("POST /v1/inline/translate HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nAuthorization: Bearer \(token)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
        wire.append(body)
        try await send(wire, socket: socket)
        try await waitFor { await gate.started }
        socket.cancel()
        try await waitFor { generations.count == 2 }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: socketRequest(port: port))
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect((try JSONSerialization.jsonObject(with: data) as? [String: String])?["translation"] == "fresh: A synthetic English paragraph.")
        await gate.release()
        await bridge.shutdown()
    }

    @Test func incompleteSocketRequestIsClosedByReadDeadline() async throws {
        let calls = InlineTestCalls()
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        let bridge = InlineTranslationBridge(configuration: configuration, port: 0, readTimeout: 0.05,
            translatorFactory: { { text, _, _ in await calls.record(text); return "unused" } })
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        let socket = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        socket.start(queue: DispatchQueue(label: "inline.tests.read"))
        defer { socket.cancel() }
        try await send(Data("POST /v1/inline/translate HTTP/1.1\r\n".utf8), socket: socket)
        let start = ProcessInfo.processInfo.systemUptime
        let timer = Task { try? await Task.sleep(nanoseconds: 1_000_000_000); if !Task.isCancelled { socket.cancel() } }
        let closed = await withCheckedContinuation { continuation in
            socket.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
                continuation.resume(returning: complete || error != nil || data == nil)
            }
        }
        timer.cancel()
        #expect(closed)
        #expect(ProcessInfo.processInfo.systemUptime - start < 0.8)
        #expect(await calls.texts.isEmpty)
        await bridge.shutdown()
    }

    @Test func shutdownCancelsActiveSocketWithoutWaitingForFrameworkAndReleasesPort() async throws {
        let gate = InlineTestGate()
        let bridge = try makeBridge(timeout: 5) { _ in await gate.wait(); return "stale" }
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let requestTask = Task { try? await session.data(for: socketRequest(port: port)) }
        try await waitFor { await gate.started }
        let start = ProcessInfo.processInfo.systemUptime
        await bridge.shutdown()
        #expect(ProcessInfo.processInfo.systemUptime - start < 0.8)
        let replacement = try makeBridge(port: port) { _ in "fresh" }
        try await replacement.start()
        await replacement.shutdown()
        await gate.release()
        requestTask.cancel()
        _ = await requestTask.value
    }

    @Test func portConflictsAndOverlappingLifecycleCallsDoNotReplaceListener() async throws {
        let first = try makeBridge { _ in "译文" }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<2 { group.addTask { try await first.start() } }
            try await group.waitForAll()
        }
        let port = try #require(await first.listeningPort)
        let conflict = try makeBridge(port: port) { _ in "unused" }
        do { try await conflict.start(); Issue.record("Conflicting port must fail") }
        catch { #expect(error is InlineBridgeFailure) }
        await conflict.shutdown()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<2 { group.addTask { await first.shutdown() } }
            await group.waitForAll()
        }
        let replacement = try makeBridge(port: port) { _ in "replacement" }
        try await replacement.start()
        await replacement.shutdown()
    }

    private func makeBridge(port: UInt16 = 0, timeout: Double = 2,
                            handler: @escaping @Sendable (String) async throws -> String) throws -> InlineTranslationBridge {
        let configuration = try InlineConnectionConfiguration(token: token, extensionID: extensionID)
        return InlineTranslationBridge(configuration: configuration, port: port, translationTimeout: timeout,
            translatorFactory: { { text, _, _ in try await handler(text) } })
    }
    private func request(method: String = "POST", path: String = "/v1/inline/translate", id: String = "paragraph-1",
                         text: String = "A synthetic English paragraph.", port: UInt16 = 0,
                         source: String = "en", target: String = "zh-Hans",
                         headers extra: [String: String] = [:], body: Data? = nil) -> InlineHTTPRequest {
        var headers = ["host": "127.0.0.1:\(port)", "authorization": "Bearer " + token, "content-type": "application/json"]
        headers.merge(extra) { _, next in next }
        let encoded = try! JSONSerialization.data(withJSONObject: ["id": id, "text": text, "source": source, "target": target])
        return InlineHTTPRequest(method: method, path: path, headers: headers, body: body ?? encoded)
    }
    private func socketRequest(port: UInt16) -> URLRequest {
        var query = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/v1/inline/translate")!)
        query.httpMethod = "POST"; query.httpBody = request().body; query.timeoutInterval = 2
        query.setValue("application/json", forHTTPHeaderField: "Content-Type")
        query.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        return query
    }
    private func json(_ response: InlineHTTPResponse) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
    }
    private func errorCode(_ response: InlineHTTPResponse) throws -> String {
        let object = try #require(json(response)["error"] as? [String: String])
        return try #require(object["code"])
    }
    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("InlineBridgeTests-" + UUID().uuidString, isDirectory: true)
    }
    private func waitFor(_ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        throw InlineFixtureFailure.conditionTimedOut
    }
    private func send(_ data: Data, socket: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            socket.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }
}

private actor InlineTestCalls {
    private(set) var texts: [String] = []
    func record(_ text: String) { texts.append(text) }
}
private actor InlineNativeDirectionSpy: NativeTranslationDriver {
    struct Call: Equatable { let text: String; let source: String; let target: String }
    private(set) var calls: [Call] = []
    func availability(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability { .installed }
    func warmUp(sourceLanguage: String, targetLanguage: String) async throws {}
    func translate(_ text: String, sourceLanguage: String, targetLanguage: String) async throws -> String {
        calls.append(.init(text: text, source: sourceLanguage, target: targetLanguage))
        return sourceLanguage + ">" + targetLanguage + ":" + text
    }
}
private actor InlineTestGate {
    private(set) var started = false
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        started = true
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}
private final class InlineTestGenerations: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0
    var count: Int { lock.withLock { generation } }
    func factory(gate: InlineTestGate) -> InlineTranslationBridge.TranslatorFactory {
        { [self] in
            let first = lock.withLock { generation += 1; return generation == 1 }
            return { text, _, _ in
                if first { await gate.wait(); return "late stale translation" }
                return "fresh: " + text
            }
        }
    }
}
private enum InlineFixtureFailure: Error { case failed, conditionTimedOut }

import Foundation
import Network
import Security
import Testing
@testable import AskGPTCore

@Suite(.serialized)
struct WritingBridgeTests {
    private let token = String(repeating: "b", count: 64)
    private let origin = "https://localhost:43793"

    @Test func anonymousSocketDiagnosticUsesOnlyCompletedSendOrFixedFailureStates() {
        #expect(NativeWritingDocumentDiagnostics.socketOutcome(sent: true, cancelled: false).rawValue == "sent")
        #expect(NativeWritingDocumentDiagnostics.socketOutcome(sent: true, cancelled: true).rawValue == "sent")
        #expect(NativeWritingDocumentDiagnostics.socketOutcome(sent: false, cancelled: true).rawValue == "cancelled")
        #expect(NativeWritingDocumentDiagnostics.socketOutcome(sent: false, cancelled: false).rawValue == "io_failed")
    }

    @Test func configurationIsPrivateStableAndIndependent() throws {
        let directory = temporary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("connection.json")
        let first = try WritingConnectionConfiguration.loadOrCreate(at: url)
        let second = try WritingConnectionConfiguration.loadOrCreate(at: url)
        #expect(first.token == second.token)
        #expect(first.baseURL == origin)
        #expect(first.token.count == 64)
        #expect(try permissions(url) == 0o600)
        #expect(try permissions(directory) == 0o700)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        #expect(throws: WritingBridgeError.self) { try WritingConnectionConfiguration.loadOrCreate(at: url) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let link = directory.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
        #expect(throws: WritingBridgeError.self) { try WritingConnectionConfiguration.loadOrCreate(at: link) }
    }

    @Test func hostOriginAndCredentialRejectedBeforeDecoding() async throws {
        let bridge = try makeBridge()
        for headers in [["host": "127.0.0.1:43793"], ["host": "localhost:43792"], ["origin": "https://evil.example"],
                        ["origin": "null"], ["origin": ""], ["authorization": "Bearer wrong"]] {
            let result = await bridge.handleRequest(request(headers: headers, body: Data("not json".utf8)))
            #expect([401, 403].contains(result.status))
            #expect(result.headers["Access-Control-Allow-Origin"] == nil)
        }
        let valid = await bridge.handleRequest(request())
        #expect(valid.status == 200)
    }

    @Test func bootstrapRequiresSameOriginAndReturnsOnlyRuntimeConfiguration() async throws {
        let bridge = try makeBridge()
        let response = await bridge.handleRequest(request(method: "GET", path: "/v1/writing/bootstrap"))
        #expect(response.status == 200)
        let object = try #require(JSONSerialization.jsonObject(with: response.body) as? [String: String])
        #expect(object == ["token": token, "baseURL": origin, "skillVersion": "1.0.1"])
        let absent = await bridge.handleRequest(request(method: "GET", path: "/v1/writing/bootstrap", headers: ["origin": ""]))
        #expect(absent.status == 403)
        let metadata = await bridge.handleRequest(request(method: "GET", path: "/v1/writing/bootstrap", headers: ["origin": "", "sec-fetch-site": "same-origin"]))
        #expect(metadata.status == 200)
        let custom = await bridge.handleRequest(request(method: "GET", path: "/v1/writing/bootstrap", headers: ["origin": "", "x-askgpt-writing": "1"]))
        #expect(custom.status == 200)
        let hostile = await bridge.handleRequest(request(method: "GET", path: "/v1/writing/bootstrap", headers: ["origin": "", "x-askgpt-writing": "1", "sec-fetch-site": "cross-site"]))
        #expect(hostile.status == 403)
    }

    @Test func oversizedTextContextAndProfileAreBounded() async throws {
        let bridge = try makeBridge()
        for snapshot in [snapshot(text: String(repeating: "x", count: 4001)), snapshot(context: String(repeating: "y", count: 2001))] {
            #expect(await bridge.handleRequest(request(snapshot: snapshot)).status == 413)
        }
        #expect(await bridge.handleRequest(request(profile: .init(customTerms: [String(repeating: "x", count: 257)]))).status == 413)
        var badHash = snapshot(); badHash.contextHash = "wrong"
        #expect(await bridge.handleRequest(request(snapshot: badHash)).status == 400)
    }

    @Test func traversalPrivateFilesAndSymlinksNeverServed() async throws {
        let root = temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("shared"), withIntermediateDirectories: true)
        try Data("<!doctype html><title>Writing</title>".utf8).write(to: root.appendingPathComponent("shared/taskpane.html"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("shared/leak.js"), withDestinationURL: URL(fileURLWithPath: "/etc/passwd"))
        let bridge = try makeBridge(resources: root)
        for path in ["/../connection.json", "/shared/%2e%2e/connection.json", "/shared/%252e%252e/secret.js", "/shared/leak.js", "/word/manifest.xml", "/shared/connection.local.json"] {
            #expect(await bridge.handleRequest(request(method: "GET", path: path)).status != 200)
        }
        let page = await bridge.handleRequest(request(method: "GET", path: "/shared/taskpane.html?host=word", headers: ["origin": ""]))
        #expect(page.status == 200)
        #expect(page.headers["Content-Type"] == "text/html; charset=utf-8")
        #expect(page.headers["X-Content-Type-Options"] == "nosniff")
        #expect(page.headers["Cache-Control"] == "no-store")
        #expect(page.headers["Content-Security-Policy"]?.contains("connect-src 'self'") == true)
    }

    @Test func errorsNeverEchoTextTokenOrUnderlyingException() async throws {
        let secret = "manuscript-secret " + token
        let bridge = try makeBridge(handler: { _, _, _ in throw NSError(domain: secret, code: 1) })
        let result = await bridge.handleRequest(request(snapshot: snapshot(text: secret)))
        #expect(result.status == 502)
        #expect(!String(decoding: result.wireData, as: UTF8.self).contains(secret))
        #expect(!String(decoding: result.wireData, as: UTF8.self).contains(token))
        #expect(result.headers["Access-Control-Allow-Origin"] == nil)
    }

    @Test func cancellationNotifiesServiceWithExactRequestIdentity() async throws {
        let calls = WritingBridgeCalls()
        let bridge = try makeBridge(cancel: { await calls.record($0) })
        let body = try JSONSerialization.data(withJSONObject: ["requestID": "request-1"])
        #expect(await bridge.handleRequest(request(path: "/v1/writing/cancel", body: body)).status == 200)
        #expect(await calls.ids == ["request-1"])
    }

    @Test func nativeDocumentRoutesRetainOriginBearerAndStrictPayloadValidation() async throws {
        let broker = NativeWritingDocumentBroker(), bridge = try makeBridge(documentBroker: broker)
        let path = "/v1/writing/document/register"
        let body = Data(#"{"version":1,"documentSessionID":"doc","capabilities":{"sharedRuntime":true,"activeWindow":true,"hiddenRuntime":true,"safeReplace":true}}"#.utf8)
        for headers in [["origin": "https://evil.example"], ["authorization": "Bearer wrong"], ["host": "127.0.0.1:43793"]] {
            let response = await bridge.handleRequest(request(path: path, headers: headers, body: body))
            #expect([401, 403].contains(response.status))
            #expect(response.headers["Access-Control-Allow-Origin"] == nil)
        }
        let registered = await bridge.handleRequest(request(path: path, body: body))
        #expect(registered.status == 200)
        let lease = try JSONDecoder().decode(NativeWritingDocumentLease.self, from: registered.body)
        let invalid = Data(#"{"version":1,"documentSessionID":"doc","capabilities":{"sharedRuntime":true,"activeWindow":true,"hiddenRuntime":true,"safeReplace":true},"url":"private"}"#.utf8)
        #expect(await bridge.handleRequest(request(path: path, body: invalid)).status == 400)
        let exchange = try JSONEncoder().encode(NativeWritingDocumentExchange(version: 1, leaseID: lease.leaseID, sequence: 1, state: nil, result: nil))
        #expect(await bridge.handleRequest(request(path: "/v1/writing/document/exchange", body: exchange)).status == 200)
        #expect(await bridge.handleRequest(request(path: "/v1/writing/document/exchange", body: exchange)).status == 400)
        let close = try JSONEncoder().encode(NativeWritingDocumentClose(version: 1, leaseID: lease.leaseID))
        #expect(await bridge.handleRequest(request(path: "/v1/writing/document/close", body: close)).status == 200)
        let unavailable = try makeBridge()
        #expect(await unavailable.handleRequest(request(path: path, body: body)).status == 503)
        await bridge.shutdown()
        #expect(await broker.activeDocument() == nil)
    }

    @Test func nativeDocumentLongPollUsesExistingAuthenticatedRouteAndRejectsExtraRequestFields() async throws {
        let broker = NativeWritingDocumentBroker(), bridge = try makeBridge(documentBroker: broker)
        let registration = NativeWritingDocumentRegistration(version: 1, documentSessionID: "longpoll-doc", capabilities: .init(sharedRuntime: true, activeWindow: true, hiddenRuntime: true, safeReplace: true))
        let lease = try await broker.register(registration)
        let payload = NativeWritingDocumentExchange(version: 1, leaseID: lease.leaseID, sequence: 1, state: nil, result: nil)
        let response = await bridge.handleRequest(request(path: "/v1/writing/document/exchange", body: try JSONEncoder().encode(payload)))
        #expect(response.status == 200)
        let object = try #require(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        #expect(object["idleWaitMilliseconds"] as? Int == 1000)
        #expect(Set(object.keys) == ["commands", "idleWaitMilliseconds"])
        let extra = try JSONSerialization.data(withJSONObject: ["version": 1, "leaseID": lease.leaseID, "sequence": 2, "waitForCommands": false])
        #expect(await bridge.handleRequest(request(path: "/v1/writing/document/exchange", body: extra)).status == 400)
        await bridge.shutdown()
    }

    @Test func nativeDocumentLongPollCancellationUsesExistingCancelledResponseAndRevokesLease() async throws {
        let broker = NativeWritingDocumentBroker(), bridge = try makeBridge(documentBroker: broker)
        let lease = try await broker.register(.init(version: 1, documentSessionID: "cancel-doc", capabilities: .init(sharedRuntime: true, activeWindow: true, hiddenRuntime: true, safeReplace: true)))
        let state = NativeWritingDocumentState(epoch: 1, active: true, visibility: .hidden, status: .ready, scope: nil, issues: [], errorCode: nil)
        let payload = NativeWritingDocumentExchange(version: 1, leaseID: lease.leaseID, sequence: 1, state: state, result: nil)
        let value = request(path: "/v1/writing/document/exchange", body: try JSONEncoder().encode(payload))
        let pending = Task { await bridge.handleRequest(value) }
        for _ in 0..<200 {
            if await broker.activeDocument() != nil { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(await broker.activeDocument() != nil)
        pending.cancel()
        #expect(await pending.value.status == 499)
        #expect(await broker.activeDocument() == nil)
        await bridge.shutdown()
    }

    @Test func missingResourcesFailClosedBeforeListenerStarts() async throws {
        let bridge = try makeBridge()
        do { try await bridge.start(); Issue.record("Missing writing resources must prevent startup") }
        catch { #expect(error is WritingBridgeError) }
        #expect(await bridge.listeningPort == nil)
        await bridge.shutdown()
    }

    @Test func parserAuthenticatesHeadersBeforeReceivingBodyAndBoundsFraming() throws {
        var parser = WritingHTTPParser { _ in throw WritingBridgeError.forbidden }
        #expect(throws: WritingBridgeError.self) {
            try parser.append(Data("POST /v1/writing/check HTTP/1.1\r\nHost: evil\r\nContent-Length: 50000\r\n\r\n".utf8))
        }
        var duplicate = WritingHTTPParser { _ in }
        #expect(throws: WritingBridgeError.self) {
            try duplicate.append(Data("GET / HTTP/1.1\r\nHost: localhost\r\nHost: evil\r\n\r\n".utf8))
        }
    }

    @Test func pinnedTLSHandshakeDisconnectCancelsAndShutdownReleasesPort() async throws {
        let folder = temporary()
        defer { try? FileManager.default.removeItem(at: folder) }
        let tlsDirectory = folder.appendingPathComponent("tls", isDirectory: true)
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [repository.appendingPathComponent("scripts/prepare-writing-tls").path, "--output", tlsDirectory.path]
        let preparationErrors = Pipe()
        process.standardOutput = FileHandle.nullDevice; process.standardError = preparationErrors
        try process.run(); process.waitUntilExit()
        let diagnostic = String(decoding: preparationErrors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        // The preparation script emits fixed, sanitized failures; do not expose unexpected subprocess output.
        let knownFailures = ["Output already exists; refusing to replace existing TLS material",
            "Refusing symbolic-link directory", "TLS directory must be owned by the current user", "Local TLS preparation failed"]
        let safeDiagnostic = knownFailures.first(where: { diagnostic.contains($0) }) ?? (diagnostic.isEmpty ? "No diagnostic" : "Unexpected preparation failure")
        try #require(process.terminationStatus == 0, "TLS preparation failed: \(safeDiagnostic)")
        let calls = WritingBridgeCalls()
        let bridge = WritingBridge(configuration: try WritingConnectionConfiguration(token: token), resources: repository.appendingPathComponent("Integrations/Writing"),
            tlsDirectory: tlsDirectory, skillVersion: "1.0.1", port: 0, check: { snapshot, _, _ in
                await calls.record("started")
                try await Task.sleep(nanoseconds: 30_000_000_000)
                return .init(requestID: snapshot.requestID, snapshotHash: snapshot.snapshotHash, skillVersion: "1.0.1", status: .completed, issues: [])
            }, cancel: { await calls.record($0) })
        try await bridge.start()
        let port = try #require(await bridge.listeningPort)
        let certificate = try Data(contentsOf: tlsDirectory.appendingPathComponent("localhost-cert.der"))
        let options = NWProtocolTLS.Options()
        sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, "localhost")
        sec_protocol_options_set_verify_block(options.securityProtocolOptions, { _, trust, complete in
            let value = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let anchor = SecCertificateCreateWithData(nil, certificate as CFData) else { complete(false); return }
            SecTrustSetAnchorCertificates(value, [anchor] as CFArray)
            SecTrustSetAnchorCertificatesOnly(value, true)
            SecTrustSetPolicies(value, SecPolicyCreateSSL(true, "localhost" as CFString))
            let chain = SecTrustCopyCertificateChain(value) as? [SecCertificate]
            let leaf = chain?.first.map { SecCertificateCopyData($0) as Data }
            complete(leaf == certificate && SecTrustEvaluateWithError(value, nil))
        }, DispatchQueue(label: "writing.tests.trust"))
        let socket = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: NWParameters(tls: options, tcp: NWProtocolTCP.Options()))
        socket.start(queue: DispatchQueue(label: "writing.tests.socket"))
        let body = request().body
        var wire = Data("POST /v1/writing/check HTTP/1.1\r\nHost: localhost:\(port)\r\nOrigin: https://localhost:\(port)\r\nAuthorization: Bearer \(token)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
        wire.append(body)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            socket.send(content: wire, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
        try await waitFor { await calls.ids.contains("started") }
        socket.cancel()
        try await waitFor { await calls.ids.contains("request-1") }
        await bridge.shutdown()
        let second = WritingBridge(configuration: try WritingConnectionConfiguration(token: token), resources: repository.appendingPathComponent("Integrations/Writing"), tlsDirectory: tlsDirectory,
            skillVersion: "1.0.1", port: port, check: { snapshot, _, _ in .init(requestID: snapshot.requestID, snapshotHash: snapshot.snapshotHash, skillVersion: "1.0.1", status: .completed, issues: []) })
        try await second.start()
        await second.shutdown()
    }
    private func waitFor(_ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<300 {
            if await condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(domain: "WritingBridgeTests.timeout", code: 1)
    }

    private func makeBridge(resources: URL? = nil,
        handler: @escaping WritingBridge.Check = { snapshot, _, _ in .init(requestID: snapshot.requestID, snapshotHash: snapshot.snapshotHash, skillVersion: "1.0.1", status: .completed, issues: []) },
        cancel: @escaping WritingBridge.Cancel = { _ in }, documentBroker: NativeWritingDocumentBroker? = nil) throws -> WritingBridge {
        WritingBridge(configuration: try WritingConnectionConfiguration(token: token), resources: resources ?? temporary(),
            tlsDirectory: temporary(), skillVersion: "1.0.1", check: handler, cancel: cancel, documentBroker: documentBroker)
    }
    private func snapshot(text: String = "Synthetic paragraph.", context: String = "") -> WritingSnapshot {
        .init(requestID: "request-1", documentSessionID: "document-1", blockID: "block-1", revision: "1", rawText: text, contextBefore: context)
    }
    private func request(method: String = "POST", path: String = "/v1/writing/check", headers extra: [String: String] = [:], body: Data? = nil,
                         snapshot supplied: WritingSnapshot? = nil, profile: WritingProfile = .init()) -> WritingHTTPRequest {
        var headers = ["host": "localhost:43793", "origin": origin, "authorization": "Bearer " + token, "content-type": "application/json"]
        headers.merge(extra) { _, next in next }
        headers = headers.filter { !$0.value.isEmpty }
        let encoded = try! JSONEncoder().encode(WritingCheckPayload(snapshot: supplied ?? snapshot(), mode: .polish, profile: profile))
        return .init(method: method, path: path, headers: headers, body: body ?? encoded)
    }
    private func temporary() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("WritingBridge-" + UUID().uuidString) }
    private func permissions(_ file: URL) throws -> Int { (try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber).intValue }
}

private actor WritingBridgeCalls {
    private(set) var ids: [String] = []
    func record(_ value: String) { ids.append(value) }
}

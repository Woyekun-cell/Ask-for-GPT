import Foundation
import Testing
@testable import AskGPTCore

struct ZoteroPaperShortcutTests {
    private let zotero = "org.zotero.zotero"

    @Test func challengeUsesFixedLoopbackRequestWithoutBearerSecret() throws {
        let configuration = try InlineConnectionConfiguration(token: "test-token-A0123456789abcdefghijklmnop",
            extensionID: String(repeating: "a", count: 32))
        let nonce = "0123456789abcdef0123456789abcdef"
        let request = try ZoteroPaperShortcut.makeRequest(configuration: configuration, nonce: nonce,
            timestamp: 1_794_235_200_123)
        #expect(request.url?.absoluteString == "http://127.0.0.1:23119/askgpt/paper")
        #expect(request.httpMethod == "POST")
        #expect(request.httpBody == Data("{}".utf8))
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "X-AskGPT-Timestamp") == "1794235200123")
        #expect(request.value(forHTTPHeaderField: "X-AskGPT-Nonce") == nonce)
        #expect(request.value(forHTTPHeaderField: "X-AskGPT-Proof") ==
            "5d8c88903b28c6fd0a16030b3d2702c9f626496086ef3334ed3a391c39278f04")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(!(request.allHTTPHeaderFields ?? [:]).values.contains(configuration.token))
    }

    @Test func onlyTheCurrentForegroundZoteroNonceCanBeConsumedOnce() throws {
        var gate = ZoteroPaperShortcutGate()
        let unrelated = gate.begin(bundleID: "com.apple.Preview", processID: 41)
        #expect(unrelated == nil)

        let first = gate.begin(bundleID: zotero, processID: 42)
        let current = gate.begin(bundleID: zotero, processID: 42)
        let oldNonce = try #require(first)
        let nonce = try #require(current)
        #expect(oldNonce != nonce)
        #expect(ZoteroPaperShortcut.isValidNonce(nonce))

        let superseded = gate.consume(oldNonce, bundleID: zotero, processID: 42)
        let accepted = gate.consume(nonce, bundleID: zotero, processID: 42)
        let duplicate = gate.consume(nonce, bundleID: zotero, processID: 42)
        #expect(!superseded)
        #expect(accepted)
        #expect(!duplicate)
    }

    @Test func cancellationAndForegroundChangeInvalidateLateHandoffs() throws {
        var gate = ZoteroPaperShortcutGate()
        let initial = gate.begin(bundleID: zotero, processID: 42)
        let cancelled = try #require(initial)
        gate.cancel()
        let afterCancel = gate.consume(cancelled, bundleID: zotero, processID: 42)
        #expect(!afterCancel)

        let originalProcess = gate.begin(bundleID: zotero, processID: 42)
        let previousProcess = try #require(originalProcess)
        let changedProcess = gate.consume(previousProcess, bundleID: zotero, processID: 43)
        let afterProcessRestored = gate.consume(previousProcess, bundleID: zotero, processID: 42)
        #expect(!changedProcess)
        #expect(!afterProcessRestored)

        let originalApp = gate.begin(bundleID: zotero, processID: 42)
        let previousApp = try #require(originalApp)
        let changedApp = gate.consume(previousApp, bundleID: "com.apple.Preview", processID: 42)
        let afterAppRestored = gate.consume(previousApp, bundleID: zotero, processID: 42)
        #expect(!changedApp)
        #expect(!afterAppRestored)
    }
}

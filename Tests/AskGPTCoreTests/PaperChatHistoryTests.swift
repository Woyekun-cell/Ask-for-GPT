import Foundation
import Testing
@testable import AskGPTCore

struct PaperChatHistoryTests {
    @Test func separateHistoriesRoundTripWithPrivatePermissions() throws {
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? files.removeItem(at: directory) }
        let history = PaperChatHistory(directory: directory)
        let first = [ChatMessage(role: .user, text: "First paper question"),
                     ChatMessage(role: .assistant, text: "First paper answer")]
        let second = [ChatMessage(role: .user, text: "Second paper question")]

        let paperA = PaperChatRecord(lastScope: "whole", nearby: first,
                                     whole: [ChatMessage(role: .user, text: "Summarize whole paper")],
                                     documentDigest: String(repeating: "a", count: 64))
        let paperB = PaperChatRecord(nearby: second)

        #expect(try history.load(key: "paper-a") == PaperChatRecord())
        var interrupted = paperA
        interrupted.nearby.append(ChatMessage(role: .assistant, text: "Partial", completed: false))
        try history.save(interrupted, key: "paper-a")
        try history.save(paperB, key: "paper-b")
        let reopened = PaperChatHistory(directory: directory)
        #expect(try reopened.load(key: "paper-a") == paperA)
        #expect(try reopened.load(key: "paper-b") == paperB)

        let info = try files.attributesOfItem(atPath: directory.path)
        #expect((info[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        let entries = try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(entries.count == 2)
        for entry in entries {
            let info = try files.attributesOfItem(atPath: entry.path)
            #expect((info[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        }
    }

    @Test func refusingSymlinksNeverReadsOrReplacesTheirTarget() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? files.removeItem(at: root) }
        let directory = root.appendingPathComponent("history")
        let history = PaperChatHistory(directory: directory)
        let first = PaperChatRecord(nearby: [ChatMessage(role: .user, text: "First paper question")])
        let next = PaperChatRecord(nearby: [ChatMessage(role: .user, text: "New paper question")])
        try history.save(first, key: "../unsafe")
        let entry = try #require(files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let outside = root.appendingPathComponent("original")
        try files.moveItem(at: entry, to: outside)
        let original = try Data(contentsOf: outside)
        try files.createSymbolicLink(at: entry, withDestinationURL: outside)

        #expect(throws: (any Error).self) { try history.load(key: "../unsafe") }
        #expect(throws: (any Error).self) { try history.save(next, key: "../unsafe") }
        #expect(try Data(contentsOf: outside) == original)
        #expect(try files.destinationOfSymbolicLink(atPath: entry.path) == outside.path)

        let alias = root.appendingPathComponent("alias")
        try files.createSymbolicLink(at: alias, withDestinationURL: directory)
        let aliased = PaperChatHistory(directory: alias)
        #expect(throws: (any Error).self) { try aliased.load(key: "../unsafe") }
        #expect(throws: (any Error).self) { try aliased.save(next, key: "../unsafe") }
    }

    @Test func malformedArchiveRemainsAvailableForRecovery() throws {
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? files.removeItem(at: directory) }
        let history = PaperChatHistory(directory: directory)
        let record = PaperChatRecord(nearby: [ChatMessage(role: .user, text: "Original question")])
        try history.save(record, key: "paper-a")
        let entry = try #require(files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let original = Data("Malformed archive".utf8)
        try original.write(to: entry)

        #expect(throws: (any Error).self) { try history.load(key: "paper-a") }
        #expect(throws: (any Error).self) { try history.save(record, key: "paper-a") }
        #expect(try Data(contentsOf: entry) == original)
    }
}

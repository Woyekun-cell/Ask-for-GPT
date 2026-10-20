import Foundation
import CryptoKit

public struct UTF16Range: Codable, Equatable, Sendable {
    public var start: Int
    public var length: Int
    public var end: Int? {
        let (value, overflow) = start.addingReportingOverflow(length)
        return overflow ? nil : value
    }
    public init(start: Int, length: Int) { self.start = start; self.length = length }
}

public enum WritingScope: String, Codable, Sendable {
    case selection, visiblePages, activeParagraph, cursorPage
}

public enum WritingCheckMode: String, Codable, Sendable { case spelling, polish }
public enum WritingCheckStatus: String, Codable, Sendable { case completed, cancelled, stale, failed }

public struct WritingProfile: Codable, Equatable, Sendable {
    public var spellingVariant: String
    public var style: String
    public var customTerms: [String]
    public init(spellingVariant: String = "en-US", style: String = "minimal", customTerms: [String] = []) {
        self.spellingVariant = spellingVariant; self.style = style; self.customTerms = customTerms
    }
}

public struct WritingSnapshot: Codable, Equatable, Sendable {
    public var requestID: String
    public var documentSessionID: String
    public var blockID: String
    public var revision: String
    public var rawText: String
    public var snapshotHash: String
    public var contextHash: String
    public var contextBefore: String
    public var contextAfter: String
    public var targetRange: UTF16Range
    public var protectedRanges: [UTF16Range]
    public var pageIndices: [Int]
    public var scope: WritingScope

    public init(requestID: String, documentSessionID: String, blockID: String, revision: String,
                rawText: String, snapshotHash: String? = nil, contextHash: String? = nil,
                contextBefore: String = "", contextAfter: String = "", targetRange: UTF16Range? = nil,
                protectedRanges: [UTF16Range] = [], pageIndices: [Int] = [], scope: WritingScope = .activeParagraph) {
        self.requestID = requestID; self.documentSessionID = documentSessionID
        self.blockID = blockID; self.revision = revision; self.rawText = rawText
        self.snapshotHash = snapshotHash ?? Self.hash(rawText: rawText)
        self.contextHash = contextHash ?? Self.hash(contextBefore: contextBefore, contextAfter: contextAfter)
        self.contextBefore = contextBefore; self.contextAfter = contextAfter
        self.targetRange = targetRange ?? UTF16Range(start: 0, length: rawText.utf16.count)
        self.protectedRanges = protectedRanges; self.pageIndices = pageIndices; self.scope = scope
    }

    /// Hashes the exact original UTF-8 bytes; never performs Unicode or newline normalization.
    public static func hash(rawText: String) -> String { writingSHA256(Data(rawText.utf8)) }
    public static func hash(contextBefore: String, contextAfter: String) -> String {
        writingSHA256(Data((contextBefore + "\u{0000}" + contextAfter).utf8))
    }
}

public struct ModelWritingSuggestion: Codable, Equatable, Sendable {
    public var original: String
    public var replacement: String
    public var prefix: String
    public var suffix: String
    public var category: String
    public var reason: String
    public init(original: String, replacement: String, prefix: String = "", suffix: String = "",
                category: String = "expression", reason: String = "") {
        self.original = original; self.replacement = replacement; self.prefix = prefix; self.suffix = suffix
        self.category = category; self.reason = reason
    }
}

public struct WritingIssue: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var category: String
    public var original: String
    public var replacement: String
    public var reason: String
    public var range: UTF16Range
    public var requiresAuthorConfirmation: Bool
    public init(id: String = UUID().uuidString, category: String, original: String, replacement: String,
                reason: String, range: UTF16Range, requiresAuthorConfirmation: Bool) {
        self.id = id; self.category = category; self.original = original; self.replacement = replacement
        self.reason = reason; self.range = range; self.requiresAuthorConfirmation = requiresAuthorConfirmation
    }
}

public struct WritingCheckResult: Codable, Equatable, Sendable {
    public var requestID: String
    public var snapshotHash: String
    public var skillVersion: String
    public var status: WritingCheckStatus
    public var issues: [WritingIssue]
    public init(requestID: String, snapshotHash: String, skillVersion: String, status: WritingCheckStatus, issues: [WritingIssue]) {
        self.requestID = requestID; self.snapshotHash = snapshotHash; self.skillVersion = skillVersion
        self.status = status; self.issues = issues
    }
}

public struct CapturedScope: Codable, Equatable, Sendable {
    public var scope: WritingScope
    public var pageIndices: [Int]
    public var snapshots: [WritingSnapshot]
    public init(scope: WritingScope, pageIndices: [Int], snapshots: [WritingSnapshot]) {
        self.scope = scope; self.pageIndices = pageIndices; self.snapshots = snapshots
    }
}

public struct IssueEnvelope: Codable, Equatable, Sendable {
    public var snapshot: WritingSnapshot
    public var issue: WritingIssue
    public init(snapshot: WritingSnapshot, issue: WritingIssue) { self.snapshot = snapshot; self.issue = issue }
}

func writingSHA256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

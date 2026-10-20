import Foundation

public enum WritingPolishComparisonError: Error, Equatable, Sendable {
    case duplicateIssueID
    case invalidIssueID
}

/// A byte-preserving preview of validated issues inside one captured target.
/// This model never establishes that Word can safely apply a suggestion.
public struct WritingPolishComparison: Equatable, Sendable {
    public enum Emphasis: String, Equatable, Sendable { case unchanged, removed, inserted }

    public struct Segment: Identifiable, Equatable, Sendable {
        public let id: Int
        public let text: String
        public let emphasis: Emphasis
        public static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.id == rhs.id && lhs.emphasis == rhs.emphasis && lhs.text.utf8.elementsEqual(rhs.text.utf8)
        }
    }

    public struct Row: Identifiable, Equatable, Sendable {
        public let id: String
        public let original: String
        /// nil is a review-only author question; an empty string is a proposed deletion.
        public let replacement: String?
        public let reason: String
        public let category: String
        public let range: UTF16Range
        public static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.id == rhs.id && lhs.range == rhs.range && lhs.category == rhs.category
                && lhs.original.utf8.elementsEqual(rhs.original.utf8)
                && lhs.replacement.map { Data($0.utf8) } == rhs.replacement.map { Data($0.utf8) }
                && lhs.reason.utf8.elementsEqual(rhs.reason.utf8)
        }
    }

    public let documentSessionID: String
    public let blockID: String
    public let revision: String
    public let snapshotHash: String
    public let contextHash: String
    public let targetRange: UTF16Range
    public let original: String
    public let revised: String
    public let originalSegments: [Segment]
    public let revisedSegments: [Segment]
    public let rows: [Row]
    public let changes: [WritingIssue]
    public let questions: [WritingIssue]

    public init(snapshot: WritingSnapshot, issues: [WritingIssue]) throws {
        try WritingSnapshotPreflight.validate(snapshot, profile: .init())
        let sourceIndices = Self.indices(in: snapshot.rawText)
        let sourceCount = snapshot.rawText.utf16.count
        let boundaries = Set(sourceIndices.keys)
        var seenIDs = Set<String>()
        for issue in issues {
            guard !issue.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw WritingPolishComparisonError.invalidIssueID
            }
            guard seenIDs.insert(issue.id).inserted else { throw WritingPolishComparisonError.duplicateIssueID }
            guard ["spelling", "grammar", "expression", "context"].contains(issue.category) else {
                throw WritingValidationError.invalidCategory
            }
            guard !issue.original.isEmpty else { throw WritingValidationError.emptyOriginal }
            try WritingSnapshotPreflight.validate(issue.range, count: sourceCount, boundaries: boundaries)
            guard issue.range.length > 0 else { throw WritingValidationError.invalidRange }
            guard let end = issue.range.end, let targetEnd = snapshot.targetRange.end,
                  issue.range.start >= snapshot.targetRange.start, end <= targetEnd else {
                throw WritingValidationError.outsideTargetRange
            }
            let literal = try Self.slice(issue.range, in: snapshot.rawText, indices: sourceIndices)
            guard literal.utf8.elementsEqual(issue.original.utf8) else { throw WritingValidationError.originalNotFound }
            let unchanged = issue.original.utf8.elementsEqual(issue.replacement.utf8)
            if unchanged && (issue.category != "context" || issue.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                throw WritingValidationError.unchangedSuggestion
            }
            for protected in snapshot.protectedRanges where Self.overlaps(issue.range, protected) {
                throw WritingValidationError.protectedRange
            }
        }
        let ordered = issues.sorted { $0.range.start < $1.range.start }
        for (index, issue) in ordered.enumerated() where index > 0 {
            if Self.overlaps(ordered[index - 1].range, issue.range) { throw WritingValidationError.overlappingIssues }
        }
        let changes = ordered.filter { !$0.original.utf8.elementsEqual($0.replacement.utf8) }
        let questions = ordered.filter { $0.original.utf8.elementsEqual($0.replacement.utf8) }
        let original = try Self.slice(snapshot.targetRange, in: snapshot.rawText, indices: sourceIndices)
        var originalPieces: [(String, Emphasis)] = []
        var revisedPieces: [(String, Emphasis)] = []
        var cursor = snapshot.targetRange.start
        for issue in changes {
            let preceding = try Self.slice(.init(start: cursor, length: issue.range.start - cursor), in: snapshot.rawText, indices: sourceIndices)
            Self.append(preceding, emphasis: .unchanged, to: &originalPieces)
            Self.append(preceding, emphasis: .unchanged, to: &revisedPieces)
            Self.append(issue.original, emphasis: .removed, to: &originalPieces)
            Self.append(issue.replacement, emphasis: .inserted, to: &revisedPieces)
            cursor = issue.range.end!
        }
        let remaining = try Self.slice(.init(start: cursor, length: snapshot.targetRange.end! - cursor), in: snapshot.rawText, indices: sourceIndices)
        Self.append(remaining, emphasis: .unchanged, to: &originalPieces)
        Self.append(remaining, emphasis: .unchanged, to: &revisedPieces)
        let revised = revisedPieces.map(\.0).joined()

        // Validate the combined draft too: adjacent valid edits must not join a
        // combining sequence or emoji beyond an edit or the selected target.
        let before = try Self.slice(.init(start: 0, length: snapshot.targetRange.start), in: snapshot.rawText, indices: sourceIndices)
        let after = try Self.slice(.init(start: snapshot.targetRange.end!, length: sourceCount - snapshot.targetRange.end!), in: snapshot.rawText, indices: sourceIndices)
        let revisedBlock = before + revised + after
        let revisedBoundaries = Set(Self.indices(in: revisedBlock).keys)
        let revisedCount = revisedBlock.utf16.count
        try WritingSnapshotPreflight.validate(.init(start: snapshot.targetRange.start, length: revised.utf16.count), count: revisedCount, boundaries: revisedBoundaries)
        var shift = 0
        for issue in changes {
            let location = issue.range.start + shift
            try WritingSnapshotPreflight.validate(.init(start: location, length: issue.replacement.utf16.count), count: revisedCount, boundaries: revisedBoundaries)
            shift += issue.replacement.utf16.count - issue.range.length
        }
        for protected in snapshot.protectedRanges {
            let shift = changes.filter { $0.range.end! <= protected.start }.reduce(0) { $0 + $1.replacement.utf16.count - $1.range.length }
            try WritingSnapshotPreflight.validate(.init(start: protected.start + shift, length: protected.length), count: revisedCount, boundaries: revisedBoundaries)
        }

        documentSessionID = snapshot.documentSessionID; blockID = snapshot.blockID; revision = snapshot.revision
        snapshotHash = snapshot.snapshotHash; contextHash = snapshot.contextHash; targetRange = snapshot.targetRange
        self.original = original; self.revised = revised; self.changes = changes; self.questions = questions
        originalSegments = originalPieces.enumerated().map { .init(id: $0.offset, text: $0.element.0, emphasis: $0.element.1) }
        revisedSegments = revisedPieces.enumerated().map { .init(id: $0.offset, text: $0.element.0, emphasis: $0.element.1) }
        rows = ordered.map { issue in
            .init(id: issue.id, original: issue.original,
                  replacement: issue.original.utf8.elementsEqual(issue.replacement.utf8) ? nil : issue.replacement,
                  reason: issue.reason, category: issue.category, range: issue.range)
        }
    }

    private static func append(_ text: String, emphasis: Emphasis, to pieces: inout [(String, Emphasis)]) {
        if !text.isEmpty { pieces.append((text, emphasis)) }
    }
    private static func indices(in text: String) -> [Int: String.Index] {
        var result: [Int: String.Index] = [0: text.startIndex]
        var offset = 0, index = text.startIndex
        while index < text.endIndex {
            let next = text.index(after: index)
            offset += text[index..<next].utf16.count
            result[offset] = next; index = next
        }
        return result
    }
    private static func slice(_ range: UTF16Range, in text: String, indices: [Int: String.Index]) throws -> String {
        guard let end = range.end, let startIndex = indices[range.start], let endIndex = indices[end] else {
            throw WritingValidationError.invalidGraphemeBoundary
        }
        return String(text[startIndex..<endIndex])
    }
    private static func overlaps(_ lhs: UTF16Range, _ rhs: UTF16Range) -> Bool {
        guard let leftEnd = lhs.end, let rightEnd = rhs.end else { return true }
        return lhs.start < rightEnd && rhs.start < leftEnd
    }
}

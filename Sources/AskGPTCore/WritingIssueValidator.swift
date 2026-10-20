import Foundation

public enum WritingValidationError: Error, Equatable, Sendable {
    case emptyOriginal, unchangedSuggestion, originalNotFound, ambiguousAnchor
    case invalidRange, invalidGraphemeBoundary, outsideTargetRange, protectedRange
    case protectedTermChanged, overlappingIssues, snapshotHashMismatch, contextHashMismatch, invalidCategory
}

/// Checks physical edit safety. This does not establish scientific or semantic equivalence.
public struct WritingIssueValidator: Sendable {
    public let profile: WritingProfile
    public init(profile: WritingProfile = .init()) { self.profile = profile }

    public func validate(_ suggestion: ModelWritingSuggestion, in snapshot: WritingSnapshot) throws -> WritingIssue {
        guard !suggestion.original.isEmpty else { throw WritingValidationError.emptyOriginal }
        let isUnchanged = Array(suggestion.original.utf8) == Array(suggestion.replacement.utf8)
        let isReviewOnlyContext = isUnchanged && suggestion.category == "context"
            && !suggestion.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard !isUnchanged || isReviewOnlyContext else {
            throw WritingValidationError.unchangedSuggestion
        }
        guard ["spelling", "grammar", "expression", "context"].contains(suggestion.category) else {
            throw WritingValidationError.invalidCategory
        }
        guard snapshot.snapshotHash == WritingSnapshot.hash(rawText: snapshot.rawText) else {
            throw WritingValidationError.snapshotHashMismatch
        }
        guard snapshot.contextHash == WritingSnapshot.hash(contextBefore: snapshot.contextBefore, contextAfter: snapshot.contextAfter) else {
            throw WritingValidationError.contextHashMismatch
        }

        let bytes = Array(snapshot.rawText.utf8)
        var byteToUTF16: [Int: Int] = [0: 0]
        var byteOffset = 0
        var utf16Offset = 0
        for character in snapshot.rawText {
            let text = String(character)
            byteOffset += text.utf8.count; utf16Offset += text.utf16.count
            byteToUTF16[byteOffset] = utf16Offset
        }
        let boundaries = Set(byteToUTF16.values)
        try check(snapshot.targetRange, count: utf16Offset, boundaries: boundaries)
        for range in snapshot.protectedRanges { try check(range, count: utf16Offset, boundaries: boundaries) }

        // Match literal bytes, including adjacent anchors, throughout the original block.
        // Scope filtering must not quietly disambiguate an otherwise repeated anchor.
        let original = Array(suggestion.original.utf8)
        let prefix = Array(suggestion.prefix.utf8)
        let suffix = Array(suggestion.suffix.utf8)
        var matches: [Int] = []
        if original.count <= bytes.count {
            for start in 0...(bytes.count - original.count) {
                let end = start + original.count
                guard bytes[start..<end].elementsEqual(original), start >= prefix.count,
                      suffix.count <= bytes.count - end,
                      bytes[(start - prefix.count)..<start].elementsEqual(prefix),
                      bytes[end..<(end + suffix.count)].elementsEqual(suffix) else { continue }
                matches.append(start)
            }
        }
        guard !matches.isEmpty else { throw WritingValidationError.originalNotFound }
        guard matches.count == 1 else { throw WritingValidationError.ambiguousAnchor }
        let byteStart = matches[0]
        guard let start = byteToUTF16[byteStart], let end = byteToUTF16[byteStart + original.count] else {
            throw WritingValidationError.invalidGraphemeBoundary
        }
        let range = UTF16Range(start: start, length: end - start)
        guard let targetEnd = snapshot.targetRange.end, start >= snapshot.targetRange.start, end <= targetEnd else {
            throw WritingValidationError.outsideTargetRange
        }
        for protected in snapshot.protectedRanges where overlaps(range, protected) {
            throw WritingValidationError.protectedRange
        }
        let editedBytes = Array(bytes[..<byteStart]) + Array(suggestion.replacement.utf8)
            + Array(bytes[(byteStart + original.count)...])
        let editedText = String(decoding: editedBytes, as: UTF8.self)
        var editedBoundaries: Set<Int> = [0]
        var editedOffset = 0
        for character in editedText {
            editedOffset += String(character).utf16.count
            editedBoundaries.insert(editedOffset)
        }
        let replacementEnd = start + suggestion.replacement.utf16.count
        guard editedBoundaries.contains(start), editedBoundaries.contains(replacementEnd) else {
            throw WritingValidationError.invalidGraphemeBoundary
        }
        let delta = suggestion.replacement.utf16.count - range.length
        for protected in snapshot.protectedRanges {
            // Nonoverlapping protected spans after the edit move by its UTF-16 delta.
            let shift = protected.start >= end ? delta : 0
            let mapped = UTF16Range(start: protected.start + shift, length: protected.length)
            try check(mapped, count: editedOffset, boundaries: editedBoundaries)
        }
        for term in profile.customTerms where !term.isEmpty {
            // Count in the entire block so a proposal for only part of a protected term
            // cannot bypass protection by omitting the rest from `original`.
            if literalCount(term, in: snapshot.rawText) != literalCount(term, in: editedText) {
                throw WritingValidationError.protectedTermChanged
            }
        }
        // A plausible grammar edit can still alter scope, negation or evidence strength.
        // Every model proposal remains subject to author review; this flag never proves meaning.
        return WritingIssue(category: suggestion.category, original: suggestion.original,
                            replacement: suggestion.replacement, reason: suggestion.reason,
                            range: range, requiresAuthorConfirmation: true)
    }

    public func validate(_ suggestions: [ModelWritingSuggestion], in snapshot: WritingSnapshot) throws -> [WritingIssue] {
        let issues = try suggestions.map { try validate($0, in: snapshot) }
        for (index, issue) in issues.enumerated() {
            for earlier in issues.prefix(index) where overlaps(issue.range, earlier.range) {
                throw WritingValidationError.overlappingIssues
            }
        }
        return issues
    }

    private func check(_ range: UTF16Range, count: Int, boundaries: Set<Int>) throws {
        guard range.start >= 0, range.length >= 0, let end = range.end, end <= count else {
            throw WritingValidationError.invalidRange
        }
        guard boundaries.contains(range.start), boundaries.contains(end) else {
            throw WritingValidationError.invalidGraphemeBoundary
        }
    }

    private func overlaps(_ a: UTF16Range, _ b: UTF16Range) -> Bool {
        guard let aEnd = a.end, let bEnd = b.end else { return true }
        return a.start < bEnd && b.start < aEnd
    }

    private func literalCount(_ term: String, in text: String) -> Int {
        let needle = Array(term.utf8), bytes = Array(text.utf8)
        guard !needle.isEmpty, needle.count <= bytes.count else { return 0 }
        return (0...(bytes.count - needle.count)).reduce(0) { count, offset in
            count + (bytes[offset..<(offset + needle.count)].elementsEqual(needle) ? 1 : 0)
        }
    }
}

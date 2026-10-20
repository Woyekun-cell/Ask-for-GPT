import Foundation
import Testing
@testable import AskGPTCore

struct WritingPolishComparisonTests {
    @Test func comparisonIsLimitedToSelectedSourceAndPreservesExactBytes() throws {
        let text = "Before\r\n  Cafe\u{301} resuts is clear.  \r\nAfter"
        let target = range("  Cafe\u{301} resuts is clear.  ", in: text)
        let snapshot = makeSnapshot(text, target: target)
        let grammar = issue("grammar", "is", "are", in: text, category: "grammar")
        let spelling = issue("spell", "resuts", "results", in: text, category: "spelling")
        let comparison = try WritingPolishComparison(snapshot: snapshot, issues: [grammar, spelling])
        #expect(bytes(comparison.original) == bytes("  Cafe\u{301} resuts is clear.  "))
        #expect(bytes(comparison.revised) == bytes("  Cafe\u{301} results are clear.  "))
        #expect(comparison.rows.map(\.id) == ["spell", "grammar"])
        #expect(comparison.changes.map(\.id) == ["spell", "grammar"])
        #expect(comparison.originalSegments.map(\.text).joined().utf8.elementsEqual(comparison.original.utf8))
        #expect(comparison.revisedSegments.map(\.text).joined().utf8.elementsEqual(comparison.revised.utf8))
        #expect(comparison.targetRange == target)
        #expect(comparison.snapshotHash == snapshot.snapshotHash)
    }

    @Test func reviewOnlyContextIsAQuestionAndNeverEntersTheRevisedDraft() throws {
        let text = "This treatment improved survival."
        let question = issue("q", "This treatment", "This treatment", in: text, category: "context", reason: "Which treatment does this refer to?")
        let comparison = try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [question])
        #expect(bytes(comparison.original) == bytes(comparison.revised))
        #expect(comparison.changes.isEmpty)
        #expect(comparison.questions.map(\.id) == ["q"])
        #expect(comparison.rows[0].replacement == nil)
        #expect(comparison.rows[0].reason == question.reason)
        #expect(comparison.originalSegments.allSatisfy { $0.emphasis == .unchanged })
        #expect(comparison.revisedSegments.allSatisfy { $0.emphasis == .unchanged })
    }

    @Test func unchangedSpellingGrammarExpressionAndEmptyContextQuestionAreRejected() {
        for category in ["spelling", "grammar", "expression", "context"] {
            let noop = issue("n", "text", "text", in: "text", category: category, reason: category == "context" ? " \n " : "Reason")
            #expect(throws: WritingValidationError.unchangedSuggestion) {
                try WritingPolishComparison(snapshot: makeSnapshot("text"), issues: [noop])
            }
        }
    }

    @Test func emptyResultStillRejectsStaleRawAndContextHashes() {
        var raw = makeSnapshot("Original")
        raw.rawText = "Changed"
        #expect(throws: WritingValidationError.snapshotHashMismatch) {
            try WritingPolishComparison(snapshot: raw, issues: [])
        }
        var context = makeSnapshot("Original")
        context.contextBefore = "Changed context"
        #expect(throws: WritingValidationError.contextHashMismatch) {
            try WritingPolishComparison(snapshot: context, issues: [])
        }
    }

    @Test func canonicalEquivalenceCannotSubstituteForLiteralOriginalBytes() {
        let snapshot = makeSnapshot("Cafe\u{301} works.")
        let wrong = WritingIssue(id: "wrong", category: "expression", original: "Café", replacement: "Coffee", reason: "Literal mismatch", range: .init(start: 0, length: 5), requiresAuthorConfirmation: true)
        #expect(throws: WritingValidationError.originalNotFound) {
            try WritingPolishComparison(snapshot: snapshot, issues: [wrong])
        }
    }

    @Test func invalidOrOverflowingRangesAreRejectedEvenWithoutSuggestions() {
        for target in [UTF16Range(start: -1, length: 1), .init(start: 0, length: -1), .init(start: Int.max, length: 2), .init(start: 0, length: 50)] {
            #expect(throws: WritingValidationError.invalidRange) {
                try WritingPolishComparison(snapshot: makeSnapshot("Text", target: target), issues: [])
            }
        }
        let bad = WritingIssue(id: "bad", category: "spelling", original: "Text", replacement: "Test", reason: "", range: .init(start: Int.max, length: 1), requiresAuthorConfirmation: true)
        #expect(throws: WritingValidationError.invalidRange) {
            try WritingPolishComparison(snapshot: makeSnapshot("Text"), issues: [bad])
        }
    }

    @Test func targetAndIssueCannotSplitEmojiOrCombiningGraphemes() {
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try WritingPolishComparison(snapshot: makeSnapshot("🧬 bad", target: .init(start: 1, length: 5)), issues: [])
        }
        for (text, original, start, length) in [("e\u{301}", "e", 0, 1), ("👩‍🔬", "👩", 0, 2)] {
            let bad = WritingIssue(id: "split", category: "spelling", original: original, replacement: "x", reason: "", range: .init(start: start, length: length), requiresAuthorConfirmation: true)
            #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
                try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [bad])
            }
        }
    }

    @Test func aSuggestionOutsideSelectionIsRejected() {
        let text = "bad good"
        #expect(throws: WritingValidationError.outsideTargetRange) {
            try WritingPolishComparison(snapshot: makeSnapshot(text, target: .init(start: 4, length: 4)), issues: [issue("x", "bad", "poor", in: text)])
        }
    }

    @Test func overlappingEditsAndQuestionsAreRejected() {
        let text = "bad text"
        let whole = issue("whole", "bad text", "clear wording", in: text)
        let part = issue("part", "text", "word", in: text)
        #expect(throws: WritingValidationError.overlappingIssues) {
            try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [part, whole])
        }
        let question = issue("q", "bad text", "bad text", in: text, category: "context", reason: "What does this refer to?")
        #expect(throws: WritingValidationError.overlappingIssues) {
            try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [part, question])
        }
    }

    @Test func duplicateIssueIDsCannotCollapseDistinctTableRows() {
        let text = "bad text"
        #expect(throws: WritingPolishComparisonError.duplicateIssueID) {
            try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [issue("same", "bad", "poor", in: text), issue("same", "text", "word", in: text)])
        }
    }

    @Test func adjacentChangesAndDeletionRemainSeparateSourceAnchoredRows() throws {
        let text = "badtext"
        let comparison = try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [issue("a", "bad", "poor", in: text), issue("b", "text", "", in: text)])
        #expect(comparison.revised == "poor")
        #expect(comparison.rows.map(\.original) == ["bad", "text"])
        #expect(comparison.rows[1].replacement == "")
        #expect(comparison.revisedSegments.map(\.text).joined() == "poor")
        #expect(comparison.originalSegments.map(\.emphasis) == [.removed, .removed])
    }

    @Test func replacementCannotJoinGraphemesBeyondItsSourceBoundaries() {
        for (text, target, original, replacement) in [
            ("aX", UTF16Range(start: 1, length: 1), "X", "\u{301}"),
            ("X🔬", UTF16Range(start: 0, length: 1), "X", "👩‍"),
            ("🇺X🇸", UTF16Range(start: 2, length: 1), "X", "")
        ] {
            #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
                try WritingPolishComparison(snapshot: makeSnapshot(text, target: target), issues: [issue("unsafe", original, replacement, in: text)])
            }
        }
    }

    @Test func combinedAdjacentEditsCannotJoinOutsideRegionalIndicators() {
        let text = "🇺AB🇸"
        let changes = [issue("a", "A", "", in: text), issue("b", "B", "", in: text)]
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try WritingPolishComparison(snapshot: makeSnapshot(text, target: .init(start: 2, length: 2)), issues: changes)
        }
    }

    @Test func protectedSourceCannotBecomeAPreviewedReplacement() {
        let text = "Ref text"
        let snapshot = makeSnapshot(text, protected: [.init(start: 0, length: 3)])
        #expect(throws: WritingValidationError.protectedRange) {
            try WritingPolishComparison(snapshot: snapshot, issues: [issue("ref", "Ref", "Other", in: text)])
        }
    }

    @Test func unknownCategoryAndEmptyOriginalAreRejected() {
        let text = "Text"
        #expect(throws: WritingValidationError.invalidCategory) {
            try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [issue("x", text, "Other", in: text, category: "style")])
        }
        let empty = WritingIssue(id: "empty", category: "expression", original: "", replacement: "New", reason: "", range: .init(start: 0, length: 0), requiresAuthorConfirmation: true)
        #expect(throws: WritingValidationError.emptyOriginal) {
            try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [empty])
        }
    }

    @Test func byteDistinctUnicodeReplacementIsKeptWithoutNormalization() throws {
        let text = "Cafe\u{301}"
        let comparison = try WritingPolishComparison(snapshot: makeSnapshot(text), issues: [issue("unicode", text, "Café", in: text)])
        #expect(bytes(comparison.original) != bytes(comparison.revised))
        #expect(bytes(comparison.revised) == bytes("Café"))
        #expect(comparison.changes.count == 1)
        #expect(comparison.revisedSegments[0].emphasis == .inserted)
    }

    @Test func canonicalEqualReplacementBytesRemainDistinctInComparisonEquality() throws {
        let snapshot = makeSnapshot("Coffee")
        let composed = try WritingPolishComparison(snapshot: snapshot, issues: [issue("unicode", "Coffee", "Café", in: "Coffee")])
        let decomposed = try WritingPolishComparison(snapshot: snapshot, issues: [issue("unicode", "Coffee", "Cafe\u{301}", in: "Coffee")])
        #expect(composed != decomposed)
        #expect(composed.rows != decomposed.rows)
        #expect(composed.revisedSegments != decomposed.revisedSegments)
    }

    private func makeSnapshot(_ text: String, target: UTF16Range? = nil, protected: [UTF16Range] = []) -> WritingSnapshot {
        .init(requestID: "request", documentSessionID: "document", blockID: "paragraph", revision: "1", rawText: text,
              contextBefore: "Read-only before.", contextAfter: "Read-only after.", targetRange: target, protectedRanges: protected, scope: .selection)
    }
    private func issue(_ id: String, _ original: String, _ replacement: String, in text: String, category: String = "expression", reason: String = "Clearer wording") -> WritingIssue {
        .init(id: id, category: category, original: original, replacement: replacement, reason: reason, range: range(original, in: text), requiresAuthorConfirmation: true)
    }
    private func range(_ original: String, in text: String) -> UTF16Range {
        let found = (text as NSString).range(of: original, options: .literal)
        precondition(found.location != NSNotFound)
        return .init(start: found.location, length: found.length)
    }
    private func bytes(_ text: String) -> [UInt8] { Array(text.utf8) }
}

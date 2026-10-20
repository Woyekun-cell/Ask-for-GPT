import Foundation
import Testing
@testable import AskGPTCore

struct WritingIssueValidatorTests {
    private let validator = WritingIssueValidator()

    @Test func repeatedOriginalWithoutUniqueAnchorsIsRejected() throws {
        let snapshot = makeSnapshot("The result are clear. The result are clear.")
        #expect(throws: WritingValidationError.ambiguousAnchor) {
            try validator.validate(.init(original: "result are", replacement: "results are"), in: snapshot)
        }
    }

    @Test func adjacentAnchorsResolveRepeatedOriginalAndDeriveUTF16Offset() throws {
        let snapshot = makeSnapshot("A result are clear. B result are clear.")
        let issue = try validator.validate(.init(original: "result are", replacement: "results are", prefix: "B ", suffix: " clear."), in: snapshot)
        #expect(issue.range == UTF16Range(start: 22, length: 10))
        #expect(issue.original == "result are")
        #expect(issue.requiresAuthorConfirmation)
    }

    @Test func selectionDoesNotSilentlyDisambiguateDuplicateOriginal() {
        let snapshot = makeSnapshot("bad bad", target: .init(start: 4, length: 3))
        #expect(throws: WritingValidationError.ambiguousAnchor) {
            try validator.validate(.init(original: "bad", replacement: "good"), in: snapshot)
        }
    }

    @Test func emojiAndCombiningMarkKeepOriginalUTF16Coordinates() throws {
        let snapshot = makeSnapshot("🧬 Cafe\u{301} are useful.")
        let issue = try validator.validate(.init(original: "are", replacement: "is"), in: snapshot)
        #expect(issue.range == UTF16Range(start: 9, length: 3))
        #expect(snapshot.rawText.utf16.count == 20)
    }

    @Test func canonicallyEquivalentButNonidenticalOriginalIsNotMatched() {
        let snapshot = makeSnapshot("Cafe\u{301} is useful.")
        #expect(throws: WritingValidationError.originalNotFound) {
            try validator.validate(.init(original: "Café", replacement: "Coffee"), in: snapshot)
        }
    }

    @Test func partialCombiningGraphemeIsRejected() {
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try validator.validate(.init(original: "e", replacement: "a"), in: makeSnapshot("e\u{301}"))
        }
    }

    @Test func partialEmojiSequenceIsRejected() {
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try validator.validate(.init(original: "👩", replacement: "person"), in: makeSnapshot("👩‍🔬 works"))
        }
    }

    @Test func suggestionOutsideSelectionIsRejected() {
        #expect(throws: WritingValidationError.outsideTargetRange) {
            try validator.validate(.init(original: "bad", replacement: "poor"), in: makeSnapshot("bad good", target: .init(start: 4, length: 4)))
        }
    }

    @Test func invalidAndOverflowingTargetRangesAreRejected() {
        for range in [UTF16Range(start: -1, length: 1), .init(start: 0, length: -1), .init(start: Int.max, length: 1), .init(start: 0, length: 100)] {
            #expect(throws: WritingValidationError.invalidRange) {
                try validator.validate(.init(original: "bad", replacement: "good"), in: makeSnapshot("bad", target: range))
            }
        }
    }

    @Test func selectionBoundaryCannotSplitEmojiSurrogatePair() {
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try validator.validate(.init(original: "bad", replacement: "good"), in: makeSnapshot("🧬bad", target: .init(start: 1, length: 4)))
        }
    }

    @Test func protectedCitationRangeCannotBeChanged() {
        let snapshot = makeSnapshot("Smith et al. are correct.", protected: [.init(start: 0, length: 12)])
        #expect(throws: WritingValidationError.protectedRange) {
            try validator.validate(.init(original: "et al.", replacement: "and colleagues"), in: snapshot)
        }
    }

    @Test func invalidProtectedRangeIsRejectedEvenWhenIssueDoesNotOverlap() {
        let snapshot = makeSnapshot("bad text", protected: [.init(start: 99, length: 1)])
        #expect(throws: WritingValidationError.invalidRange) {
            try validator.validate(.init(original: "bad", replacement: "poor"), in: snapshot)
        }
    }

    @Test func configuredTermCannotBeRemovedOrRecased() {
        let validator = WritingIssueValidator(profile: .init(customTerms: ["PaEprs1a"]))
        for replacement in ["EPRS", "paeprs1a"] {
            #expect(throws: WritingValidationError.protectedTermChanged) {
                try validator.validate(.init(original: "PaEprs1a", replacement: replacement), in: makeSnapshot("PaEprs1a"))
            }
        }
    }

    @Test func replacementCannotMergeWithProtectedGraphemeOutsideSelection() {
        let snapshot = makeSnapshot("aX", target: .init(start: 1, length: 1), protected: [.init(start: 0, length: 1)])
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try validator.validate(.init(original: "X", replacement: "\u{0301}"), in: snapshot)
        }
    }

    @Test func replacementCannotJoinEmojiOutsideItsRightBoundary() {
        let snapshot = makeSnapshot("X🔬", target: .init(start: 0, length: 1))
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try validator.validate(.init(original: "X", replacement: "👩‍"), in: snapshot)
        }
    }

    @Test func deletionCannotMergeRegionalIndicatorsOutsideSelection() {
        let snapshot = makeSnapshot("🇺X🇸", target: .init(start: 2, length: 1))
        #expect(throws: WritingValidationError.invalidGraphemeBoundary) {
            try validator.validate(.init(original: "X", replacement: ""), in: snapshot)
        }
    }

    @Test func ordinaryDeletionAndReplacementPreserveOutsideGraphemes() throws {
        let snapshot = makeSnapshot("aXb", target: .init(start: 1, length: 1), protected: [.init(start: 0, length: 1), .init(start: 2, length: 1)])
        let deletion = try validator.validate(.init(original: "X", replacement: ""), in: snapshot)
        let replacement = try validator.validate(.init(original: "X", replacement: "text"), in: snapshot)
        #expect(deletion.replacement.isEmpty)
        #expect(replacement.range == UTF16Range(start: 1, length: 1))
    }

    @Test func partialEditCannotBypassProtectedTerm() {
        let validator = WritingIssueValidator(profile: .init(customTerms: ["PaEprs1a"]))
        #expect(throws: WritingValidationError.protectedTermChanged) {
            try validator.validate(.init(original: "Pa", replacement: "Other"), in: makeSnapshot("PaEprs1a"))
        }
    }

    @Test func tamperedContextIsRejectedEvenWhenRawTextIsUnchanged() {
        var snapshot = makeSnapshot("bad")
        snapshot.contextBefore = "different context"
        #expect(throws: WritingValidationError.contextHashMismatch) {
            try validator.validate(.init(original: "bad", replacement: "poor"), in: snapshot)
        }
    }

    @Test func unknownCategoryIsRejected() {
        #expect(throws: WritingValidationError.invalidCategory) {
            try validator.validate(.init(original: "bad", replacement: "poor", category: "style"), in: makeSnapshot("bad"))
        }
    }

    @Test func quantitativeNegationAndEvidenceChangesNeverBecomeAutomatic() throws {
        let changes = [("n = 3", "n = 30"), ("P < 0.05", "P > 0.05"), ("5 mg", "5 g"), ("did not increase", "increased"), ("may support", "demonstrates"), ("higher than", "lower than")]
        for (original, replacement) in changes {
            let issue = try validator.validate(.init(original: original, replacement: replacement), in: makeSnapshot(original))
            #expect(issue.requiresAuthorConfirmation)
        }
    }

    @Test func unrelatedReplacementStillRequiresAuthorReview() throws {
        let issue = try validator.validate(.init(original: "The fish was sampled.", replacement: "The fish caused infection."), in: makeSnapshot("The fish was sampled."))
        #expect(issue.requiresAuthorConfirmation)
    }

    @Test func overlappingBatchSuggestionsAreRejected() {
        #expect(throws: WritingValidationError.overlappingIssues) {
            try validator.validate([.init(original: "bad text", replacement: "poor text"), .init(original: "text", replacement: "word")], in: makeSnapshot("bad text"))
        }
    }

    @Test func adjacentBatchSuggestionsAreAllowed() throws {
        let issues = try validator.validate([.init(original: "bad", replacement: "poor"), .init(original: "text", replacement: "word")], in: makeSnapshot("badtext"))
        #expect(issues.count == 2)
    }

    @Test func suppliedSnapshotHashMustMatchRawUnnormalizedText() {
        let snapshot = WritingSnapshot(requestID: "r", documentSessionID: "d", blockID: "b", revision: "1", rawText: "bad", snapshotHash: "not-the-hash")
        #expect(throws: WritingValidationError.snapshotHashMismatch) {
            try validator.validate(.init(original: "bad", replacement: "poor"), in: snapshot)
        }
    }

    @Test func contextQuestionCanRetainExactOriginalWithoutInventedReplacement() throws {
        let original = "This treatment improved survival."
        let issue = try validator.validate(.init(original: original, replacement: original, category: "context", reason: "请明确 This treatment 指哪一种处理。"), in: makeSnapshot(original))
        #expect(Array(issue.original.utf8) == Array(issue.replacement.utf8))
        #expect(issue.range == UTF16Range(start: 0, length: 33))
        #expect(issue.category == "context")
        #expect(issue.requiresAuthorConfirmation)
    }

    @Test func noOpContextQuestionStillRequiresUniqueAnchorAndSelectedRange() {
        let suggestion = ModelWritingSuggestion(original: "This treatment", replacement: "This treatment", category: "context", reason: "请明确处理名称。")
        #expect(throws: WritingValidationError.ambiguousAnchor) {
            try validator.validate(suggestion, in: makeSnapshot("This treatment; This treatment"))
        }
        #expect(throws: WritingValidationError.outsideTargetRange) {
            try validator.validate(suggestion, in: makeSnapshot("This treatment improved survival.", target: .init(start: 15, length: 18)))
        }
    }

    @Test func noOpRequiresContextCategoryAndNonemptyReason() {
        for category in ["spelling", "grammar", "expression", "context"] {
            let reason = category == "context" ? " \n " : "An explanation cannot authorize a non-context no-op."
            #expect(throws: WritingValidationError.unchangedSuggestion) {
                try validator.validate(.init(original: "text", replacement: "text", category: category, reason: reason), in: makeSnapshot("text"))
            }
        }
    }

    @Test func emptyOrUnchangedModelSuggestionsAreRejected() {
        #expect(throws: WritingValidationError.emptyOriginal) {
            try validator.validate(.init(original: "", replacement: "new"), in: makeSnapshot("bad"))
        }
        #expect(throws: WritingValidationError.unchangedSuggestion) {
            try validator.validate(.init(original: "bad", replacement: "bad"), in: makeSnapshot("bad"))
        }
    }

    @Test func snapshotHashUsesExactUTF8RatherThanCanonicalEquivalence() {
        #expect(WritingSnapshot.hash(rawText: "abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(WritingSnapshot.hash(rawText: "é") != WritingSnapshot.hash(rawText: "e\u{301}"))
    }

    @Test func JSONRoundTripRetainsOriginalTextAndIdentity() throws {
        let source = makeSnapshot("e\u{301}\r\n🧬", target: .init(start: 0, length: 2))
        let data = try JSONEncoder().encode(source)
        let decoded = try JSONDecoder().decode(WritingSnapshot.self, from: data)
        #expect(Array(decoded.rawText.utf8) == Array(source.rawText.utf8))
        #expect(decoded.requestID == "r")
        #expect(decoded.targetRange == UTF16Range(start: 0, length: 2))
    }

    private func makeSnapshot(_ text: String, target: UTF16Range? = nil, protected ranges: [UTF16Range] = []) -> WritingSnapshot {
        WritingSnapshot(requestID: "r", documentSessionID: "d", blockID: "b", revision: "1", rawText: text, targetRange: target, protectedRanges: ranges)
    }
}

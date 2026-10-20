import Foundation
import Testing
@testable import AskGPTCore

struct LocalPunctuationCheckerTests {
    @Test func realSystemDictionaryAndPunctuationShareTheAutomaticLocalPipeline() async throws {
        let text = "The results,however are clear;another result changed."
        let issues = try await LocalProofreader().check(writingSnapshot(text), profile: .init())
        #expect(issues.contains { $0.original == "," && $0.replacement == ", " }, Comment(rawValue: String(describing: issues)))
        #expect(issues.contains { $0.original == ";" && $0.replacement == "; " }, Comment(rawValue: String(describing: issues)))
        #expect(issues.allSatisfy { $0.category == "spelling" })
    }

    @Test func replacesChinesePunctuationOnlyInEnglishProse() async throws {
        let issues = try await check("The results，however，were clear。")
        #expect(issues.map(\.original) == ["，", "，", "。"])
        #expect(issues.map(\.replacement) == [", ", ", ", "."])
        #expect(issues.allSatisfy { $0.category == "spelling" && $0.requiresAuthorConfirmation && $0.reason.contains("标点") })
    }

    @Test func collapsesRepeatedPunctuationWithoutChangingItsKind() async throws {
        let issues = try await check("The result,,however;; seems clear!!")
        #expect(issues.map(\.original) == [",,", ";;", "!!"])
        #expect(issues.map(\.replacement) == [", ", ";", "!"])
        #expect(try await check("The result?! is valid...").isEmpty)
    }

    @Test func removesOnlyOrdinarySpacesBeforeClearProsePunctuation() async throws {
        let issues = try await check("The results  ,however ; another finding : clearly useful !")
        #expect(issues.map(\.original) == ["  ,", " ;", " :", " !"])
        #expect(issues.map(\.replacement) == [", ", ";", ":", "!"])
        #expect(try await check("The results\t, however changed.").isEmpty)
    }

    @Test func addsMissingSpaceAfterCommaSemicolonAndColonBetweenWords() async throws {
        let issues = try await check("The results,however;another finding:clearly changed")
        #expect(issues.map(\.original) == [",", ";", ":"])
        #expect(issues.map(\.replacement) == [", ", "; ", ": "])
    }

    @Test func leavesEnglishPeriodsAbbreviationsAndEllipsesUntouched() async throws {
        #expect(try await check("The result.Next is e.g. clear... Dr. Smith wrote this.").isEmpty)
        #expect(try await check("The result . Next is clear.").isEmpty)
    }

    @Test func protectsScientificNumbersRangesAndIdentifiers() async throws {
        let text = "P=0.08; n=10; IL-6,TNF-alpha; ABCA1:ABCG1; 1:2; 0.1,0.2; 3–5; gene_name,other; β-catenin,another."
        #expect(try await check(text).isEmpty)
    }

    @Test func protectsURLsDOIsAndEmailAddresses() async throws {
        let text = "See https://example.org/a,b?x=1,and doi:10.1038/s41586-024-00000-0,email@example.org or name@example.org;another@example.net."
        #expect(try await check(text).isEmpty)
    }

    @Test func protectsParentheticalAndBracketedCitationsAndCode() async throws {
        let text = "The result (Smith,2024;Jones,2025) supports [1,2] and [see,also] with `value,,other`."
        #expect(try await check(text).isEmpty)
    }

    @Test func respectsFieldRangesAndPrivateTerms() async throws {
        let text = "The results，however were clear ; changed"
        let punctuation = (text as NSString).range(of: "，")
        let snapshot = writingSnapshot(text, protectedRanges: [.init(start: punctuation.location, length: punctuation.length)])
        let issues = try await LocalProofreader(provider: FixedWritingSpellProvider()).check(snapshot,
            profile: .init(customTerms: ["clear ;"]))
        #expect(issues.isEmpty)
    }

    @Test func filtersFindingsOutsideSelectionAndRetainsExactUTF16Anchors() async throws {
        let text = "😀 First,second then third,fourth"
        let selected = (text as NSString).range(of: "third,fourth")
        let snapshot = writingSnapshot(text, targetRange: .init(start: selected.location, length: selected.length))
        let issues = try await LocalProofreader(provider: FixedWritingSpellProvider()).check(snapshot, profile: .init())
        #expect(issues.count == 1)
        #expect(issues.first?.range == UTF16Range(start: selected.location + 5, length: 1))
        #expect(issues.first?.original == "," && issues.first?.replacement == ", ")
    }

    @Test func neverOverlapsAnExistingDictionarySuggestion() async throws {
        let text = "The results,however changed"
        let original = "results,however"
        let range = (text as NSString).range(of: original)
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: range.location, length: range.length), replacement: "results however")]))
        let issues = try await checker.check(writingSnapshot(text), profile: .init())
        #expect(issues.count == 1)
        #expect(issues.first?.original == original)
    }

    @Test func aJoinedUnknownWordCannotHideAnIndependentlyValidatedPunctuationIssue() async throws {
        let text = "The qxzzy results,however changed."
        let unknown = (text as NSString).range(of: "qxzzy")
        let joined = (text as NSString).range(of: "results,however")
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: unknown.location, length: unknown.length), replacement: nil),
            .init(range: .init(start: joined.location, length: joined.length), replacement: nil)]))
        let issues = try await checker.check(writingSnapshot(text), profile: .init())
        #expect(issues.map(\.original) == ["qxzzy", ","])
        #expect(issues.map(\.replacement) == ["qxzzy", ", "])
        #expect(issues.allSatisfy { $0.requiresAuthorConfirmation })
    }

    @Test func joinedUnknownWordDoesNotBypassPrivateTermOrFieldProtection() async throws {
        let text = "The results,however changed."
        let joined = (text as NSString).range(of: "results,however")
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: joined.location, length: joined.length), replacement: nil)]))
        #expect(try await checker.check(writingSnapshot(text), profile: .init(customTerms: ["results,however"])).isEmpty)
        let comma = (text as NSString).range(of: ",")
        let protected = writingSnapshot(text, protectedRanges: [.init(start: comma.location, length: comma.length)])
        #expect(try await checker.check(protected, profile: .init()).isEmpty)
    }

    @Test func returnsSpellingAndPunctuationInSourceOrder() async throws {
        let text = "The results,however are teh same."
        let typo = (text as NSString).range(of: "teh")
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: typo.location, length: typo.length), replacement: "the")]))
        let issues = try await checker.check(writingSnapshot(text), profile: .init())
        #expect(issues.map(\.original) == [",", "teh"])
    }

    @Test func doesNotApplyEnglishRulesToChineseTextOrSingleLetterNotation() async throws {
        #expect(try await check("这个 results，however 是说明。").isEmpty)
        #expect(try await check("We use A:B and x,y coordinates.").isEmpty)
    }

    @Test func skipsPunctuationInsideACombinedGraphemeRatherThanFailingTheWholeCheck() async throws {
        #expect(try await check("The results，\u{0301}however were clear.").isEmpty)
    }

    private func check(_ text: String) async throws -> [WritingIssue] {
        try await LocalProofreader(provider: FixedWritingSpellProvider()).check(writingSnapshot(text), profile: .init())
    }
}

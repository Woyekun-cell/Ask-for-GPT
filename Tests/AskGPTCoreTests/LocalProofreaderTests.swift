import Foundation
import Testing
@testable import AskGPTCore

struct LocalProofreaderTests {
    @Test func alphanumericIdentifiersAreNotRewrittenAsOrdinaryDictionaryWords() async throws {
        for original in ["PaEprs1a", "IL-6", "ABCA1"] {
            let text = "The \(original) expression changed."
            let range = (text as NSString).range(of: original)
            let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
                .init(range: .init(start: range.location, length: range.length), replacement: "papers")]))
            #expect(try await checker.check(writingSnapshot(text), profile: .init()).isEmpty)
        }
    }

    @Test func identifierProtectionCoversInternalDictionaryFragmentsWithoutHidingOrdinaryTypos() async throws {
        let text = "PaEprs1a has a wrting error."
        let typo = (text as NSString).range(of: "wrting")
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: 0, length: 6), replacement: "papers"),
            .init(range: .init(start: typo.location, length: typo.length), replacement: "writing")]))
        let issues = try await checker.check(writingSnapshot(text), profile: .init())
        #expect(issues.count == 1)
        #expect(issues.first?.original == "wrting" && issues.first?.replacement == "writing")
    }

    @Test func realDictionaryDoesNotSuggestPapersForPaEprs1a() async throws {
        let issues = try await LocalProofreader().check(writingSnapshot("PaEprs1a expression was measured."), profile: .init())
        #expect(!issues.contains { $0.original.contains("PaEprs") })
    }

    @Test func flagsExactUTF16RangeWithoutRemoteBackend() async throws {
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [.init(range: .init(start: 3, length: 3), replacement: "the")]))
        let issues = try await checker.check(writingSnapshot("😀 teh result."), profile: .init())
        #expect(issues.count == 1)
        #expect(issues.first?.original == "teh")
        #expect(issues.first?.replacement == "the")
        #expect(issues.first?.range == UTF16Range(start: 3, length: 3))
        #expect(issues.first?.requiresAuthorConfirmation == true)
    }

    @Test func whitelistProtectsWholeTechnicalTermAndProtectedSpans() async throws {
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: 0, length: 3), replacement: "Ran"),
            .init(range: .init(start: 8, length: 3), replacement: "the")]))
        let snapshot = writingSnapshot("RNA-seq teh", protectedRanges: [.init(start: 8, length: 3)])
        #expect(try await checker.check(snapshot, profile: .init(customTerms: ["RNA-seq"])).isEmpty)
    }

    @Test func whitelistedSubstringDoesNotHideLongerMisspellingWhenTermBytesArePreserved() async throws {
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: 4, length: 8), replacement: "cell")]))
        let issues = try await checker.check(writingSnapshot("The cellzzzz changed."), profile: .init(customTerms: ["cell"]))
        #expect(issues.count == 1)
        #expect(issues.first?.original == "cellzzzz")
        #expect(issues.first?.replacement == "cell")
        #expect(issues.first?.range == UTF16Range(start: 4, length: 8))
        #expect(issues.first?.requiresAuthorConfirmation == true)
    }

    @Test func partiallyOverlappingProtectedRangeStillSuppressesLongerFinding() async throws {
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
            .init(range: .init(start: 4, length: 8), replacement: "cell")]))
        let snapshot = writingSnapshot("The cellzzzz changed.", protectedRanges: [.init(start: 4, length: 4)])
        #expect(try await checker.check(snapshot, profile: .init()).isEmpty)
    }

    @Test func whitelistSuppressesWholeTechnicalTermAndItsInternalSpellingFragments() async throws {
        for length in [7, 3] {
            let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
                .init(range: .init(start: 0, length: length), replacement: "Ran")]))
            #expect(try await checker.check(writingSnapshot("RNA-seq"), profile: .init(customTerms: ["RNA-seq"])).isEmpty)
        }
    }

    @Test func longerMisspellingCandidateCannotChangeWhitelistedTerm() async {
        for replacement in ["Cell", "well"] {
            let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [
                .init(range: .init(start: 4, length: 8), replacement: replacement)]))
            do {
                _ = try await checker.check(writingSnapshot("The cellzzzz changed."), profile: .init(customTerms: ["cell"]))
                Issue.record("Candidate that changes protected term was not rejected")
            } catch {
                #expect(error as? WritingValidationError == .protectedTermChanged)
            }
        }
    }

    @Test func passesSelectedVariantToLocalDictionaryAndAcceptsCleanSentence() async throws {
        let provider = LanguageWritingSpellProvider()
        let checker = LocalProofreader(provider: provider)
        #expect(try await checker.check(writingSnapshot("The colour is blue."), profile: .init(spellingVariant: "en-GB")).isEmpty)
        #expect(await provider.languages == ["en-GB"])
    }

    @Test func missingGuessIsReadOnlyIssueRatherThanDeletionOrCleanResult() async throws {
        let checker = LocalProofreader(provider: FixedWritingSpellProvider(findings: [.init(range: .init(start: 0, length: 6), replacement: nil)]))
        let issue = try #require(try await checker.check(writingSnapshot("xyzqzx"), profile: .init()).first)
        #expect(issue.original == "xyzqzx" && issue.replacement == "xyzqzx")
        #expect(!issue.reason.isEmpty && issue.requiresAuthorConfirmation)
    }

    @Test func dictionaryFailureNeverBecomesCompletedEmptyIssues() async {
        for failure in [WritingServiceError.spellCheckingUnavailable, .spellCheckingTimeout] {
            let checker = LocalProofreader(provider: FixedWritingSpellProvider(error: failure))
            do { _ = try await checker.check(writingSnapshot("A sentence."), profile: .init()); Issue.record("Unchecked text reported clean") }
            catch { #expect(error as? WritingServiceError == failure) }
        }
    }

    @Test func malformedSnapshotRejectedEvenWhenProviderWouldReturnEmpty() async {
        var invalid = writingSnapshot("Cafe\u{301}")
        invalid.snapshotHash = String(repeating: "0", count: 64)
        let checker = LocalProofreader(provider: FixedWritingSpellProvider())
        do { _ = try await checker.check(invalid, profile: .init()); Issue.record("Bad hash accepted") }
        catch { #expect(error is WritingValidationError) }
        invalid = writingSnapshot("😀", targetRange: .init(start: 1, length: 1))
        do { _ = try await checker.check(invalid, profile: .init()); Issue.record("Split surrogate accepted") }
        catch { #expect(error is WritingValidationError) }
    }

    @Test func actualSystemDictionaryCompletesCleanEnglishCheck() async throws {
        #expect(try await LocalProofreader().check(writingSnapshot("The results are clear."), profile: .init()).isEmpty)
    }

    @Test func actualSystemDictionaryHonoursAmericanAndBritishVariants() async throws {
        let checker = LocalProofreader()
        let snapshot = writingSnapshot("The colour is blue.")
        let american = try await checker.check(snapshot, profile: .init(spellingVariant: "en-US"))
        let british = try await checker.check(snapshot, profile: .init(spellingVariant: "en-GB"))
        #expect(american.contains { $0.original == "colour" })
        #expect(british.isEmpty)
    }
}

func writingSnapshot(_ text: String, requestID: String = "request-1", revision: String = "1",
                     targetRange: UTF16Range? = nil, protectedRanges: [UTF16Range] = []) -> WritingSnapshot {
    .init(requestID: requestID, documentSessionID: "document", blockID: "paragraph", revision: revision,
          rawText: text, targetRange: targetRange, protectedRanges: protectedRanges)
}

struct FixedWritingSpellProvider: WritingSpellProvider {
    var findings: [WritingSpellingFinding] = []
    var error: (any Error)? = nil
    func check(text: String, language: String) async throws -> [WritingSpellingFinding] {
        if let error { throw error }
        return findings
    }
}

actor LanguageWritingSpellProvider: WritingSpellProvider {
    private(set) var languages: [String] = []
    func check(text: String, language: String) async throws -> [WritingSpellingFinding] {
        languages.append(language); return []
    }
}

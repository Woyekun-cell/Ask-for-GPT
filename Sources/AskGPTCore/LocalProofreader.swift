import AppKit
import Foundation

struct WritingSpellingFinding: Sendable {
    let range: UTF16Range
    let replacement: String?
}

protocol WritingSpellProvider: Sendable {
    func check(text: String, language: String) async throws -> [WritingSpellingFinding]
}

/// Uses the system spelling service and conservative local punctuation rules.
/// Private terms are filtered per request;
/// they are never learned, unlearned, or written to the global system dictionary.
public struct LocalProofreader: Sendable {
    private let provider: any WritingSpellProvider
    public init() { provider = SystemWritingSpellProvider() }
    init(provider: any WritingSpellProvider) { self.provider = provider }

    public func check(_ snapshot: WritingSnapshot, profile: WritingProfile) async throws -> [WritingIssue] {
        try WritingSnapshotPreflight.validate(snapshot, profile: profile)
        let findings = try await provider.check(text: snapshot.rawText, language: profile.spellingVariant)
        try Task.checkCancellation()
        let source = snapshot.rawText as NSString
        let boundaries = WritingSnapshotPreflight.graphemeBoundaries(snapshot.rawText)
        // Mixed letters and digits usually identify a term, accession or model,
        // rather than an ordinary dictionary word. Do not rename such tokens.
        let identifierPattern = try NSRegularExpression(pattern: "[A-Za-z0-9_]+(?:[-‐‑][A-Za-z0-9_]+)*")
        let identifierRanges = identifierPattern.matches(in: snapshot.rawText, range: .init(location: 0, length: source.length)).compactMap { match -> UTF16Range? in
            let bytes = source.substring(with: match.range).utf8
            guard bytes.contains(where: { (65...90).contains($0) || (97...122).contains($0) }),
                  bytes.contains(where: { (48...57).contains($0) }) else { return nil }
            return .init(start: match.range.location, length: match.range.length)
        }
        let termRanges = profile.customTerms.flatMap { term -> [UTF16Range] in
            var ranges: [UTF16Range] = []
            var cursor = snapshot.rawText.startIndex
            while cursor < snapshot.rawText.endIndex,
                  let match = snapshot.rawText.range(of: term, options: .literal, range: cursor..<snapshot.rawText.endIndex) {
                let range = NSRange(match, in: snapshot.rawText)
                ranges.append(.init(start: range.location, length: range.length))
                cursor = match.upperBound
            }
            return ranges
        }
        var issues: [WritingIssue] = []
        for finding in findings {
            do { try WritingSnapshotPreflight.validate(finding.range, count: source.length, boundaries: boundaries) }
            catch { throw WritingServiceError.invalidSpellingResult }
            guard finding.range.length > 0, let end = finding.range.end else { throw WritingServiceError.invalidSpellingResult }
            guard finding.range.start >= snapshot.targetRange.start, end <= snapshot.targetRange.end! else { continue }
            if snapshot.protectedRanges.contains(where: { overlap($0, finding.range) }) { continue }
            if identifierRanges.contains(where: { overlap($0, finding.range) }) { continue }
            // A term suppresses only findings inside it. Longer findings must still
            // pass the validator, which preserves the term's original bytes.
            if termRanges.contains(where: { term in
                guard let termEnd = term.end else { return false }
                return term.start <= finding.range.start && end <= termEnd
            }) { continue }
            if issues.contains(where: { overlap($0.range, finding.range) }) { throw WritingServiceError.invalidSpellingResult }
            let original = source.substring(with: NSRange(location: finding.range.start, length: finding.range.length))
            if let replacement = finding.replacement, !replacement.isEmpty,
               !Data(replacement.utf8).elementsEqual(Data(original.utf8)) {
                let suggestion = ModelWritingSuggestion(original: original, replacement: replacement,
                    prefix: source.substring(to: finding.range.start), suffix: source.substring(from: end),
                    category: "spelling", reason: "本机词典提示拼写错误，请核对后接受。")
                issues.append(try WritingIssueValidator(profile: profile).validate(suggestion, in: snapshot))
            } else {
                issues.append(.init(category: "spelling", original: original, replacement: original,
                    reason: "本机词典未识别此词，暂无替换候选；请核对或加入本插件词典。", range: finding.range,
                    requiresAuthorConfirmation: true))
            }
        }
        // The system dictionary can report "results,however" as one unknown
        // word with no replacement. That read-only notice must not mask a
        // separately verified punctuation edit. Actionable dictionary edits
        // still take priority, so the two result sets can never overlap.
        let excluded = snapshot.protectedRanges + termRanges + identifierRanges + issues.filter { !isUnchanged($0) }.map(\.range)
        for finding in LocalPunctuationChecker.findings(in: snapshot.rawText, excluding: excluded) {
            try Task.checkCancellation()
            guard let end = finding.range.end, finding.range.start >= snapshot.targetRange.start,
                  end <= snapshot.targetRange.end!, boundaries.contains(finding.range.start),
                  boundaries.contains(end) else { continue }
            let original = source.substring(with: .init(location: finding.range.start, length: finding.range.length))
            let suggestion = ModelWritingSuggestion(original: original, replacement: finding.replacement,
                prefix: source.substring(to: finding.range.start), suffix: source.substring(from: end),
                category: "spelling", reason: finding.reason)
            let issue = try WritingIssueValidator(profile: profile).validate(suggestion, in: snapshot)
            issues.removeAll { isUnchanged($0) && overlap($0.range, issue.range) }
            issues.append(issue)
        }
        return issues.sorted { $0.range.start < $1.range.start }
    }

    private func overlap(_ a: UTF16Range, _ b: UTF16Range) -> Bool {
        guard let aEnd = a.end, let bEnd = b.end else { return true }
        return a.start < bEnd && b.start < aEnd
    }

    private func isUnchanged(_ issue: WritingIssue) -> Bool {
        Data(issue.original.utf8).elementsEqual(Data(issue.replacement.utf8))
    }
}

struct SystemWritingSpellProvider: WritingSpellProvider {
    func check(text: String, language: String) async throws -> [WritingSpellingFinding] {
        try await SystemWritingSpellCheck.check(text: text, language: language)
    }
}

@MainActor private enum SystemWritingSpellCheck {
    static func check(text: String, language: String) async throws -> [WritingSpellingFinding] {
        try Task.checkCancellation()
        let checker = NSSpellChecker.shared
        // Apple's built-in American dictionary is advertised as "en", while
        // British spelling has its own "en_GB" entry. Do not treat generic
        // English as a fallback for a missing British dictionary.
        let candidates = language == "en-US" ? ["en_US", "en"] : ["en_GB"]
        guard let systemLanguage = candidates.first(where: { candidate in
            checker.availableLanguages.contains { $0.replacingOccurrences(of: "-", with: "_") == candidate }
        }) else {
            throw WritingServiceError.spellCheckingUnavailable
        }
        let tag = NSSpellChecker.uniqueSpellDocumentTag()
        defer { checker.closeSpellDocument(withTag: tag) }
        // Native requestChecking ignores the requested regional orthography when
        // automatic language identification is enabled. The explicit-language
        // API is reliable, so scan at most 4000 UTF-16 units without changing the
        // shared checker's language or automatic-identification preference.
        let count = text.utf16.count
        guard count <= 4000 else { throw WritingServiceError.inputTooLong }
        let started = ContinuousClock.now
        var cursor = 0
        var findings: [WritingSpellingFinding] = []
        while cursor < count {
            await Task.yield()
            try Task.checkCancellation()
            guard started.duration(to: .now) < .seconds(8) else { throw WritingServiceError.spellCheckingTimeout }
            var wordCount = 0
            let range = checker.checkSpelling(of: text, startingAt: cursor, language: systemLanguage,
                wrap: false, inSpellDocumentWithTag: tag, wordCount: &wordCount)
            guard started.duration(to: .now) < .seconds(8) else { throw WritingServiceError.spellCheckingTimeout }
            guard wordCount >= 0 else { throw WritingServiceError.spellCheckingUnavailable }
            if range.location == NSNotFound {
                guard range.length == 0 else { throw WritingServiceError.invalidSpellingResult }
                break
            }
            guard range.location >= cursor, range.length > 0, range.location <= count,
                  range.length <= count - range.location else { throw WritingServiceError.invalidSpellingResult }
            let guess = checker.guesses(forWordRange: range, in: text, language: systemLanguage, inSpellDocumentWithTag: tag)?.first
            findings.append(.init(range: .init(start: range.location, length: range.length), replacement: guess))
            cursor = range.location + range.length
        }
        try Task.checkCancellation()
        return findings
    }
}

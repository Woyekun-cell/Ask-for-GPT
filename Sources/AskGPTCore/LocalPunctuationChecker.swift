import Foundation

struct LocalPunctuationFinding {
    let range: UTF16Range
    let replacement: String
    let reason: String
}

/// Deliberately limited to visible, English prose punctuation. This is not a
/// grammar model: periods, ellipses, mixed emphatic marks, notation and quoted
/// citations are left alone. Findings still require the normal author action.
enum LocalPunctuationChecker {
    static func findings(in text: String, excluding excluded: [UTF16Range]) -> [LocalPunctuationFinding] {
        let source = text as NSString
        guard matches(#"[\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}]"#, in: text).isEmpty,
              matches("[A-Za-z]{2,}", in: text).count >= 2 else { return [] }
        let protected = excluded + protectedRanges(in: text)
        var result: [LocalPunctuationFinding] = []
        for match in matches("[,;:!?，。；：！？]+", in: text) {
            let punctuation = source.substring(with: match)
            let mapped = punctuation.map { character -> Character in
                switch character {
                case "，": return ","
                case "。": return "."
                case "；": return ";"
                case "：": return ":"
                case "！": return "!"
                case "？": return "?"
                default: return character
                }
            }
            // Do not reinterpret deliberately mixed punctuation such as ?!.
            guard let mark = mapped.first, mapped.allSatisfy({ $0 == mark }) else { continue }
            var start = match.location
            while start > 0, source.character(at: start - 1) == 32 { start -= 1 }
            guard let leftWord = word(before: start, in: source), !abbreviations.contains(leftWord.lowercased()) else { continue }
            let end = NSMaxRange(match)
            let hasRightWord = word(after: end, in: source) != nil
            let hasChineseMark = punctuation.contains { "，。；：！？".contains($0) }
            let missingSpace = hasRightWord && (",;:".contains(mark) || hasChineseMark)
            let hasSpaceBefore = start < match.location
            let isRepeated = mapped.count > 1
            guard hasChineseMark || missingSpace || hasSpaceBefore || isRepeated else { continue }
            let range = UTF16Range(start: start, length: end - start)
            guard !protected.contains(where: { overlaps($0, range) }) else { continue }
            var reasons: [String] = []
            if hasChineseMark { reasons.append("英文中混用了中文标点") }
            if isRepeated { reasons.append("标点重复，请确认是否保留") }
            if hasSpaceBefore { reasons.append("标点前有多余空格") }
            if missingSpace { reasons.append("标点后缺少空格") }
            result.append(.init(range: range, replacement: String(mark) + (missingSpace ? " " : ""),
                                reason: reasons.joined(separator: "；") + "。"))
        }
        return result
    }

    private static let abbreviations: Set<String> = [
        "dr", "mr", "mrs", "ms", "prof", "fig", "figs", "eq", "eqs", "ref", "refs", "vs", "etc", "al",
        "no", "nos", "vol", "pp", "ed", "eds", "approx", "cf"
    ]

    private static func protectedRanges(in text: String) -> [UTF16Range] {
        var ranges = [#"\([^\r\n)]*\)"#, #"\[[^\r\n\]]*\]"#, #"`[^`\r\n]*`"#]
            .flatMap { matches($0, in: text) }
        // Technical whitespace-delimited tokens are not prose. This also covers
        // decimals/ranges, gene IDs, DOI/URL/email tokens and common notation.
        let source = text as NSString
        let technical = try? NSRegularExpression(pattern: #"[\p{N}_/@\\=<>^{}‐‑‒–—-]|[A-Za-z]\.[A-Za-z]"#)
        for range in matches(#"\S+"#, in: text) {
            let token = source.substring(with: range)
            if technical?.firstMatch(in: token, range: .init(location: 0, length: token.utf16.count)) != nil {
                ranges.append(range)
            }
        }
        return ranges.map { .init(start: $0.location, length: $0.length) }
    }

    private static func word(before end: Int, in source: NSString) -> String? {
        var start = end
        while start > 0, isLetter(source.character(at: start - 1)) { start -= 1 }
        guard end - start >= 2, start == 0 || !isIdentifierPart(source.character(at: start - 1)) else { return nil }
        return source.substring(with: .init(location: start, length: end - start))
    }

    private static func word(after start: Int, in source: NSString) -> String? {
        var end = start
        while end < source.length, isLetter(source.character(at: end)) { end += 1 }
        guard end - start >= 2, end == source.length || !isIdentifierPart(source.character(at: end)) else { return nil }
        return source.substring(with: .init(location: start, length: end - start))
    }

    private static func isLetter(_ unit: unichar) -> Bool {
        (65...90).contains(unit) || (97...122).contains(unit)
    }

    private static func isIdentifierPart(_ unit: unichar) -> Bool {
        if (48...57).contains(unit) || "_-/\\@^=".utf16.contains(unit) { return true }
        guard let scalar = UnicodeScalar(unit) else { return true }
        return CharacterSet.letters.contains(scalar)
    }

    private static func matches(_ pattern: String, in text: String) -> [NSRange] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: .init(location: 0, length: text.utf16.count)).map(\.range)
    }

    private static func overlaps(_ lhs: UTF16Range, _ rhs: UTF16Range) -> Bool {
        guard let lhsEnd = lhs.end, let rhsEnd = rhs.end else { return true }
        return lhs.start < rhsEnd && rhs.start < lhsEnd
    }
}

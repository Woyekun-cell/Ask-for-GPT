import Foundation

/// Prepares a separate translation input. Callers retain the original excerpt
/// for display, passage identity, and follow-up context.
public enum TranslationTextPreparation {
    private static let knownLineBrokenWords: Set<String> = [
        "interleukin", "transcriptional", "expression", "metabolomics",
        "transcriptomics", "biological", "technical"
    ]

    public static func preparePDFSelection(_ text: String) -> String {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var result: [String] = []
        for rawLine in normalized.components(separatedBy: "\n") {
            let line = isStructured(rawLine) ? rawLine : removingInlineSoftHyphens(rawLine)
            guard let previous = result.last else { result.append(line); continue }
            if let joined = joiningExplicitSoftHyphen(previous, line) {
                result[result.count - 1] = joined
            } else if let joined = joiningASCIIHyphen(previous, line) {
                result[result.count - 1] = joined
            } else if isProseContinuation(previous, line) {
                // Add only the word separator lost at a physical line wrap.
                // Punctuation, identifiers, numbers, and units remain unchanged.
                result[result.count - 1] = trimHorizontalEnd(previous) + " " + trimHorizontalStart(line)
            } else { result.append(line) }
        }
        return result.joined(separator: "\n")
    }

    private static func isProseContinuation(_ previous: String, _ next: String) -> Bool {
        guard !isStructured(previous), !isStructured(next) else { return false }
        let left = previous.trimmingCharacters(in: .whitespaces)
        let right = next.trimmingCharacters(in: .whitespaces)
        guard !left.isEmpty, !right.isEmpty, asciiWordCount(left) >= 3,
              let last = left.last, let first = right.unicodeScalars.first,
              // A hyphen boundary is handled separately; never insert a word
              // separator inside a compound or identifier.
              !"-\u{00AD}.!?:;".contains(last),
              asciiWordCount(right) >= 1 else { return false }
        // A lowercase continuation (including one final word) is strong enough
        // to join. Uppercase labels/headings remain separate unless the line
        // has ordinary sentence context on both sides.
        return (97...122).contains(first.value) || asciiWordCount(right) >= 3
    }

    private static func joiningExplicitSoftHyphen(_ previous: String, _ next: String) -> String? {
        guard !isStructured(previous), !isStructured(next) else { return nil }
        let left = trimHorizontalEnd(previous)
        let right = trimHorizontalStart(next)
        guard left.last == "\u{00AD}",
              let preceding = left.dropLast().unicodeScalars.last,
              let following = right.unicodeScalars.first,
              isASCIILetter(preceding), isASCIILetter(following) else { return nil }
        return String(left.dropLast()) + right
    }

    private static func removingInlineSoftHyphens(_ text: String) -> String {
        text.replacingOccurrences(of: "(?<=[A-Za-z])\u{00AD}(?=[A-Za-z])", with: "",
            options: .regularExpression)
    }

    private static func joiningASCIIHyphen(_ previous: String, _ next: String) -> String? {
        guard !isStructured(previous), !isStructured(next) else { return nil }
        let left = trimHorizontalEnd(previous)
        let right = trimHorizontalStart(next)
        guard left.last == "-" else { return nil }
        let stem = left.dropLast()
        let suffix = String(stem.reversed().prefix(while: { $0.isLetter || $0.isNumber }).reversed())
        let prefix = String(right.prefix(while: { $0.isLetter || $0.isNumber }))
        guard !suffix.isEmpty, !prefix.isEmpty,
              // Keep an isolated a-/b expression separate; T-/cell and IDs
              // still have enough token context to restore their boundary.
              suffix.count > 1 || prefix.count > 1 else { return nil }
        if knownLineBrokenWords.contains((suffix + prefix).lowercased()) {
            return String(stem) + right
        }
        // Unknown words and genuine compounds retain the original hyphen.
        return left + right
    }

    private static func isStructured(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return true }
        // Conservative barriers for formulas, code, table rows, and lists.
        // This classifier does not modify any token inside such a line.
        if text.contains("\t") || trimmed.rangeOfCharacter(from: CharacterSet(charactersIn: "=<>≤≥±×÷∑∫√^{}|$\\+−")) != nil {
            return true
        }
        if trimmed.range(of: " {2,}", options: .regularExpression) != nil { return true }
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") || trimmed.hasPrefix("#") { return true }
        return trimmed.range(of: "^(?:[-*+•◦▪] +|[0-9]+[.)] +|[A-Za-z][.)] +)",
            options: .regularExpression) != nil
    }

    private static func asciiWordCount(_ text: String) -> Int {
        text.unicodeScalars.split(whereSeparator: { !isASCIILetter($0) }).filter { $0.count >= 2 }.count
    }

    private static func isASCIILetter(_ scalar: Unicode.Scalar) -> Bool {
        (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
    }

    private static func trimHorizontalStart(_ text: String) -> String {
        String(text.drop(while: { $0 == " " || $0 == "\t" }))
    }

    private static func trimHorizontalEnd(_ text: String) -> String {
        String(text.reversed().drop(while: { $0 == " " || $0 == "\t" }).reversed())
    }
}

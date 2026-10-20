import Foundation
import SQLite3

public struct WordSense: Sendable, Equatable {
    public let partOfSpeech: String
    public let meanings: [String]
    public init(partOfSpeech: String, meanings: [String]) {
        self.partOfSpeech = partOfSpeech; self.meanings = meanings
    }
}

public struct WordEntry: Sendable, Equatable {
    public let headword: String
    public let phonetic: String?
    public let senses: [WordSense]
    /// The selected spelling, including a verified inflected form when it differs from the headword.
    public let query: String
    public init(headword: String, phonetic: String? = nil, senses: [WordSense], query: String? = nil) {
        self.headword = headword; self.phonetic = phonetic; self.senses = senses; self.query = query ?? headword
    }
}

public protocol WordLookupProviding: Sendable {
    func entry(for word: String) async throws -> WordEntry?
}

/// Selection-only English dictionary. It never opens a UI, sends a request, or
/// enters the serial Apple/GPT translation queues. Missing resources are a miss,
/// so the caller can keep its existing sentence translation unchanged.
public actor WordLookupEngine {
    private struct Cached { let value: WordEntry?; let expires: Date? }
    private let provider: any WordLookupProviding
    private let capacity: Int
    private let negativeTTL: TimeInterval
    private let now: @Sendable () -> Date
    private var cache: [String: Cached] = [:]
    private var order: [String] = []
    private var pending: [String: (UUID, Task<WordEntry?, Never>)] = [:]
    private var generation: UInt64 = 0

    public init(databaseURL: URL? = nil) {
        provider = SQLiteWordLookupProvider(databaseURL: databaseURL ?? Self.bundledDatabaseURL)
        capacity = 256; negativeTTL = 30; now = { Date() }
    }

    public init(provider: any WordLookupProviding, cacheCapacity: Int = 256,
                negativeCacheSeconds: TimeInterval = 30, now: @escaping @Sendable () -> Date = { Date() }) {
        self.provider = provider; capacity = min(1_024, max(0, cacheCapacity))
        negativeTTL = min(300, max(0, negativeCacheSeconds)); self.now = now
    }

    public func lookup(_ text: String) async -> WordEntry? {
        guard !Task.isCancelled, let word = Self.normalizedWord(text) else { return nil }
        if let cached = cache[word] {
            if cached.expires.map({ $0 > now() }) ?? true { touch(word); return cached.value.map { WordEntry(headword: $0.headword, phonetic: $0.phonetic, senses: $0.senses, query: word) } }
            cache.removeValue(forKey: word); order.removeAll { $0 == word }
        }
        let job: (UUID, Task<WordEntry?, Never>)
        if let existing = pending[word] { job = existing }
        else {
            let provider = provider
            job = (UUID(), Task { try? await provider.entry(for: word) })
            pending[word] = job
        }
        let currentGeneration = generation
        let value = await job.1.value
        if pending[word]?.0 == job.0 {
            pending.removeValue(forKey: word)
            if currentGeneration == generation { remember(value, for: word) }
        }
        guard !Task.isCancelled else { return nil }
        return value.map { WordEntry(headword: $0.headword, phonetic: $0.phonetic, senses: $0.senses, query: word) }
    }

    public func clearCache() {
        generation &+= 1; cache.removeAll(); order.removeAll(); pending.removeAll()
    }

    private func touch(_ word: String) { order.removeAll { $0 == word }; order.append(word) }
    private func remember(_ value: WordEntry?, for word: String) {
        guard capacity > 0, value != nil || negativeTTL > 0 else { return }
        cache[word] = Cached(value: value, expires: value == nil ? now().addingTimeInterval(negativeTTL) : nil)
        touch(word)
        while order.count > capacity { cache.removeValue(forKey: order.removeFirst()) }
    }

    private nonisolated static var bundledDatabaseURL: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("Dictionary/words.sqlite", isDirectory: false)
    }

    /// Preserve case for US/us and exact acronyms. Unicode quotation marks and
    /// outer punctuation are trimmed; internal hyphens/apostrophes are retained.
    /// Gene/accession numbers and multiword passages use the existing translator.
    public nonisolated static func normalizedWord(_ text: String) -> String? {
        guard text.utf8.count <= 512 else { return nil }
        var word = text.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        guard !word.isEmpty else { return nil }
        let punctuation = CharacterSet.punctuationCharacters
        while let first = word.unicodeScalars.first, punctuation.contains(first) { word.removeFirst() }
        // Keep the terminal dot in an abbreviation such as U.S. or e.g.
        while let last = word.unicodeScalars.last, punctuation.contains(last) {
            let abbreviationDot = last.value == 46 && word.dropLast().contains(".")
            if abbreviationDot { break }
            word.removeLast()
        }
        word = word.replacingOccurrences(of: "’", with: "'")
            .replacingOccurrences(of: "‐", with: "-").replacingOccurrences(of: "‑", with: "-")
        guard !word.isEmpty, word.count <= 96 else { return nil }
        var previousLetter = false, hasLetter = false, hasDot = false
        for (index, scalar) in word.unicodeScalars.enumerated() {
            let letter = (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
                || ((0x00C0...0x024F).contains(scalar.value) || (0x0370...0x03FF).contains(scalar.value)) && CharacterSet.letters.contains(scalar)
            if letter { previousLetter = true; hasLetter = true; continue }
            guard [39, 45, 46].contains(scalar.value), previousLetter else { return nil }
            if scalar.value == 46 { hasDot = true }
            previousLetter = false
            if index == word.unicodeScalars.count - 1 && scalar.value != 46 { return nil }
        }
        guard hasLetter, previousLetter || hasDot else { return nil }
        return word
    }
}

/// SQLite is opened lazily on this actor's executor, never on MainActor. The
/// shipped database is immutable; exact parameterized lookups do not create WAL,
/// journal, preferences, history, or user dictionary files.
public actor SQLiteWordLookupProvider: WordLookupProviding {
    private let databaseURL: URL?
    private var database: OpaquePointer?
    private var openingFailed = false
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    public init(databaseURL: URL?) { self.databaseURL = databaseURL }
    deinit { if let database { sqlite3_close(database) } }

    public func entry(for word: String) async throws -> WordEntry? {
        guard !Task.isCancelled, let database = open() else { return nil }
        if let direct = try find(word, in: database, exact: true) { return direct }
        // Do not turn an unknown all-capital acronym into an unrelated common
        // word (US -> us, AIDS -> aids). Exact dictionary entries remain valid.
        let letters = word.unicodeScalars.filter { CharacterSet.letters.contains($0) }
        let acronym = letters.count > 1 && word == word.uppercased() && word != word.lowercased()
        guard !acronym else { return nil }
        if let folded = try find(word, in: database, exact: false) { return folded }
        let candidates = try rows("SELECT headword FROM forms WHERE form = ? COLLATE NOCASE ORDER BY headword LIMIT 2", word: word, in: database)
        // A spelling can be a valid form of two different words. Do not pick
        // one by frequency or suffix guessing; a normal translation can handle it.
        guard candidates.count == 1, let headword = candidates.first?.first else { return nil }
        return try find(headword, in: database, exact: true)
    }

    private func open() -> OpaquePointer? {
        if let database { return database }
        guard !openingFailed, let databaseURL, databaseURL.isFileURL else { return nil }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(databaseURL.path, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK,
              let handle else { if let handle { sqlite3_close(handle) }; openingFailed = true; return nil }
        sqlite3_busy_timeout(handle, 30)
        sqlite3_limit(handle, SQLITE_LIMIT_LENGTH, 131_072)
        sqlite3_limit(handle, SQLITE_LIMIT_SQL_LENGTH, 4_096)
        guard scalar("PRAGMA application_id", in: handle) == 0x41574C44,
              scalar("PRAGMA user_version", in: handle) == 1 else {
            sqlite3_close(handle); openingFailed = true; return nil
        }
        database = handle; return handle
    }

    private func scalar(_ sql: String, in database: OpaquePointer) -> Int32? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else { return nil }
        defer { sqlite3_finalize(statement) }
        return sqlite3_step(statement) == SQLITE_ROW ? sqlite3_column_int(statement, 0) : nil
    }

    private func find(_ word: String, in database: OpaquePointer, exact: Bool) throws -> WordEntry? {
        let values = try rows("SELECT word, phonetic, translation FROM entries WHERE word = ? COLLATE " + (exact ? "BINARY" : "NOCASE") + " ORDER BY word LIMIT 2", word: word, in: database)
        guard values.count == 1, let row = values.first, row.count == 3 else { return nil }
        let senses = Self.senses(from: row[2]); guard !senses.isEmpty else { return nil }
        return WordEntry(headword: row[0], phonetic: row[1].isEmpty ? nil : row[1], senses: senses)
    }

    private func rows(_ sql: String, word: String, in database: OpaquePointer) throws -> [[String]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw LookupFailure.invalidDatabase }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_bind_text(statement, 1, word, -1, transient) == SQLITE_OK else { throw LookupFailure.invalidDatabase }
        var result: [[String]] = []
        while true {
            let state = sqlite3_step(statement)
            if state == SQLITE_DONE { return result }
            guard state == SQLITE_ROW else { throw LookupFailure.invalidDatabase }
            var row: [String] = []
            for index in 0..<sqlite3_column_count(statement) {
                guard let bytes = sqlite3_column_text(statement, index) else { row.append(""); continue }
                row.append(String(cString: bytes))
            }
            result.append(row)
            if result.count > 2 { throw LookupFailure.invalidDatabase }
        }
    }

    /// Only explicit labels from the source dictionary are assigned to a sense.
    /// Corpus POS percentages cannot safely identify the POS of an unlabeled
    /// Chinese definition, so those definitions deliberately have an empty label.
    nonisolated static func senses(from translation: String) -> [WordSense] {
        let aliases = ["n.": "n.", "v.": "v.", "vt.": "vt.", "vi.": "vi.", "v.t.": "vt.", "v.i.": "vi.",
                       "a.": "adj.", "adj.": "adj.", "ad.": "adv.", "adv.": "adv.", "prep.": "prep.",
                       "pron.": "pron.", "conj.": "conj.", "int.": "interj.", "interj.": "interj.",
                       "num.": "num.", "art.": "art.", "aux.": "aux.", "abbr.": "abbr.", "det.": "det.",
                       "pl.": "pl.", "vbl.": "vbl.", "pref.": "pref.", "suff.": "suff."]
        var order: [String] = [], grouped: [String: [String]] = [:]
        for raw in translation.replacingOccurrences(of: "\\n", with: "\n").split(whereSeparator: \.isNewline) {
            var meaning = raw.trimmingCharacters(in: .whitespacesAndNewlines), labels: [String] = []
            guard !meaning.isEmpty else { continue }
            while true {
                let lower = meaning.lowercased()
                guard let label = aliases.keys.sorted(by: { $0.count > $1.count }).first(where: { lower.hasPrefix($0) }) else { break }
                labels.append(aliases[label]!)
                meaning = String(meaning.dropFirst(label.count)).trimmingCharacters(in: .whitespaces)
                if let separator = meaning.first, "&/,".contains(separator) { meaning.removeFirst(); meaning = meaning.trimmingCharacters(in: .whitespaces) }
            }
            guard !meaning.isEmpty else { continue }
            let pos = labels.joined(separator: " / ")
            if grouped[pos] == nil { order.append(pos); grouped[pos] = [] }
            let meanings = meaning.components(separatedBy: CharacterSet(charactersIn: ";；")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            for value in meanings where !grouped[pos]!.contains(value) { grouped[pos]!.append(value) }
        }
        return order.compactMap { key in guard let meanings = grouped[key], !meanings.isEmpty else { return nil }; return WordSense(partOfSpeech: key, meanings: meanings) }
    }

    private enum LookupFailure: Error { case invalidDatabase }
}

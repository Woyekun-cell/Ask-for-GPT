import Foundation
import SQLite3
import Testing
@testable import AskGPTCore

struct WordLookupEngineTests {
    @Test func wholeWordBoundaryTrimsOnlyOuterPunctuationAndPreservesScientificSpelling() {
        for (text, expected) in [("  “tables,”  ", "tables"), ("(record)", "record"), ("Don't", "Don't"),
                                 ("DNA", "DNA"), ("long-read", "long-read"), ("β-glucan", "β-glucan"),
                                 ("well‑known", "well-known"), ("U.S.", "U.S."), ("e.g.", "e.g."),
                                 ("résumé.", "résumé")] {
            #expect(WordLookupEngine.normalizedWord(text) == expected)
        }
        for text in ["", "   ", "two words", "two  words", "hello\nworld", "results. Discussion", "123", "12.5",
                     "IL6", "PaEprs1a", "H2O", "中文", "a/b", "x+y", "a--b", "one…two", String(repeating: "a", count: 97)] {
            #expect(WordLookupEngine.normalizedWord(text) == nil)
        }
    }

    @Test func explicitDictionaryPOSAndMultipleSensesAreGroupedWithoutInferringUnlabeledPOS() {
        let senses = SQLiteWordLookupProvider.senses(from: "n. 表；表格\\nvt. 制表；搁置\\nn. 一览表\\n[计] 数据表\\na. & n. 复合词义")
        #expect(senses == [WordSense(partOfSpeech: "n.", meanings: ["表", "表格", "一览表"]),
                           WordSense(partOfSpeech: "vt.", meanings: ["制表", "搁置"]),
                           WordSense(partOfSpeech: "", meanings: ["[计] 数据表"]),
                           WordSense(partOfSpeech: "adj. / n.", meanings: ["复合词义"])])
    }

    @Test func exactReadOnlyLookupKeepsAllRealSensesAndNeverCreatesHistoryOrJournals() async throws {
        let fixture = try WordDatabaseFixture(); defer { fixture.remove() }
        let before = try Data(contentsOf: fixture.url)
        let engine = WordLookupEngine(databaseURL: fixture.url)
        let entry = await engine.lookup("“table,”")
        #expect(entry?.headword == "table" && entry?.phonetic == "ˈteɪbəl")
        #expect(entry?.query == "table")
        #expect(entry?.senses == [WordSense(partOfSpeech: "n.", meanings: ["表", "表格", "桌子"]), WordSense(partOfSpeech: "vt.", meanings: ["制表", "搁置"])])
        #expect(try Data(contentsOf: fixture.url) == before)
        #expect(try FileManager.default.contentsOfDirectory(atPath: fixture.directory.path).sorted() == ["words.sqlite"])
    }

    @Test func inflectedFormsUseOnlyVerifiedExchangeAliasesAndKeepTheOriginalSelectionOnCacheHits() async throws {
        let fixture = try WordDatabaseFixture(); defer { fixture.remove() }
        let engine = WordLookupEngine(databaseURL: fixture.url)
        for (query, headword) in [("tables", "table"), ("went", "go"), ("genes", "gene")] {
            let first = await engine.lookup(query), cached = await engine.lookup(query)
            #expect(first?.headword == headword && first?.query == query)
            #expect(cached == first)
        }
        #expect(await engine.lookup("fabricateds") == nil, "suffixes must not be stripped heuristically")
        #expect(await engine.lookup("ambiguous") == nil, "two possible lemmas must not be guessed")
    }

    @Test func directMeaningsTakePriorityOverAnAmbiguousInflectionAndAcronymsStayDistinct() async throws {
        let fixture = try WordDatabaseFixture(); defer { fixture.remove() }
        let engine = WordLookupEngine(databaseURL: fixture.url)
        #expect(await engine.lookup("saw")?.headword == "saw")
        #expect(await engine.lookup("DNA")?.headword == "DNA")
        #expect(await engine.lookup("US") == nil, "unknown US must not silently become the pronoun us")
        #expect(await engine.lookup("us")?.headword == "us")
        #expect(await engine.lookup("Table")?.headword == "table")
        #expect(await engine.lookup("long-read")?.headword == "long-read")
        #expect(await engine.lookup("longread") == nil, "a hyphen cannot be dropped as fuzzy matching")
    }

    @Test func invalidPassagesNeverCallTheWordProvider() async {
        let provider = FixtureWordProvider(), engine = WordLookupEngine(provider: provider)
        for input in ["two words", "123", "IL6", "中文"] { #expect(await engine.lookup(input) == nil) }
        #expect(await provider.queries.isEmpty)
    }

    @Test func sameWordConcurrentRequestsShareOneLookupAndPositiveCache() async {
        let provider = FixtureWordProvider(delayNanoseconds: 30_000_000), engine = WordLookupEngine(provider: provider)
        async let first = engine.lookup("table")
        async let second = engine.lookup("table")
        let values = await [first, second]
        #expect(values[0] == values[1] && values[0]?.headword == "table")
        #expect(await provider.queries == ["table"])
        #expect(await engine.lookup("table") == values[0])
        #expect(await provider.queries.count == 1)
    }

    @Test func boundedLRUAndNegativeCacheAvoidRepeatedMissesButExpire() async {
        let clock = WordFixtureClock(), provider = FixtureWordProvider()
        let engine = WordLookupEngine(provider: provider, cacheCapacity: 2, negativeCacheSeconds: 5, now: { clock.now })
        #expect(await engine.lookup("missing") == nil)
        #expect(await engine.lookup("missing") == nil)
        #expect(await provider.queries == ["missing"])
        clock.advance(6)
        #expect(await engine.lookup("missing") == nil)
        #expect(await provider.queries == ["missing", "missing"])
        _ = await engine.lookup("table"); _ = await engine.lookup("gene")
        _ = await engine.lookup("missing")
        #expect(await provider.queries.count == 5)
        await engine.clearCache(); _ = await engine.lookup("table")
        #expect(await provider.queries.count == 6)
    }

    @Test func missingCorruptOrForeignDatabaseIsASafeMissAndDoesNotCreateAFile() async throws {
        let fixture = try WordDatabaseFixture(); defer { fixture.remove() }
        let absent = fixture.directory.appendingPathComponent("absent.sqlite")
        #expect(await WordLookupEngine(databaseURL: absent).lookup("table") == nil)
        #expect(!FileManager.default.fileExists(atPath: absent.path))
        let corrupt = fixture.directory.appendingPathComponent("corrupt.sqlite")
        try Data("not a database".utf8).write(to: corrupt)
        #expect(await WordLookupEngine(databaseURL: corrupt).lookup("table") == nil)
        let foreign = fixture.directory.appendingPathComponent("foreign.sqlite")
        var handle: OpaquePointer?; #expect(sqlite3_open(foreign.path, &handle) == SQLITE_OK); sqlite3_close(handle)
        #expect(await WordLookupEngine(databaseURL: foreign).lookup("table") == nil)
    }

    @Test func coldSQLiteLookupRunsOffTheMainActor() async throws {
        let fixture = try WordDatabaseFixture(); defer { fixture.remove() }
        let provider = ThreadCheckedWordProvider(base: SQLiteWordLookupProvider(databaseURL: fixture.url))
        let engine = WordLookupEngine(provider: provider)
        let entry = await Task { @MainActor in await engine.lookup("gene") }.value
        #expect(entry?.headword == "gene")
        #expect(await provider.wasOffMainThread)
    }

    @Test func shippedPinnedDictionaryCoversCommonScientificAndHyphenatedWords() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("Resources/Dictionary/words.sqlite")
        #expect(FileManager.default.fileExists(atPath: url.path), "the distributable dictionary must be present, not just test fixtures")
        let engine = WordLookupEngine(databaseURL: url)
        for word in ["table", "record", "gene", "genome", "protein", "transcription", "sequencing", "glucan", "long-term"] {
            let entry = await engine.lookup(word)
            #expect(entry != nil, "the complete packaged dictionary must cover \(word)")
            #expect(entry?.senses.contains(where: { !$0.meanings.isEmpty }) == true)
        }
        #expect(await engine.lookup("table")?.senses.count ?? 0 >= 2)
    }
}

private actor FixtureWordProvider: WordLookupProviding {
    var queries: [String] = []
    let delayNanoseconds: UInt64
    init(delayNanoseconds: UInt64 = 0) { self.delayNanoseconds = delayNanoseconds }
    func entry(for word: String) async throws -> WordEntry? {
        queries.append(word)
        if delayNanoseconds > 0 { try await Task.sleep(nanoseconds: delayNanoseconds) }
        guard word != "missing" else { return nil }
        return WordEntry(headword: word, senses: [.init(partOfSpeech: "n.", meanings: ["fixture"])])
    }
}

private final class WordFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_000)
    var now: Date { lock.lock(); defer { lock.unlock() }; return date }
    func advance(_ seconds: TimeInterval) { lock.lock(); date = date.addingTimeInterval(seconds); lock.unlock() }
}

private actor ThreadCheckedWordProvider: WordLookupProviding {
    let base: SQLiteWordLookupProvider
    var wasOffMainThread = false
    init(base: SQLiteWordLookupProvider) { self.base = base }
    func entry(for word: String) async throws -> WordEntry? { wasOffMainThread = !Thread.isMainThread; return try await base.entry(for: word) }
}

private struct WordDatabaseFixture {
    let directory: URL
    var url: URL { directory.appendingPathComponent("words.sqlite") }
    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("askgpt-word-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var database: OpaquePointer?
        guard sqlite3_open(url.path, &database) == SQLITE_OK, let database else { throw FixtureFailure.database }
        defer { sqlite3_close(database) }
        let sql = """
            PRAGMA application_id=0x41574C44; PRAGMA user_version=1;
            CREATE TABLE entries(word TEXT PRIMARY KEY COLLATE BINARY,phonetic TEXT,translation TEXT,pos TEXT) WITHOUT ROWID;
            CREATE INDEX entries_casefold ON entries(word COLLATE NOCASE);
            CREATE TABLE forms(form TEXT COLLATE NOCASE,headword TEXT,PRIMARY KEY(form,headword)) WITHOUT ROWID;
            INSERT INTO entries VALUES('table','ˈteɪbəl','n. 表；表格；桌子\nvt. 制表；搁置','n:60/v:40');
            INSERT INTO entries VALUES('go','','vi. 去；走','');
            INSERT INTO entries VALUES('gene','','n. 基因','n:100');
            INSERT INTO entries VALUES('DNA','','n. 脱氧核糖核酸','');
            INSERT INTO entries VALUES('us','','pron. 我们','');
            INSERT INTO entries VALUES('saw','','n. 锯子','');
            INSERT INTO entries VALUES('see','','v. 看见','');
            INSERT INTO entries VALUES('long-read','','adj. 长读长的','');
            INSERT INTO forms VALUES('tables','table'),('went','go'),('genes','gene'),('ambiguous','go'),('ambiguous','see'),('saw','see');
            """
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw FixtureFailure.database }
    }
    func remove() { try? FileManager.default.removeItem(at: directory) }
    private enum FixtureFailure: Error { case database }
}

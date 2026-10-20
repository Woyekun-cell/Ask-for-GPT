import CoreGraphics
import Foundation
import Testing
@testable import AskGPTCore

struct NativePDFTranslationStoreTests {
    @Test func twoDocumentsKeepIndependentJobsWhenTheSecondStartsAndTheFirstFinishesLater() async throws {
        let first = try NativePDFFixture(pages: 2), second = try NativePDFFixture(pages: 2)
        defer { first.remove(); second.remove() }
        let mock = NativePDFConcurrentService(output: try nativePDF(pages: 1))
        let store = NativePDFTranslationStore(service: mock, directory: first.cache, pollingNanoseconds: 0)
        let firstTask = Task { try await store.translate(first.request(scope: .page(0))) }
        await mock.waitForStatus("job-1")
        let secondTask = Task { try await store.translate(second.request(scope: .page(1))) }
        await mock.waitForStatus("job-2")
        #expect(await mock.cancelled.isEmpty)
        await mock.finish("job-2")
        let secondResult = try await secondTask.value
        await mock.finish("job-1")
        let firstResult = try await firstTask.value
        #expect(firstResult.originalURL == first.original)
        #expect(secondResult.originalURL == second.original)
        #expect(firstResult.sourcePages == [0])
        #expect(secondResult.sourcePages == [1])
        let firstOutput = try await store.output(firstResult, mode: .dual)
        let secondOutput = try await store.output(secondResult, mode: .dual)
        #expect(firstOutput != secondOutput)
        #expect(await store.latestResult(applicationBundleID: "com.apple.Preview", originalURL: first.original) == firstResult)
        #expect(await store.latestResult(applicationBundleID: "com.apple.Preview", originalURL: second.original) == secondResult)
        #expect(await mock.cancelled.isEmpty)
    }

    @Test func cancellingOneDocumentDoesNotRetireAnotherDocumentsJobOrOutput() async throws {
        let first = try NativePDFFixture(pages: 2), second = try NativePDFFixture(pages: 2)
        defer { first.remove(); second.remove() }
        let mock = NativePDFConcurrentService(output: try nativePDF(pages: 1))
        let store = NativePDFTranslationStore(service: mock, directory: first.cache, pollingNanoseconds: 0)
        let firstID = UUID(), secondID = UUID()
        let firstTask = Task { try await store.translate(first.request(scope: .page(0)), operationID: firstID) }
        await mock.waitForStatus("job-1")
        let secondTask = Task { try await store.translate(second.request(scope: .page(1)), operationID: secondID) }
        await mock.waitForStatus("job-2")
        await store.cancel(operationID: firstID)
        #expect(await mock.cancelled == ["job-1"])
        await mock.finish("job-1")
        await #expect(throws: CancellationError.self) { try await firstTask.value }
        await mock.finish("job-2")
        let result = try await secondTask.value
        #expect(result.originalURL == second.original)
        #expect(FileManager.default.fileExists(atPath: result.outputURL(mode: .mono).path))
        #expect(await mock.cancelled == ["job-1"])
    }
    @Test func completedJobDoesNotReplaceAnotherDocumentInTheSameReaderOrStealAnotherAppsFocus() {
        let original = URL(fileURLWithPath: "/tmp/Original.pdf")
        let other = URL(fileURLWithPath: "/tmp/Other.pdf")
        #expect(NativePDFPresentationPolicy.mayPresent(sourcePID: 10, foregroundPID: 10, ownPID: 20,
            expectedDocument: original, observedDocument: original))
        #expect(NativePDFPresentationPolicy.mayPresent(sourcePID: 10, foregroundPID: 20, ownPID: 20,
            expectedDocument: original, observedDocument: original))
        #expect(!NativePDFPresentationPolicy.mayPresent(sourcePID: 10, foregroundPID: 10, ownPID: 20,
            expectedDocument: original, observedDocument: other))
        #expect(!NativePDFPresentationPolicy.mayPresent(sourcePID: 10, foregroundPID: 30, ownPID: 20,
            expectedDocument: original, observedDocument: original))
        #expect(!NativePDFPresentationPolicy.mayPresent(sourcePID: 10, foregroundPID: 10, ownPID: 20,
            expectedDocument: original, observedDocument: nil))
    }
    @Test func shortcutIsObservedOnlyInPreviewOrWPSAndDoesNotOwnOtherReaderCommands() {
        let optionShift: UInt = (1 << 17) | (1 << 19)
        for bundleID in ["com.apple.Preview", "com.kingsoft.wpsoffice.mac"] {
            #expect(NativePDFReaderPolicy.matchesShortcut(bundleID: bundleID, keyCode: 7, modifiers: optionShift))
            #expect(!NativePDFReaderPolicy.matchesShortcut(bundleID: bundleID, keyCode: 7, modifiers: optionShift | (1 << 20)))
            #expect(!NativePDFReaderPolicy.matchesShortcut(bundleID: bundleID, keyCode: 2, modifiers: optionShift))
        }
        for bundleID in ["com.google.Chrome", "org.zotero.zotero", "com.microsoft.Word", "com.apple.Terminal"] {
            #expect(!NativePDFReaderPolicy.matchesShortcut(bundleID: bundleID, keyCode: 7, modifiers: optionShift))
        }
    }

    @Test func currentPageCreatesPrivateCopyAndSwitchingModeReusesJobWithoutChangingSource() async throws {
        let fixture = try NativePDFFixture(pages: 3)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 3, output: try nativePDF(pages: 1))
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache, pollingNanoseconds: 0)
        let result = try await store.translate(fixture.request(scope: .page(2)))
        #expect(result.sourcePages == [2])
        #expect(result.originalURL == fixture.original)
        #expect(result.applicationBundleID == "com.apple.Preview")
        #expect(try Data(contentsOf: fixture.original) == fixture.data)
        let mono = try await store.output(result, mode: .mono)
        #expect(mono != fixture.original)
        #expect(try permissions(mono) == 0o600)
        #expect(try permissions(result.directoryURL) == 0o700)
        let dual = try await store.output(result, mode: .dual)
        #expect(dual != mono)
        #expect(try await store.output(result, mode: .dual) == dual)
        #expect(await mock.requests.count == 1)
        #expect(await mock.requests.first?.pages == [2])
        #expect(await mock.outputs == [.mono, .dual])
        #expect(await store.result(forOutputURL: mono) == result)
        #expect(await store.result(forOutputURL: fixture.original) == nil)
        #expect(try Data(contentsOf: fixture.original) == fixture.data)
        // Original restoration still resolves after restarting the app.
        let reopened = NativePDFTranslationStore(service: mock, directory: fixture.cache)
        let reloaded = try #require(await reopened.result(forOutputURL: mono))
        #expect(reloaded.originalURL == fixture.original)
        #expect(try await reopened.output(reloaded, mode: .dual) == dual)
        #expect(await mock.outputs == [.mono, .dual])
        #expect(await reopened.latestResult(applicationBundleID: "com.apple.Preview") == reloaded)
        #expect(await reopened.latestResult(applicationBundleID: "com.kingsoft.wpsoffice.mac") == nil)
    }

    @Test func wholeDocumentAndReverseLanguageArePassedExplicitly() async throws {
        let fixture = try NativePDFFixture(pages: 2)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 2, output: fixture.data)
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache, pollingNanoseconds: 0)
        let result = try await store.translate(.init(sourceURL: fixture.original,
            applicationURL: fixture.app, applicationBundleID: "com.kingsoft.wpsoffice.mac", scope: .wholeDocument,
            sourceLanguage: "zh-Hans", targetLanguage: "en"), mode: .dual)
        #expect(result.sourcePages == [0, 1])
        #expect(await mock.requests.first?.pages == nil)
        #expect(await mock.requests.first?.source == "zh-Hans")
        #expect(await mock.requests.first?.target == "en")
        #expect(await mock.outputs == [.dual, .mono])
    }

    @Test func outOfRangePageFailsBeforeSubmittingAndNeverGuessesFirstPage() async throws {
        let fixture = try NativePDFFixture(pages: 2)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 2, output: fixture.data)
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache)
        await #expect(throws: PDFTranslationDocumentError.pageOutOfBounds(index: 2, count: 2)) {
            try await store.translate(fixture.request(scope: .page(2)))
        }
        #expect(await mock.requests.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: fixture.cache.path))
    }

    @Test func wrongServicePageMapIsRejectedAndCancelledWithoutWritingOutput() async throws {
        let fixture = try NativePDFFixture(pages: 3)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 3, output: try nativePDF(pages: 1), overridePages: [0])
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache)
        await #expect(throws: NativePDFTranslationError.invalidOutput) {
            try await store.translate(fixture.request(scope: .page(2)))
        }
        #expect(await mock.cancelled == ["job-1"])
        #expect(await mock.outputs.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: fixture.cache.path))
    }

    @Test func outputWithWrongPageCountDoesNotOpenOrPersistAsSuccessfulTranslation() async throws {
        let fixture = try NativePDFFixture(pages: 3)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 3, output: try nativePDF(pages: 1))
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache)
        await #expect(throws: NativePDFTranslationError.invalidOutput) {
            try await store.translate(fixture.request(scope: .wholeDocument))
        }
        #expect(await mock.cancelled == ["job-1"])
        #expect(try Data(contentsOf: fixture.original) == fixture.data)
        #expect(!FileManager.default.fileExists(atPath: fixture.cache.path))
    }

    @Test func cancellationDuringUncooperativeSubmissionCancelsLateJobAndDropsOutput() async throws {
        let fixture = try NativePDFFixture(pages: 2)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 2, output: try nativePDF(pages: 1), suspendCreate: true)
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache)
        let task = Task { try await store.translate(fixture.request(scope: .page(1))) }
        await mock.waitForCreate()
        #expect(await mock.waiting)
        task.cancel()
        await store.cancel()
        await mock.releaseCreate()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(await mock.cancelled == ["job-1"])
        #expect(await mock.outputs.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: fixture.cache.path))
    }

    @Test func boundedCacheRemovesOnlyOwnedOldCopiesAndPreservesAllSourceFiles() async throws {
        let fixture = try NativePDFFixture(pages: 2)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 2, output: try nativePDF(pages: 1))
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache, maximumRecords: 1)
        let first = try await store.translate(fixture.request(scope: .page(0)))
        let foreign = fixture.cache.appendingPathComponent("not-owned")
        try FileManager.default.createDirectory(at: foreign, withIntermediateDirectories: false)
        let marker = foreign.appendingPathComponent("keep.txt")
        try Data("Keep".utf8).write(to: marker)
        let second = try await store.translate(fixture.request(scope: .page(1)))
        #expect(!FileManager.default.fileExists(atPath: first.directoryURL.path))
        #expect(FileManager.default.fileExists(atPath: second.outputURL(mode: .mono).path))
        #expect(FileManager.default.fileExists(atPath: marker.path))
        #expect(await store.result(forOutputURL: first.outputURL(mode: .mono)) == nil)
        #expect(try Data(contentsOf: fixture.original) == fixture.data)
    }

    @Test func unsupportedReadersAndSameLanguageNeverReachWorker() async throws {
        let fixture = try NativePDFFixture(pages: 1)
        defer { fixture.remove() }
        let mock = NativePDFMockService(pageCount: 1, output: fixture.data)
        let store = NativePDFTranslationStore(service: mock, directory: fixture.cache)
        await #expect(throws: NativePDFTranslationError.unsupportedReader) {
            try await store.translate(.init(sourceURL: fixture.original, applicationURL: fixture.app,
                applicationBundleID: "com.google.Chrome", scope: .page(0)))
        }
        await #expect(throws: PDFLayoutServiceError.invalidInput) {
            try await store.translate(.init(sourceURL: fixture.original, applicationURL: fixture.app,
                applicationBundleID: "com.apple.Preview", scope: .page(0), sourceLanguage: "en", targetLanguage: "en"))
        }
        #expect(await mock.requests.isEmpty)
    }
}

private struct NativePDFFixture {
    let directory: URL
    let original: URL
    let cache: URL
    let data: Data
    let app = URL(fileURLWithPath: "/System/Applications/Preview.app", isDirectory: true)
    init(pages: Int) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-pdf-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        original = directory.appendingPathComponent("Original.pdf")
        cache = directory.appendingPathComponent("copies", isDirectory: true)
        data = try nativePDF(pages: pages)
        try data.write(to: original)
    }
    func request(scope: NativePDFTranslationScope) -> NativePDFTranslationRequest {
        .init(sourceURL: original, applicationURL: app, applicationBundleID: "com.apple.Preview", scope: scope)
    }
    func remove() { try? FileManager.default.removeItem(at: directory) }
}

private func nativePDF(pages: Int) throws -> Data {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 300, height: 400)
    guard let consumer = CGDataConsumer(data: data), let context = CGContext(consumer: consumer, mediaBox: &box, nil) else {
        throw NativePDFTranslationError.invalidOutput
    }
    for _ in 0..<pages {
        context.beginPDFPage(nil)
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 20, y: 20, width: 100, height: 100))
        context.endPDFPage()
    }
    context.closePDF()
    return data as Data
}

private func permissions(_ url: URL) throws -> Int {
    try (FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
}

private actor NativePDFMockService: PDFLayoutServing {
    struct Request: Sendable { let pages: [Int]?; let source: String; let target: String }
    let pageCount: Int
    let outputData: Data
    let overridePages: [Int]?
    let suspendCreate: Bool
    var requests: [Request] = []
    var outputs: [PDFLayoutOutputMode] = []
    var cancelled: [String] = []
    var waiting = false
    var continuation: CheckedContinuation<Void, Never>?
    var started: CheckedContinuation<Void, Never>?
    init(pageCount: Int, output: Data, overridePages: [Int]? = nil, suspendCreate: Bool = false) {
        self.pageCount = pageCount; outputData = output; self.overridePages = overridePages; self.suspendCreate = suspendCreate
    }
    func createJob(data: Data, pages: [Int]?, source: String, target: String) async throws -> PDFLayoutJob {
        requests.append(.init(pages: pages, source: source, target: target))
        let number = requests.count
        if suspendCreate {
            await withCheckedContinuation { continuation = $0; waiting = true; started?.resume(); started = nil }
        }
        return .init(id: "job-\(number)", state: .complete, sourcePages: overridePages ?? pages ?? Array(0..<pageCount), pageCount: pageCount)
    }
    func releaseCreate() { continuation?.resume(); continuation = nil }
    func waitForCreate() async {
        guard !waiting else { return }
        await withCheckedContinuation { started = $0 }
    }
    func status(id: String) async throws -> PDFLayoutJob { throw PDFLayoutServiceError.invalidResponse }
    func output(id: String, mode: PDFLayoutOutputMode) async throws -> Data { outputs.append(mode); return outputData }
    func cancel(id: String) async { cancelled.append(id) }
}

private actor NativePDFConcurrentService: PDFLayoutServing {
    let outputData: Data
    var jobs: [String: PDFLayoutJob] = [:]
    var statusContinuations: [String: CheckedContinuation<PDFLayoutJob, Never>] = [:]
    var statusWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    var cancelled: [String] = []
    init(output: Data) { outputData = output }
    func createJob(data: Data, pages: [Int]?, source: String, target: String) async throws -> PDFLayoutJob {
        let job = PDFLayoutJob(id: "job-\(jobs.count + 1)", state: .running,
            sourcePages: pages ?? [0, 1], pageCount: 2)
        jobs[job.id] = job
        return job
    }
    func status(id: String) async throws -> PDFLayoutJob {
        await withCheckedContinuation {
            statusContinuations[id] = $0
            statusWaiters.removeValue(forKey: id)?.resume()
        }
    }
    func waitForStatus(_ id: String) async {
        guard statusContinuations[id] == nil else { return }
        await withCheckedContinuation { statusWaiters[id] = $0 }
    }
    func finish(_ id: String) {
        guard let job = jobs[id] else { return }
        statusContinuations.removeValue(forKey: id)?.resume(returning: .init(id: id, state: .complete,
            sourcePages: job.sourcePages, pageCount: job.pageCount))
    }
    func output(id: String, mode: PDFLayoutOutputMode) async throws -> Data { outputData }
    func cancel(id: String) async { cancelled.append(id) }
}

import Foundation
import Testing
@testable import AskGPTCore

struct NativeTranslationEngineTests {
    @Test func successfulTranslationIsCachedAndPreservesExactInput() async throws {
        let driver = FixtureNativeDriver(outputs: [.text("译文")])
        let engine = NativeTranslationEngine(driver: driver)
        let original = "  Alpha-742\nβ = 2.0 µm\n"
        let first = try await engine.translate(original)
        let second = try await engine.translate(original)
        #expect(first.text == "译文")
        #expect(!first.fromCache)
        #expect(second.text == first.text)
        #expect(second.fromCache)
        #expect(first.elapsedSeconds >= 0)
        let calls = await driver.calls
        #expect(calls.count == 1)
        #expect(calls.first?.text == original)
    }

    @Test func cacheKeysIncludeDestinationLanguage() async throws {
        let driver = FixtureNativeDriver()
        let engine = NativeTranslationEngine(driver: driver)
        _ = try await engine.translate("hello", targetLanguage: "zh-Hans")
        _ = try await engine.translate("hello", targetLanguage: "fr")
        #expect(await driver.calls.count == 2)
    }

    @Test func explicitSourceOverridesUncertainScientificTokenDetection() async throws {
        let driver = FixtureNativeDriver(outputs: [.text("葡聚糖")])
        let engine = NativeTranslationEngine(driver: driver, sourceDetector: { _ in "hr" })
        let result = try await engine.translate("β-glucan", sourceLanguage: "en")
        #expect(result.sourceLanguage == "en")
        #expect(result.text == "葡聚糖")
        #expect(await driver.calls.first?.source == "en")
    }

    @Test func cacheSeparatesAutomaticAndExplicitSourceSelections() async throws {
        let driver = FixtureNativeDriver(outputs: [.text("automatic"), .text("English"), .text("French")])
        let engine = NativeTranslationEngine(driver: driver, sourceDetector: { _ in "en" })
        #expect(try await engine.translate("same text").text == "automatic")
        #expect(try await engine.translate("same text", sourceLanguage: "en").text == "English")
        #expect(try await engine.translate("same text", sourceLanguage: "fr").text == "French")
        #expect(try await engine.translate("same text").fromCache)
        #expect(try await engine.translate("same text", sourceLanguage: "en").text == "English")
        #expect(try await engine.translate("same text", sourceLanguage: "fr").fromCache)
        #expect(await driver.calls.count == 3)
    }

    @Test func explicitSameLanguageBypassesDetectorAndFramework() async throws {
        let driver = FixtureNativeDriver(status: .unavailable)
        let engine = NativeTranslationEngine(driver: driver, sourceDetector: { _ in nil })
        let result = try await engine.translate("原文", sourceLanguage: " zh_Hans ")
        #expect(result.text == "原文")
        #expect(await driver.calls.isEmpty)
        await #expect(throws: NativeTranslationError.unableToIdentifyLanguage) {
            try await engine.translate("原文", sourceLanguage: " \n")
        }
    }

    @Test func languageErrorsIdentifyActualSourceAndDestination() {
        let missing = NativeTranslationError.languagePackMissing(sourceLanguage: "en", targetLanguage: "zh-Hans").localizedDescription
        let unsupported = NativeTranslationError.unsupportedLanguagePair(sourceLanguage: "de", targetLanguage: "zh-Hans").localizedDescription
        #expect(missing.contains("English") && missing.contains("Chinese"))
        #expect(missing.contains("en") && missing.contains("zh-Hans"))
        #expect(unsupported.contains("German") && unsupported.contains("Chinese"))
        #expect(unsupported.contains("de") && unsupported.contains("zh-Hans"))
        #expect(NativeTranslationError.timedOut.localizedDescription.contains("timed out"))
    }

    @Test func installedLowLatencyWinsWithoutQueryingAnotherModel() async {
        let fixture = FixtureStrategyAvailability(lowLatency: .installed, highFidelity: .installed)
        let resolver = NativeTranslationStrategyResolver(strategies: NativeTranslationQuality.fast.preferredStrategies) {
            strategy, _, _ in await fixture.status(strategy)
        }
        let choice = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(choice.strategy == .lowLatency && choice.availability == .installed)
        #expect(await fixture.queries == [.lowLatency])
    }

    @Test func qualityPreferenceChoosesInstalledHighFidelityFirst() async {
        let fixture = FixtureStrategyAvailability(lowLatency: .installed, highFidelity: .installed)
        let resolver = NativeTranslationStrategyResolver(strategies: NativeTranslationQuality.quality.preferredStrategies) {
            strategy, _, _ in await fixture.status(strategy)
        }
        let choice = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(choice.strategy == .highFidelity && choice.availability == .installed)
        #expect(await fixture.queries == [.highFidelity])
    }

    @Test func qualityPreferenceUsesInstalledFastAlternativeWithoutDownloading() async {
        let fixture = FixtureStrategyAvailability(lowLatency: .installed, highFidelity: .supported)
        let resolver = NativeTranslationStrategyResolver(strategies: NativeTranslationQuality.quality.preferredStrategies) {
            strategy, _, _ in await fixture.status(strategy)
        }
        let choice = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(choice.strategy == .lowLatency && choice.availability == .installed)
        #expect(await fixture.queries == [.highFidelity, .lowLatency])
    }

    @Test func qualityPreferenceNeverSelectsAnUninstalledModel() async {
        let fixture = FixtureStrategyAvailability(lowLatency: .supported, highFidelity: .supported)
        let resolver = NativeTranslationStrategyResolver(strategies: NativeTranslationQuality.quality.preferredStrategies) {
            strategy, _, _ in await fixture.status(strategy)
        }
        let choice = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(choice.strategy == nil && choice.availability == .supported)
        #expect(await fixture.queries == [.highFidelity, .lowLatency])
    }

    @Test func installedAlternativeIsCachedAndInvalidationRechecksInstallation() async {
        let fixture = FixtureStrategyAvailability(lowLatency: .supported, highFidelity: .installed)
        let resolver = NativeTranslationStrategyResolver(strategies: [.lowLatency, .highFidelity]) {
            strategy, _, _ in await fixture.status(strategy)
        }
        let first = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(first.strategy == .highFidelity && first.availability == .installed)
        #expect(await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans") == first)
        #expect(await fixture.queries.count == 2)
        await fixture.installLowLatency()
        await resolver.invalidate(sourceLanguage: "en", targetLanguage: "zh-Hans")
        let afterFailure = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(afterFailure.strategy == .lowLatency)
        #expect(await fixture.queries.count == 3)
    }

    @Test func supportedButUninstalledStrategiesAreNeverSelectedOrCached() async {
        let fixture = FixtureStrategyAvailability(lowLatency: .supported, highFidelity: .unsupported)
        let resolver = NativeTranslationStrategyResolver(strategies: [.lowLatency, .highFidelity]) {
            strategy, _, _ in await fixture.status(strategy)
        }
        let choice = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(choice.strategy == nil && choice.availability == .supported)
        _ = await resolver.resolve(sourceLanguage: "en", targetLanguage: "zh-Hans")
        #expect(await fixture.queries.count == 4)
    }

    @Test func leastRecentlyUsedEntryIsEvictedAtCapacity() async throws {
        let driver = FixtureNativeDriver()
        let engine = NativeTranslationEngine(driver: driver, cacheEntryLimit: 2)
        _ = try await engine.translate("a")
        _ = try await engine.translate("b")
        #expect(try await engine.translate("a").fromCache)
        _ = try await engine.translate("c")
        #expect(try await engine.translate("a").fromCache)
        #expect(!(try await engine.translate("b").fromCache))
        #expect(await driver.calls.count == 4)
    }

    @Test func combinedSourceAndOutputCharactersBoundTheCache() async throws {
        let driver = FixtureNativeDriver(outputs: [.text("123"), .text("456"), .text("123"), .text("much too long"), .text("much too long")])
        let engine = NativeTranslationEngine(driver: driver, cacheCharacterLimit: 8)
        _ = try await engine.translate("ab") // Five characters, including the key.
        _ = try await engine.translate("cd") // Evicts the first five-character entry.
        #expect(!(try await engine.translate("ab").fromCache))
        _ = try await engine.translate("oversize")
        #expect(!(try await engine.translate("oversize").fromCache))
        #expect(await driver.calls.count == 5)
    }

    @Test func failedAndEmptyOutputsAreNotCached() async throws {
        let driver = FixtureNativeDriver(outputs: [.failure, .text(" \n"), .text("ok")])
        let engine = NativeTranslationEngine(driver: driver)
        await #expect(throws: NativeTranslationError.translationFailed) { try await engine.translate("hello") }
        await #expect(throws: NativeTranslationError.emptyTranslation) { try await engine.translate("hello") }
        #expect(try await engine.translate("hello").text == "ok")
        #expect(try await engine.translate("hello").fromCache)
        #expect(await driver.calls.count == 3)
    }

    @Test func uninstalledUnsupportedAndUnavailablePairsFailWithoutTranslation() async {
        for (state, expected) in [
            (NativeTranslationAvailability.supported, NativeTranslationError.languagePackMissing(sourceLanguage: "en", targetLanguage: "zh-Hans")),
            (.unsupported, .unsupportedLanguagePair(sourceLanguage: "en", targetLanguage: "zh-Hans")),
            (.unavailable, .unavailable)
        ] {
            let driver = FixtureNativeDriver(status: state)
            let engine = NativeTranslationEngine(driver: driver)
            await #expect(throws: expected) { try await engine.translate("hello") }
            #expect(await driver.calls.isEmpty)
            #expect(await engine.availability() == state)
        }
    }

    @Test func sameLanguageReturnsOriginalWithoutInvokingFramework() async throws {
        let driver = FixtureNativeDriver(status: .unavailable)
        let engine = NativeTranslationEngine(driver: driver, sourceDetector: { _ in "zh-Hans" })
        let text = "  生物学重复与技术重复\n"
        #expect(try await engine.translate(text).text == text)
        #expect(await driver.calls.isEmpty)
    }

    @Test func missingLanguageAndInvalidInputsFailWithoutTranslation() async {
        let driver = FixtureNativeDriver()
        let engine = NativeTranslationEngine(driver: driver, sourceDetector: { _ in nil })
        await #expect(throws: NativeTranslationError.emptyInput) { try await engine.translate(" \n") }
        await #expect(throws: NativeTranslationError.inputTooLong) { try await engine.translate(String(repeating: "a", count: 60_001)) }
        await #expect(throws: NativeTranslationError.unableToIdentifyLanguage) { try await engine.translate("742") }
        #expect(await driver.calls.isEmpty)
    }

    @Test func naturalLanguageDetectionHandlesNonEnglishText() {
        #expect(NativeTranslationEngine.detectLanguage("Bonjour, cette étude compare deux groupes indépendants à deux moments différents.") == "fr")
        #expect(NativeTranslationEngine.detectLanguage("本实验比较两组样本在两个时间点的差异，技术重复不能作为独立生物学重复。") == "zh-Hans")
    }

    @Test func isolatedEnglishScientificTokensAreNotMisclassifiedAsOtherLanguages() {
        for word in ["glucan", "replicate", "WGCNA", "DESeq2", "metabolomics", "phosphorylation"] {
            #expect(NativeTranslationEngine.detectLanguage(word) == "en")
        }
    }

    @Test func englishTokenHintHasAnExplicitAsciiAndLengthBoundary() {
        for token in ["Gene_1", "P-42", "log2", "x.y", "Na+", String(repeating: "a", count: 64), " \nglucan\t "] {
            #expect(NativeTranslationEngine.isEnglishReadingToken(token))
        }
        for other in ["", "742", "._+-", "two words", "glucan\nreplicate", "étude", "葡聚糖", "https://example.com", String(repeating: "a", count: 65)] {
            #expect(!NativeTranslationEngine.isEnglishReadingToken(other))
        }
        #expect(NativeTranslationEngine.detectLanguage("bonjour monde") == "fr")
    }

    @Test func exactGlucanEntryHandlesCaseAndCachesSuccessfulLocalResult() async throws {
        let driver = FixtureNativeDriver(outputs: [.text("葡糖")])
        let engine = NativeTranslationEngine(driver: driver)
        for token in ["glucan", "GLUCAN", " GlUcAn\n"] {
            let first = try await engine.translate(token)
            #expect(first.text == "葡聚糖")
            #expect(!first.fromCache)
            #expect(try await engine.translate(token).fromCache)
        }
        #expect(await driver.calls.isEmpty)
    }

    @Test func glucanEntryDoesNotReplaceSentencesSimilarWordsOrOtherLanguages() async throws {
        let driver = FixtureNativeDriver(outputs: [.text("sentence"), .text("plural"), .text("punctuation"), .text("traditional"), .text("French")])
        let engine = NativeTranslationEngine(driver: driver)
        #expect(try await engine.translate("I studied glucan.").text == "sentence")
        #expect(try await engine.translate("glucans").text == "plural")
        #expect(try await engine.translate("glucan.").text == "punctuation")
        #expect(try await engine.translate("glucan", targetLanguage: "zh-Hant").text == "traditional")
        #expect(try await engine.translate("glucan", targetLanguage: "fr").text == "French")
        #expect(await driver.calls.count == 5)

        let nonEnglishDriver = FixtureNativeDriver(outputs: [.text("other source")])
        let nonEnglish = NativeTranslationEngine(driver: nonEnglishDriver, sourceDetector: { _ in "fr" })
        #expect(try await nonEnglish.translate("glucan").text == "other source")
        #expect(await nonEnglishDriver.calls.count == 1)
    }

    @Test func cancellationDiscardsLateResultAndDoesNotBreakNextRequest() async throws {
        let driver = FixtureNativeDriver(outputs: [.delayedIgnoringCancellation("stale"), .text("fresh"), .text("retry")])
        let engine = NativeTranslationEngine(driver: driver)
        let first = Task { try await engine.translate("first") }
        await waitForCall(driver)
        let second = Task { try await engine.translate("second") }
        first.cancel()
        await #expect(throws: CancellationError.self) { try await first.value }
        #expect(try await second.value.text == "fresh")
        #expect(try await engine.translate("second").fromCache)
        let retry = try await engine.translate("first")
        #expect(retry.text == "retry")
        #expect(!retry.fromCache)
        #expect(await driver.calls.count == 3)
    }

    @Test func canceledQueuedRequestNeverInvokesTranslator() async throws {
        let driver = FixtureNativeDriver(outputs: [.delayedIgnoringCancellation("first")])
        let engine = NativeTranslationEngine(driver: driver)
        let first = Task { try await engine.translate("first") }
        await waitForCall(driver)
        let queued = Task { try await engine.translate("queued") }
        queued.cancel()
        await #expect(throws: CancellationError.self) { try await queued.value }
        #expect(try await first.value.text == "first")
        #expect(await driver.calls.count == 1)
    }

    @Test func successfulCacheHitsDoNotWaitForAnotherLiveRequest() async throws {
        let driver = FixtureNativeDriver(outputs: [.text("cached"), .delayedIgnoringCancellation("busy")])
        let engine = NativeTranslationEngine(driver: driver)
        _ = try await engine.translate("known")
        let busy = Task { try await engine.translate("new") }
        while await driver.calls.count < 2 { await Task.yield() }
        let result = try await engine.translate("known")
        #expect(result.fromCache)
        #expect(result.elapsedSeconds < 0.05)
        _ = try await busy.value
    }

    @Test func clearingCacheDuringTranslationPreventsLaterRepopulation() async throws {
        let driver = FixtureNativeDriver(outputs: [.delayedIgnoringCancellation("late"), .text("retry")])
        let engine = NativeTranslationEngine(driver: driver)
        let active = Task { try await engine.translate("first") }
        await waitForCall(driver)
        await engine.clearCache()
        _ = try await active.value
        #expect(!(try await engine.translate("first").fromCache))
    }

    @Test func warmUpRequiresInstalledLanguagePack() async {
        let driver = FixtureNativeDriver(status: .supported)
        let engine = NativeTranslationEngine(driver: driver)
        await #expect(throws: NativeTranslationError.languagePackMissing(sourceLanguage: "en", targetLanguage: "zh-Hans")) {
            try await engine.warmUp()
        }
        #expect(await driver.calls.isEmpty)
    }

    @Test func warmUpPreparesInstalledPairWithoutSendingAnyText() async throws {
        let driver = FixtureNativeDriver()
        let engine = NativeTranslationEngine(driver: driver)
        try await engine.warmUp()
        #expect(await driver.warmUps == 1)
        #expect(await driver.calls.isEmpty)
    }

    @Test func cancelingAnActuallyQueuedTranslationReturnsBeforeBusyRequestFinishes() async throws {
        let driver = FixtureNativeDriver(outputs: [.suspendedIgnoringCancellation("first"), .text("third"), .text("second")])
        let submissions = NativeTestSignal()
        let returned = NativeTestSignal()
        let engine = NativeTranslationEngine(driver: driver, onEnqueue: { submissions.increment() })
        let first = Task { try await engine.translate("first") }
        await waitForCall(driver)
        let queued = Task { try await engine.translate("second") }
        #expect(await waitForSignal(submissions, count: 2)) // B entered the queue, rather than failing its preflight check.
        let observer = Task {
            do { _ = try await queued.value; Issue.record("Cancelled request returned a translation") }
            catch is CancellationError { returned.increment() }
            catch { Issue.record("Wrong cancellation error") }
        }
        queued.cancel()
        #expect(await waitForSignal(returned, count: 1)) // A is still held by a deterministic gate.
        let third = Task { try await engine.translate("third") }
        #expect(await waitForSignal(submissions, count: 3))
        for _ in 0..<10 { await Task.yield() }
        #expect(await driver.calls.count == 1)
        await driver.releaseSuspended()
        _ = await observer.value
        #expect(try await first.value.text == "first")
        #expect(try await third.value.text == "third")
        let retry = try await engine.translate("second")
        #expect(retry.text == "second")
        #expect(!retry.fromCache)
        #expect(await driver.calls.count == 3)
    }

    @Test func cancelingAnActuallyQueuedWarmUpReturnsBeforeBusyTranslationFinishes() async throws {
        let driver = FixtureNativeDriver(outputs: [.suspendedIgnoringCancellation("first")])
        let submissions = NativeTestSignal()
        let returned = NativeTestSignal()
        let engine = NativeTranslationEngine(driver: driver, onEnqueue: { submissions.increment() })
        let first = Task { try await engine.translate("first") }
        await waitForCall(driver)
        let queued = Task { try await engine.warmUp() }
        #expect(await waitForSignal(submissions, count: 2))
        let observer = Task {
            do { try await queued.value; Issue.record("Cancelled warm-up completed") }
            catch is CancellationError { returned.increment() }
            catch { Issue.record("Wrong cancellation error") }
        }
        queued.cancel()
        #expect(await waitForSignal(returned, count: 1))
        #expect(await driver.warmUps == 0)
        await driver.releaseSuspended()
        _ = await observer.value
        #expect(try await first.value.text == "first")
        try await engine.warmUp()
        #expect(await driver.warmUps == 1)
    }

    private func waitForSignal(_ signal: NativeTestSignal, count: Int) async -> Bool {
        for _ in 0..<40 {
            if signal.count >= count { return true }
            try? await Task.sleep(nanoseconds: 2_500_000)
        }
        return signal.count >= count
    }

    private func waitForCall(_ driver: FixtureNativeDriver) async {
        for _ in 0..<10_000 {
            if await !driver.calls.isEmpty { return }
            await Task.yield()
        }
        Issue.record("Translator did not start")
    }
}

private actor FixtureNativeDriver: NativeTranslationDriver {
    struct Call: Sendable { let text: String; let source: String; let target: String }
    enum Output: Sendable { case text(String), failure, delayedIgnoringCancellation(String), suspendedIgnoringCancellation(String) }
    var calls: [Call] = []
    var warmUps = 0
    private var outputs: [Output]
    private let status: NativeTranslationAvailability
    private var suspended: [CheckedContinuation<Void, Never>] = []
    init(outputs: [Output] = [], status: NativeTranslationAvailability = .installed) {
        self.outputs = outputs; self.status = status
    }
    func availability(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability { status }
    func warmUp(sourceLanguage: String, targetLanguage: String) async throws { warmUps += 1 }
    func translate(_ text: String, sourceLanguage: String, targetLanguage: String) async throws -> String {
        calls.append(Call(text: text, source: sourceLanguage, target: targetLanguage))
        let output = outputs.isEmpty ? Output.text("translated " + text) : outputs.removeFirst()
        switch output {
        case .text(let value): return value
        case .failure: throw NativeTranslationError.translationFailed
        case .delayedIgnoringCancellation(let value):
            await withCheckedContinuation { continuation in
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.08) { continuation.resume() }
            }
            return value
        case .suspendedIgnoringCancellation(let value):
            await withCheckedContinuation { suspended.append($0) }
            return value
        }
    }

    func releaseSuspended() {
        let waiting = suspended
        suspended.removeAll()
        for continuation in waiting { continuation.resume() }
    }
}

private final class NativeTestSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func increment() { lock.lock(); value += 1; lock.unlock() }
}

private actor FixtureStrategyAvailability {
    private var lowLatency: NativeTranslationAvailability
    private let highFidelity: NativeTranslationAvailability
    var queries: [NativeTranslationStrategy] = []
    init(lowLatency: NativeTranslationAvailability, highFidelity: NativeTranslationAvailability) {
        self.lowLatency = lowLatency; self.highFidelity = highFidelity
    }
    func status(_ strategy: NativeTranslationStrategy) -> NativeTranslationAvailability {
        queries.append(strategy)
        return strategy == .lowLatency ? lowLatency : highFidelity
    }
    func installLowLatency() { lowLatency = .installed }
}

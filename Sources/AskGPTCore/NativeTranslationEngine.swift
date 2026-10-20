import Foundation
import NaturalLanguage
import Translation

public enum NativeTranslationAvailability: Sendable, Equatable {
    case installed, supported, unsupported, unavailable
}

/// A requested preference, not proof of which model Apple's framework used.
/// Apple's high-fidelity strategy may fall back when Apple Intelligence is unavailable.
public enum NativeTranslationQuality: String, Sendable, CaseIterable {
    case fast, quality

    var preferredStrategies: [NativeTranslationStrategy] {
        switch self {
        case .fast: return [.lowLatency, .highFidelity]
        case .quality: return [.highFidelity, .lowLatency]
        }
    }
}

public struct NativeTranslationResult: Sendable, Equatable {
    public let text: String
    public let fromCache: Bool
    public let elapsedSeconds: TimeInterval
    public let sourceLanguage: String
    public let targetLanguage: String
}

public enum NativeTranslationError: Error, LocalizedError, Sendable, Equatable {
    case emptyInput, inputTooLong, unableToIdentifyLanguage, unavailable, emptyTranslation, translationFailed, timedOut
    case languagePackMissing(sourceLanguage: String, targetLanguage: String)
    case unsupportedLanguagePair(sourceLanguage: String, targetLanguage: String)

    public var errorDescription: String? {
        switch self {
        case .emptyInput: return "请选择或粘贴原文。"
        case .inputTooLong: return "原文过长，请缩小选段。"
        case .unableToIdentifyLanguage: return "未能识别原文语言。"
        case .unavailable: return "本机翻译需要 macOS 26 或更新版本。"
        case .languagePackMissing(let source, let target):
            return "尚未安装\(Self.languageName(source)) → \(Self.languageName(target))的本机翻译资源。请先确认源语言；需要这组语言时，再到系统翻译设置下载。"
        case .unsupportedLanguagePair(let source, let target):
            return "本机翻译暂不支持\(Self.languageName(source)) → \(Self.languageName(target))。请确认源语言是否正确。"
        case .timedOut: return "本机翻译超时，请重试或重新选择原文。"
        case .emptyTranslation, .translationFailed: return "本机翻译失败，请重试。"
        }
    }

    private static func languageName(_ identifier: String) -> String {
        guard !identifier.isEmpty else { return "未指定语言" }
        let chinese = Locale(identifier: "zh-Hans")
        let name = chinese.localizedString(forIdentifier: identifier)
            ?? chinese.localizedString(forLanguageCode: identifier) ?? identifier
        return "\(name)（\(identifier)）"
    }
}

protocol NativeTranslationDriver: Sendable {
    func availability(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability
    func warmUp(sourceLanguage: String, targetLanguage: String) async throws
    func translate(_ text: String, sourceLanguage: String, targetLanguage: String) async throws -> String
}

public actor NativeTranslationEngine {
    private let driver: any NativeTranslationDriver
    private let sourceDetector: @Sendable (String) -> String?
    private let cacheEntryLimit: Int
    private let cacheCharacterLimit: Int
    private let onEnqueue: @Sendable () -> Void
    private var cache: [CacheKey: CacheEntry] = [:]
    private var cacheOrder: [CacheKey] = []
    private var cachedCharacters = 0
    private var cacheGeneration: UInt64 = 0
    private var tail: Task<Void, Never>?

    public init(quality: NativeTranslationQuality = .quality) {
        driver = AppleInstalledTranslationDriver(quality: quality)
        sourceDetector = { Self.detectLanguage($0) }
        cacheEntryLimit = 64
        cacheCharacterLimit = 128_000
        onEnqueue = {}
    }

    // Tests inject the text boundary; the public initializer always uses Apple's framework.
    init(driver: any NativeTranslationDriver, sourceDetector: @escaping @Sendable (String) -> String? = { _ in "en" }, cacheEntryLimit: Int = 64, cacheCharacterLimit: Int = 128_000, onEnqueue: @escaping @Sendable () -> Void = {}) {
        self.driver = driver; self.sourceDetector = sourceDetector
        self.cacheEntryLimit = min(64, max(0, cacheEntryLimit))
        self.cacheCharacterLimit = min(128_000, max(0, cacheCharacterLimit))
        self.onEnqueue = onEnqueue
    }

    public func availability(sourceLanguage: String = "en", targetLanguage: String = "zh-Hans") async -> NativeTranslationAvailability {
        await driver.availability(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
    }

    public func warmUp(sourceLanguage: String = "en", targetLanguage: String = "zh-Hans") async throws {
        try Task.checkCancellation()
        let previous = tail
        let job = Task { [self] in
            await previous?.value
            try Task.checkCancellation()
            let state = await driver.availability(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            try Task.checkCancellation()
            try Self.requireInstalled(state, sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            try await driver.warmUp(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            try Task.checkCancellation()
        }
        tail = Task { _ = try? await job.value }
        onEnqueue()
        try await awaitNativeJobResult(job)
    }

    public func translate(_ text: String, sourceLanguage: String? = nil, targetLanguage: String = "zh-Hans") async throws -> NativeTranslationResult {
        let started = DispatchTime.now().uptimeNanoseconds
        try Task.checkCancellation()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeTranslationError.emptyInput }
        guard text.count <= 60_000 else { throw NativeTranslationError.inputTooLong }
        let target = targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "_", with: "-")
        guard !target.isEmpty else {
            throw NativeTranslationError.unsupportedLanguagePair(sourceLanguage: "", targetLanguage: "")
        }
        let sourceOverride: String?
        if let sourceLanguage {
            let value = sourceLanguage.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "_", with: "-")
            guard !value.isEmpty else { throw NativeTranslationError.unableToIdentifyLanguage }
            sourceOverride = value
        } else { sourceOverride = nil }
        let key = CacheKey(text: text, sourceLanguageOverride: sourceOverride,
            targetLanguage: Locale.Language(identifier: target).minimalIdentifier)
        if let cached = cachedResult(for: key, targetLanguage: target, started: started) { return cached }

        // One live operation at a time. A cancelled auto-translation cannot cancel a
        // simultaneous Easydict request that is waiting for its own turn.
        let previous = tail
        let job = Task { [self] () throws -> NativeTranslationResult in
            await previous?.value
            try Task.checkCancellation()
            return try await perform(text, sourceLanguage: sourceOverride, targetLanguage: target, key: key, started: started)
        }
        tail = Task { _ = try? await job.value }
        onEnqueue()
        return try await awaitNativeJobResult(job)
    }

    public func clearCache() {
        cacheGeneration &+= 1
        cache.removeAll(); cacheOrder.removeAll(); cachedCharacters = 0
    }

    static func detectLanguage(_ text: String) -> String? {
        // Reading is English-first only for isolated short ASCII words and IDs.
        // Sentences and non-ASCII text keep NaturalLanguage's automatic detection.
        if isEnglishReadingToken(text) { return "en" }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        return recognizer.dominantLanguage?.rawValue
    }

    static func isEnglishReadingToken(_ text: String) -> Bool {
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty, token.count <= 64 else { return false }
        var hasLetter = false
        for scalar in token.unicodeScalars {
            switch scalar.value {
            case 65...90, 97...122: hasLetter = true
            case 48...57, 46, 95, 43, 45: break // Digits and . _ + -
            default: return false
            }
        }
        return hasLetter
    }

    private func perform(_ text: String, sourceLanguage: String?, targetLanguage: String, key: CacheKey, started: UInt64) async throws -> NativeTranslationResult {
        try Task.checkCancellation()
        if let cached = cachedResult(for: key, targetLanguage: targetLanguage, started: started) { return cached }
        guard let source = sourceLanguage ?? sourceDetector(text) else { throw NativeTranslationError.unableToIdentifyLanguage }
        let generation = cacheGeneration
        let translated: String
        if let entry = Self.exactGlossaryEntry(text, sourceLanguage: source, targetLanguage: targetLanguage) {
            translated = entry
        } else if Locale.Language(identifier: source).isEquivalent(to: Locale.Language(identifier: targetLanguage)) {
            translated = text
        } else {
            let state = await driver.availability(sourceLanguage: source, targetLanguage: targetLanguage)
            try Task.checkCancellation()
            try Self.requireInstalled(state, sourceLanguage: source, targetLanguage: targetLanguage)
            translated = try await driver.translate(text, sourceLanguage: source, targetLanguage: targetLanguage)
        }
        try Task.checkCancellation()
        guard !translated.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeTranslationError.emptyTranslation }
        if generation == cacheGeneration { remember(translated, sourceLanguage: source, key: key) }
        return NativeTranslationResult(text: translated, fromCache: false, elapsedSeconds: elapsed(since: started), sourceLanguage: source, targetLanguage: targetLanguage)
    }

    private func cachedResult(for key: CacheKey, targetLanguage: String, started: UInt64) -> NativeTranslationResult? {
        guard let entry = cache[key] else { return nil }
        cacheOrder.removeAll { $0 == key }; cacheOrder.append(key)
        return NativeTranslationResult(text: entry.text, fromCache: true, elapsedSeconds: elapsed(since: started), sourceLanguage: entry.sourceLanguage, targetLanguage: targetLanguage)
    }

    private func remember(_ text: String, sourceLanguage: String, key: CacheKey) {
        let characters = key.text.count + text.count
        guard cacheEntryLimit > 0, characters <= cacheCharacterLimit else { return }
        if let old = cache.removeValue(forKey: key) { cachedCharacters -= old.characters }
        cacheOrder.removeAll { $0 == key }
        while cache.count >= cacheEntryLimit || cachedCharacters + characters > cacheCharacterLimit {
            guard !cacheOrder.isEmpty else { break }
            let evicted = cacheOrder.removeFirst()
            if let old = cache.removeValue(forKey: evicted) { cachedCharacters -= old.characters }
        }
        cache[key] = CacheEntry(text: text, sourceLanguage: sourceLanguage, characters: characters)
        cacheOrder.append(key); cachedCharacters += characters
    }

    private func elapsed(since started: UInt64) -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
    }

    private static func requireInstalled(_ state: NativeTranslationAvailability, sourceLanguage: String, targetLanguage: String) throws {
        switch state {
        case .installed: return
        case .supported: throw NativeTranslationError.languagePackMissing(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
        case .unsupported: throw NativeTranslationError.unsupportedLanguagePair(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
        case .unavailable: throw NativeTranslationError.unavailable
        }
    }

    private static func exactGlossaryEntry(_ text: String, sourceLanguage: String, targetLanguage: String) -> String? {
        // The single verified correction stays local and never rewrites sentences.
        // MeSH D005936, glucose-unit polysaccharides: https://meshb.nlm.nih.gov/record/ui?ui=D005936
        guard sourceLanguage == "en",
              Locale.Language(identifier: targetLanguage).isEquivalent(to: Locale.Language(identifier: "zh-Hans")),
              text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "glucan"
        else { return nil }
        return "葡聚糖"
    }

    private struct CacheKey: Hashable { let text: String; let sourceLanguageOverride: String?; let targetLanguage: String }
    private struct CacheEntry { let text: String; let sourceLanguage: String; let characters: Int }
}

// Cancellation wakes the caller immediately, even if its job is queued behind
// an operation that has not finished. The engine's tail still awaits that job,
// so returning here never allows the next request to overtake session cleanup.
private func awaitNativeJobResult<Value: Sendable>(_ job: Task<Value, Error>) async throws -> Value {
    let waiter = NativeJobResultWaiter<Value>()
    let result = try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            waiter.install(continuation)
            Task { waiter.finish(await job.result) }
        }
    } onCancel: {
        job.cancel()
        waiter.finish(.failure(CancellationError()))
    }
    try Task.checkCancellation()
    return result
}

// The synchronous cancellation handler and the async result observer can race.
// This lock owns the continuation and admits exactly one terminal result.
private final class NativeJobResultWaiter<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?
    private var continuation: CheckedContinuation<Value, Error>?

    func install(_ continuation: CheckedContinuation<Value, Error>) {
        lock.lock()
        if let result {
            lock.unlock()
            continuation.resume(with: result)
        } else {
            self.continuation = continuation
            lock.unlock()
        }
    }

    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}

enum NativeTranslationStrategy: Sendable, Hashable {
    case lowLatency, highFidelity, legacyDefault
}

struct NativeTranslationStrategyChoice: Sendable, Equatable {
    let strategy: NativeTranslationStrategy?
    let availability: NativeTranslationAvailability
}

private struct NativeTranslationLanguagePair: Sendable, Hashable {
    let source: String
    let target: String
}

// Queries are injectable because framework availability depends on the app's
// native execution context. Only confirmed installed strategies are cached.
actor NativeTranslationStrategyResolver {
    typealias Query = @Sendable (NativeTranslationStrategy, String, String) async -> NativeTranslationAvailability
    private let strategies: [NativeTranslationStrategy]
    private let query: Query
    private var installed: [NativeTranslationLanguagePair: NativeTranslationStrategy] = [:]
    private var order: [NativeTranslationLanguagePair] = []
    private var generation: UInt64 = 0

    init(strategies: [NativeTranslationStrategy], query: @escaping Query) {
        self.strategies = strategies; self.query = query
    }

    func resolve(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationStrategyChoice {
        let pair = NativeTranslationLanguagePair(source: sourceLanguage, target: targetLanguage)
        if let strategy = installed[pair] {
            order.removeAll { $0 == pair }; order.append(pair)
            return NativeTranslationStrategyChoice(strategy: strategy, availability: .installed)
        }
        let startedGeneration = generation
        var sawSupported = false, sawUnsupported = false
        for strategy in strategies {
            guard !Task.isCancelled else {
                return NativeTranslationStrategyChoice(strategy: nil, availability: .unavailable)
            }
            let state = await query(strategy, sourceLanguage, targetLanguage)
            if state == .installed {
                if !Task.isCancelled && generation == startedGeneration {
                    while installed.count >= 8, !order.isEmpty {
                        installed.removeValue(forKey: order.removeFirst())
                    }
                    installed[pair] = strategy
                    order.removeAll { $0 == pair }; order.append(pair)
                }
                return NativeTranslationStrategyChoice(strategy: strategy, availability: .installed)
            }
            sawSupported = sawSupported || state == .supported
            sawUnsupported = sawUnsupported || state == .unsupported
        }
        return NativeTranslationStrategyChoice(strategy: nil,
            availability: sawSupported ? .supported : (sawUnsupported ? .unsupported : .unavailable))
    }

    func invalidate(sourceLanguage: String, targetLanguage: String) {
        generation &+= 1
        let pair = NativeTranslationLanguagePair(source: sourceLanguage, target: targetLanguage)
        installed.removeValue(forKey: pair); order.removeAll { $0 == pair }
    }
}

private actor AppleInstalledTranslationDriver: NativeTranslationDriver {
    // Keep newer framework objects behind availability checks on macOS 13–25.
    private var sessionStorage: Any?
    private let strategyResolver: NativeTranslationStrategyResolver

    init(quality: NativeTranslationQuality) {
        let strategies: [NativeTranslationStrategy]
        if #available(macOS 26.4, *) { strategies = quality.preferredStrategies }
        else { strategies = [.legacyDefault] }
        strategyResolver = NativeTranslationStrategyResolver(strategies: strategies) {
            strategy, source, target in
            await Self.queryAvailability(strategy: strategy, sourceLanguage: source, targetLanguage: target)
        }
    }

    func availability(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability {
        await strategyResolver.resolve(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage).availability
    }

    private nonisolated static func queryAvailability(strategy: NativeTranslationStrategy,
        sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability {
        guard #available(macOS 26.0, *) else { return .unavailable }
        let availability: LanguageAvailability
        if #available(macOS 26.4, *) {
            switch strategy {
            case .lowLatency: availability = LanguageAvailability(preferredStrategy: .lowLatency)
            case .highFidelity: availability = LanguageAvailability(preferredStrategy: .highFidelity)
            case .legacyDefault: availability = LanguageAvailability()
            }
        } else { availability = LanguageAvailability() }
        let state = await availability.status(from: Locale.Language(identifier: sourceLanguage), to: Locale.Language(identifier: targetLanguage))
        switch state {
        case .installed: return .installed
        case .supported: return .supported
        case .unsupported: return .unsupported
        @unknown default: return .unavailable
        }
    }

    func translate(_ text: String, sourceLanguage: String, targetLanguage: String) async throws -> String {
        guard #available(macOS 26.0, *) else { throw NativeTranslationError.unavailable }
        return try await runInstalled(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage) { entry in
            let text = try await entry.session.translate(text).targetText
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw NativeTranslationError.emptyTranslation
            }
            entry.prepared = true
            return text
        }
    }

    func warmUp(sourceLanguage: String, targetLanguage: String) async throws {
        guard #available(macOS 26.0, *) else { throw NativeTranslationError.unavailable }
        try await runInstalled(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage) { entry in
            if !entry.prepared {
                try await entry.session.prepareTranslation()
                entry.prepared = true
            }
        }
    }

    @available(macOS 26.0, *)
    private func runInstalled<Result>(sourceLanguage: String, targetLanguage: String, operation: (InstalledSession) async throws -> Result) async throws -> Result {
        try Task.checkCancellation()
        let choice = await strategyResolver.resolve(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
        try Task.checkCancellation()
        guard let strategy = choice.strategy, choice.availability == .installed else {
            switch choice.availability {
            case .supported: throw NativeTranslationError.languagePackMissing(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            case .unsupported: throw NativeTranslationError.unsupportedLanguagePair(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            case .unavailable, .installed: throw NativeTranslationError.unavailable
            }
        }
        let pair = NativeTranslationLanguagePair(source: sourceLanguage, target: targetLanguage)
        let storage = installedSessions()
        let entry: InstalledSession
        if let existing = storage.sessions[pair], existing.strategy == strategy { entry = existing }
        else {
            let source = Locale.Language(identifier: sourceLanguage), target = Locale.Language(identifier: targetLanguage)
            let session: TranslationSession
            if #available(macOS 26.4, *) {
                switch strategy {
                case .lowLatency: session = TranslationSession(installedSource: source, target: target, preferredStrategy: .lowLatency)
                case .highFidelity: session = TranslationSession(installedSource: source, target: target, preferredStrategy: .highFidelity)
                case .legacyDefault: session = TranslationSession(installedSource: source, target: target)
                }
            } else { session = TranslationSession(installedSource: source, target: target) }
            // This initializer cannot request language downloads.
            entry = InstalledSession(session: session, strategy: strategy)
            while storage.sessions.count >= 8, !storage.order.isEmpty {
                storage.sessions.removeValue(forKey: storage.order.removeFirst())
            }
            storage.sessions[pair] = entry
        }
        storage.order.removeAll { $0 == pair }; storage.order.append(pair)
        let request = UUID(); entry.activeRequest = request
        do {
            let translated = try await withTaskCancellationHandler {
                try Task.checkCancellation()
                let response = try await operation(entry)
                try Task.checkCancellation()
                return response
            } onCancel: {
                Task { await self.cancelActive(pair: pair, request: request) }
            }
            entry.activeRequest = nil
            return translated
        } catch {
            entry.activeRequest = nil
            if storage.sessions[pair] === entry { storage.sessions.removeValue(forKey: pair); storage.order.removeAll { $0 == pair } }
            await strategyResolver.invalidate(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            if let native = error as? NativeTranslationError { throw native }
            switch error {
            case TranslationError.notInstalled: throw NativeTranslationError.languagePackMissing(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            case TranslationError.unsupportedSourceLanguage, TranslationError.unsupportedTargetLanguage, TranslationError.unsupportedLanguagePairing:
                throw NativeTranslationError.unsupportedLanguagePair(sourceLanguage: sourceLanguage, targetLanguage: targetLanguage)
            case TranslationError.unableToIdentifyLanguage: throw NativeTranslationError.unableToIdentifyLanguage
            case TranslationError.nothingToTranslate: throw NativeTranslationError.emptyTranslation
            case TranslationError.alreadyCancelled: throw CancellationError()
            default: throw NativeTranslationError.translationFailed
            }
        }
    }

    @available(macOS 26.0, *)
    private func installedSessions() -> InstalledSessions {
        if let existing = sessionStorage as? InstalledSessions { return existing }
        let storage = InstalledSessions(); sessionStorage = storage; return storage
    }

    @available(macOS 26.0, *)
    private func cancelActive(pair: NativeTranslationLanguagePair, request: UUID) async {
        let storage = installedSessions()
        guard let entry = storage.sessions[pair], entry.activeRequest == request else { return }
        entry.session.cancel()
        storage.sessions.removeValue(forKey: pair); storage.order.removeAll { $0 == pair }
        await strategyResolver.invalidate(sourceLanguage: pair.source, targetLanguage: pair.target)
    }

    @available(macOS 26.0, *)
    private final class InstalledSessions { var sessions: [NativeTranslationLanguagePair: InstalledSession] = [:]; var order: [NativeTranslationLanguagePair] = [] }
    @available(macOS 26.0, *)
    private final class InstalledSession {
        let session: TranslationSession
        let strategy: NativeTranslationStrategy
        var prepared = false
        var activeRequest: UUID?
        init(session: TranslationSession, strategy: NativeTranslationStrategy) {
            self.session = session; self.strategy = strategy
        }
    }
}

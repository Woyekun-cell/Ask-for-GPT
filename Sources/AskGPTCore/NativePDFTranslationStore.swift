import Darwin
import Foundation

public enum NativePDFTranslationScope: Sendable, Equatable {
    case page(Int), wholeDocument
}

public struct NativePDFTranslationRequest: Sendable {
    public let sourceURL: URL
    public let applicationURL: URL
    public let applicationBundleID: String
    public let scope: NativePDFTranslationScope
    public let sourceLanguage: String
    public let targetLanguage: String

    public init(sourceURL: URL, applicationURL: URL, applicationBundleID: String,
                scope: NativePDFTranslationScope, sourceLanguage: String = "en", targetLanguage: String = "zh-Hans") {
        self.sourceURL = sourceURL; self.applicationURL = applicationURL
        self.applicationBundleID = applicationBundleID; self.scope = scope
        self.sourceLanguage = sourceLanguage; self.targetLanguage = targetLanguage
    }
}

public struct NativePDFTranslationResult: Sendable, Codable, Equatable {
    public let id: UUID
    public let originalURL: URL
    public let applicationURL: URL
    public let applicationBundleID: String
    public let sourcePages: [Int]
    public let sourcePageCount: Int
    public let sourceLanguage: String
    public let targetLanguage: String
    public let createdAt: Date
    public let jobID: String
    public let directoryURL: URL

    public func outputURL(mode: PDFLayoutOutputMode) -> URL {
        directoryURL.appendingPathComponent(mode == .mono ? "Translated.pdf" : "Comparison.pdf")
    }
}

public enum NativePDFTranslationError: Error, LocalizedError, Sendable, Equatable {
    case unsupportedReader, invalidOutput, cacheUnavailable
    public var errorDescription: String? {
        switch self {
        case .unsupportedReader: return "请在预览或 WPS 的 PDF 标签中使用此入口。"
        case .invalidOutput: return "保版译文与请求页码不一致，原 PDF 已保留。"
        case .cacheUnavailable: return "无法保存私有译文副本，原 PDF 已保留。"
        }
    }
}

public enum NativePDFReaderPolicy {
    public static func supports(bundleID: String) -> Bool {
        ["com.apple.Preview", "com.kingsoft.wpsoffice.mac"].contains(bundleID)
    }

    /// Observes only the native readers. Browser/Zotero extensions keep owning
    /// their shortcut, and no system-wide Carbon hotkey is registered.
    public static func matchesShortcut(bundleID: String, keyCode: UInt16, modifiers: UInt) -> Bool {
        // NSEvent.ModifierFlags device-independent values, without AppKit UI.
        let mask: UInt = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)
        let optionShift: UInt = (1 << 17) | (1 << 19)
        return supports(bundleID: bundleID) && keyCode == 7 && modifiers & mask == optionShift
    }
}

public enum NativePDFPresentationPolicy {
    public static func mayPresent(sourcePID: Int32, foregroundPID: Int32?, ownPID: Int32,
                                  expectedDocument: URL, observedDocument: URL?) -> Bool {
        guard foregroundPID == sourcePID || foregroundPID == ownPID,
              let observedDocument else { return false }
        return expectedDocument.standardizedFileURL == observedDocument.standardizedFileURL
    }
}

/// Produces bounded private copies for native readers; the source is opened
/// read-only. UI presentation and NSWorkspace launching live in the controller.
public actor NativePDFTranslationStore {
    private let service: any PDFLayoutServing
    private let root: URL
    private let pollingNanoseconds: UInt64
    private let maximumRecords: Int
    private let maximumBytes: Int64
    private struct Operation { var jobID: String? }
    private var operations: [UUID: Operation] = [:]
    private var records: [UUID: NativePDFTranslationResult] = [:]

    public init(service: any PDFLayoutServing = PDFLayoutService.shared, directory: URL? = nil,
                pollingNanoseconds: UInt64 = 250_000_000, maximumRecords: Int = 4,
                maximumBytes: Int64 = 1_500 * 1_024 * 1_024) {
        self.service = service
        self.root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AskGPTReader/PDFLayout/NativeReaderCopies", isDirectory: true)
        self.pollingNanoseconds = pollingNanoseconds
        self.maximumRecords = max(1, maximumRecords); self.maximumBytes = max(1, maximumBytes)
    }

    public func translate(_ request: NativePDFTranslationRequest, mode: PDFLayoutOutputMode = .mono,
                          operationID operation: UUID = UUID()) async throws -> NativePDFTranslationResult {
        guard operations[operation] == nil else { throw PDFLayoutServiceError.invalidInput }
        operations[operation] = Operation()
        var createdID: String?
        var registeredJobID: String?
        var resultDirectory: URL?
        do {
            try check(operation)
            guard NativePDFReaderPolicy.supports(bundleID: request.applicationBundleID), request.applicationURL.isFileURL else {
                throw NativePDFTranslationError.unsupportedReader
            }
            guard ["en", "zh-Hans"].contains(request.sourceLanguage), ["en", "zh-Hans"].contains(request.targetLanguage),
                  request.sourceLanguage != request.targetLanguage else { throw PDFLayoutServiceError.invalidInput }
            let document = try await PDFTranslationDocument.open(url: request.sourceURL)
            try check(operation)
            let pages: [Int]?
            switch request.scope {
            case .page(let page):
                guard (0..<document.pageCount).contains(page) else {
                    throw PDFTranslationDocumentError.pageOutOfBounds(index: page, count: document.pageCount)
                }
                pages = [page]
            case .wholeDocument: pages = nil
            }
            let bytes = await document.originalPDFData()
            try check(operation)
            var job = try await service.createJob(data: bytes, pages: pages, source: request.sourceLanguage, target: request.targetLanguage)
            createdID = job.id
            try check(operation)
            operations[operation]?.jobID = job.id
            registeredJobID = job.id
            try validate(job, pageCount: document.pageCount, pages: pages)
            while job.state == .running {
                try await Task.sleep(nanoseconds: pollingNanoseconds)
                try check(operation)
                job = try await service.status(id: job.id)
                try check(operation)
                try validate(job, pageCount: document.pageCount, pages: pages)
            }
            guard job.state == .complete else {
                if job.state == .cancelled { throw CancellationError() }
                throw PDFLayoutServiceError.requestFailed(job.error ?? "保版翻译未完成，原 PDF 已保留。")
            }
            let output = try await service.output(id: job.id, mode: mode)
            try check(operation)
            try Self.validateOutput(output, expectedPages: job.sourcePages.count)
            try prepareRoot()
            let id = UUID()
            let directory = root.appendingPathComponent(id.uuidString, isDirectory: true)
            resultDirectory = directory
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let result = NativePDFTranslationResult(id: id, originalURL: request.sourceURL.standardizedFileURL,
                applicationURL: request.applicationURL, applicationBundleID: request.applicationBundleID,
                sourcePages: job.sourcePages, sourcePageCount: job.pageCount,
                sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage,
                createdAt: Date(), jobID: job.id, directoryURL: directory)
            try write(output, to: result.outputURL(mode: mode))
            // Keep both generated views with the native copy. The private
            // sidecar job can retire when the app restarts or prunes its cache.
            let alternateMode: PDFLayoutOutputMode = mode == .mono ? .dual : .mono
            let alternate = try await service.output(id: job.id, mode: alternateMode)
            try check(operation)
            try Self.validateOutput(alternate, expectedPages: job.sourcePages.count)
            try write(alternate, to: result.outputURL(mode: alternateMode))
            try write(JSONEncoder().encode(result), to: directory.appendingPathComponent("record.json"))
            try check(operation)
            records[result.id] = result
            operations.removeValue(forKey: operation)
            prune(keeping: result.id)
            return result
        } catch {
            let owned = operations.removeValue(forKey: operation)
            // Cancellation can race an uncooperative submission. Retire a late
            // job here, but do not cancel an already-retired job a second time.
            if let createdID, owned != nil || registeredJobID == nil { await service.cancel(id: createdID) }
            if let resultDirectory { try? FileManager.default.removeItem(at: resultDirectory) }
            throw error
        }
    }

    public func output(_ result: NativePDFTranslationResult, mode: PDFLayoutOutputMode) async throws -> URL {
        try Task.checkCancellation()
        guard records[result.id] == result else { throw NativePDFTranslationError.cacheUnavailable }
        let url = result.outputURL(mode: mode)
        if Self.isRegularPrivateFile(url) { return url }
        let output = try await service.output(id: result.jobID, mode: mode)
        try Task.checkCancellation()
        guard records[result.id] == result else { throw CancellationError() }
        try Self.validateOutput(output, expectedPages: result.sourcePages.count)
        try write(output, to: url)
        prune(keeping: result.id)
        return url
    }

    public func result(forOutputURL url: URL) -> NativePDFTranslationResult? {
        if let existing = records.values.first(where: { record in
            [record.outputURL(mode: .mono), record.outputURL(mode: .dual)].contains(url.standardizedFileURL)
        }) { return existing }
        let directory = url.deletingLastPathComponent().standardizedFileURL
        guard directory.deletingLastPathComponent() == root.standardizedFileURL,
              let id = UUID(uuidString: directory.lastPathComponent),
              let attributes = try? FileManager.default.attributesOfItem(atPath: directory.path),
              attributes[.type] as? FileAttributeType == .typeDirectory,
              Self.isRegularPrivateFile(directory.appendingPathComponent("record.json")),
              let size = (try? FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("record.json").path)[.size]) as? NSNumber,
              size.intValue < 16_384,
              let data = try? Data(contentsOf: directory.appendingPathComponent("record.json")),
              let result = try? JSONDecoder().decode(NativePDFTranslationResult.self, from: data),
              result.id == id, result.directoryURL.standardizedFileURL == directory,
              NativePDFReaderPolicy.supports(bundleID: result.applicationBundleID),
              result.originalURL.isFileURL, result.applicationURL.isFileURL,
              (1...2_000).contains(result.sourcePageCount), !result.sourcePages.isEmpty,
              result.sourcePages.allSatisfy({ (0..<result.sourcePageCount).contains($0) }),
              [result.outputURL(mode: .mono), result.outputURL(mode: .dual)].contains(url.standardizedFileURL) else { return nil }
        records[result.id] = result
        return result
    }

    public func cancel(operationID: UUID) async {
        let operation = operations.removeValue(forKey: operationID)
        if let id = operation?.jobID { await service.cancel(id: id) }
    }

    /// Used only for application shutdown. Reader commands cancel one operation.
    public func cancel() async {
        let jobs = operations.values.compactMap(\.jobID)
        operations.removeAll()
        for id in Set(jobs) { await service.cancel(id: id) }
    }

    public func latestResult(applicationBundleID: String? = nil, originalURL: URL? = nil) -> NativePDFTranslationResult? {
        // Only our bounded private cache is inspected; never the reader's files
        // or recent-document database. Reuse the same metadata validation.
        if let children = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            for directory in children where UUID(uuidString: directory.lastPathComponent) != nil {
                _ = result(forOutputURL: directory.appendingPathComponent("Translated.pdf"))
            }
        }
        return records.values.filter { result in
            (applicationBundleID == nil || result.applicationBundleID == applicationBundleID)
                && (originalURL == nil || result.originalURL.standardizedFileURL == originalURL?.standardizedFileURL)
                && Date().timeIntervalSince(result.createdAt) < 86_400
        }.max { $0.createdAt < $1.createdAt }
    }

    private func check(_ operation: UUID) throws {
        try Task.checkCancellation()
        guard operations[operation] != nil else { throw CancellationError() }
    }

    private func validate(_ job: PDFLayoutJob, pageCount: Int, pages: [Int]?) throws {
        try job.validate()
        guard job.pageCount == pageCount, job.sourcePages == (pages ?? Array(0..<pageCount)) else {
            throw NativePDFTranslationError.invalidOutput
        }
    }

    private static func validateOutput(_ data: Data, expectedPages: Int) throws {
        guard data.count <= 450 * 1_024 * 1_024, data.starts(with: Data("%PDF-".utf8)) else {
            throw NativePDFTranslationError.invalidOutput
        }
        // Validate PDF structure and page map without extracting or logging text.
        let document = try PDFTranslationDocument(data: data,
            limits: .init(maximumBytes: 450 * 1_024 * 1_024))
        guard document.pageCount == expectedPages else { throw NativePDFTranslationError.invalidOutput }
    }

    private func prepareRoot() throws {
        let files = FileManager.default
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try files.attributesOfItem(atPath: root.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
            throw NativePDFTranslationError.cacheUnavailable
        }
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    }

    private func write(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func isRegularPrivateFile(_ url: URL) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue else { return false }
        return permissions & 0o077 == 0
    }

    private func prune(keeping id: UUID) {
        let files = FileManager.default
        guard let children = try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        var candidates: [(UUID, URL, Date, Int64)] = []
        for directory in children {
            guard let candidateID = UUID(uuidString: directory.lastPathComponent),
                  let attributes = try? files.attributesOfItem(atPath: directory.path),
                  attributes[.type] as? FileAttributeType == .typeDirectory,
                  Self.isRegularPrivateFile(directory.appendingPathComponent("record.json")),
                  let bytes = try? Data(contentsOf: directory.appendingPathComponent("record.json")), bytes.count < 16_384,
                  let record = try? JSONDecoder().decode(NativePDFTranslationResult.self, from: bytes),
                  record.id == candidateID, record.directoryURL.standardizedFileURL == directory.standardizedFileURL else { continue }
            let size = ["Translated.pdf", "Comparison.pdf", "record.json"].reduce(Int64(0)) { total, name in
                total + (((try? files.attributesOfItem(atPath: directory.appendingPathComponent(name).path)[.size]) as? NSNumber)?.int64Value ?? 0)
            }
            candidates.append((candidateID, directory, record.createdAt, size))
        }
        candidates.sort { $0.2 > $1.2 }
        var count = candidates.count, bytes = candidates.reduce(Int64(0)) { $0 + $1.3 }
        for candidate in candidates.reversed() where candidate.0 != id {
            if Date().timeIntervalSince(candidate.2) > 86_400 || count > maximumRecords || bytes > maximumBytes {
                if (try? files.removeItem(at: candidate.1)) != nil {
                    records.removeValue(forKey: candidate.0); count -= 1; bytes -= candidate.3
                }
            }
        }
    }
}

import CoreGraphics
import CryptoKit
import Foundation
import PDFKit
import Vision

public struct PDFTranslationLimits: Sendable, Equatable {
    public static let `default` = PDFTranslationLimits()
    public let maximumBytes: Int
    public let maximumPages: Int
    public let maximumPageCharacters: Int
    public let maximumBlockCharacters: Int

    public init(maximumBytes: Int = 150 * 1_024 * 1_024, maximumPages: Int = 2_000,
                maximumPageCharacters: Int = 300_000, maximumBlockCharacters: Int = 1_800) {
        self.maximumBytes = max(1, maximumBytes)
        self.maximumPages = max(1, maximumPages)
        self.maximumPageCharacters = max(1, maximumPageCharacters)
        self.maximumBlockCharacters = min(1_800, max(1, maximumBlockCharacters))
    }
}

public enum PDFTranslationExtractionMethod: String, Sendable, Equatable {
    case textLayer, ocr, accessibility
}

public struct PDFTranslationBlock: Identifiable, Sendable, Equatable {
    public let blockID: String
    public let pageIndex: Int
    public let originalText: String
    public var id: String { blockID }

    public init(blockID: String, pageIndex: Int, originalText: String) {
        self.blockID = blockID; self.pageIndex = pageIndex; self.originalText = originalText
    }
}

public struct PDFTranslationPage: Sendable, Equatable {
    public let pageIndex: Int
    public let pageLabel: String
    public let blocks: [PDFTranslationBlock]
    public let extractionMethod: PDFTranslationExtractionMethod

    public init(pageIndex: Int, pageLabel: String, blocks: [PDFTranslationBlock], extractionMethod: PDFTranslationExtractionMethod) {
        self.pageIndex = pageIndex; self.pageLabel = pageLabel; self.blocks = blocks; self.extractionMethod = extractionMethod
    }
}

public enum PDFTranslationDocumentError: Error, LocalizedError, Sendable, Equatable {
    case nonLocalURL, unreadableFile, emptyInput, invalidPDF, lockedPDF, extractionRestricted
    case inputTooLarge(limitBytes: Int)
    case tooManyPages(limit: Int)
    case pageOutOfBounds(index: Int, count: Int)
    case pageTooLarge(index: Int, limit: Int)
    case noReadableText(pageIndex: Int)
    case unableToRenderPage(pageIndex: Int)
    case ocrFailed(pageIndex: Int)

    public var errorDescription: String? {
        switch self {
        case .nonLocalURL: return "请选择本机 PDF 文件。"
        case .unreadableFile: return "无法读取 PDF，请重新选择文件。"
        case .emptyInput, .invalidPDF: return "文件不是可读取的 PDF。"
        case .lockedPDF: return "PDF 已加密，请先在阅读器中解锁并保存可读取副本。"
        case .extractionRestricted: return "此 PDF 不允许提取文字。"
        case .inputTooLarge(let limit): return "PDF 超过本机读取上限（\(max(1, limit / 1_024 / 1_024)) MB）。"
        case .tooManyPages(let limit): return "PDF 超过 \(limit) 页，请先选择较小的文件。"
        case .pageOutOfBounds(let index, let count): return "第 \(index + 1) 页不存在，文件共有 \(count) 页。"
        case .pageTooLarge(let index, _): return "第 \(index + 1) 页文字过多，无法安全处理。"
        case .noReadableText(let index): return "第 \(index + 1) 页未识别到文字，可继续翻译其他页。"
        case .unableToRenderPage(let index): return "无法渲染第 \(index + 1) 页供本机文字识别。"
        case .ocrFailed(let index): return "第 \(index + 1) 页本机文字识别失败，可重试或继续其他页。"
        }
    }
}

/// Owns all mutable PDFKit objects. Only immutable text, metadata, and the original
/// file bytes leave this actor; OCR uses an image rendered from this file's page.
public actor PDFTranslationDocument: BilingualDocument {
    public nonisolated let pageCount: Int
    public nonisolated let title: String
    public nonisolated let documentID: String
    public nonisolated var kind: BilingualDocumentKind { .pdf }
    private let document: PDFDocument
    private let pdfData: Data
    private let limits: PDFTranslationLimits
    private let recognize: @Sendable (CGImage) async throws -> [PDFTranslationOCRLine]
    private var pageCache: [Int: PDFTranslationPage] = [:]
    private var cacheOrder: [Int] = []

    public init(data: Data, title: String? = nil, limits: PDFTranslationLimits = .default) throws {
        try self.init(data: data, title: title, limits: limits,
            recognize: { image in try await PDFTranslationOCR.recognize(image) })
    }

    init(data: Data, title: String? = nil, limits: PDFTranslationLimits = .default,
         recognize: @escaping @Sendable (CGImage) async throws -> [PDFTranslationOCRLine]) throws {
        try Task.checkCancellation()
        guard !data.isEmpty else { throw PDFTranslationDocumentError.emptyInput }
        guard data.count <= limits.maximumBytes else {
            throw PDFTranslationDocumentError.inputTooLarge(limitBytes: limits.maximumBytes)
        }
        guard let document = PDFDocument(data: data) else {
            throw PDFTranslationDocumentError.invalidPDF
        }
        guard !document.isLocked else { throw PDFTranslationDocumentError.lockedPDF }
        guard document.pageCount > 0 else { throw PDFTranslationDocumentError.invalidPDF }
        guard document.allowsCopying else { throw PDFTranslationDocumentError.extractionRestricted }
        guard document.pageCount <= limits.maximumPages else {
            throw PDFTranslationDocumentError.tooManyPages(limit: limits.maximumPages)
        }
        try Task.checkCancellation()
        self.document = document
        self.pdfData = data
        self.limits = limits
        self.recognize = recognize
        self.pageCount = document.pageCount
        let fileTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let metadataTitle = (document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = [fileTitle, metadataTitle].compactMap { $0 }.first { !$0.isEmpty } ?? "PDF 原文"
        self.documentID = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// This method never fetches remote URLs. The caller can separately obtain
    /// authorized bytes from Zotero's local API and use init(data:title:).
    public static func open(url: URL, limits: PDFTranslationLimits = .default) async throws -> PDFTranslationDocument {
        try Task.checkCancellation()
        guard url.isFileURL else { throw PDFTranslationDocumentError.nonLocalURL }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.resolvingSymlinksInPath().path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw PDFTranslationDocumentError.unreadableFile
            }
            if let size = attributes[.size] as? NSNumber, size.uint64Value > UInt64(limits.maximumBytes) {
                throw PDFTranslationDocumentError.inputTooLarge(limitBytes: limits.maximumBytes)
            }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var data = Data()
            // Recheck while reading: a file that grows after the size lookup
            // must not allocate an unbounded buffer or evade cancellation.
            while let chunk = try handle.read(upToCount: 1_024 * 1_024), !chunk.isEmpty {
                try Task.checkCancellation()
                guard chunk.count <= limits.maximumBytes - data.count else {
                    throw PDFTranslationDocumentError.inputTooLarge(limitBytes: limits.maximumBytes)
                }
                data.append(chunk)
            }
            try Task.checkCancellation()
            return try PDFTranslationDocument(data: data, title: url.deletingPathExtension().lastPathComponent, limits: limits)
        } catch is CancellationError { throw CancellationError() }
        catch let error as PDFTranslationDocumentError { throw error }
        catch { throw PDFTranslationDocumentError.unreadableFile }
    }

    /// A PDFView may create its own document from these bytes on the main actor.
    /// This retains the unmodified source and creates no exported copy on disk.
    public func originalPDFData() -> Data { pdfData }

    public func page(at index: Int) async throws -> PDFTranslationPage {
        try Task.checkCancellation()
        guard index >= 0, index < pageCount else {
            throw PDFTranslationDocumentError.pageOutOfBounds(index: index, count: pageCount)
        }
        if let cached = pageCache[index] {
            cacheOrder.removeAll { $0 == index }; cacheOrder.append(index)
            return cached
        }
        guard let page = document.page(at: index) else {
            throw PDFTranslationDocumentError.pageOutOfBounds(index: index, count: pageCount)
        }
        let rawText = page.string ?? ""
        try Task.checkCancellation()
        let method: PDFTranslationExtractionMethod
        let text: String
        if rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let image = try Self.render(page, pageIndex: index)
            do {
                let lines = try await recognize(image)
                try Task.checkCancellation()
                text = PDFTranslationOCR.readingText(lines)
            } catch is CancellationError { throw CancellationError() }
            catch { throw PDFTranslationDocumentError.ocrFailed(pageIndex: index) }
            method = .ocr
        } else { text = rawText; method = .textLayer }
        guard text.count <= limits.maximumPageCharacters else {
            throw PDFTranslationDocumentError.pageTooLarge(index: index, limit: limits.maximumPageCharacters)
        }
        let blocks = try PDFTranslationParagraphs.blocks(text: text, pageIndex: index,
            documentID: documentID, maximumCharacters: limits.maximumBlockCharacters)
        guard !blocks.isEmpty else { throw PDFTranslationDocumentError.noReadableText(pageIndex: index) }
        try Task.checkCancellation()
        let result = PDFTranslationPage(pageIndex: index, pageLabel: page.label ?? String(index + 1),
            blocks: blocks, extractionMethod: method)
        cacheOrder.removeAll { $0 == index }
        while cacheOrder.count >= 12 {
            pageCache.removeValue(forKey: cacheOrder.removeFirst())
        }
        cacheOrder.append(index); pageCache[index] = result
        return result
    }

    private static func render(_ page: PDFPage, pageIndex: Int) throws -> CGImage {
        try Task.checkCancellation()
        guard let source = page.pageRef else {
            throw PDFTranslationDocumentError.unableToRenderPage(pageIndex: pageIndex)
        }
        let bounds = source.getBoxRect(.cropBox)
        guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
            throw PDFTranslationDocumentError.unableToRenderPage(pageIndex: pageIndex)
        }
        // Bound bitmap memory regardless of the source's paper size or PDF DPI.
        let rotated = abs(Int64(source.rotationAngle)) % 180 == 90
        let width = rotated ? bounds.height : bounds.width
        let height = rotated ? bounds.width : bounds.height
        let scale = min(3, 2_400 / max(width, height))
        let pixelWidth = min(2_400, max(1, Int(ceil(width * scale))))
        let pixelHeight = min(2_400, max(1, Int(ceil(height * scale))))
        guard let context = CGContext(data: nil, width: pixelWidth, height: pixelHeight,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw PDFTranslationDocumentError.unableToRenderPage(pageIndex: pageIndex)
        }
        let destination = CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight)
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(destination)
        context.concatenate(source.getDrawingTransform(.cropBox, rect: destination, rotate: 0, preserveAspectRatio: true))
        context.drawPDFPage(source)
        try Task.checkCancellation()
        guard let image = context.makeImage() else {
            throw PDFTranslationDocumentError.unableToRenderPage(pageIndex: pageIndex)
        }
        return image
    }
}

enum PDFTranslationParagraphs {
    /// Joins visual line wraps, preserves hard hyphens/IDs/numbers, and only
    /// splits long paragraphs at whitespace where possible. It never reorders text.
    static func blocks(text: String, pageIndex: Int, documentID: String, maximumCharacters: Int) throws -> [PDFTranslationBlock] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let limit = min(1_800, max(1, maximumCharacters))
        var paragraphs: [String] = []
        var current = ""
        func flush() {
            if !current.isEmpty { paragraphs.append(current); current = "" }
        }
        for rawLine in normalized.components(separatedBy: "\n") {
            try Task.checkCancellation()
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { flush(); continue }
            if current.isEmpty { current = line }
            else if current.hasSuffix("\u{00AD}"),
                    let preceding = current.dropLast().unicodeScalars.last,
                    let following = line.unicodeScalars.first,
                    Self.isASCIILetter(preceding), Self.isASCIILetter(following) {
                current.removeLast(); current += line
            } else if current.hasSuffix("-") || current.hasSuffix("‐") {
                current += line
            } else { current += " " + line }
        }
        flush()
        var blocks: [PDFTranslationBlock] = []
        for paragraph in paragraphs {
            var remainder = paragraph[...]
            while !remainder.isEmpty {
                try Task.checkCancellation()
                let upper = remainder.index(remainder.startIndex, offsetBy: limit, limitedBy: remainder.endIndex) ?? remainder.endIndex
                var end = upper
                if upper != remainder.endIndex,
                   let split = remainder[..<upper].lastIndex(where: { $0.isWhitespace }), split > remainder.startIndex {
                    end = split
                }
                let chunk = String(remainder[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !chunk.isEmpty {
                    let contentHash = SHA256.hash(data: Data(chunk.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
                    let id = "\(documentID):p\(pageIndex):b\(blocks.count):\(contentHash)"
                    blocks.append(PDFTranslationBlock(blockID: id, pageIndex: pageIndex, originalText: chunk))
                }
                remainder = remainder[end...].drop(while: { $0.isWhitespace })
            }
        }
        return blocks
    }

    private static func isASCIILetter(_ scalar: Unicode.Scalar) -> Bool {
        (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
    }
}

struct PDFTranslationOCRLine: Sendable {
    let text: String
    let bounds: CGRect
}

enum PDFTranslationOCR {
    static func recognize(_ image: CGImage) async throws -> [PDFTranslationOCRLine] {
        try Task.checkCancellation()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US", "zh-Hans"]
        request.automaticallyDetectsLanguage = true
        // Do not spell-correct scientific identifiers or numerical measurements.
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        return try await withTaskCancellationHandler(operation: {
            try handler.perform([request])
            try Task.checkCancellation()
            return (request.results ?? []).compactMap { observation in
                guard let text = observation.topCandidates(1).first?.string else { return nil }
                return PDFTranslationOCRLine(text: text, bounds: observation.boundingBox)
            }
        }, onCancel: { request.cancel() })
    }

    static func readingText(_ rawLines: [PDFTranslationOCRLine]) -> String {
        let lines = rawLines.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        // PDFKit provides logical order for text PDFs. OCR needs explicit reading
        // order: recognize a clear two-column body, with spanning titles/captions
        // delimiting bands. Ambiguous layouts keep conservative visual line order.
        func topFirst(_ lhs: PDFTranslationOCRLine, _ rhs: PDFTranslationOCRLine) -> Bool {
            if lhs.bounds.midY != rhs.bounds.midY {
                return lhs.bounds.midY > rhs.bounds.midY
            }
            return lhs.bounds.minX < rhs.bounds.minX
        }
        let split: CGFloat = 0.5
        let left = lines.filter { $0.bounds.maxX < split }
        let right = lines.filter { $0.bounds.minX > split }
        let crossing = lines.filter { $0.bounds.minX <= split && $0.bounds.maxX >= split }
        let narrowCrossing = crossing.filter { $0.bounds.width < 0.65 }
        let twoColumns = left.count >= 3 && right.count >= 3 && narrowCrossing.count <= max(1, lines.count / 10)
        var ordered: [PDFTranslationOCRLine] = []
        if twoColumns {
            var remaining = left + right
            for spanning in crossing.sorted(by: topFirst) {
                let above = remaining.filter { $0.bounds.midY > spanning.bounds.midY }
                ordered += above.filter { $0.bounds.maxX < split }.sorted(by: topFirst)
                ordered += above.filter { $0.bounds.minX > split }.sorted(by: topFirst)
                remaining.removeAll { $0.bounds.midY > spanning.bounds.midY }
                ordered.append(spanning)
            }
            ordered += remaining.filter { $0.bounds.maxX < split }.sorted(by: topFirst)
            ordered += remaining.filter { $0.bounds.minX > split }.sorted(by: topFirst)
        } else { ordered = lines.sorted(by: topFirst) }
        return ordered.map(\.text).joined(separator: "\n")
    }
}

import Foundation
import AskGPTCore

/// A private JSONL worker, deliberately separate from selection translation.
/// stdout is protocol-only; requests and translations are never logged.
@main struct AskGPTTranslationWorker {
    private struct Request: Decodable {
        let id: String
        let text: String?
        let segments: [PDFTranslationSegment]?
        let context: PDFTranslationContext?
        let paragraphs: [PDFSentenceAlignmentParagraph]?
        let units: [PDFPhraseAlignmentUnit]?
        let source: String
        let target: String
    }
    private struct Response: Encodable {
        let id: String
        var translation: String?
        var translations: [PDFTranslationSegment]?
        var alignments: [String: [String]]?
        var firstDeltaSeconds: Double?
        var totalSeconds: Double?
        var error: String?
        var errorDetail: String?
    }

    static func main() async {
        let engine = NativeTranslationEngine(quality: .fast)
        let batchMode = CommandLine.arguments.dropFirst().elementsEqual(["--gpt-batch"])
        let alignmentMode = CommandLine.arguments.dropFirst().elementsEqual(["--gpt-align"])
        let phraseMode = CommandLine.arguments.dropFirst().elementsEqual(["--gpt-phrase-align"])
        let preferences = UserDefaults(suiteName: "local.askgpt.reader")
        let settings = preferences?.data(forKey: "codexSettings")
            .flatMap { try? JSONDecoder().decode(CodexSettings.self, from: $0) } ?? CodexSettings()
        let batch = batchMode ? PDFBatchTranslator(settings: settings) : nil
        let alignment = alignmentMode ? PDFSentenceAlignmentTranslator(settings: settings) : nil
        let phrase = phraseMode ? PDFPhraseAlignmentTranslator(settings: settings) : nil
        let lifecycle: TranslationHelperLifecycle?
        if let batch { lifecycle = TranslationHelperLifecycle { await batch.shutdown() } }
        else if let alignment { lifecycle = TranslationHelperLifecycle { await alignment.shutdown() } }
        else if let phrase { lifecycle = TranslationHelperLifecycle { await phrase.shutdown() } }
        else { lifecycle = nil }
        lifecycle?.start()
        while let line = readLine(strippingNewline: true) {
            if lifecycle?.isShuttingDown == true { break }
            guard let bytes = line.data(using: .utf8), bytes.count <= ((batchMode || alignmentMode || phraseMode) ? 256 * 1_024 : 65_536),
                  let request = try? JSONDecoder().decode(Request.self, from: bytes) else {
                write(Response(id: "", error: "invalid_request")); continue
            }
            guard !request.id.isEmpty, request.id.utf8.count <= 128,
                  ["en", "zh-Hans"].contains(request.source),
                  ["en", "zh-Hans"].contains(request.target), request.source != request.target else {
                write(Response(id: request.id, error: "invalid_request")); continue
            }
            do {
                if let phrase {
                    guard request.text == nil, request.segments == nil, request.paragraphs == nil, request.context == nil, let units = request.units else {
                        write(Response(id: request.id, error: "invalid_request")); continue
                    }
                    let result = try await phrase.align(units, source: request.source, target: request.target)
                    writePhrase(id: request.id, result: result)
                } else if let alignment {
                    guard request.text == nil, request.segments == nil, request.units == nil, request.context == nil, let paragraphs = request.paragraphs else {
                        write(Response(id: request.id, error: "invalid_request")); continue
                    }
                    let result = try await alignment.align(paragraphs, source: request.source, target: request.target)
                    write(Response(id: request.id, alignments: result.alignments,
                        firstDeltaSeconds: result.firstDeltaSeconds, totalSeconds: result.totalSeconds))
                } else if let batch {
                    guard request.text == nil, request.paragraphs == nil, request.units == nil, let segments = request.segments else {
                        write(Response(id: request.id, error: "invalid_request")); continue
                    }
                    let result = try await batch.translate(segments, source: request.source, target: request.target, context: request.context)
                    write(Response(id: request.id, translations: result.translations,
                        firstDeltaSeconds: result.firstDeltaSeconds, totalSeconds: result.totalSeconds))
                } else {
                    guard let text = request.text, request.segments == nil, request.paragraphs == nil, request.units == nil, request.context == nil, (1...1_800).contains(text.unicodeScalars.count) else {
                        write(Response(id: request.id, error: "invalid_request")); continue
                    }
                    let result = try await engine.translate(text,
                        sourceLanguage: request.source, targetLanguage: request.target)
                    write(Response(id: request.id, translation: result.text))
                }
            } catch {
                let code: String
                if phraseMode {
                    code = error is PDFPhraseAlignmentError ? "alignment_invalid" : "gpt_unavailable"
                } else if alignmentMode {
                    code = error is PDFSentenceAlignmentError ? "alignment_invalid" : "gpt_unavailable"
                } else if batchMode {
                    code = error is PDFBatchTranslationError ? "batch_invalid" : "gpt_unavailable"
                } else { switch error as? NativeTranslationError {
                case .languagePackMissing: code = "language_pack_missing"
                case .unsupportedLanguagePair: code = "unsupported_language"
                case .unavailable: code = "translation_unavailable"
                case .timedOut: code = "translation_timeout"
                default: code = "translation_failed"
                } }
                let detail = phraseMode && code == "alignment_invalid" ? await phrase?.lastValidationReason?.rawValue
                    : alignmentMode && code == "alignment_invalid" ? await alignment?.lastValidationReason?.rawValue
                    : batchMode && code == "batch_invalid" ? await batch?.lastValidationReason?.rawValue : nil
                write(Response(id: request.id, error: code, errorDetail: detail))
            }
            if lifecycle?.isShuttingDown == true { break }
        }
        await lifecycle?.shutdownAndWait()
    }

    private static func writePhrase(id: String, result: PDFPhraseAlignmentResult) {
        // Keep the same external `alignments` JSONL field while the two modes
        // use different statically checked value types.
        struct PhraseResponse: Encodable {
            let id: String
            let alignments: [String: [PDFPhraseAlignmentGroup]]
            let firstDeltaSeconds: Double?
            let totalSeconds: Double
        }
        guard var data = try? JSONEncoder().encode(PhraseResponse(id: id, alignments: result.alignments, firstDeltaSeconds: result.firstDeltaSeconds, totalSeconds: result.totalSeconds)) else { return }
        data.append(10); try? FileHandle.standardOutput.write(contentsOf: data)
    }

    private static func write(_ response: Response) {
        guard var data = try? JSONEncoder().encode(response) else { return }
        data.append(10)
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
}

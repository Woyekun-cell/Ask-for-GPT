import AppKit
import AskGPTCore

@main struct AskGPTApplication {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--word-writing-probe") {
            runWordWritingProbe()
            return
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }

    /// Runs inside the fixed app identity. It does not start services, open a
    /// window, request permission, or print document text.
    @MainActor private static func runWordWritingProbe() {
        struct Input: Decodable {
            let expectedParagraph: String
            let issueStartUTF16: Int
            let issueLengthUTF16: Int
            let original: String
        }
        do {
            let arguments = CommandLine.arguments
            guard let index = arguments.firstIndex(of: "--probe-input"), index + 1 < arguments.count else {
                throw CocoaError(.fileReadInvalidFileName)
            }
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: arguments[index + 1]))
            defer { try? handle.close() }
            let bytes = try handle.read(upToCount: 32_769) ?? Data()
            guard bytes.count <= 32_768 else { throw CocoaError(.fileReadTooLarge) }
            let input = try JSONDecoder().decode(Input.self, from: bytes)
            let result = WordInlineGeometry.probe(.init(expectedParagraph: input.expectedParagraph,
                issueStartUTF16: input.issueStartUTF16, issueLengthUTF16: input.issueLengthUTF16,
                original: input.original))
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            FileHandle.standardOutput.write(try encoder.encode(result))
            FileHandle.standardOutput.write(Data("\n".utf8))
            exit(result.status == "geometry_verified" ? 0 : 2)
        } catch {
            FileHandle.standardError.write(Data("WORD_WRITING_PROBE_INPUT_FAILED\n".utf8))
            exit(1)
        }
    }
}

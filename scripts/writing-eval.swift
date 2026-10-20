import Foundation
import AskGPTCore

// This helper has no listener, app identity, TLS setup or document host. It reuses production services.
private struct EvaluationInput: Decodable {
    let rawText: String
    let contextBefore: String
    let contextAfter: String
    let profile: WritingProfile
    let targetRange: UTF16Range
    let protectedRanges: [UTF16Range]
}
private struct EvaluationCase: Decodable {
    let id: String
    let mode: WritingCheckMode
    let input: EvaluationInput
}
private struct EvaluationJob: Decodable {
    let repository: String
    let runID: String
    let cases: [EvaluationCase]
}
private struct EvaluationRecord: Encodable {
    let id: String
    let mode: WritingCheckMode
    let requestID: String
    let elapsedSeconds: Double
    let result: WritingCheckResult?
    let errorType: String?
}
@main struct WritingEvaluation {
    static func main() async {
        var service: WritingService?
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count < 200_000 else { throw WritingServiceError.inputTooLong }
            let job = try JSONDecoder().decode(EvaluationJob.self, from: data)
            guard !job.cases.isEmpty, job.cases.count <= 6 else { throw WritingServiceError.invalidSnapshot }
            let repository = URL(fileURLWithPath: job.repository)
            let skill = try WritingSkill.load(from: repository.appendingPathComponent("Resources/Writing/skill"))
            let instance = WritingService(settings: CodexSettings(), skill: skill)
            service = instance
            var records: [EvaluationRecord] = []
            for item in job.cases {
                let requestID = job.runID + ":" + item.id
                let snapshot = WritingSnapshot(requestID: requestID, documentSessionID: "public-synthetic-evaluation-" + job.runID,
                    blockID: item.id, revision: "frozen-2026-10-17", rawText: item.input.rawText,
                    contextBefore: item.input.contextBefore, contextAfter: item.input.contextAfter,
                    targetRange: item.input.targetRange, protectedRanges: item.input.protectedRanges, pageIndices: [1], scope: .selection)
                let start = ProcessInfo.processInfo.systemUptime
                do {
                    let result = try await instance.check(snapshot, mode: item.mode, profile: item.input.profile)
                    records.append(.init(id: item.id, mode: item.mode, requestID: requestID,
                        elapsedSeconds: ProcessInfo.processInfo.systemUptime - start, result: result, errorType: nil))
                    FileHandle.standardError.write(Data("WRITING_CASE_COMPLETED \(item.id) \(item.mode.rawValue)\n".utf8))
                } catch {
                    // Preserve failure state without logging prompt, CLI output, credentials or manuscript content.
                    records.append(.init(id: item.id, mode: item.mode, requestID: requestID,
                        elapsedSeconds: ProcessInfo.processInfo.systemUptime - start, result: nil,
                        errorType: String(reflecting: type(of: error))))
                    FileHandle.standardError.write(Data("WRITING_CASE_FAILED \(item.id)\n".utf8))
                }
            }
            await instance.shutdown(); service = nil
            FileHandle.standardOutput.write(try JSONEncoder().encode(records))
        } catch {
            if let service { await service.shutdown() }
            FileHandle.standardError.write(Data("WRITING_EVAL_HELPER_FAILED\n".utf8))
            exit(1)
        }
    }
}

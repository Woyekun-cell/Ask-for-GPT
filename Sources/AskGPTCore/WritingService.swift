import Foundation

public enum WritingServiceError: Error, LocalizedError, Equatable, Sendable {
    case invalidSnapshot, inputTooLong, invalidProfile, invalidModelOutput, unsupportedSkill, shutDown
    case spellCheckingUnavailable, spellCheckingTimeout, invalidSpellingResult

    public var errorDescription: String? {
        switch self {
        case .invalidSnapshot: return "写作快照不完整，请重新捕获原文。"
        case .inputTooLong: return "检查范围过长：目标最多 4000 UTF-16，上下文合计最多 2000，请缩小范围。"
        case .invalidProfile: return "写作偏好无效，请选择美式或英式拼写及有效风格。"
        case .invalidModelOutput: return "语言审核未返回完整有效的建议，未生成可接受修改。"
        case .unsupportedSkill: return "内置写作规则不可用，请重新加载规则。"
        case .shutDown: return "写作服务已关闭。"
        case .spellCheckingUnavailable: return "本机拼写词典不可用，本段尚未完成检查。"
        case .spellCheckingTimeout: return "本机拼写检查超时，本段尚未完成检查。"
        case .invalidSpellingResult: return "本机拼写结果无法安全定位，本段尚未完成检查。"
        }
    }
}

/// Validates even empty suggestion arrays; the issue validator alone cannot do that.
enum WritingSnapshotPreflight {
    static func validate(_ snapshot: WritingSnapshot, profile: WritingProfile) throws {
        try Task.checkCancellation()
        guard [snapshot.requestID, snapshot.documentSessionID, snapshot.blockID, snapshot.revision]
            .allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= 512 }),
              !snapshot.rawText.isEmpty, snapshot.pageIndices.allSatisfy({ $0 >= 0 }) else {
            throw WritingServiceError.invalidSnapshot
        }
        guard snapshot.snapshotHash == WritingSnapshot.hash(rawText: snapshot.rawText) else {
            throw WritingValidationError.snapshotHashMismatch
        }
        guard snapshot.contextHash == WritingSnapshot.hash(contextBefore: snapshot.contextBefore, contextAfter: snapshot.contextAfter) else {
            throw WritingValidationError.contextHashMismatch
        }
        let count = snapshot.rawText.utf16.count
        let contextCount = snapshot.contextBefore.utf16.count + snapshot.contextAfter.utf16.count
        guard count <= 4000, contextCount <= 2000, count + contextCount <= 6000 else {
            throw WritingServiceError.inputTooLong
        }
        let boundaries = graphemeBoundaries(snapshot.rawText)
        try validate(snapshot.targetRange, count: count, boundaries: boundaries)
        guard snapshot.targetRange.length > 0 else { throw WritingServiceError.invalidSnapshot }
        for range in snapshot.protectedRanges { try validate(range, count: count, boundaries: boundaries) }
        guard ["en-US", "en-GB"].contains(profile.spellingVariant), ["minimal", "clarity"].contains(profile.style),
              profile.customTerms.count <= 1000,
              profile.customTerms.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 256 }),
              profile.customTerms.reduce(0, { $0 + $1.utf8.count }) <= 128_000 else {
            throw WritingServiceError.invalidProfile
        }
    }

    static func graphemeBoundaries(_ text: String) -> Set<Int> {
        var boundaries: Set<Int> = [0]
        var offset = 0
        for character in text { offset += String(character).utf16.count; boundaries.insert(offset) }
        return boundaries
    }

    static func validate(_ range: UTF16Range, count: Int, boundaries: Set<Int>) throws {
        guard range.start >= 0, range.length >= 0, let end = range.end, end <= count else {
            throw WritingValidationError.invalidRange
        }
        guard boundaries.contains(range.start), boundaries.contains(end) else {
            throw WritingValidationError.invalidGraphemeBoundary
        }
    }

    static func merged(_ profile: WritingProfile, skill: WritingSkill) -> WritingProfile {
        var result = profile
        var seen: Set<Data> = []
        result.customTerms = (skill.profile.customTerms + skill.defaultTerms + profile.customTerms).filter {
            seen.insert(Data($0.utf8)).inserted
        }
        return result
    }
}

/// Local checks run independently. Model checks use one queue whose predecessor includes
/// session cleanup. Cancelling a caller never permits a replacement model turn to race it.
public actor WritingService {
    private let skill: WritingSkill
    private let local: LocalProofreader
    private let reviewer: GPTWritingReviewer
    private var requests: [UUID: Request] = [:]
    private var cancellations: [UUID: WritingCheckStatus] = [:]
    private var modelTail: (id: UUID, task: Task<WritingCheckResult, Error>)?
    private var isShutDown = false

    public init(settings: CodexSettings, skill: WritingSkill) {
        self.skill = skill
        local = LocalProofreader()
        reviewer = GPTWritingReviewer(settings: settings, skill: skill)
    }

    init(skill: WritingSkill, spellProvider: any WritingSpellProvider, backend: any WritingReviewBackend) {
        self.skill = skill
        local = LocalProofreader(provider: spellProvider)
        reviewer = GPTWritingReviewer(backend: backend, skill: skill)
    }

    public func check(_ snapshot: WritingSnapshot, mode: WritingCheckMode, profile: WritingProfile) async throws -> WritingCheckResult {
        guard !isShutDown else { throw WritingServiceError.shutDown }
        let profile = WritingSnapshotPreflight.merged(profile, skill: skill)
        try WritingSnapshotPreflight.validate(snapshot, profile: profile)
        let identity = SnapshotIdentity(snapshot)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let profileIdentity = try encoder.encode(profile)
        // A mode/request-ID change alone does not invalidate a healthy model check.
        for (id, request) in requests where request.identity.document == identity.document
            && request.identity.block == identity.block
            && (request.identity != identity || request.profile != profileIdentity) {
            cancellations[id] = .stale
            request.task.cancel()
        }
        let id = UUID()
        let previous = mode == .polish ? modelTail?.task : nil
        let local = local, reviewer = reviewer
        let task = Task<WritingCheckResult, Error> {
            _ = try? await previous?.value
            try Task.checkCancellation()
            switch mode {
            case .spelling:
                let issues = try await local.check(snapshot, profile: profile)
                try Task.checkCancellation()
                return .init(requestID: snapshot.requestID, snapshotHash: snapshot.snapshotHash,
                             skillVersion: "local-1", status: .completed, issues: issues)
            case .polish:
                return try await reviewer.review(snapshot, profile: profile)
            }
        }
        requests[id] = Request(requestID: snapshot.requestID, identity: identity, profile: profileIdentity, task: task)
        if mode == .polish { modelTail = (id, task) }
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            let cancelled = cancellations[id] ?? (Task.isCancelled ? .cancelled : nil)
            finish(id)
            if let cancelled { return emptyResult(snapshot, mode: mode, status: cancelled) }
            return result
        } catch {
            let cancelled = cancellations[id] ?? ((error is CancellationError || Task.isCancelled) ? .cancelled : nil)
            finish(id)
            if let cancelled { return emptyResult(snapshot, mode: mode, status: cancelled) }
            throw error
        }
    }

    public func cancel(requestID: String) async {
        let affected = requests.filter { $0.value.requestID == requestID }
        for (id, request) in affected {
            if cancellations[id] == nil { cancellations[id] = .cancelled }
            request.task.cancel()
        }
        for request in affected.values { _ = try? await request.task.value }
    }

    public func shutdown() async {
        guard !isShutDown else { return }
        isShutDown = true
        let affected = requests
        for (id, request) in affected {
            if cancellations[id] == nil { cancellations[id] = .cancelled }
            request.task.cancel()
        }
        for request in affected.values { _ = try? await request.task.value }
        await reviewer.shutdown()
    }

    private func finish(_ id: UUID) {
        requests.removeValue(forKey: id); cancellations.removeValue(forKey: id)
        if modelTail?.id == id { modelTail = nil }
    }

    private func emptyResult(_ snapshot: WritingSnapshot, mode: WritingCheckMode, status: WritingCheckStatus) -> WritingCheckResult {
        .init(requestID: snapshot.requestID, snapshotHash: snapshot.snapshotHash,
              skillVersion: mode == .spelling ? "local-1" : skill.version, status: status, issues: [])
    }

    private struct Request {
        let requestID: String
        let identity: SnapshotIdentity
        let profile: Data
        let task: Task<WritingCheckResult, Error>
    }
    private struct SnapshotIdentity: Equatable {
        let document: String, block: String, revision: String, hash: String, contextHash: String
        let target: UTF16Range, protected: [UTF16Range], scope: WritingScope
        init(_ snapshot: WritingSnapshot) {
            document = snapshot.documentSessionID; block = snapshot.blockID; revision = snapshot.revision
            hash = snapshot.snapshotHash; contextHash = snapshot.contextHash
            target = snapshot.targetRange; protected = snapshot.protectedRanges; scope = snapshot.scope
        }
    }
}

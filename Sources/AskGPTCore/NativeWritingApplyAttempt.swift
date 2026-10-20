import Foundation

/// One explicit acceptance. A dispatched handle is never offered for retry.
public final class NativeWritingApplyAttempt {
    public enum GuardCode: String, Error, Sendable {
        case cancelled, superseded, foreground, noActiveDocument, leaseChanged, epochChanged
        case candidateUnavailable, candidateChanged, notApplicable
    }
    public enum Outcome: String, Sendable { case completed, rejected, cancelled, unknown }
    public struct Resolution: Equatable, Sendable {
        public let outcome: Outcome
        public let retryCandidate: NativeWritingDocumentIssue?
        public let message: String?
    }
    private let leaseID: String
    private let documentSessionID: String
    private let epoch: Int
    private let bound: NativeWritingDocumentIssue
    private var finished = false
    private var receiptAllowed = false
    public private(set) var commandEnqueued = false
    public var awaitingReceipt: Bool { commandEnqueued && !finished }
    /// A receipt can survive its command's epoch advance or lease expiry. It is
    /// never a candidate or write permission, and cannot follow another document.
    public func permitsReceipt(document: NativeWritingActiveDocument?) -> Bool {
        guard commandEnqueued, receiptAllowed else { return false }
        guard let document else { return true }
        return document.leaseID == leaseID && document.documentSessionID == documentSessionID
    }

    public init(document: NativeWritingActiveDocument, candidate: NativeWritingDocumentIssue) {
        leaseID = document.leaseID; documentSessionID = document.documentSessionID
        epoch = document.state.epoch; bound = candidate
    }
    public func guardCode(document: NativeWritingActiveDocument?, candidate: NativeWritingDocumentIssue?, foregroundAllowed: Bool, generationMatches: Bool, cancelled: Bool) -> GuardCode? {
        if cancelled { return .cancelled }
        if !generationMatches { return .superseded }
        if !foregroundAllowed { return .foreground }
        guard let document, document.state.active, document.state.visibility == .hidden,
              [.ready, .preview].contains(document.state.status) else { return .noActiveDocument }
        guard document.leaseID == leaseID, document.documentSessionID == documentSessionID else { return .leaseChanged }
        guard document.state.epoch == epoch else { return .epochChanged }
        guard let candidate else { return .candidateUnavailable }
        guard candidate.handle == bound.handle, candidate.envelope == bound.envelope else { return .candidateChanged }
        return candidate.canApply ? nil : .notApplicable
    }
    public func markEnqueued() { commandEnqueued = true; receiptAllowed = true }
    public func finish(status: NativeWritingCommandCompletion.Status, code: String) -> Resolution {
        finished = true
        guard commandEnqueued else { return .init(outcome: .rejected, retryCandidate: nil, message: Self.message(for: "candidateUnavailable")) }
        if status == .completed, code == "applied" {
            receiptAllowed = false
            return .init(outcome: .completed, retryCandidate: nil, message: nil)
        }
        if status == .rejected { return .init(outcome: .rejected, retryCandidate: nil, message: Self.message(for: code)) }
        return .init(outcome: .unknown, retryCandidate: nil, message: Self.unknownMessage)
    }
    public func fail(code: String, cancelled: Bool, document: NativeWritingActiveDocument?, candidate: NativeWritingDocumentIssue?) -> Resolution {
        finished = true
        if commandEnqueued { return .init(outcome: .unknown, retryCandidate: nil, message: Self.unknownMessage) }
        if cancelled { return .init(outcome: .cancelled, retryCandidate: nil, message: nil) }
        let retry = guardCode(document: document, candidate: candidate, foregroundAllowed: true, generationMatches: true, cancelled: false) == nil ? candidate : nil
        return .init(outcome: .rejected, retryCandidate: retry, message: Self.message(for: code))
    }
    private static let unknownMessage = "Word 未确认修改结果。请先查看原文，再重新打开建议；本次不会自动重试。"
    public static func message(for code: String) -> String {
        switch code {
        case "暂无替换候选。", "受保护内容，仅预览。", "保留词典术语，仅预览。", "此候选会拆分字符，仅预览。", "此候选包含段落或控制字符，仅预览。": return code
        case "preparing": return "正在核对这处文字，请稍候。"
        case "foreground", "document_inactive": return "请回到原 Word 文档后重试。"
        case "protectedRange", "readOnly", "previewOnly", "preview_only", "notApplicable": return "此处包含受保护内容或复杂格式，无法安全替换。"
        case "invalidReplacement", "reviewOnly": return "这项建议无法直接替换，请在正文中修改。"
        case "leaseChanged", "epochChanged", "candidateChanged", "candidateUnavailable", "staleSnapshot", "stale_epoch", "unknown_handle", "superseded": return "原文或建议已变化，请重新打开建议。"
        case "noActiveDocument", "temporary_unavailable", "unavailable", "busy", "ambiguousActiveDocument", "active_window_unavailable": return "暂时无法核对当前 Word 文档，请重试。"
        default:
            // Legacy preview reasons were English prose; never expose raw API diagnostics.
            if code.localizedCaseInsensitiveContains("protected") || code.localizedCaseInsensitiveContains("formatting") { return "此处包含受保护内容或复杂格式，无法安全替换。" }
            if code.localizedCaseInsensitiveContains("field") { return "Word 无法核对这处字段，请在正文中手动修改。" }
            if code.localizedCaseInsensitiveContains("stale") || code.localizedCaseInsensitiveContains("changed") { return "原文或建议已变化，请重新打开建议。" }
            return "本次未能替换，请重试；若仍失败，请重新打开建议。"
        }
    }
}

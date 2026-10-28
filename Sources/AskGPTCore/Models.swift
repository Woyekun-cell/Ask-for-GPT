import Foundation

public struct SelectedExcerpt: Equatable, Codable, Sendable {
    public var text: String
    public var sourceBundleID: String
    public var sourceName: String
    public init(text: String, sourceBundleID: String = "manual", sourceName: String = "粘贴原文") {
        self.text = text; self.sourceBundleID = sourceBundleID; self.sourceName = sourceName
    }
    public var identity: String {
        sourceBundleID + "\u{0000}" + text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public struct CodexSettings: Equatable, Codable, Sendable {
    public var cliPath: String
    public var model: String
    public var reasoningEffort: String
    public init(cliPath: String = "/opt/homebrew/bin/codex", model: String = "gpt-6.1-sol", reasoningEffort: String = "low") {
        self.cliPath = cliPath; self.model = model; self.reasoningEffort = reasoningEffort
    }
}

public struct ChatMessage: Identifiable, Equatable, Sendable {
    public enum Role: String, Sendable { case user, assistant }
    public var id: UUID
    public var role: Role
    public var text: String
    public var completed: Bool
    public init(id: UUID = UUID(), role: Role, text: String, completed: Bool = true) {
        self.id = id; self.role = role; self.text = text; self.completed = completed
    }
}

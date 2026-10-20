import Foundation

public struct AnswerTicket: Equatable, Sendable {
    public let id: UUID
    public let assistantMessageID: UUID
}

public struct ConversationLedger: Sendable {
    public private(set) var excerpt: SelectedExcerpt?
    public private(set) var messages: [ChatMessage] = []
    public private(set) var activeTicket: AnswerTicket?
    public init() {}

    public mutating func startNewConversation() {
        excerpt = nil
        messages = []
        activeTicket = nil
    }

    @discardableResult public mutating func adopt(_ value: SelectedExcerpt) -> Bool {
        guard value.identity != excerpt?.identity else { return false }
        excerpt = value
        messages = []
        activeTicket = nil
        return true
    }

    public mutating func beginAnswer(question: String) -> AnswerTicket {
        let assistant = ChatMessage(role: .assistant, text: "", completed: false)
        let ticket = AnswerTicket(id: UUID(), assistantMessageID: assistant.id)
        messages.append(ChatMessage(role: .user, text: question))
        messages.append(assistant)
        activeTicket = ticket
        return ticket
    }

    public mutating func appendDelta(_ text: String, ticket: AnswerTicket) {
        guard ticket == activeTicket, let index = messages.firstIndex(where: { $0.id == ticket.assistantMessageID }) else { return }
        messages[index].text += text
    }

    public mutating func finish(_ text: String, ticket: AnswerTicket) {
        guard ticket == activeTicket, let index = messages.firstIndex(where: { $0.id == ticket.assistantMessageID }) else { return }
        messages[index].text = text
        messages[index].completed = true
        activeTicket = nil
    }

    public mutating func cancel(ticket: AnswerTicket) {
        guard ticket == activeTicket else { return }
        activeTicket = nil
    }
}

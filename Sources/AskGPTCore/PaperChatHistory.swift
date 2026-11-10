import CryptoKit
import Darwin
import Foundation

public struct PaperChatRecord: Codable, Equatable, Sendable {
    public var lastScope: String
    public var nearby: [ChatMessage]
    public var whole: [ChatMessage]
    public var documentDigest: String?

    public init(lastScope: String = "nearby", nearby: [ChatMessage] = [],
                whole: [ChatMessage] = [], documentDigest: String? = nil) {
        self.lastScope = lastScope
        self.nearby = nearby
        self.whole = whole
        self.documentDigest = documentDigest
    }
}

/// Private per-attachment archives. Keys are opaque and never used as path components.
public struct PaperChatHistory: Sendable {
    private let directory: URL
    private static let maximumRecordSize = 16 * 1024 * 1024

    public init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        self.init(directory: support.appendingPathComponent("AskGPTReader/PaperChatHistory", isDirectory: true))
    }

    public init(directory: URL) { self.directory = directory }

    public func load(key: String) throws -> PaperChatRecord {
        guard let folder = try openDirectory(create: false) else { return .init() }
        defer { close(folder) }
        return try Self.readRecord(in: folder, digest: Self.keyDigest(key)) ?? .init()
    }

    private static func readRecord(in folder: Int32, digest: String) throws -> PaperChatRecord? {
        let descriptor = openat(folder, digest, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw StorageError.unavailable }

        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        do {
            var info = stat()
            guard fstat(descriptor, &info) == 0,
                  info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  info.st_uid == geteuid(), info.st_mode & 0o777 == 0o600, info.st_nlink == 1,
                  info.st_size > 0, info.st_size <= Self.maximumRecordSize, Self.hasNoACL(descriptor),
                  let data = try handle.read(upToCount: Self.maximumRecordSize + 1),
                  data.count <= Self.maximumRecordSize else { throw StorageError.unavailable }
            let record = try JSONDecoder().decode(StoredRecord.self, from: data)
            guard record.keyDigest == digest else { throw StorageError.unavailable }
            return try Self.validated(record.chat)
        } catch {
            throw StorageError.unavailable
        }
    }

    public func save(_ chat: PaperChatRecord, key: String) throws {
        let digest = Self.keyDigest(key)
        let record = StoredRecord(keyDigest: digest, chat: try Self.validated(chat))
        let data = try JSONEncoder().encode(record)
        guard data.count <= Self.maximumRecordSize,
              let folder = try openDirectory(create: true) else { throw StorageError.unavailable }
        defer { close(folder) }

        let temporary = "." + UUID().uuidString
        let descriptor = openat(folder, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw StorageError.unavailable }
        defer { unlinkat(folder, temporary, 0) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        guard fchmod(descriptor, 0o600) == 0, Self.hasNoACL(descriptor) else { throw StorageError.unavailable }
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
        } catch {
            throw StorageError.unavailable
        }
        // Preserve an unreadable or mismatched archive for recovery.
        _ = try Self.readRecord(in: folder, digest: digest)
        guard renameat(folder, temporary, folder, digest) == 0 else { throw StorageError.unavailable }
    }

    private func openDirectory(create: Bool) throws -> Int32? {
        if create {
            do {
                try FileManager.default.createDirectory(at: directory.deletingLastPathComponent(),
                                                       withIntermediateDirectories: true)
            } catch {
                throw StorageError.unavailable
            }
            guard mkdir(directory.path, mode_t(0o700)) == 0 || errno == EEXIST else { throw StorageError.unavailable }
        }
        let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT && !create { return nil }
        guard descriptor >= 0 else { throw StorageError.unavailable }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == geteuid(),
              info.st_mode & 0o777 == 0o700, Self.hasNoACL(descriptor) else {
            close(descriptor)
            throw StorageError.unavailable
        }
        return descriptor
    }

    private static func hasNoACL(_ descriptor: Int32) -> Bool {
        guard let acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) else { return errno == ENOENT }
        acl_free(UnsafeMutableRawPointer(acl))
        return false
    }

    private static func keyDigest(_ key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func validated(_ chat: PaperChatRecord) throws -> PaperChatRecord {
        guard chat.lastScope == "nearby" || chat.lastScope == "whole",
              chat.documentDigest.map({ digest in
                  digest.utf8.count == 64 && digest.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
              }) ?? true else { throw StorageError.unavailable }
        var sanitized = chat
        sanitized.nearby = chat.nearby.filter { $0.completed && !$0.text.isEmpty }
        sanitized.whole = chat.whole.filter { $0.completed && !$0.text.isEmpty }
        return sanitized
    }

    private struct StoredRecord: Codable {
        let keyDigest: String
        let chat: PaperChatRecord
    }

    private enum StorageError: LocalizedError {
        case unavailable

        var errorDescription: String? { "Local paper chat history could not be accessed securely." }
    }
}

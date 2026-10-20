import Foundation
import Darwin
import Testing
@testable import AskGPTCore

struct RPCShutdownTests {
    @Test func closeWaitsForIndependentlyGroupedTermIgnoringCLI() async throws {
        try await verifyClose(cancelCaller: false)
    }

    @Test func cancelledCallerStillWaitsForOwnedCLIToExit() async throws {
        try await verifyClose(cancelCaller: true)
    }

    private func verifyClose(cancelCaller: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("owned-fixture")
        let marker = root.appendingPathComponent("child.pid")
        try "#!/bin/sh\ntrap '' TERM\nprintf '%s' \"$$\" > \"$1\"\nexec /bin/sleep 30\n".write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let rpc = try CodexRPCConnection(executable: executable.path, arguments: [marker.path],
            workingDirectory: root, environment: ProcessInfo.processInfo.environment)
        let pid: Int32
        do {
            pid = try await readyPID(marker: marker, rpc: rpc)
        } catch {
            await rpc.close()
            throw error
        }
        defer { if kill(pid, 0) == 0 { _ = kill(pid, SIGKILL) } }
        #expect(getpgid(pid) == pid)
        #expect(getpgid(pid) != getpgrp())
        let close = Task { await rpc.close() }
        if cancelCaller { close.cancel() }
        await close.value
        #expect(kill(pid, 0) == -1)
        #expect(errno == ESRCH)
    }

    private func readyPID(marker: URL, rpc: CodexRPCConnection) async throws -> Int32 {
        let readiness = RPCFixtureReadiness()
        await rpc.beginReading()
        let observer = Task {
            for await event in rpc.events {
                if event.value["method"] as? String == "askgpt/connectionClosed" {
                    await readiness.closed()
                    break
                }
            }
        }
        defer { observer.cancel() }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            // Creation and printf are separate operations. Accept only a
            // complete PID rather than treating an existing empty file as ready.
            if let value = try? String(contentsOf: marker, encoding: .utf8),
               let identity = Int32(value), identity > 1 {
                return identity
            }
            if await readiness.didClose { throw RPCFixtureReadinessError.exitedBeforeReady }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        throw RPCFixtureReadinessError.readyDeadlineExceeded
    }
}

private actor RPCFixtureReadiness {
    private(set) var didClose = false
    func closed() { didClose = true }
}

private enum RPCFixtureReadinessError: Error {
    case exitedBeforeReady
    case readyDeadlineExceeded
}

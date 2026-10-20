import Foundation
import Darwin
import Testing
@testable import AskGPTCore

struct PDFLayoutServiceTests {
    @Test(.enabled(if: PDFLayoutLifecycleFixture.productionRuntimeAvailable))
    func productionServerRecoversWhenRetiringLockOutlivesHealthListener() async throws {
        let fixture = try PDFLayoutLifecycleFixture(realProductionServer: true)
        defer { fixture.cleanup() }
        let lockPath = fixture.directory.appendingPathComponent("server.lock").path
        let marker = fixture.directory.appendingPathComponent("lock-held")
        let holder = Process()
        holder.executableURL = fixture.python
        holder.arguments = ["-c", "import fcntl,pathlib,sys,time; h=open(sys.argv[1],'w'); fcntl.flock(h,fcntl.LOCK_EX); pathlib.Path(sys.argv[2]).write_text('ready'); time.sleep(.7)", lockPath, marker.path]
        holder.standardOutput = FileHandle.nullDevice; holder.standardError = FileHandle.nullDevice
        try holder.run()
        try await fixture.until { FileManager.default.fileExists(atPath: marker.path) }
        let release = Task.detached { holder.waitUntilExit() }
        let service = fixture.service()
        do {
            // Real packaged server.py must first fail its production flock
            // acquisition, then recover after the old owner's lock releases.
            try await service.start(configurationURL: fixture.configuration)
            await release.value
            await service.shutdown()
        } catch {
            await release.value
            await service.shutdown()
            throw error
        }
    }

    @Test func shutdownWaitsForOwnedServerToExitBeforeReturning() async throws {
        let fixture = try PDFLayoutLifecycleFixture()
        defer { fixture.cleanup() }
        let service = fixture.service()
        try await service.start(configurationURL: fixture.configuration)
        let oldPID = try fixture.startedPIDs().first.unwrap()
        await service.shutdown()
        #expect(kill(oldPID, 0) == -1 && errno == ESRCH,
            "shutdown returned while the retiring PDF server still owned its port")
    }

    @Test func startDuringShutdownWaitsForRetirementAndOwnsReplacement() async throws {
        let fixture = try PDFLayoutLifecycleFixture()
        defer { fixture.cleanup() }
        let service = fixture.service()
        try await service.start(configurationURL: fixture.configuration)
        let oldPID = try fixture.startedPIDs().first.unwrap()
        let retiring = Task { await service.shutdown() }
        try await fixture.until { fixture.hasTerminationMarker() }
        try await service.start(configurationURL: fixture.configuration)
        await retiring.value
        let replacements = try fixture.startedPIDs()
        #expect(replacements.count == 2 && replacements.last != oldPID,
            "new start reused the old server's last ready response")
        #expect(kill(oldPID, 0) == -1 && errno == ESRCH)
        await service.shutdown()
    }

    @Test func readyBorrowedFromRetiringAppRecoversAfterItsServerExits() async throws {
        let fixture = try PDFLayoutLifecycleFixture()
        defer { fixture.cleanup() }
        let oldApp = fixture.service(), newApp = fixture.service()
        try await oldApp.start(configurationURL: fixture.configuration)
        let oldPID = try fixture.startedPIDs().first.unwrap()
        try await newApp.start(configurationURL: fixture.configuration)
        #expect(try fixture.startedPIDs().count == 1)
        await oldApp.shutdown()
        try await fixture.until { (try? fixture.startedPIDs().count) == 2 }
        #expect(try fixture.startedPIDs().last != oldPID)
        await newApp.shutdown()
    }

    @Test func shutdownReapsAnOwnedServerThatIgnoresTermination() async throws {
        let fixture = try PDFLayoutLifecycleFixture(ignoreTermination: true)
        defer { fixture.cleanup() }
        let service = fixture.service()
        try await service.start(configurationURL: fixture.configuration)
        let oldPID = try fixture.startedPIDs().first.unwrap()
        await service.shutdown()
        #expect(kill(oldPID, 0) == -1 && errno == ESRCH,
            "an unresponsive owned child survived the shutdown deadline")
    }

    @Test func jobMappingUsesOriginalZeroBasedPages() throws {
        let value = PDFLayoutJob(id: "private-job_3", state: .complete, sourcePages: [2], pageCount: 10)
        try value.validate()
        let copy = try JSONDecoder().decode(PDFLayoutJob.self, from: JSONEncoder().encode(value))
        #expect(copy == value)
        #expect(copy.sourcePages == [2])
    }

    @Test func malformedWorkerIDsAndPageMappingsAreRejected() {
        let invalid = [
            PDFLayoutJob(id: "../secret", state: .complete, sourcePages: [0], pageCount: 1),
            PDFLayoutJob(id: "valid", state: .complete, sourcePages: [], pageCount: 1),
            PDFLayoutJob(id: "valid", state: .complete, sourcePages: [1], pageCount: 1),
            PDFLayoutJob(id: "valid", state: .complete, sourcePages: [0, 0], pageCount: 2),
            PDFLayoutJob(id: "valid", state: .complete, sourcePages: [0], pageCount: 0)
        ]
        for value in invalid {
            #expect(throws: PDFLayoutServiceError.invalidResponse) { try value.validate() }
        }
    }

    @Test func invalidPDFOrLanguageInputsFailBeforeConnectingToWorker() async {
        let service = PDFLayoutService()
        await #expect(throws: PDFLayoutServiceError.invalidInput) {
            try await service.createJob(data: Data("text".utf8), pages: nil, source: "en", target: "zh-Hans")
        }
        await #expect(throws: PDFLayoutServiceError.invalidInput) {
            try await service.createJob(data: Data("%PDF-fixture".utf8), pages: [0, 0], source: "en", target: "zh-Hans")
        }
        await #expect(throws: PDFLayoutServiceError.invalidInput) {
            try await service.createJob(data: Data("%PDF-fixture".utf8), pages: [0], source: "en", target: "en")
        }
        await #expect(throws: PDFLayoutServiceError.invalidInput) {
            try await service.createJob(data: Data("%PDF-fixture".utf8), pages: [-1], source: "en", target: "zh-Hans")
        }
        await #expect(throws: PDFLayoutServiceError.invalidInput) {
            try await service.status(id: "../../../outside")
        }
        await service.shutdown()
    }
}

private struct PDFLayoutLifecycleFixture {
    let directory: URL
    let configuration: URL
    let script: URL
    let endpoint: URL
    let python: URL
    static var support: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AskGPTReader/PDFLayout")
    }
    static var productionScripts: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Ask for GPT.app/Contents/Resources/PDFLayout")
    }
    static var productionRuntimeAvailable: Bool {
        FileManager.default.isExecutableFile(atPath: support.appendingPathComponent("runtime/bin/python3").path) &&
        FileManager.default.fileExists(atPath: support.appendingPathComponent("assets-ready.json").path) &&
        FileManager.default.fileExists(atPath: productionScripts.appendingPathComponent("server.py").path)
    }
    init(ignoreTermination: Bool = false, realProductionServer: Bool = false) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("pdf-lifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        configuration = directory.appendingPathComponent("connection.json")
        script = directory.appendingPathComponent("worker.py")
        python = realProductionServer ? Self.support.appendingPathComponent("runtime/bin/python3")
            : URL(fileURLWithPath: "/usr/bin/python3")
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw PDFLayoutServiceError.startup }
        defer { Darwin.close(socket) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1"); address.sin_port = 0
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw PDFLayoutServiceError.startup }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(socket, $0, &length) }
        }
        let port = UInt16(bigEndian: address.sin_port)
        endpoint = URL(string: "http://127.0.0.1:\(port)")!
        try JSONSerialization.data(withJSONObject: ["version": 1, "endpoint": InlineConnectionConfiguration.baseEndpoint,
            "token": String(repeating: "a", count: 64), "extensionID": String(repeating: "a", count: 32),
            "pdfPort": Int(port), "ignoreTermination": ignoreTermination,
            "productionScripts": Self.productionScripts.path])
            .write(to: configuration)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configuration.path)
        if realProductionServer {
            try FileManager.default.copyItem(at: Self.support.appendingPathComponent("assets-ready.json"),
                to: directory.appendingPathComponent("assets-ready.json"))
            let assetParent = directory.appendingPathComponent("engine-home/.cache", isDirectory: true)
            try FileManager.default.createDirectory(at: assetParent, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            // Health only stats the installed public layout assets. No PDF is
            // submitted and no installed/runtime file is written by this test.
            try FileManager.default.createSymbolicLink(at: assetParent.appendingPathComponent("babeldoc"),
                withDestinationURL: Self.support.appendingPathComponent("engine-home/.cache/babeldoc"))
        }
        try (realProductionServer ? Self.productionBootstrap : Self.pythonFixture)
            .write(to: script, atomically: true, encoding: .utf8)
    }
    func service() -> PDFLayoutService {
        PDFLayoutService(endpoint: endpoint, workerPaths: PDFLayoutWorkerPaths(python: python,
            script: script, translator: URL(fileURLWithPath: "/usr/bin/true"), cache: directory))
    }
    func startedPIDs() throws -> [pid_t] {
        let file = directory.appendingPathComponent("starts.txt")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try String(contentsOf: file, encoding: .utf8).split(separator: "\n").compactMap { pid_t($0) }
    }
    func hasTerminationMarker() -> Bool { FileManager.default.fileExists(atPath: directory.appendingPathComponent("terminating").path) }
    func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<150 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw PDFLayoutServiceError.startup
    }
    func cleanup() {
        for pid in (try? startedPIDs()) ?? [] { if kill(pid, 0) == 0 { _ = kill(pid, SIGKILL) } }
        try? FileManager.default.removeItem(at: directory)
    }
    static let productionBootstrap = #"""
import json,pathlib,sys
config=json.loads(pathlib.Path(sys.argv[sys.argv.index('--config')+1]).read_text())
sys.path.insert(0,config['productionScripts'])
import server
original=server.create_server
def independent_port(manager,token,**options):return original(manager,token,port=config['pdfPort'],**options)
server.create_server=independent_port
raise SystemExit(server.main())
"""#
    static let pythonFixture = #"""
import argparse,json,os,pathlib,signal,threading,time
from http.server import BaseHTTPRequestHandler,HTTPServer
p=argparse.ArgumentParser();p.add_argument('--config');p.add_argument('--translator');p.add_argument('--cache-root');a=p.parse_args()
c=json.loads(pathlib.Path(a.config).read_text());root=pathlib.Path(a.cache_root)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  data=b'{"status":"ready","protocolVersion":1}';self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
HTTPServer.allow_reuse_address=True
server=HTTPServer(('127.0.0.1',c['pdfPort']),Handler)
with (root/'starts.txt').open('a') as h:h.write(str(os.getpid())+'\n')
def stop(*a):
 (root/'terminating').write_text('yes')
 if c.get('ignoreTermination'):return
 def delayed():time.sleep(.35);server.shutdown()
 threading.Thread(target=delayed,daemon=True).start()
signal.signal(signal.SIGTERM,stop)
try:server.serve_forever(poll_interval=.02)
finally:server.server_close()
"""#
}

private extension Optional {
    func unwrap() throws -> Wrapped {
        guard let self else { throw PDFLayoutServiceError.startup }; return self
    }
}

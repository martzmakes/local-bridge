import Foundation
import XCTest
@testable import LocalBridgeCore

func makeTempDir(_ name: String = "lb") -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@discardableResult
func writeScript(_ body: String, in dir: URL, name: String = "fake.sh") -> String {
    let url = dir.appendingPathComponent(name)
    try! Data(("#!/bin/sh\n" + body + "\n").utf8).write(to: url)
    try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url.path
}

func repoFile(_ relative: String) -> URL {
    // Tests/LocalBridgeCoreTests/Support.swift -> macapp -> repo root
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent(relative)
}

final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [DaemonSupervisor.State] = []
    private var lines: [String] = []

    func record(_ event: DaemonSupervisor.Event) {
        lock.lock()
        defer { lock.unlock() }
        switch event {
        case .state(let s): states.append(s)
        case .stdoutLine(let l): lines.append(l)
        case .stderrLine: break
        }
    }

    var allStates: [DaemonSupervisor.State] {
        lock.lock()
        defer { lock.unlock() }
        return states
    }

    var stdout: [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }
}

func waitUntil(timeout: TimeInterval = 5, _ condition: @escaping () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}

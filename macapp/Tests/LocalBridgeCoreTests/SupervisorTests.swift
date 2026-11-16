import XCTest
@testable import LocalBridgeCore

final class SupervisorTests: XCTestCase {
    /// Stands in for `node cli.mjs run`: prints a call line, then runs until it is told to stop.
    let longRunning = """
    trap 'exit 0' TERM
    echo "$1 $LOCAL_BRIDGE_CONFIG" > "$MARKER"
    echo '{"ts":"2026-11-15T21:07:03.000Z","level":"info","event":"call","server":"notes","tool":"get_note","ms":7,"outcome":"ok"}'
    while true; do sleep 0.05; done
    """

    func makeSupervisor(
        script: String, dir: URL, log: EventLog, launchAgent: Bool = false,
        initialBackoff: TimeInterval = 0.05, maximumBackoff: TimeInterval = 0.2, killGrace: TimeInterval = 2
    ) -> DaemonSupervisor {
        let path = writeScript(script, in: dir)
        let configuration = DaemonSupervisor.Configuration(
            nodePath: "/bin/sh", scriptPath: path, arguments: ["run"],
            environment: ["LOCAL_BRIDGE_CONFIG": "/tmp/test-config.json", "MARKER": dir.path + "/marker", "PATH": "/bin:/usr/bin"],
            initialBackoff: initialBackoff, maximumBackoff: maximumBackoff, stableAfter: 30, killGrace: killGrace)
        return DaemonSupervisor(configuration: configuration, launchAgentLoaded: { launchAgent }, onEvent: { log.record($0) })
    }

    func testStartRunsTheChildWithArgumentsAndEnvironment() async throws {
        let dir = makeTempDir()
        let log = EventLog()
        let supervisor = makeSupervisor(script: longRunning, dir: dir, log: log)
        try supervisor.start()
        let pid = try XCTUnwrap(supervisor.childPID)
        XCTAssertEqual(supervisor.state, .running(pid: pid))
        XCTAssertTrue(ProcessProbe.isAlive(pid: pid))

        let sawLine = await waitUntil { !log.stdout.isEmpty }
        XCTAssertTrue(sawLine)
        var activity = ActivityBuffer()
        log.stdout.forEach { activity.ingest(line: $0) }
        XCTAssertEqual(activity.entries.map(\.tool), ["get_note"])
        XCTAssertEqual(try String(contentsOfFile: dir.path + "/marker"), "run /tmp/test-config.json\n")

        // A second start is a no-op, not a second child.
        try supervisor.start()
        XCTAssertEqual(supervisor.childPID, pid)

        await supervisor.stop()
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.childPID)
        XCTAssertFalse(ProcessProbe.isAlive(pid: pid), "the child is gone after stop")
        // And it stays gone: no restart after a deliberate stop.
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(supervisor.state, .stopped)
    }

    func testStopEscalatesToKill() async throws {
        let dir = makeTempDir()
        let log = EventLog()
        let stubborn = "trap '' TERM\nwhile true; do sleep 0.05; done"
        let supervisor = makeSupervisor(script: stubborn, dir: dir, log: log, killGrace: 0.3)
        try supervisor.start()
        let pid = try XCTUnwrap(supervisor.childPID)
        try await Task.sleep(nanoseconds: 150_000_000)
        let started = Date()
        await supervisor.stop()
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertFalse(ProcessProbe.isAlive(pid: pid))
        XCTAssertGreaterThan(elapsed, 0.25)
        XCTAssertLessThan(elapsed, 2)
    }

    func testRestartReplacesTheChild() async throws {
        let dir = makeTempDir()
        let log = EventLog()
        let supervisor = makeSupervisor(script: longRunning, dir: dir, log: log)
        try supervisor.start()
        let first = try XCTUnwrap(supervisor.childPID)
        try await supervisor.restart()
        let second = try XCTUnwrap(supervisor.childPID)
        XCTAssertNotEqual(first, second)
        XCTAssertFalse(ProcessProbe.isAlive(pid: first))
        XCTAssertTrue(ProcessProbe.isAlive(pid: second))
        await supervisor.stop()
        XCTAssertFalse(ProcessProbe.isAlive(pid: second))
    }

    func testCrashingChildIsRestartedWithDoublingBackoffUpToTheCap() async throws {
        let dir = makeTempDir()
        let log = EventLog()
        let supervisor = makeSupervisor(script: "exit 3", dir: dir, log: log, initialBackoff: 0.05, maximumBackoff: 0.2)
        try supervisor.start()
        func delays() -> [TimeInterval] {
            log.allStates.compactMap { if case .backingOff(let d, _) = $0 { return d } else { return nil } }
        }
        let enough = await waitUntil(timeout: 5) { delays().count >= 5 }
        XCTAssertTrue(enough)
        await supervisor.stop()
        XCTAssertEqual(Array(delays().prefix(5)), [0.05, 0.1, 0.2, 0.2, 0.2])
        let statuses = log.allStates.compactMap { state -> Int32? in
            if case .backingOff(_, let status) = state { return status } else { return nil }
        }
        XCTAssertEqual(Set(statuses), [3])
        XCTAssertEqual(supervisor.state, .stopped)
        let count = delays().count
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(delays().count, count, "no restarts after stop")
    }

    func testAChildKilledFromOutsideComesBack() async throws {
        let dir = makeTempDir()
        let log = EventLog()
        let supervisor = makeSupervisor(script: longRunning, dir: dir, log: log)
        try supervisor.start()
        let first = try XCTUnwrap(supervisor.childPID)
        kill(first, SIGKILL)
        let back = await waitUntil { supervisor.childPID != nil && supervisor.childPID != first }
        XCTAssertTrue(back)
        await supervisor.stop()
    }

    func testRefusesWhileTheLaunchAgentIsLoaded() async {
        let dir = makeTempDir()
        let log = EventLog()
        let supervisor = makeSupervisor(script: longRunning, dir: dir, log: log, launchAgent: true)
        XCTAssertThrowsError(try supervisor.start()) { XCTAssertEqual($0 as? DaemonSupervisor.StartError, .launchAgentLoaded) }
        XCTAssertEqual(supervisor.state, .blocked(.launchAgentLoaded))
        XCTAssertNil(supervisor.childPID)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path + "/marker"))
        await supervisor.stop()
    }

    func testRefusesWithoutNodeOrScript() {
        let log = EventLog()
        let noNode = DaemonSupervisor(
            configuration: .init(nodePath: "/nonexistent/node", scriptPath: "/bin/sh"), launchAgentLoaded: { false }, onEvent: { log.record($0) })
        XCTAssertThrowsError(try noNode.start()) { XCTAssertEqual($0 as? DaemonSupervisor.StartError, .nodeNotFound("/nonexistent/node")) }
        let noScript = DaemonSupervisor(
            configuration: .init(nodePath: "/bin/sh", scriptPath: "/nonexistent/cli.mjs"), launchAgentLoaded: { false })
        XCTAssertThrowsError(try noScript.start()) { XCTAssertEqual($0 as? DaemonSupervisor.StartError, .scriptNotFound("/nonexistent/cli.mjs")) }
    }

    func testStopAndWaitForAppTermination() throws {
        let dir = makeTempDir()
        let supervisor = makeSupervisor(script: longRunning, dir: dir, log: EventLog())
        try supervisor.start()
        let pid = try XCTUnwrap(supervisor.childPID)
        supervisor.stopAndWait()
        XCTAssertFalse(ProcessProbe.isAlive(pid: pid))
    }
}

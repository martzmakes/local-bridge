import XCTest
@testable import LocalBridgeCore

final class InspectTests: XCTestCase {
    let server = ServerConfig(title: "Notes", command: "/usr/local/bin/node", args: ["x.js"], read: ["a"], write: ["b"])

    func testParseOK() {
        let out = #"{"ok":true,"tools":[{"name":"search_notes","description":"Search","readOnlyHint":true,"suggestedAccess":"read"},{"name":"create_note","description":"","suggestedAccess":"write"},{"name":"list_x"}]}"#
        XCTAssertEqual(InspectRunner.parse(Data(out.utf8)), .ok([
            InspectedTool(name: "search_notes", description: "Search", readOnlyHint: true, suggestedAccess: .read),
            InspectedTool(name: "create_note", description: "", suggestedAccess: .write),
            InspectedTool(name: "list_x", suggestedAccess: .read),
        ]))
    }

    func testParseErrorAndGarbage() {
        XCTAssertEqual(InspectRunner.parse(Data(#"{"ok":false,"error":"could not start: ENOENT"}"#.utf8)), .failed("could not start: ENOENT"))
        XCTAssertNil(InspectRunner.parse(Data("hello\n{not json}\n".utf8)))
        XCTAssertNil(InspectRunner.parse(Data()))
        XCTAssertNil(InspectRunner.parse(Data(#"{"ok":true}"#.utf8)))
        // Noise before the result line is ignored.
        XCTAssertEqual(InspectRunner.parse(Data("warming up\n{\"ok\":true,\"tools\":[]}\n".utf8)), .ok([]))
    }

    func testInspectInputLeavesExposureOut() throws {
        let object = try XCTUnwrap(server.inspectJSON.objectValue)
        XCTAssertEqual(object["read"], .array([]))
        XCTAssertEqual(object["write"], .array([]))
        XCTAssertEqual(object["command"], .string("/usr/local/bin/node"))
    }

    func testRunsTheScriptWithTheServerOnStdin() async {
        let dir = makeTempDir()
        // Echoes back what it was given, so the test sees both the argument and stdin.
        let script = writeScript("""
        input=$(cat)
        case "$input" in *'"command":"/usr/local/bin/node"'*) ;; *) echo '{"ok":false,"error":"no stdin"}'; exit 0;; esac
        [ "$1" = "inspect" ] || { echo '{"ok":false,"error":"wrong argument"}'; exit 0; }
        echo '{"ok":true,"tools":[{"name":"echo","description":"Returns its text","suggestedAccess":"write"}]}'
        """, in: dir)
        let result = await InspectRunner(nodePath: "/bin/sh", cliPath: script, timeout: 5).inspect(server)
        XCTAssertEqual(result, .ok([InspectedTool(name: "echo", description: "Returns its text", suggestedAccess: .write)]))
    }

    func testScriptReportingAnError() async {
        let script = writeScript("cat > /dev/null; echo '{\"ok\":false,\"error\":\"timed out starting the server\"}'; exit 1", in: makeTempDir())
        let result = await InspectRunner(nodePath: "/bin/sh", cliPath: script, timeout: 5).inspect(server)
        XCTAssertEqual(result, .failed("timed out starting the server"))
    }

    func testGarbageOutput() async {
        let script = writeScript("cat > /dev/null; echo 'Segmentation fault'", in: makeTempDir())
        let result = await InspectRunner(nodePath: "/bin/sh", cliPath: script, timeout: 5).inspect(server)
        XCTAssertEqual(result, .failed("inspect returned output that could not be read."))

        let crashing = writeScript("cat > /dev/null; echo 'boom' >&2; exit 7", in: makeTempDir())
        let crashed = await InspectRunner(nodePath: "/bin/sh", cliPath: crashing, timeout: 5).inspect(server)
        XCTAssertEqual(crashed, .failed("inspect exited with status 7: boom"))
    }

    func testTimeoutKillsTheScript() async {
        let dir = makeTempDir()
        let script = writeScript("echo $$ > \"\(dir.path)/pid\"; exec sleep 30", in: dir)
        let started = Date()
        let result = await InspectRunner(nodePath: "/bin/sh", cliPath: script, timeout: 0.5).inspect(server)
        XCTAssertEqual(result, .failed("The server did not answer within 0 seconds."))
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        let pid = Int32((try? String(contentsOfFile: dir.path + "/pid"))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        XCTAssertGreaterThan(pid, 0)
        let gone = await waitUntil { !ProcessProbe.isAlive(pid: pid) }
        XCTAssertTrue(gone)
    }

    func testMissingNode() async {
        let result = await InspectRunner(nodePath: "/nonexistent/node", cliPath: "/x", timeout: 2).inspect(server)
        XCTAssertEqual(result, .failed("could not start /nonexistent/node"))
    }

    func testCacheRoundTrip() throws {
        let url = makeTempDir().appendingPathComponent("cache.json")
        XCTAssertEqual(InspectCache.load(from: url), InspectCache())
        var cache = InspectCache()
        cache.servers["notes"] = .init(tools: [InspectedTool(name: "a", description: "d", suggestedAccess: .read)],
                                       inspectedAt: Date(timeIntervalSince1970: 1_700_000_000))
        try cache.save(to: url)
        XCTAssertEqual(InspectCache.load(from: url), cache)
    }
}

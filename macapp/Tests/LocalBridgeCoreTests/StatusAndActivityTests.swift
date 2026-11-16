import XCTest
@testable import LocalBridgeCore

final class StatusAndActivityTests: XCTestCase {
    let sample = """
    {"pid":123,"version":"0.2.0","machine":"mini","account":"abc","updatedAt":1731700000000,
     "connection":{"state":"connected","since":1731699000000,"lastError":null},
     "servers":[{"name":"notes","title":"Apple Notes","status":"up","error":null,
                 "tools":[{"name":"search_notes","access":"read"}]}],
     "calls":{"total":12,"failed":1,"lastAt":1731699990000,"lastTool":"notes.search_notes","lastOutcome":"ok"}}
    """

    func reader(_ text: String?, ageSeconds: Double, alive: Bool) -> StatusReader {
        let url = makeTempDir().appendingPathComponent("status.json")
        if let text { try! Data(text.utf8).write(to: url) }
        let now = Date(timeIntervalSince1970: 1_731_700_000 + ageSeconds)
        return StatusReader(url: url, now: { now }, isAlive: { _ in alive })
    }

    func testFreshFileWithLivePidIsRunning() {
        let snapshot = reader(sample, ageSeconds: 10, alive: true).read()
        guard case .running(let status) = snapshot else { return XCTFail() }
        XCTAssertEqual(status.machine, "mini")
        XCTAssertEqual(status.account, "abc")
        XCTAssertEqual(status.server(named: "notes")?.tools?.count, 1)
        XCTAssertEqual(status.calls?.total, 12)
        XCTAssertEqual(snapshot.connectionState, .connected)
        XCTAssertFalse(snapshot.needsRegistration)
    }

    func testStaleness() {
        XCTAssertTrue(reader(sample, ageSeconds: 45, alive: true).read().isRunning)
        XCTAssertFalse(reader(sample, ageSeconds: 46, alive: true).read().isRunning)
        XCTAssertFalse(reader(sample, ageSeconds: 1, alive: false).read().isRunning)
        XCTAssertEqual(reader(nil, ageSeconds: 0, alive: true).read(), .notRunning(lastKnown: nil))
        XCTAssertEqual(reader("garbage", ageSeconds: 0, alive: true).read(), .notRunning(lastKnown: nil))
        XCTAssertEqual(reader(sample, ageSeconds: 99, alive: true).read().connectionState, .offline)
    }

    func testNoAccountIsReadEvenWhenTheDaemonHasExited() {
        let text = #"{"pid":9,"version":"0.2.0","machine":"mini","account":null,"updatedAt":1731700000000,"connection":{"state":"offline","since":1,"lastError":"no_account"},"servers":[]}"#
        let snapshot = reader(text, ageSeconds: 2, alive: false).read()
        XCTAssertFalse(snapshot.isRunning)
        XCTAssertEqual(snapshot.lastError, "no_account")
        XCTAssertTrue(snapshot.needsRegistration)
        XCTAssertEqual(snapshot.lastUpdated, Date(timeIntervalSince1970: 1_731_700_000))

        let refused = sample.replacingOccurrences(of: #""lastError":null"#, with: #""lastError":"auth_refused""#)
        XCTAssertTrue(reader(refused, ageSeconds: 1, alive: true).read().needsRegistration)
        let other = sample.replacingOccurrences(of: #""lastError":null"#, with: #""lastError":"Error ECONNREFUSED""#)
        XCTAssertFalse(reader(other, ageSeconds: 1, alive: true).read().needsRegistration)
    }

    func testRealPidCheck() {
        XCTAssertTrue(ProcessProbe.isAlive(pid: getpid()))
        XCTAssertFalse(ProcessProbe.isAlive(pid: 0))
    }

    func testActivityParsing() {
        let line = #"{"ts":"2026-11-15T21:07:03.123Z","level":"info","event":"call","callId":"c1","server":"notes","tool":"search_notes","ms":42,"outcome":"ok","resultBytes":10}"#
        let entry = ActivityParser.parse(line: line)
        XCTAssertEqual(entry?.server, "notes")
        XCTAssertEqual(entry?.tool, "search_notes")
        XCTAssertEqual(entry?.outcome, "ok")
        XCTAssertEqual(entry?.milliseconds, 42)
        XCTAssertEqual(entry?.time.timeIntervalSince1970 ?? 0, 1_794_776_823.123, accuracy: 0.01)
        XCTAssertNil(ActivityParser.parse(line: #"{"ts":"x","event":"starting","machine":"mini"}"#))
        XCTAssertNil(ActivityParser.parse(line: "plain text with \"call\" in it"))
        XCTAssertNil(ActivityParser.parse(line: #"{"event":"call"}"#))
    }

    func testBufferKeepsTheLast200() {
        var buffer = ActivityBuffer()
        for i in 0..<250 {
            let kept = buffer.ingest(line: #"{"ts":"2026-11-15T21:07:03Z","event":"call","server":"s","tool":"t\#(i)","ms":1,"outcome":"timeout"}"#)
            XCTAssertTrue(kept)
        }
        XCTAssertFalse(buffer.ingest(line: #"{"event":"connected"}"#))
        XCTAssertEqual(buffer.entries.count, 200)
        XCTAssertEqual(buffer.entries.first?.tool, "t50")
        XCTAssertEqual(buffer.entries.last?.tool, "t249")
        XCTAssertEqual(Set(buffer.entries.map(\.id)).count, 200)
        XCTAssertEqual(buffer.entries.last?.succeeded, false)
    }

    func testLineSplitter() {
        var s = LineSplitter()
        XCTAssertEqual(s.feed(Data("a\nb".utf8)), ["a"])
        XCTAssertEqual(s.feed(Data("c\n\nd\n".utf8)), ["bc", "d"])
        XCTAssertEqual(s.feed(Data()), [])
    }

    func testNodeLocator() {
        let exists: Set<String> = ["/usr/local/bin/node", "/custom/node", "/shell/node"]
        func locator(candidates: [String] = NodeLocator.standardCandidates, shell: String? = nil) -> NodeLocator {
            NodeLocator(candidates: candidates, isExecutable: { exists.contains($0) }, shellLookup: { shell })
        }
        XCTAssertEqual(locator().locate(), "/usr/local/bin/node")
        XCTAssertEqual(locator().locate(override: "/custom/node"), "/custom/node")
        XCTAssertNil(locator().locate(override: "/typo/node"), "a wrong override is reported, not silently replaced")
        XCTAssertEqual(locator().locate(override: "  "), "/usr/local/bin/node")
        XCTAssertEqual(locator(candidates: ["/nope"], shell: "/shell/node").locate(), "/shell/node")
        XCTAssertNil(locator(candidates: ["/nope"], shell: "/also/nope").locate())
        XCTAssertNil(locator(candidates: [], shell: nil).locate())
    }
}

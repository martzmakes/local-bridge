import XCTest
@testable import LocalBridgeCore

final class ToolTests: XCTestCase {
    let inspected = [
        InspectedTool(name: "list_notes", description: "List", suggestedAccess: .read),
        InspectedTool(name: "get_note", description: "Get", suggestedAccess: .read),
        InspectedTool(name: "create_note", description: "Create", suggestedAccess: .write),
        InspectedTool(name: "export_all", description: "Export", suggestedAccess: .write),
    ]

    func testGrouping() {
        let server = ServerConfig(command: "x", read: ["list_notes"], write: ["create_note"])
        let groups = ToolCatalog.groups(server: server, saved: server, inspected: inspected)
        XCTAssertEqual(groups.read.map(\.name), ["list_notes", "get_note"])
        XCTAssertEqual(groups.write.map(\.name), ["create_note", "export_all"])
        XCTAssertEqual(ToolGroups.count(on: groups.read), 1)
        XCTAssertEqual(ToolGroups.count(on: groups.write), 1)
        XCTAssertEqual(groups.all.count, 4)
        XCTAssertEqual(groups.read[0].description, "List")
    }

    func testGroupFollowsTheConfigListThenTheOverrideThenTheServer() {
        // On: the list it is saved under decides, even against the server's own hint.
        var server = ServerConfig(command: "x", read: ["export_all"], write: ["get_note"])
        var groups = ToolCatalog.groups(server: server, saved: nil, inspected: inspected)
        XCTAssertEqual(groups.read.map(\.name), ["list_notes", "export_all"])
        XCTAssertEqual(groups.write.map(\.name), ["get_note", "create_note"])

        // Off: the user's choice decides.
        server = ServerConfig(command: "x")
        groups = ToolCatalog.groups(server: server, saved: nil, inspected: inspected, overrides: ["export_all": .read, "list_notes": .write])
        XCTAssertEqual(groups.read.map(\.name), ["get_note", "export_all"])
        XCTAssertEqual(groups.write.map(\.name), ["list_notes", "create_note"])
        XCTAssertTrue(groups.all.allSatisfy { !$0.isOn })
    }

    func testToolsKnownOnlyFromTheConfig() {
        let saved = ServerConfig(command: "x", read: ["old_read"], write: ["old_write"])
        let draft = ServerConfig(command: "x", read: [], write: ["old_write"])
        // Never inspected: everything the config ever named is listed, classed by where it was saved.
        var groups = ToolCatalog.groups(server: draft, saved: saved, inspected: nil)
        XCTAssertEqual(groups.read.map(\.name), ["old_read"])
        XCTAssertEqual(groups.write.map(\.name), ["old_write"])
        XCTAssertEqual(groups.read[0].isOn, false)
        XCTAssertEqual(groups.read[0].notReported, false)
        // Inspected, and the server no longer lists them.
        groups = ToolCatalog.groups(server: draft, saved: saved, inspected: inspected)
        XCTAssertTrue(groups.all.first { $0.name == "old_write" }!.notReported)
        // Unknown everywhere: the name decides.
        groups = ToolCatalog.groups(server: ServerConfig(command: "x", read: [], write: []), saved: ServerConfig(command: "x"), inspected: [])
        XCTAssertEqual(groups.all, [])
    }

    func testTurnAllAndMoveBetweenGroups() {
        var server = ServerConfig(command: "x", read: ["list_notes"])
        server.setTools(["list_notes", "get_note"], exposed: true, access: .read)
        XCTAssertEqual(server.read, ["list_notes", "get_note"])
        server.setTools(["create_note", "export_all"], exposed: true, access: .write)
        XCTAssertEqual(server.write, ["create_note", "export_all"])
        server.setTools(["create_note", "export_all"], exposed: false, access: .write)
        XCTAssertEqual(server.write, [])

        // Moving a tool that is on changes the list it is saved under, and nothing else.
        XCTAssertTrue(server.reclassify("get_note", as: .write))
        XCTAssertEqual(server.read, ["list_notes"])
        XCTAssertEqual(server.write, ["get_note"])
        XCTAssertTrue(server.reclassify("get_note", as: .read))
        XCTAssertEqual(server.read, ["list_notes", "get_note"])
        XCTAssertEqual(server.write, [])
        // A tool that is off has nothing in the config to move.
        XCTAssertFalse(server.reclassify("export_all", as: .read))
        XCTAssertNil(server.access(for: "export_all"))
    }

    // MARK: - Schema to form

    let schema = try! JSONValue.parse("""
    {"type":"object","required":["query","limit"],
     "properties":{
       "query":{"type":"string","description":"Text to search for"},
       "limit":{"type":"integer","default":10},
       "folder":{"type":["string","null"]},
       "score":{"type":"number"},
       "exact":{"type":"boolean","default":false},
       "sort":{"type":"string","enum":["date","title"]},
       "filters":{"type":"object"},
       "tags":{"type":"array","items":{"type":"string"}},
       "mixed":{"enum":[1,"a"]}
     }}
    """)

    func testFieldsFromSchema() {
        let fields = ToolForm.fields(from: schema)
        XCTAssertEqual(fields.map(\.name), ["query", "limit", "exact", "filters", "folder", "mixed", "score", "sort", "tags"])
        XCTAssertEqual(fields.map(\.required), [true, true, false, false, false, false, false, false, false])
        let kinds = Dictionary(uniqueKeysWithValues: fields.map { ($0.name, $0.kind) })
        XCTAssertEqual(kinds["query"], .string)
        XCTAssertEqual(kinds["limit"], .integer)
        XCTAssertEqual(kinds["folder"], .string)
        XCTAssertEqual(kinds["score"], .number)
        XCTAssertEqual(kinds["exact"], .boolean)
        XCTAssertEqual(kinds["sort"], .choice(["date", "title"]))
        XCTAssertEqual(kinds["filters"], .json)
        XCTAssertEqual(kinds["tags"], .json)
        XCTAssertEqual(kinds["mixed"], .json)
        XCTAssertEqual(fields[0].description, "Text to search for")
        XCTAssertEqual(ToolForm.initialText(for: fields[1]), "10")
        XCTAssertEqual(ToolForm.initialText(for: fields[2]), "false")
        XCTAssertEqual(ToolForm.initialText(for: fields[0]), "")

        XCTAssertEqual(ToolForm.fields(from: nil), [])
        XCTAssertEqual(ToolForm.fields(from: .object(["type": .string("object")])), [])
        XCTAssertEqual(ToolForm.fields(from: .string("nonsense")), [])
    }

    func testArgumentsFromForm() throws {
        let fields = ToolForm.fields(from: schema)
        let arguments = try ToolForm.arguments(fields: fields, values: [
            "query": "milk ", "limit": "5", "exact": "true", "score": "0.5", "sort": "date",
            "filters": #"{"a":[1,2]}"#, "tags": "", "folder": "",
        ])
        XCTAssertEqual(arguments, .object([
            "query": .string("milk "), "limit": .int(5), "exact": .bool(true), "score": .double(0.5), "sort": .string("date"),
            "filters": .object(["a": .array([.int(1), .int(2)])]),
        ]))
        // Optional and untouched fields are left out; a false switch that is the default is not sent.
        XCTAssertEqual(try ToolForm.arguments(fields: fields, values: ["query": "x", "limit": "1", "exact": "false"]),
                       .object(["query": .string("x"), "limit": .int(1)]))

        func error(_ values: [String: String]) -> String? {
            do {
                _ = try ToolForm.arguments(fields: fields, values: values)
                return nil
            } catch {
                return (error as? ToolFormError)?.message
            }
        }
        XCTAssertEqual(error(["limit": "5"]), "query is required.")
        XCTAssertEqual(error(["query": "x", "limit": "five"]), "limit must be a whole number.")
        XCTAssertEqual(error(["query": "x", "limit": "1", "score": "high"]), "score must be a number.")
        XCTAssertEqual(error(["query": "x", "limit": "1", "filters": "{oops"]), "filters must be valid JSON.")

        XCTAssertEqual(try ToolForm.rawArguments("  "), .object([:]))
        XCTAssertEqual(try ToolForm.rawArguments(#"{"a":1}"#), .object(["a": .int(1)]))
        XCTAssertThrowsError(try ToolForm.rawArguments("[1]"))
        XCTAssertThrowsError(try ToolForm.rawArguments("nope"))
    }

    // MARK: - Running a tool

    func testParseCallOutput() {
        let ok = #"{"ok":true,"result":{"content":[{"type":"text","text":"{\"b\":1,\"a\":[true]}"},{"type":"image","data":"…"}],"isError":false},"ms":123}"#
        guard case .finished(let result)? = ToolRunner.parse(Data(ok.utf8)) else { return XCTFail() }
        XCTAssertEqual(result.milliseconds, 123)
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, [.text(#"{"b":1,"a":[true]}"#), .other("image")])
        XCTAssertEqual(result.displayText, "{\n  \"a\": [\n    true\n  ],\n  \"b\": 1\n}\n\n[image content, not shown]")

        XCTAssertEqual(ToolCallResult(content: [.text("plain words")], isError: true, milliseconds: 1).displayText, "plain words")
        XCTAssertEqual(ToolCallResult(content: [.text("{not json")], isError: false, milliseconds: 1).displayText, "{not json")

        XCTAssertEqual(ToolRunner.parse(Data(#"{"ok":false,"error":"Automation permission not granted for Notes","ms":40}"#.utf8)),
                       .failed("Automation permission not granted for Notes"))
        XCTAssertNil(ToolRunner.parse(Data("garbage".utf8)))
        XCTAssertNil(ToolRunner.parse(Data(#"{"ok":true}"#.utf8)))
        let reported = #"{"ok":true,"result":{"content":[{"type":"text","text":"no such note"}],"isError":true},"ms":9}"#
        guard case .finished(let failed)? = ToolRunner.parse(Data(reported.utf8)) else { return XCTFail() }
        XCTAssertTrue(failed.isError)
    }

    func testCallSendsServerToolAndArgumentsOnStdin() async {
        let dir = makeTempDir()
        let script = writeScript("""
        [ "$1" = "call" ] || { echo '{"ok":false,"error":"wrong argument"}'; exit 1; }
        cat > "\(dir.path)/stdin"
        echo '{"ok":true,"result":{"content":[{"type":"text","text":"hi"}],"isError":false},"ms":7}'
        """, in: dir)
        let server = ServerConfig(command: "/usr/local/bin/node", args: ["x.js"], env: ["K": "v"], read: ["a"], write: [])
        let outcome = await ToolRunner(nodePath: "/bin/sh", cliPath: script, timeout: 5)
            .call(server: server, tool: "echo", arguments: .object(["text": .string("hi")]))
        XCTAssertEqual(outcome, .finished(ToolCallResult(content: [.text("hi")], isError: false, milliseconds: 7)))
        let sent = try? JSONValue.parse(Data(contentsOf: dir.appendingPathComponent("stdin")))
        XCTAssertEqual(sent?.objectValue?["tool"], .string("echo"))
        XCTAssertEqual(sent?.objectValue?["arguments"], .object(["text": .string("hi")]))
        XCTAssertEqual(sent?.objectValue?["server"], server.json)
    }

    func testCallFailures() async {
        let refused = writeScript("cat >/dev/null; echo '{\"ok\":false,\"error\":\"timed out after 60 s\"}'; exit 1", in: makeTempDir())
        let a = await ToolRunner(nodePath: "/bin/sh", cliPath: refused, timeout: 5).call(server: ServerConfig(command: "x"), tool: "t", arguments: .object([:]))
        XCTAssertEqual(a, .failed("timed out after 60 s"))

        let old = writeScript("cat >/dev/null; echo 'Usage: local-bridge-agent <command>'; exit 2", in: makeTempDir())
        let b = await ToolRunner(nodePath: "/bin/sh", cliPath: old, timeout: 5).call(server: ServerConfig(command: "x"), tool: "t", arguments: .object([:]))
        XCTAssertEqual(b, .failed("The bridge agent could not run the tool (status 2). This app may be newer than its agent."))

        let slow = writeScript("exec sleep 30", in: makeTempDir())
        let c = await ToolRunner(nodePath: "/bin/sh", cliPath: slow, timeout: 0.4).call(server: ServerConfig(command: "x"), tool: "t", arguments: .object([:]))
        XCTAssertEqual(c, .failed("The tool did not answer within 0 seconds."))
    }

    /// The real agent, when it is built, against the local fixture server. No network.
    func testRealAgentInspectAndCall() async throws {
        let node = "/usr/local/bin/node"
        let cli = repoFile("agent/dist/cli.mjs").path
        let fixture = repoFile("agent/test/fixtures/fixture-server.mjs").path
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: node) && FileManager.default.fileExists(atPath: cli)
                          && FileManager.default.fileExists(atPath: repoFile("agent/node_modules").path), "the agent is not built here")
        let server = ServerConfig(title: "Fixture", enabled: true, command: node, args: [fixture])
        guard case .ok(let tools) = await InspectRunner(nodePath: node, cliPath: cli).inspect(server) else {
            throw XCTSkip("this agent build has no inspect")
        }
        let echo = try XCTUnwrap(tools.first { $0.name == "echo" })
        try XCTSkipUnless(echo.inputSchema != nil, "this agent build does not report input schemas")
        XCTAssertEqual(ToolForm.fields(from: echo.inputSchema).map(\.name), ["text"])
        let arguments = try ToolForm.arguments(fields: ToolForm.fields(from: echo.inputSchema), values: ["text": "hello bridge"])
        let outcome = await ToolRunner(nodePath: node, cliPath: cli).call(server: server, tool: "echo", arguments: arguments)
        guard case .finished(let result) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.displayText, "hello bridge")
    }

    // MARK: - Inspect additions, activity

    func testInspectCarriesTheInputSchemaAndOverridesSurvive() throws {
        let out = #"{"ok":true,"tools":[{"name":"echo","description":"","suggestedAccess":"write","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}},{"name":"bare","inputSchema":"bad"}]}"#
        guard case .ok(let tools)? = InspectRunner.parse(Data(out.utf8)) else { return XCTFail() }
        XCTAssertEqual(ToolForm.fields(from: tools[0].inputSchema).map(\.name), ["text"])
        XCTAssertNil(tools[1].inputSchema)

        let url = makeTempDir().appendingPathComponent("cache.json")
        var cache = InspectCache()
        cache.servers["s"] = .init(tools: tools, inspectedAt: Date(timeIntervalSince1970: 1_700_000_000), overrides: ["echo": .read])
        try cache.save(to: url)
        XCTAssertEqual(InspectCache.load(from: url), cache)
        // A cache written before overrides existed still loads.
        try Data(#"{"servers":{"s":{"tools":[{"name":"a","suggestedAccess":"read"}],"inspectedAt":1700000000000}}}"#.utf8).write(to: url)
        XCTAssertEqual(InspectCache.load(from: url).servers["s"]?.tools.map(\.name), ["a"])
    }

    func line(_ server: String, _ tool: String, _ date: Date) -> String {
        #"{"ts":"\#(ISO8601DateFormatter().string(from: date))","event":"call","server":"\#(server)","tool":"\#(tool)","ms":5,"outcome":"ok"}"#
    }

    func testUsagePerServer() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_794_800_000)   // 2026-11-16 02:13 UTC
        var buffer = ActivityBuffer()
        buffer.ingest(line: line("notes", "a", now.addingTimeInterval(-86_400)))
        buffer.ingest(line: line("notes", "b", now.addingTimeInterval(-3_600)))
        buffer.ingest(line: line("notes", "c", now.addingTimeInterval(-180)))
        buffer.ingest(line: line("ha", "d", now.addingTimeInterval(-90_000)))
        let notes = buffer.usage(ofServer: "notes", now: now, calendar: calendar)
        XCTAssertEqual(notes?.today, 2)
        XCTAssertEqual(notes?.last, now.addingTimeInterval(-180))
        XCTAssertEqual(buffer.usage(ofServer: "ha", now: now, calendar: calendar)?.today, 0)
        XCTAssertNil(buffer.usage(ofServer: "reminders", now: now, calendar: calendar))
    }

    func testActivityStoreKeepsTheLast500CallLines() throws {
        let url = makeTempDir().appendingPathComponent("state/activity.jsonl")
        let store = ActivityStore(url: url)
        XCTAssertEqual(store.load(), [])
        let start = Date(timeIntervalSince1970: 1_794_000_000)
        for i in 0..<520 { store.append(line("notes", "t\(i)", start.addingTimeInterval(Double(i)))) }
        store.append(#"{"event":"connected"}"#)
        store.append("not json at all")
        let lines = store.load()
        XCTAssertEqual(lines.count, 500)
        XCTAssertTrue(lines.first!.contains("\"t20\""))
        XCTAssertTrue(lines.last!.contains("\"t519\""))
        XCTAssertLessThanOrEqual(try String(contentsOf: url, encoding: .utf8).split(separator: "\n").count, 500)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int, 0o600)

        var buffer = ActivityBuffer(capacity: 500)
        lines.forEach { buffer.ingest(line: $0) }
        XCTAssertEqual(buffer.entries.count, 500)
    }
}

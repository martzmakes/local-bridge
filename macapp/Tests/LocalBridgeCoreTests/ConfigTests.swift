import XCTest
@testable import LocalBridgeCore

final class ConfigTests: XCTestCase {
    func testExampleConfigRoundTripsUnchanged() throws {
        let data = try Data(contentsOf: repoFile("agent/config.example.json"))
        let original = try JSONValue.parse(data)
        let config = try BridgeConfig(data: data)
        XCTAssertEqual(config.machine, "mini")
        XCTAssertEqual(config.endpoint, "wss://bridge-ws.martzmakes.com")
        XCTAssertEqual(config.servers["notes"]?.read, ["list_folders", "list_notes", "get_note", "search_notes"])
        XCTAssertEqual(ConfigValidator.validate(config), [])
        XCTAssertEqual(try JSONValue.parse(config.serialized()), original)
    }

    func testUnknownKeysSurviveAtEveryLevel() throws {
        let text = """
        {"machine":"mini","endpoint":"wss://x.example","future":{"a":[1,2.5,null,true]},"account":"abc123",
         "servers":{"ha":{"transport":"sse","url":"http://127.0.0.1:8123/sse","headers":{"Authorization":"keychain:ha"},
           "read":["a"],"write":[],"concurrency":2,"callTimeoutMs":5000,"newThing":{"x":"y"},"title":"Home","enabled":false}}}
        """
        let config = try BridgeConfig(data: Data(text.utf8))
        XCTAssertEqual(config.extra["future"], .object(["a": .array([.int(1), .double(2.5), .null, .bool(true)])]))
        XCTAssertEqual(config.account, "abc123")
        XCTAssertEqual(config.servers["ha"]?.extra["newThing"], .object(["x": .string("y")]))
        XCTAssertEqual(config.servers["ha"]?.isEnabled, false)
        XCTAssertEqual(try JSONValue.parse(config.serialized()), try JSONValue.parse(text))

        var edited = config
        edited.servers["ha"]?.title = "Home Assistant"
        let reparsed = try BridgeConfig(data: Data(edited.serialized().utf8))
        XCTAssertEqual(reparsed.servers["ha"]?.extra["newThing"], .object(["x": .string("y")]))
        XCTAssertEqual(reparsed.extra["future"], config.extra["future"])
    }

    func testOutputIsStableSortedAndPretty() throws {
        var config = BridgeConfig(machine: "mini")
        config.servers["b"] = ServerConfig(transport: .stdio, command: "/bin/echo", args: ["x"])
        config.servers["a"] = ServerConfig(transport: .http, url: "https://example.com/mcp")
        let text = config.serialized()
        XCTAssertEqual(text, config.serialized())
        XCTAssertTrue(text.hasSuffix("}\n"))
        XCTAssertTrue(text.contains("\n  \"machine\": \"mini\""))
        let order = ["\"endpoint\"", "\"machine\"", "\"servers\"", "\"a\"", "\"b\""].map { text.range(of: $0)!.lowerBound }
        XCTAssertEqual(order, order.sorted())
        XCTAssertFalse(text.contains("\"enabled\""), "absent keys stay absent")
        XCTAssertFalse(text.contains("\\/"))
    }

    func testCodableGoesThroughTheSameShape() throws {
        let data = try Data(contentsOf: repoFile("agent/config.example.json"))
        let decoded = try JSONDecoder().decode(BridgeConfig.self, from: data)
        let encoded = try JSONEncoder().encode(decoded)
        XCTAssertEqual(try JSONValue.parse(encoded), try JSONValue.parse(data))
    }

    func testStructureErrors() {
        XCTAssertThrowsError(try BridgeConfig(data: Data("not json".utf8)))
        XCTAssertThrowsError(try BridgeConfig(data: Data("[]".utf8)))
        XCTAssertThrowsError(try BridgeConfig(data: Data(#"{"machine":"m","endpoint":"wss://x","servers":{"a":{"transport":"pipe"}}}"#.utf8)))
        XCTAssertThrowsError(try BridgeConfig(data: Data(#"{"machine":"m","endpoint":"wss://x","servers":{"a":{"transport":"stdio","args":"x"}}}"#.utf8)))
    }

    func testValidation() {
        func issues(_ mutate: (inout BridgeConfig) -> Void) -> [String] {
            var c = BridgeConfig(machine: "mini", servers: ["notes": ServerConfig(command: "/usr/local/bin/node")])
            mutate(&c)
            return ConfigValidator.validate(c).map(\.path)
        }
        XCTAssertEqual(issues { _ in }, [])
        XCTAssertEqual(issues { $0.machine = "Mini" }, ["machine"])
        XCTAssertEqual(issues { $0.machine = "" }, ["machine"])
        XCTAssertEqual(issues { $0.machine = "abcdefghijklmnopq" }, ["machine"])
        XCTAssertEqual(issues { $0.machine = "abcdefghijklmnop" }, [])
        XCTAssertEqual(issues { $0.endpoint = "https://x.example" }, ["endpoint"])
        XCTAssertEqual(issues { $0.endpoint = "ws://example.com" }, ["endpoint"])
        XCTAssertEqual(issues { $0.endpoint = "ws://127.0.0.1:9" }, [])
        XCTAssertEqual(issues { $0.endpoint = "ws://localhost:8080" }, [])
        XCTAssertEqual(issues { $0.endpoint = "ws://[::1]:8080" }, [])
        XCTAssertEqual(issues { $0.publicBase = "http://bridge.example" }, ["publicBase"])
        XCTAssertEqual(issues { $0.publicBase = "https://bridge.example" }, [])
        XCTAssertEqual(issues { $0.servers["my-notes"] = ServerConfig(command: "x") }, ["servers.my-notes"])
        XCTAssertEqual(issues { $0.servers["notes"]?.command = "" }, ["servers.notes.command"])
        XCTAssertEqual(issues { $0.servers["ha"] = ServerConfig(transport: .sse, url: "ftp://x") }, ["servers.ha.url"])
        XCTAssertEqual(issues { $0.servers["ha"] = ServerConfig(transport: .http, url: "http://127.0.0.1:8123/mcp") }, [])
        XCTAssertEqual(issues { $0.servers["notes"]?.concurrency = 5 }, ["servers.notes.concurrency"])
        XCTAssertEqual(issues { $0.servers["notes"]?.read = [""] }, ["servers.notes.read"])
        XCTAssertEqual(issues { $0.servers["notes"]?.title = String(repeating: "x", count: 65) }, ["servers.notes.title"])
        XCTAssertEqual(issues { c in
            for i in 0..<32 { c.servers["s\(i)"] = ServerConfig(command: "x") }
        }, ["servers"])
    }

    func testToolSwitchMapsToLists() {
        var s = ServerConfig(command: "x", read: ["list_notes"], write: [])
        s.setTool("create_note", exposed: true, access: .write)
        XCTAssertEqual(s.write, ["create_note"])
        XCTAssertEqual(s.access(for: "create_note"), .write)
        s.setTool("get_note", exposed: true, access: .read)
        XCTAssertEqual(s.read, ["list_notes", "get_note"])
        s.setTool("list_notes", exposed: false, access: .read)
        XCTAssertEqual(s.read, ["get_note"])
        XCTAssertNil(s.access(for: "list_notes"))
        // Re-classing moves the tool, it never leaves it in both.
        s.setTool("get_note", exposed: true, access: .write)
        XCTAssertEqual(s.read, [])
        XCTAssertEqual(s.write, ["create_note", "get_note"])
        XCTAssertEqual(s.exposedToolCount, 2)
    }

    func testToolInBothListsIsWrite() throws {
        let s = ServerConfig(command: "x", read: ["a", "b", "a"], write: ["b", "b"])
        XCTAssertEqual(s.access(for: "b"), .write)
        let n = s.normalized()
        XCTAssertEqual(n.read, ["a"])
        XCTAssertEqual(n.write, ["b"])
    }

    func testSuggestedAccessAndFirstInspection() {
        XCTAssertEqual(ToolAccess.suggested(forToolNamed: "search_notes"), .read)
        XCTAssertEqual(ToolAccess.suggested(forToolNamed: "create_note"), .write)
        XCTAssertEqual(ToolAccess.suggested(forToolNamed: "HassTurnOn", readOnlyHint: true), .read)
        XCTAssertEqual(ToolAccess.suggested(forToolNamed: "getter"), .write)

        let tools = [
            InspectedTool(name: "list_notes", suggestedAccess: .read),
            InspectedTool(name: "create_note", suggestedAccess: .write),
        ]
        var fresh = ServerConfig(command: "x")
        fresh.applyFirstInspection(tools)
        XCTAssertEqual(fresh.read, ["list_notes"])
        XCTAssertEqual(fresh.write, [], "write tools start switched off")

        var existing = ServerConfig(command: "x", read: ["get_note"])
        existing.applyFirstInspection(tools)
        XCTAssertEqual(existing.read, ["get_note"], "an existing exposure list is never widened")
    }

    func testEndpointURL() {
        XCTAssertEqual(EndpointURL.build(publicBase: "https://bridge.martzmakes.com", machine: "mini", server: "notes"),
                       "https://bridge.martzmakes.com/mcp/mini/notes")
        XCTAssertEqual(EndpointURL.build(publicBase: "https://b.example/ ", machine: "air", server: "ha"), "https://b.example/mcp/air/ha")
        XCTAssertEqual(BridgeConfig(machine: "mini").endpointURL(forServer: "notes"), "https://bridge.martzmakes.com/mcp/mini/notes")
        XCTAssertEqual(BridgeConfig(machine: "mini", publicBase: "https://x.example").endpointURL(forServer: "n"), "https://x.example/mcp/mini/n")
    }

    func testProposedMachineName() {
        XCTAssertEqual(ConfigValidator.proposedMachineName(fromHost: "Matts-Mac-mini.local"), "mattsmacmini")
        XCTAssertEqual(ConfigValidator.proposedMachineName(fromHost: "MINI"), "mini")
        XCTAssertEqual(ConfigValidator.proposedMachineName(fromHost: "A Very Long Computer Name Indeed"), "averylongcompute")
        XCTAssertEqual(ConfigValidator.proposedMachineName(fromHost: "—"), "mac")
        XCTAssertTrue(ConfigValidator.isValidName(ConfigValidator.proposedMachineName(fromHost: "Büro iMac (2)")))
    }

    func testProposedServerName() {
        XCTAssertEqual(ConfigValidator.proposedServerName(fromTitle: "Apple Notes"), "applenotes")
        XCTAssertEqual(ConfigValidator.proposedServerName(fromTitle: "Home Assistant (upstairs) 2"), "homeassistantups")
        XCTAssertEqual(ConfigValidator.proposedServerName(fromTitle: "  "), "")
        XCTAssertTrue(ConfigValidator.isValidName(ConfigValidator.proposedServerName(fromTitle: "Café Notes.app")))
    }

    func testSaveIsAtomicPrivateAndValidated() throws {
        let dir = makeTempDir()
        let url = dir.appendingPathComponent("nested/config.json")
        let store = ConfigStore(url: url)
        XCTAssertEqual(store.load(), .missing)

        var config = BridgeConfig(machine: "mini", servers: ["notes": ServerConfig(command: "/bin/echo", read: ["a"], write: ["a"])])
        let written = try store.save(config)
        XCTAssertEqual(written.servers["notes"]?.read, [], "write wins on save")
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        XCTAssertEqual(store.load(), .loaded(written))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path), ["config.json"])

        // A loose file is tightened by the next save.
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        try store.save(written)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int, 0o600)

        config.machine = "Not Valid"
        let before = try Data(contentsOf: url)
        XCTAssertThrowsError(try store.save(config)) { error in
            guard case ConfigError.invalid(let issues) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(issues.map(\.path), ["machine"])
        }
        XCTAssertEqual(try Data(contentsOf: url), before, "an invalid config never replaces the file")
    }

    func testInvalidFileOnDiskIsReportedNotLoaded() throws {
        let dir = makeTempDir()
        let url = dir.appendingPathComponent("config.json")
        try Data("{ nope".utf8).write(to: url)
        guard case .invalid = ConfigStore(url: url).load() else { return XCTFail() }
        try Data(#"{"machine":"BAD","endpoint":"wss://x.example","servers":{}}"#.utf8).write(to: url)
        guard case .invalid(let message) = ConfigStore(url: url).load() else { return XCTFail() }
        XCTAssertTrue(message.contains("machine"))
    }

    func testPathsFollowEnvironment() {
        let home = URL(fileURLWithPath: "/Users/someone")
        let defaults = BridgePaths(environment: [:], home: home, bundleResourceURL: URL(fileURLWithPath: "/App.app/Contents/Resources"))
        XCTAssertEqual(defaults.configURL.path, "/Users/someone/.config/local-bridge/config.json")
        XCTAssertEqual(defaults.statusURL.path, "/Users/someone/Library/Application Support/local-bridge/status.json")
        XCTAssertEqual(defaults.cliURL?.path, "/App.app/Contents/Resources/agent/cli.mjs")
        let custom = BridgePaths(environment: [
            "LOCAL_BRIDGE_CONFIG": "/tmp/c.json", "LOCAL_BRIDGE_STATE_DIR": "/tmp/state", "LOCAL_BRIDGE_AGENT_DIR": "/tmp/agent",
        ], home: home, bundleResourceURL: nil)
        XCTAssertEqual(custom.configURL.path, "/tmp/c.json")
        XCTAssertEqual(custom.statusURL.path, "/tmp/state/status.json")
        XCTAssertEqual(custom.cliURL?.path, "/tmp/agent/cli.mjs")
    }

    func testSecretsAndPermissions() {
        XCTAssertTrue(SecretHeuristics.looksSecret(key: "Authorization", value: "abc"))
        XCTAssertTrue(SecretHeuristics.looksSecret(key: "HA_TOKEN", value: "abc"))
        XCTAssertTrue(SecretHeuristics.looksSecret(key: "X-Thing", value: "Bearer abc"))
        XCTAssertFalse(SecretHeuristics.looksSecret(key: "Authorization", value: "keychain:local-bridge.ha-token"))
        XCTAssertFalse(SecretHeuristics.looksSecret(key: "LOG_LEVEL", value: "debug"))
        XCTAssertTrue(SecretHeuristics.isKeychainReference("keychain:x"))
        XCTAssertFalse(SecretHeuristics.isKeychainReference("keychain:"))

        func titles(_ arg: String) -> [String] {
            PermissionCatalog.knownServer(for: ServerConfig(command: "/usr/local/bin/node", args: [arg]))?.requirements.map(\.title) ?? []
        }
        XCTAssertEqual(titles("/Users/m/dev/apple-notes-mcp/dist/index.js"), ["Automation: Notes"])
        XCTAssertEqual(titles("/Users/m/dev/imessage-mcp/dist/index.js"), ["Full Disk Access", "Automation: Contacts"])
        XCTAssertEqual(titles("/Users/m/dev/apple-reminders-mcp/dist/index.js"), ["Reminders"])
        XCTAssertEqual(titles("/somewhere/else.js"), [])
    }
}

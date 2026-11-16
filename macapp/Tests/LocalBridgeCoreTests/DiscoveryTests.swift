import XCTest
@testable import LocalBridgeCore

final class DiscoveryTests: XCTestCase {
    func write(_ text: String, _ name: String, in dir: URL) -> URL {
        let url = dir.appendingPathComponent(name)
        try! Data(text.utf8).write(to: url)
        return url
    }

    func discover(_ source: DiscoverySource, _ text: String, existing: BridgeConfig? = nil) -> DiscoveryResult {
        let dir = makeTempDir()
        return ServerDiscovery(locations: [.init(source: source, url: write(text, "file", in: dir))]).discover(existing: existing)
    }

    func testClaudeCodeTopLevelAndPerProject() {
        let result = discover(.claudeCode, """
        {"numStartups": 4,
         "mcpServers": {"apple-notes": {"type":"stdio","command":"/usr/local/bin/node","args":["/Users/m/dev/apple-notes-mcp/dist/index.js"],"env":{"NOTES_TOKEN":"s3cret-value"}}},
         "projects": {"/Users/m/a": {"mcpServers": {"imessage": {"command":"node","args":["/Users/m/dev/imessage-mcp/dist/index.js"]}}},
                      "/Users/m/b": {"mcpServers": {"apple-notes": {"command":"/usr/local/bin/node","args":["/Users/m/dev/apple-notes-mcp/dist/index.js"]}}, "allowedTools": []}}}
        """)
        XCTAssertEqual(result.unreadable, [])
        XCTAssertEqual(result.servers.map(\.proposedTitle), ["Apple Notes", "Messages"])
        XCTAssertEqual(result.servers.map(\.proposedName), ["notes", "messages"])
        let notes = result.servers[0]
        XCTAssertEqual(notes.config.transport, .stdio)
        XCTAssertEqual(notes.config.command, "/usr/local/bin/node")
        XCTAssertEqual(notes.config.env, ["NOTES_TOKEN": "s3cret-value"], "values are carried into the config as they are")
        XCTAssertEqual(notes.summary, "node …/apple-notes-mcp/dist/index.js")
        XCTAssertFalse(notes.summary.contains("s3cret"))
        XCTAssertEqual(notes.sourceList, "Claude Code")
        XCTAssertEqual(notes.config.title, "Apple Notes")
        XCTAssertEqual(ConfigValidator.validate(notes.config, path: "s"), [])
    }

    func testClaudeDesktopCursorAndWindsurf() {
        let desktop = discover(.claudeDesktop, #"{"mcpServers":{"reminders":{"command":"node","args":["/x/apple-reminders-mcp/dist/index.js"]}},"globalShortcut":"x"}"#)
        XCTAssertEqual(desktop.servers.map(\.proposedTitle), ["Reminders"])

        let cursor = discover(.cursor, #"{"mcpServers":{"ha":{"url":"http://127.0.0.1:8123/mcp_server/sse","headers":{"Authorization":"Bearer abc123"}},"weird":{"note":"neither"}}}"#)
        XCTAssertEqual(cursor.servers.count, 1)
        XCTAssertEqual(cursor.servers[0].proposedTitle, "Home Assistant")
        XCTAssertEqual(cursor.servers[0].proposedName, "ha")
        XCTAssertEqual(cursor.servers[0].config.transport, .sse)
        XCTAssertEqual(cursor.servers[0].config.headers, ["Authorization": "Bearer abc123"])
        XCTAssertEqual(cursor.servers[0].summary, "http://127.0.0.1:8123/mcp_server/sse")

        let windsurf = discover(.windsurf, #"{"mcpServers":{"local-thing":{"serverUrl":"http://192.168.1.20:9000/mcp?token=zzz"}}}"#)
        XCTAssertEqual(windsurf.servers[0].config.transport, .http)
        XCTAssertEqual(windsurf.servers[0].proposedTitle, "Local Thing")
        XCTAssertEqual(windsurf.servers[0].summary, "http://192.168.1.20:9000/mcp", "the query string can hold a token")
    }

    func testVSCodeUsesServersKey() {
        let result = discover(.vsCode, #"{"servers":{"calendar-mcp":{"type":"stdio","command":"npx","args":["-y","calendar-mcp","--api-key","sk-live-123","--verbose"]},"remote":{"type":"http","url":"https://mcp.example.com/mcp"}},"inputs":[]}"#)
        XCTAssertEqual(result.servers.map(\.proposedTitle), ["Calendar"])
        XCTAssertEqual(result.servers[0].summary, "npx -y calendar-mcp --api-key ••• …")
        XCTAssertFalse(result.servers[0].summary.contains("sk-live"))
        XCTAssertEqual(result.alreadyRemote, [RemoteServerNote(title: "Remote", host: "mcp.example.com", sources: [.vsCode])])
    }

    func testCodexTOML() {
        let result = discover(.codex, """
        model = "o3"   # unrelated settings are skipped
        [profiles.fast]
        model = "x"

        [mcp_servers.apple-mail]
        command = "/usr/local/bin/node"
        args = ["/Users/m/dev/apple-mail-mcp/dist/index.js", "--flag"]
        startup_timeout_sec = 20
        env = { MAIL_TOKEN = "tok-1", "OTHER" = 'two' }

        [mcp_servers."my notes"]
        command = "uvx"
        args = [
          "notes-server",
          "--db", "/tmp/x.db",
        ]

        [mcp_servers."my notes".env]
        API_KEY = "abc"

        [mcp_servers.docs]
        url = "https://docs.example.com/mcp"
        """)
        XCTAssertEqual(result.unreadable, [])
        XCTAssertEqual(result.servers.map(\.proposedTitle), ["Mail", "Apple Notes"])
        XCTAssertEqual(result.servers[0].config.args, ["/Users/m/dev/apple-mail-mcp/dist/index.js", "--flag"])
        XCTAssertEqual(result.servers[0].config.env, ["MAIL_TOKEN": "tok-1", "OTHER": "two"])
        XCTAssertEqual(result.servers[1].config.command, "uvx")
        XCTAssertEqual(result.servers[1].config.args, ["notes-server", "--db", "/tmp/x.db"])
        XCTAssertEqual(result.servers[1].config.env, ["API_KEY": "abc"])
        XCTAssertEqual(result.alreadyRemote.map(\.host), ["docs.example.com"])
    }

    func testMalformedFilesAreReportedNotFatal() {
        for (source, text) in [
            (DiscoverySource.claudeCode, "{ not json"),
            (.claudeDesktop, "[1,2,3]"),
            (.cursor, ""),
            (.windsurf, "\u{0}\u{1}binary"),
            (.vsCode, #"{"servers": "#),
            (.codex, "[mcp_servers.x]\ncommand = \"unterminated\nargs = [1"),
            (.codex, "[mcp_servers.x]\nthis line has no equals sign"),
        ] {
            let result = discover(source, text)
            XCTAssertEqual(result.unreadable, [source], "\(source): \(text.prefix(20))")
            XCTAssertEqual(result.servers, [])
        }
        // Odd but valid shapes are simply empty.
        XCTAssertEqual(discover(.cursor, #"{"mcpServers": 7}"#).unreadable, [])
        XCTAssertEqual(discover(.cursor, #"{"mcpServers": {"a": 1, "b": {"command": ""}, "c": {"args": ["x"]}}}"#).servers, [])
        XCTAssertEqual(discover(.codex, "# nothing here\n[other]\nx = {{{").servers, [])
    }

    func testMissingFilesAreNotAnError() {
        let dir = makeTempDir()
        let discovery = ServerDiscovery(home: dir)
        XCTAssertEqual(discovery.locations.map(\.source), DiscoverySource.allCases)
        XCTAssertEqual(discovery.locations.last?.url.path, dir.path + "/.codex/config.toml")
        XCTAssertEqual(discovery.discover(), DiscoveryResult())
    }

    func testDeduplicatesAcrossSourcesAndSkipsWhatIsAlreadyAdded() {
        let dir = makeTempDir()
        let notes = #"{"command":"/usr/local/bin/node","args":["/x/apple-notes-mcp/dist/index.js"]}"#
        let discovery = ServerDiscovery(locations: [
            .init(source: .claudeCode, url: write("{\"mcpServers\":{\"apple-notes\":\(notes),\"imessage\":{\"command\":\"node\",\"args\":[\"/x/imessage-mcp/i.js\"]}}}", "a.json", in: dir)),
            .init(source: .claudeDesktop, url: write("{\"mcpServers\":{\"notes\":\(notes),\"notes-two\":{\"command\":\"node\",\"args\":[\"/x/other-notes/i.js\"]}}}", "b.json", in: dir)),
            .init(source: .cursor, url: dir.appendingPathComponent("missing.json")),
        ])
        var existing = BridgeConfig(machine: "mini")
        existing.servers["messages"] = ServerConfig(command: "node", args: ["/x/imessage-mcp/i.js"])

        let result = discovery.discover(existing: existing)
        XCTAssertEqual(result.alreadyAdded, 1)
        XCTAssertEqual(result.servers.map(\.proposedTitle), ["Apple Notes", "Apple Notes"])
        XCTAssertEqual(result.servers[0].sources, [.claudeCode, .claudeDesktop])
        XCTAssertEqual(result.servers[0].sourceList, "Claude Code, Claude Desktop")
        XCTAssertEqual(result.servers.map(\.proposedName), ["notes", "notes2"], "names never collide")
        XCTAssertTrue(result.servers.allSatisfy { ConfigValidator.isValidName($0.proposedName) })

        existing.servers["notes"] = ServerConfig(command: "x")
        XCTAssertEqual(discovery.discover(existing: existing).servers.map(\.proposedName), ["notes2", "notes3"])
    }

    func testLocalVersusPublicURLs() {
        for url in ["http://localhost:3000/mcp", "http://127.0.0.1:8123/sse", "http://[::1]:9/x", "http://10.0.0.5/mcp",
                    "http://192.168.1.9:1/mcp", "http://172.20.0.2/mcp", "http://homeassistant.local:8123/mcp", "http://nas:8080/mcp"] {
            XCTAssertTrue(ServerDiscovery.isLocalURL(url), url)
        }
        for url in ["https://mcp.example.com/mcp", "https://8.8.8.8/mcp", "http://172.32.0.1/mcp", "not a url", ""] {
            XCTAssertFalse(ServerDiscovery.isLocalURL(url), url)
        }
    }

    func testTitlesFromKeys() {
        XCTAssertEqual(ServerDiscovery.title(forKey: "apple-notes"), "Apple Notes")
        XCTAssertEqual(ServerDiscovery.title(forKey: "imessage"), "Messages")
        XCTAssertEqual(ServerDiscovery.title(forKey: "apple_reminders_mcp"), "Reminders")
        XCTAssertEqual(ServerDiscovery.title(forKey: "home-assistant"), "Home Assistant")
        XCTAssertEqual(ServerDiscovery.title(forKey: "github-mcp-server"), "Github")
        XCTAssertEqual(ServerDiscovery.title(forKey: "my_cool_tool"), "My Cool Tool")
        XCTAssertEqual(ServerDiscovery.title(forKey: "mcp"), "Mcp")
    }

    func testBundleIDMapping() {
        func id(_ title: String?, _ name: String = "x", _ invocation: String = "") -> String? {
            AppIdentity.bundleID(title: title, name: name, invocation: invocation)
        }
        XCTAssertEqual(id("Apple Notes"), "com.apple.Notes")
        XCTAssertEqual(id("Messages"), "com.apple.MobileSMS")
        XCTAssertEqual(id(nil, "x", "/usr/local/bin/node /Users/m/dev/imessage-mcp/dist/index.js"), "com.apple.MobileSMS")
        XCTAssertEqual(id("Reminders"), "com.apple.reminders")
        XCTAssertEqual(id(nil, "calendar"), "com.apple.iCal")
        XCTAssertEqual(id("Mail"), "com.apple.mail")
        XCTAssertEqual(id("Contacts"), "com.apple.AddressBook")
        XCTAssertNil(id("Home Assistant", "ha", "http://127.0.0.1:8123/mcp_server/sse"))
        XCTAssertNil(id("Gmail Search"), "a word inside another word does not count")
        XCTAssertEqual(id("Work", "x", "node /x/apple-notes-mcp/index.js"), "com.apple.Notes")
        XCTAssertEqual(id("Reminders", "x", "node /x/notes-and-reminders/index.js"), "com.apple.reminders", "the title wins over the path")
        XCTAssertEqual(AppIdentity.bundleID(for: ServerConfig(title: "Calendar", command: "node"), name: "cal"), "com.apple.iCal")
    }
}

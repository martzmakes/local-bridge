import Foundation
import LocalBridgeCore

/// Fixed, realistic state for snapshots: the servers that really run on this Mac.
@MainActor
enum SampleData {
    static let uid = "3f9a1c0b7d2e4a6f8b10"

    private static func node(_ project: String) -> ServerConfig {
        ServerConfig(transport: .stdio, command: "/usr/local/bin/node", args: ["/Users/example/dev/\(project)/dist/index.js"])
    }

    static let config: BridgeConfig = {
        var notes = node("apple-notes-mcp")
        notes.title = "Apple Notes"
        notes.read = ["list_folders", "list_notes", "get_note", "search_notes"]

        var messages = node("imessage-mcp")
        messages.title = "Messages"
        messages.read = ["list_contacts", "list_conversations", "get_conversation", "search_messages", "get_message_stats", "get_attachments"]

        var reminders = node("apple-reminders-mcp")
        reminders.title = "Reminders"
        reminders.read = ["list_reminder_lists", "list_reminders", "get_reminder"]
        reminders.write = ["create_reminder"]

        var ha = ServerConfig(transport: .sse, url: "http://127.0.0.1:8123/mcp_server/sse")
        ha.title = "Home Assistant"
        ha.headers = ["Authorization": "keychain:local-bridge.ha-token"]
        ha.read = ["GetLiveContext", "GetDateTime", "get_items"]

        var calendar = node("apple-calendar-mcp")
        calendar.title = "Calendar"
        calendar.enabled = false
        calendar.read = ["list_calendars", "list_events"]

        return BridgeConfig(
            machine: "mini", endpoint: BridgeConfig.defaultEndpoint, publicBase: "https://bridge.martzmakes.com", account: uid,
            servers: ["notes": notes, "messages": messages, "reminders": reminders, "ha": ha, "calendar": calendar]).withEndpointIDs()
    }()

    static var emptyConfig: BridgeConfig {
        BridgeConfig(machine: "mini", publicBase: "https://bridge.martzmakes.com", account: uid)
    }

    static let searchNotesSchema = try! JSONValue.parse("""
    {"type":"object","required":["query"],"properties":{
      "query":{"type":"string","description":"Text to search for in titles and bodies"},
      "folder":{"type":"string","description":"Only search this folder"},
      "limit":{"type":"integer","default":10,"description":"Most notes to return"}}}
    """)

    static let searchNotesResult = ToolCallResult(content: [.text("""
    [{"id":"x-coredata://7C2E/ICNote/p412","title":"Ski trip packing","folder":"Travel","modified":"2026-11-12T19:04:00Z","snippet":"Helmets, goggles, hand warmers, spare mittens"},{"id":"x-coredata://7C2E/ICNote/p377","title":"Packing list template","folder":"Notes","modified":"2026-09-30T08:15:00Z","snippet":"Chargers, passports, snacks for the car"}]
    """)], isError: false, milliseconds: 1240)

    private static func tools(_ items: [(String, String, ToolAccess)]) -> InspectCache.Entry {
        InspectCache.Entry(
            tools: items.map {
                InspectedTool(name: $0.0, description: $0.1, suggestedAccess: $0.2,
                              inputSchema: $0.0 == "search_notes" ? searchNotesSchema : .object(["type": .string("object"), "properties": .object([:])]))
            },
            inspectedAt: Date().addingTimeInterval(-5 * 60))
    }

    /// Descriptions as the servers themselves give them.
    static var inspections: InspectCache {
        InspectCache(servers: [
            "notes": tools([
                ("list_folders", "List all folders and accounts in Apple Notes.", .read),
                ("list_notes", "List notes in Apple Notes, optionally filtered by folder. Returns id, title, folder, dates, and a short plaintext snippet.", .read),
                ("get_note", "Get a specific note by its ID or by searching for a title. Returns the full body converted to Markdown.", .read),
                ("search_notes", "Search Apple Notes by text content. Searches both titles and note bodies.", .read),
                ("create_note", "Create a new note in Apple Notes. Accepts a title and body in Markdown format, which will be converted to HTML for Notes.", .write),
                ("update_note", "Update an existing note's title or body. Accepts Markdown for the body, which will be converted to HTML.", .write),
            ]),
            "messages": tools([
                ("list_contacts", "Search your macOS contacts by name, phone number, or email. Returns matching contacts with all their phone numbers and email addresses.", .read),
                ("list_conversations", "List your most recent iMessage conversations, sorted by last activity. Shows participant names, last message preview, and whether it's a group chat.", .read),
                ("get_conversation", "Get messages from a specific conversation. You can identify the conversation by contact name, phone number, email, or chat GUID. Returns messages in chronological order.", .read),
                ("search_messages", "Search across all iMessage conversations for messages containing specific text. Optionally filter by contact name.", .read),
                ("get_message_stats", "Get messaging statistics for a contact — total messages, sent vs received, date range, average messages per day, and top words used in conversation.", .read),
                ("get_attachments", "List file attachments (images, videos, documents, etc.) exchanged in a conversation with a specific contact.", .read),
            ]),
            "reminders": tools([
                ("list_reminder_lists", "List all Apple Reminders lists", .read),
                ("list_reminders", "List reminders, optionally filtered by list name and/or completion status", .read),
                ("get_reminder", "Get full details of a specific reminder", .read),
                ("create_reminder", "Create a new reminder", .write),
                ("complete_reminder", "Mark a reminder as completed", .write),
                ("uncomplete_reminder", "Mark a completed reminder as incomplete", .write),
                ("update_reminder", "Update a reminder's title, notes, due date, or priority", .write),
                ("delete_reminder", "Delete a reminder", .write),
                ("batch_delete_reminders", "Delete multiple reminders in a single operation. Much faster than calling delete_reminder repeatedly.", .write),
                ("batch_delete_except", "Delete all incomplete reminders EXCEPT those with the specified IDs. Useful for bulk cleanup — specify what to keep, everything else is deleted.", .write),
            ]),
        ])
    }

    private static func decodeStatus(_ json: String) -> BridgeStatus {
        try! JSONDecoder().decode(BridgeStatus.self, from: Data(json.utf8))
    }

    static func status(state: String = "connected", lastError: String? = nil, servers: Bool = true) -> StatusSnapshot {
        let error = lastError.map { "\"\($0)\"" } ?? "null"
        let list = servers ? """
        {"name":"notes","title":"Apple Notes","status":"up","error":null,"tools":[{"name":"list_folders","access":"read"},{"name":"list_notes","access":"read"},{"name":"get_note","access":"read"},{"name":"search_notes","access":"read"}]},
        {"name":"messages","title":"Messages","status":"up","error":null,"tools":[{"name":"a","access":"read"},{"name":"b","access":"read"},{"name":"c","access":"read"},{"name":"d","access":"read"},{"name":"e","access":"read"},{"name":"f","access":"read"}]},
        {"name":"reminders","title":"Reminders","status":"up","error":null,"tools":[{"name":"a","access":"read"},{"name":"b","access":"read"},{"name":"c","access":"read"},{"name":"d","access":"write"}]},
        {"name":"ha","title":"Home Assistant","status":"down","error":"HTTP 401","tools":[]}
        """ : ""
        return .running(decodeStatus("""
        {"pid":4242,"version":"0.2.0","machine":"mini","account":"\(uid)","updatedAt":1794796500000,
         "connection":{"state":"\(state)","since":1794790000000,"lastError":\(error)},
         "servers":[\(list)],
         "calls":{"total":\(servers ? 12 : 0),"failed":\(servers ? 2 : 0),"lastAt":1794796490000,"lastTool":"notes.search_notes","lastOutcome":"ok"}}
        """))
    }

    static var activity: ActivityBuffer {
        var buffer = ActivityBuffer()
        let calls: [(String, String, String, String, Int)] = [
            ("14:02:11", "notes", "list_folders", "ok", 412),
            ("14:02:13", "notes", "search_notes", "ok", 1380),
            ("14:02:16", "notes", "get_note", "ok", 964),
            ("14:05:40", "reminders", "list_reminder_lists", "ok", 188),
            ("14:05:41", "reminders", "list_reminders", "ok", 276),
            ("14:06:02", "reminders", "create_reminder", "ok", 341),
            ("14:11:27", "messages", "list_conversations", "ok", 97),
            ("14:11:29", "messages", "get_conversation", "ok", 143),
            ("14:11:52", "messages", "search_messages", "permission", 31),
            ("14:19:05", "notes", "search_notes", "timeout", 30004),
            ("14:19:48", "notes", "search_notes", "ok", 1122),
            ("14:20:03", "notes", "get_note", "ok", 873),
        ]
        // Local time without an offset, so the table reads the same wherever it is rendered.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let iso = ISO8601DateFormatter()
        for (time, server, tool, outcome, ms) in calls {
            let date = formatter.date(from: "2026-11-15 \(time)") ?? Date()
            buffer.ingest(line: #"{"ts":"\#(iso.string(from: date))","level":"info","event":"call","server":"\#(server)","tool":"\#(tool)","ms":\#(ms),"outcome":"\#(outcome)"}"#)
        }
        return buffer
    }

    static var machines: [AccountMachine] {
        let now = Date().timeIntervalSince1970 * 1000
        let json = """
        [{"machine":"air","enabled":true,"connected":false,"lastSeen":\(Int(now - 2 * 3600 * 1000 - 60_000)),"agentVersion":"0.2.0","kids":["k2"],
          "servers":[{"name":"notes","title":"Apple Notes","status":"down","tools":4},{"name":"reminders","title":"Reminders","status":"down","tools":3}]},
         {"machine":"beasty","enabled":true,"connected":false,"lastSeen":\(Int(now - 3 * 86400 * 1000 - 3_600_000)),"agentVersion":"0.2.0","kids":["k3"],
          "servers":[{"name":"ha","title":"Home Assistant","status":"down","tools":3}]},
         {"machine":"mini","enabled":true,"connected":true,"lastSeen":\(Int(now)),"agentVersion":"0.2.0","kids":["k1"],
          "servers":[{"name":"notes","title":"Apple Notes","status":"up","tools":4},{"name":"messages","title":"Messages","status":"up","tools":6},{"name":"reminders","title":"Reminders","status":"up","tools":4},{"name":"ha","title":"Home Assistant","status":"down","tools":0}]}]
        """
        return try! JSONDecoder().decode([AccountMachine].self, from: Data(json.utf8))
    }

    /// What a first look at this Mac's other apps turns up.
    static var discovery: DiscoveryResult {
        func found(_ key: String, _ title: String, _ name: String, _ project: String, _ sources: [DiscoverySource] = [.claudeCode]) -> DiscoveredServer {
            var config = node(project)
            config.title = title
            return DiscoveredServer(key: key, sources: sources, proposedTitle: title, proposedName: name,
                                    config: config, summary: ServerDiscovery.summary(of: config))
        }
        var result = DiscoveryResult()
        result.servers = [
            found("apple-notes", "Apple Notes", "notes", "apple-notes-mcp", [.claudeCode, .claudeDesktop]),
            found("imessage", "Messages", "messages", "imessage-mcp"),
            found("apple-reminders", "Reminders", "reminders", "apple-reminders-mcp"),
            found("apple-calendar", "Calendar", "calendar", "apple-calendar-mcp"),
            found("apple-mail", "Mail", "mail", "apple-mail-mcp"),
        ]
        result.alreadyRemote = [RemoteServerNote(title: "Linear", host: "mcp.linear.app", sources: [.claudeCode])]
        return result
    }

    /// Signed in, connected, everything populated.
    static func populated(selection: SidebarItem? = .server("notes")) -> PreviewState {
        var state = PreviewState()
        state.saved = config
        state.selection = selection
        state.status = status()
        state.supervisorState = .running(pid: 4242)
        state.activity = activity
        state.inspections = inspections
        state.identity = AccountIdentity(email: "matt@example.com", uid: uid)
        state.machines = machines
        return state
    }
}

import Foundation

/// One finished tool call from the daemon's log. The log carries no arguments or results.
public struct ActivityEntry: Sendable, Equatable, Identifiable {
    public var id: Int
    public var time: Date
    public var server: String
    public var tool: String
    public var outcome: String
    public var milliseconds: Int

    public var succeeded: Bool { outcome == "ok" }
}

public enum ActivityParser {
    /// Reads one JSON line. Only `event == "call"` lines are activity.
    public static func parse(line: String, id: Int = 0) -> ActivityEntry? {
        guard line.contains("\"call\""),
              let object = (try? JSONValue.parse(line))?.objectValue,
              object["event"]?.stringValue == "call",
              let server = object["server"]?.stringValue,
              let tool = object["tool"]?.stringValue else { return nil }
        let outcome = object["outcome"]?.stringValue ?? "unknown"
        var ms = 0
        if case .int(let i)? = object["ms"] { ms = Int(i) }
        if case .double(let d)? = object["ms"] { ms = Int(d) }
        let time = object["ts"]?.stringValue.flatMap(parseTimestamp) ?? Date()
        return ActivityEntry(id: id, time: time, server: server, tool: tool, outcome: outcome, milliseconds: ms)
    }

    static func parseTimestamp(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}

/// The last calls, oldest first, capped.
public struct ActivityBuffer: Sendable, Equatable {
    public static let defaultCapacity = 200

    public private(set) var entries: [ActivityEntry] = []
    public let capacity: Int
    private var nextID = 1

    public init(capacity: Int = ActivityBuffer.defaultCapacity) {
        self.capacity = max(1, capacity)
    }

    /// Returns true when the line was a call and was kept.
    @discardableResult
    public mutating func ingest(line: String) -> Bool {
        guard let entry = ActivityParser.parse(line: line, id: nextID) else { return false }
        nextID += 1
        entries.append(entry)
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        return true
    }
}

extension ActivityBuffer {
    /// How much one server was used: calls since midnight and when the last one was.
    public func usage(ofServer server: String, now: Date = Date(), calendar: Calendar = .current) -> (today: Int, last: Date)? {
        let calls = entries.filter { $0.server == server }
        guard let last = calls.map(\.time).max() else { return nil }
        let midnight = calendar.startOfDay(for: now)
        return (calls.filter { $0.time >= midnight }.count, last)
    }
}

/// The call lines kept across launches. They hold times, names, outcomes and durations, never content.
public struct ActivityStore: Sendable {
    public static let maxLines = 500

    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// The kept lines, oldest first.
    public func load() -> [String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return Array(text.split(whereSeparator: \.isNewline).map(String.init).suffix(ActivityStore.maxLines))
    }

    /// Adds one call line. The file is cut back to the newest lines once it has grown a fifth over the cap.
    public func append(_ line: String) {
        guard ActivityParser.parse(line: line) != nil else { return }
        var lines = load()
        let needsTrim = lines.count >= ActivityStore.maxLines
        lines.append(line)
        if needsTrim || !FileManager.default.fileExists(atPath: url.path) {
            let kept = lines.suffix(ActivityStore.maxLines).joined(separator: "\n") + "\n"
            try? AtomicFile.write(Data(kept.utf8), to: url, mode: 0o600)
            return
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data((line + "\n").utf8))
    }
}

/// Turns a byte stream into whole lines. A line longer than the cap is dropped, not buffered forever.
public struct LineSplitter: Sendable {
    private var pending = Data()
    private let maxLineBytes: Int

    public init(maxLineBytes: Int = 64 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    public mutating func feed(_ chunk: Data) -> [String] {
        pending.append(chunk)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            let lineData = pending[pending.startIndex..<newline]
            if !lineData.isEmpty {
                lines.append(String(decoding: lineData, as: UTF8.self))
            }
            pending = Data(pending[pending.index(after: newline)...])
        }
        if pending.count > maxLineBytes { pending.removeAll() }
        return lines
    }
}

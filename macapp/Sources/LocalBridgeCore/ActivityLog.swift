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

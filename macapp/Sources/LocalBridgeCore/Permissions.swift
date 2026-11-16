import Foundation

public struct PermissionRequirement: Sendable, Equatable, Identifiable {
    public var title: String
    public var why: String
    /// The System Settings pane where the grant lives.
    public var settingsURL: String

    public var id: String { title }
}

public struct KnownServer: Sendable, Equatable {
    public var kind: String
    public var requirements: [PermissionRequirement]
}

/// The macOS privacy grants each known local server needs. The app is the process that spawns
/// the servers, so macOS attaches the grants to Local Bridge.
public enum PermissionCatalog {
    public static let automationURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    public static let fullDiskURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    public static let remindersURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"

    public static func knownServer(for server: ServerConfig) -> KnownServer? {
        let text = server.invocationText
        if text.contains("apple-notes-mcp") {
            return KnownServer(kind: "apple-notes-mcp", requirements: [
                PermissionRequirement(
                    title: "Automation: Notes",
                    why: "It reads and writes notes by sending AppleScript to the Notes app.",
                    settingsURL: automationURL),
            ])
        }
        if text.contains("imessage-mcp") {
            return KnownServer(kind: "imessage-mcp", requirements: [
                PermissionRequirement(
                    title: "Full Disk Access",
                    why: "It reads the Messages database (~/Library/Messages/chat.db) and the AddressBook databases directly.",
                    settingsURL: fullDiskURL),
                PermissionRequirement(
                    title: "Automation: Contacts",
                    why: "It looks up contact names by sending AppleScript to the Contacts app.",
                    settingsURL: automationURL),
            ])
        }
        if text.contains("apple-reminders-mcp") {
            return KnownServer(kind: "apple-reminders-mcp", requirements: [
                PermissionRequirement(
                    title: "Reminders",
                    why: "Its helper reads and changes reminders through EventKit. Without the grant it reports no reminders instead of an error.",
                    settingsURL: remindersURL),
            ])
        }
        return nil
    }
}

public enum SecretHeuristics {
    public static let keychainPrefix = "keychain:"

    public static func isKeychainReference(_ value: String) -> Bool {
        value.hasPrefix(keychainPrefix) && value.count > keychainPrefix.count
    }

    /// True for a header or environment value that should not be shown back in the clear.
    public static func looksSecret(key: String, value: String) -> Bool {
        if isKeychainReference(value) { return false }
        let k = key.lowercased()
        let markers = ["authorization", "token", "secret", "password", "passwd", "api-key", "api_key", "apikey", "cookie", "credential"]
        if markers.contains(where: k.contains) { return true }
        if k.hasSuffix("_key") || k.hasSuffix("-key") || k == "key" { return true }
        let v = value.lowercased()
        return v.hasPrefix("bearer ") || v.hasPrefix("basic ")
    }
}

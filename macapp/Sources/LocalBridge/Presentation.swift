import AppKit
import LocalBridgeCore
import SwiftUI

/// How raw state is worded and drawn. Kept in one place so the window, the menu and Activity agree.
enum Presentation {
    /// A symbol for a server, from its title or what it runs.
    static func symbol(name: String, server: ServerConfig?) -> String {
        let text = "\(name) \(server?.title ?? "") \(server?.invocationText ?? "")".lowercased()
        let known: [(String, String)] = [
            ("reminder", "checklist"),
            ("imessage", "message"), ("messages", "message"),
            ("calendar", "calendar"),
            ("home assistant", "house"), ("homeassistant", "house"), ("home-assistant", "house"), (":8123", "house"),
            ("notes", "note.text"),
            ("mail", "envelope"),
        ]
        if let match = known.first(where: { text.contains($0.0) }) { return match.1 }
        return server?.transport.isRemote == true ? "globe" : "terminal"
    }

    static func isSignInRefusal(_ error: String) -> Bool {
        error.contains("401") || error.contains("403")
    }

    /// One short phrase for a server that is down.
    static func shortProblem(_ error: String) -> String {
        isSignInRefusal(error) ? "Sign-in refused" : "Not responding"
    }

    /// The full status line for a server that is down.
    static func problem(_ error: String) -> String {
        if isSignInRefusal(error) {
            let code = error.contains("403") ? "403" : "401"
            return "Sign-in refused by the server (HTTP \(code))"
        }
        return "Not responding: \(error)"
    }

    static func stateLabel(_ state: ServerRunState) -> String {
        switch state {
        case .up: return "Running"
        case .down(let error): return shortProblem(error)
        case .off: return "Off"
        case .unsaved: return "Not saved yet"
        case .unknown: return "Bridge not running"
        }
    }

    static func outcome(_ raw: String) -> String {
        switch raw {
        case "ok": return "Succeeded"
        case "timeout": return "Timed out"
        case "permission": return "Needs permission"
        default:
            let words = raw.replacingOccurrences(of: "_", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    static func duration(milliseconds: Int) -> String {
        if milliseconds < 1000 { return "\(milliseconds) ms" }
        let seconds = Double(milliseconds) / 1000
        return seconds < 10 ? String(format: "%.1f s", seconds) : "\(Int(seconds.rounded())) s"
    }

    static func machineSymbol(_ name: String) -> String {
        let n = name.lowercased()
        if n.contains("mini") { return "macmini" }
        if n.contains("air") || n.contains("book") || n.contains("laptop") { return "laptopcomputer" }
        return "desktopcomputer"
    }
}

extension Presentation {
    /// "12 calls today, last 3 minutes ago", or "Not used yet".
    static func usage(_ usage: (today: Int, last: Date)?) -> String {
        guard let usage else { return "Not used yet" }
        let last = usage.last.formatted(.relative(presentation: .named))
        if usage.today == 0 { return "Last used \(last)" }
        return "\(usage.today) \(usage.today == 1 ? "call" : "calls") today, last \(last)"
    }

    /// The icon of the Mac app a server is about, when there is one.
    @MainActor
    static func appIcon(name: String, server: ServerConfig?) -> NSImage? {
        guard let server, let bundleID = AppIdentity.bundleID(for: server, name: name) else { return nil }
        if let cached = iconCache[bundleID] { return cached }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return nil }
        let icon = NSWorkspace.shared.icon(forFile: url.path)
        icon.size = NSSize(width: 18, height: 18)
        iconCache[bundleID] = icon
        return icon
    }

    @MainActor private static var iconCache: [String: NSImage] = [:]
}

/// A server's icon: the real app's when the server is about one, a symbol otherwise.
struct ServerIcon: View {
    var name: String
    var server: ServerConfig?
    var size: CGFloat = 18

    var body: some View {
        if let icon = Presentation.appIcon(name: name, server: server) {
            Image(nsImage: icon)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            Image(systemName: Presentation.symbol(name: name, server: server))
                .foregroundStyle(.secondary)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

/// A server's state as a small mark that does not rely on colour alone.
struct StatusIndicator: View {
    var state: ServerRunState

    var body: some View {
        Group {
            switch state {
            case .up:
                Image(systemName: "circle.fill")
                    .foregroundStyle(.green)
                    .font(.system(size: 8))
            case .down:
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .font(.system(size: 11))
            case .off:
                Text("Off")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            case .unknown, .unsaved:
                Image(systemName: "circle")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 8))
            }
        }
        .accessibilityLabel(Presentation.stateLabel(state))
        .help(Presentation.stateLabel(state))
    }
}

extension NSImage {
    /// A coloured SF Symbol that keeps its colour inside a menu.
    static func menuSymbol(_ name: String, color: NSColor) -> NSImage {
        let configuration = NSImage.SymbolConfiguration(pointSize: 12, weight: .regular)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration) ?? NSImage()
        image.isTemplate = false
        return image
    }
}

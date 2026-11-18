import LocalBridgeCore
import SwiftUI

struct MenuBarLabel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Image(systemName: MenuBarLabel.symbol(for: model))
            .accessibilityLabel("Local Bridge: \(model.daemonSummary)")
    }

    @MainActor
    static func symbol(for model: AppModel) -> String {
        guard model.phase == .signedIn, !model.paused else { return "arrow.left.arrow.right.circle" }
        switch model.connectionState {
        case .connected: return "arrow.left.arrow.right.circle.fill"
        case .connecting: return "arrow.left.arrow.right.circle"
        case .offline: return "exclamationmark.circle"
        }
    }
}

struct MenuBarContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Label(model.daemonSummary, systemImage: MenuBarLabel.symbol(for: model))
        if model.phase == .signedIn, let config = model.saved, !config.servers.isEmpty {
            Divider()
            ForEach(config.serverNamesByTitle, id: \.self) { name in
                let state = model.runState(for: name)
                Button {
                    model.selection = .server(name)
                    open()
                } label: {
                    Label {
                        Text("\(config.servers[name]?.title ?? name) — \(detail(state))")
                    } icon: {
                        Image(nsImage: Presentation.appIcon(name: name, server: config.servers[name]) ?? icon(state))
                    }
                }
                .disabled(state == .off)
            }
        }
        Divider()
        Button(model.phase == .signedIn ? "Open Local Bridge…" : "Sign In…") { open() }
        if model.phase == .signedIn {
            Button(model.paused ? "Resume Bridge" : "Pause Bridge") {
                model.setPaused(!model.paused)
            }
        }
        SettingsLink {
            Text("Settings…")
        }
        .keyboardShortcut(",")
        CheckForUpdatesButton()
        Divider()
        Button("Quit Local Bridge") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private func open() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }

    private func detail(_ state: ServerRunState) -> String {
        switch state {
        case .up(let tools): return tools == 1 ? "1 tool" : "\(tools) tools"
        case .down(let error): return Presentation.shortProblem(error)
        case .off: return "Off"
        case .unknown, .unsaved: return "Not running"
        }
    }

    private func icon(_ state: ServerRunState) -> NSImage {
        switch state {
        case .up: return .menuSymbol("circle.fill", color: .systemGreen)
        case .down: return .menuSymbol("exclamationmark.triangle.fill", color: .systemOrange)
        case .off, .unknown, .unsaved: return .menuSymbol("circle", color: .tertiaryLabelColor)
        }
    }
}

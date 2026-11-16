import LocalBridgeCore
import SwiftUI

/// One notice above the detail pane: what is wrong, and the way out.
struct Banner<Actions: View>: View {
    var symbol: String
    var tint: Color
    var title: String
    var message: String?
    var monospacedDetail: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(tint)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.headline)
                    if let message {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    if let monospacedDetail {
                        Text(monospacedDetail)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                    }
                    HStack { actions }
                        .controlSize(.small)
                        .padding(.top, 2)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            Divider()
        }
        .background(.fill.quaternary)
    }
}

struct BannerStack: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(spacing: 0) {
            if let message = model.invalidConfigMessage {
                Banner(
                    symbol: "exclamationmark.triangle.fill", tint: .orange,
                    title: "The config file has an error, so it is shown read-only",
                    message: "Nothing is written and the bridge is not started until the file is fixed.",
                    monospacedDetail: message
                ) {
                    Button("Show in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([model.paths.configURL])
                    }
                    Button("Reload") {
                        model.reloadConfig()
                        model.restartDaemon()
                    }
                }
            }
            switch model.blocker {
            case .nodeMissing:
                Banner(
                    symbol: "exclamationmark.triangle.fill", tint: .orange,
                    title: "Node was not found",
                    message: model.nodeOverride.isEmpty
                        ? "The bridge agent runs on Node. Install it, or set its path in Settings. Nothing is running."
                        : "There is no runnable node at \(model.nodeOverride). Nothing is running."
                ) {
                    Button("Open Settings…") {
                        model.settingsTab = .general
                        openSettings()
                    }
                }
            case .launchAgentLoaded:
                Banner(
                    symbol: "exclamationmark.triangle.fill", tint: .orange,
                    title: "The old background agent is still loaded",
                    message: "Two agents would compete for this Mac's connection, so this app has not started one. Remove the old one with agent/scripts/uninstall.sh, or with:",
                    monospacedDetail: LaunchAgentProbe.uninstallCommand()
                ) {
                    Button("Copy Command") { copyToPasteboard(LaunchAgentProbe.uninstallCommand()) }
                    Button("Check Again") { model.startDaemonIfPossible() }
                }
            case .agentMissing(let path):
                Banner(
                    symbol: "exclamationmark.triangle.fill", tint: .orange,
                    title: "The bridge agent is missing from this app",
                    message: "Build the app with scripts/build-app.sh so the agent is included.",
                    monospacedDetail: path
                ) {
                    Button("Check Again") { model.startDaemonIfPossible() }
                }
            case .otherDaemon(let pid):
                Banner(
                    symbol: "exclamationmark.triangle.fill", tint: .orange,
                    title: "Another bridge agent is already running",
                    message: "Process \(pid) was not started by this app. Two agents would compete for this Mac's connection."
                ) {
                    Button("Stop It and Start Here") { model.stopOtherDaemon() }
                    Button("Check Again") { model.startDaemonIfPossible() }
                }
            case nil:
                EmptyView()
            }
            if let error = model.saveError {
                Banner(
                    symbol: "xmark.octagon.fill", tint: .red,
                    title: "The changes were not saved", monospacedDetail: error
                ) {
                    EmptyView()
                }
            }
            if model.isRegistering {
                Banner(symbol: "arrow.triangle.2.circlepath", tint: .secondary, title: "Registering this Mac with your account…") {
                    EmptyView()
                }
            } else if let error = model.registrationError {
                Banner(symbol: "xmark.octagon.fill", tint: .red, title: "This Mac is not registered", message: error) {
                    Button("Try Again") { model.retryRegistration() }
                }
            }
            if model.paused {
                Banner(symbol: "pause.circle.fill", tint: .secondary, title: "The bridge is paused", message: "No endpoint on this Mac answers until you resume.") {
                    Button("Resume") { model.setPaused(false) }
                }
            }
            if model.runsWithoutAccount {
                Banner(symbol: "hammer.fill", tint: .secondary, title: "Running without an account", message: "LOCAL_BRIDGE_NO_ACCOUNT is set. This is for development against a local endpoint.") {
                    EmptyView()
                }
            }
        }
    }
}

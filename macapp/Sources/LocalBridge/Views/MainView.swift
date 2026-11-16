import LocalBridgeCore
import SwiftUI

struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingRemoval: String?

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            List(selection: $model.selection) {
                Section("Servers") {
                    ForEach(model.serverNames, id: \.self) { name in
                        ServerSidebarRow(name: name)
                            .tag(SidebarItem.server(name))
                            .contextMenu {
                                Button("Remove…", role: .destructive) { confirmingRemoval = name }
                                    .disabled(model.isReadOnly)
                            }
                    }
                    if model.serverNames.isEmpty {
                        Text("No servers yet")
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Bridge") {
                    Label("Activity", systemImage: "clock.arrow.circlepath")
                        .tag(SidebarItem.activity)
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 320)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ConnectionBadge()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .toolbar {
                ToolbarItem {
                    Button {
                        model.showingAddServer = true
                    } label: {
                        Label("Add Server", systemImage: "plus")
                    }
                    .help("Add a server")
                    .disabled(model.isReadOnly || model.serverNames.count >= BridgeConfig.maxServers)
                }
            }
        } detail: {
            VStack(spacing: 0) {
                BannerStack()
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .toolbar {
                // Only while there is something to save, and only where editing happens.
                if model.isDirty, !model.isReadOnly, isEditingServer {
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button("Revert") { model.revert() }
                            .help("Discard the changes you have not saved")
                        Button("Save") { model.requestSave() }
                            .buttonStyle(.borderedProminent)
                            .keyboardShortcut(.defaultAction)
                            .help("Save and restart the bridge. Calls in progress fail.")
                    }
                }
            }
        }
        .sheet(isPresented: $model.showingAddServer, onDismiss: { model.addServerStartsManual = false }) {
            AddServerSheet(startManually: model.addServerStartsManual)
        }
        .sheet(item: $model.tryingTool) { target in
            TryToolSheet(target: target)
        }
        .confirmationDialog("Save and restart the bridge?", isPresented: $model.confirmingSave) {
            Button("Save and Restart") { model.save() }
        } message: {
            Text("An agent used the bridge \(model.secondsSinceLastCall.map { "\($0) seconds" } ?? "moments") ago. Saving restarts it, and a call that is still running will fail.")
        }
        .confirmationDialog(
            "Remove “\(confirmingRemoval ?? "")”?",
            isPresented: Binding(get: { confirmingRemoval != nil }, set: { if !$0 { confirmingRemoval = nil } })
        ) {
            Button("Remove", role: .destructive) {
                if let name = confirmingRemoval { model.removeServer(name) }
                confirmingRemoval = nil
            }
        } message: {
            Text("Its connector URL stops working once you save. The server itself is not touched.")
        }
        .task { await model.loadMachines() }
    }

    private var isEditingServer: Bool {
        if case .server(let name)? = model.selection { return model.draft.servers[name] != nil }
        return false
    }

    @ViewBuilder
    private var detail: some View {
        switch model.selection {
        case .server(let name) where model.draft.servers[name] != nil:
            ServerDetailView(name: name) { confirmingRemoval = name }
                .id("\(name)-\(model.draftGeneration)")
        case .activity:
            ActivityView()
        default:
            if model.serverNames.isEmpty {
                ContentUnavailableView {
                    Label("No Servers Yet", systemImage: "server.rack")
                } description: {
                    Text("Local Bridge can pick up the MCP servers you already use in Claude, Cursor and other apps on this Mac. Each gets its own connector URL that your agents can use from anywhere.")
                } actions: {
                    Button("Add Servers from This Mac…") { model.showingAddServer = true }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isReadOnly)
                    Button("Add Manually…") {
                        model.addServerStartsManual = true
                        model.showingAddServer = true
                    }
                    .disabled(model.isReadOnly)
                }
                .navigationTitle("Local Bridge")
            } else {
                ContentUnavailableView("Select a Server", systemImage: "sidebar.left")
                    .navigationTitle("Local Bridge")
            }
        }
    }
}

struct ServerSidebarRow: View {
    @Environment(AppModel.self) private var model
    var name: String

    var body: some View {
        let server = model.draft.servers[name]
        HStack(spacing: 6) {
            Label {
                Text(server?.title?.isEmpty == false ? server!.title! : name)
                    .lineLimit(1)
            } icon: {
                ServerIcon(name: name, server: server)
            }
            Spacer(minLength: 4)
            StatusIndicator(state: server?.isEnabled == false ? .off : model.runState(for: name))
        }
    }
}

struct ConnectionBadge: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .font(.system(size: symbol == "circle.fill" ? 8 : 11))
            Text(model.daemonSummary)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .help(model.daemonSummary)
    }

    private var symbol: String {
        if model.paused { return "pause.circle" }
        switch model.connectionState {
        case .connected: return "circle.fill"
        case .connecting: return "circle.dotted"
        case .offline: return "exclamationmark.triangle.fill"
        }
    }

    private var color: Color {
        if model.paused { return .secondary }
        switch model.connectionState {
        case .connected: return .green
        case .connecting: return .secondary
        case .offline: return .orange
        }
    }
}

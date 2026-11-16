import LocalBridgeCore
import SwiftUI

struct ServerDetailView: View {
    @Environment(AppModel.self) private var model
    var name: String
    var remove: () -> Void
    @State private var copied = false
    /// nil until the user opens or closes Configuration themselves.
    @State private var configurationExpanded: Bool?

    private var server: Binding<ServerConfig> {
        Binding(
            get: { model.draft.servers[name] ?? ServerConfig() },
            set: { model.draft.servers[name] = $0 })
    }

    /// Configuration stays out of the way while the server works, and is open when it needs attention.
    private var expandedByDefault: Bool {
        if case .up = model.runState(for: name) { return !model.hasBeenInspected(name) }
        if case .off = model.runState(for: name) { return false }
        return true
    }

    var body: some View {
        @Bindable var model = model
        let readOnly = model.isReadOnly
        let state = model.runState(for: name)
        Form {
            Section {
                LabeledContent("Connector URL") {
                    HStack(spacing: 8) {
                        Text(model.endpointURL(for: name))
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Button(copied ? "Copied" : "Copy") {
                            copyToPasteboard(model.endpointURL(for: name))
                            copied = true
                            Task {
                                try? await Task.sleep(nanoseconds: 1_500_000_000)
                                copied = false
                            }
                        }
                        .controlSize(.small)
                        .help("Copy the connector URL")
                    }
                }
                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        if state != .off { StatusIndicator(state: state) }
                        Text(statusText)
                            .foregroundStyle(.secondary)
                    }
                }
                Toggle("Enabled", isOn: server.isEnabled)
                    .disabled(readOnly)
            } footer: {
                Text("Add the connector URL to an agent to give it this server’s tools. While a server is off it is not started and its URL does not answer.")
                    .formFooter()
            }

            ToolsSection(name: name)

            Section {
                let expanded = configurationExpanded ?? expandedByDefault
                Button {
                    configurationExpanded = !expanded
                } label: {
                    HStack {
                        Text("Configuration")
                        Spacer()
                        if !expanded {
                            Text(configurationSummary)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Hide configuration" : "Show configuration")
                if expanded {
                    TextField("Title", text: Binding(
                        get: { server.wrappedValue.title ?? "" },
                        set: { server.wrappedValue.title = $0.isEmpty ? nil : $0 }), prompt: Text(name))
                        .disabled(readOnly)
                    TransportFields(server: server, disabled: readOnly)
                    if server.wrappedValue.transport == .stdio {
                        KeyValueEditor(title: "Environment", addLabel: "Add Variable", values: server.env, disabled: readOnly)
                    } else {
                        KeyValueEditor(title: "Headers", addLabel: "Add Header", values: server.headers, disabled: readOnly)
                    }
                }
            } footer: {
                if configurationExpanded ?? expandedByDefault {
                    Text("Values are saved in a settings file only your user can read. A value written as keychain:<service> is read from the Keychain when the server starts.")
                        .formFooter()
                }
            }

            Section {
                Button("Remove Server…", role: .destructive, action: remove)
                    .foregroundStyle(.red)
                    .disabled(readOnly)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(server.wrappedValue.title ?? name)
        .navigationSubtitle(model.isDirty ? "Edited" : "")
        .toolbar {
            ToolbarItem {
                Button {
                    model.refreshTools(for: name)
                } label: {
                    Label("Refresh Tools", systemImage: "arrow.clockwise")
                }
                .help("Ask the server which tools it offers")
                .disabled(model.isInspecting(name))
            }
        }
        .alert(
            "Let agents use “\(model.pendingWriteTool?.tool ?? "")”?",
            isPresented: Binding(get: { model.pendingWriteTool != nil }, set: { if !$0 { model.pendingWriteTool = nil } })
        ) {
            Button("Turn On") { model.confirmPendingWriteTool() }
            Button("Cancel", role: .cancel) { model.pendingWriteTool = nil }
        } message: {
            Text("This tool can make changes on this Mac. Once you save, any agent using this connector URL can call it.")
        }
    }

    /// What the collapsed Configuration row shows: the command or URL.
    private var configurationSummary: String {
        let server = server.wrappedValue
        if server.transport.isRemote { return server.url }
        let last = server.args.last.map { ($0 as NSString).lastPathComponent }
        return ([(server.command as NSString).lastPathComponent] + (last.map { [$0] } ?? [])).joined(separator: " ")
    }

    private var statusText: String {
        let server = server.wrappedValue
        let exposed = server.exposedToolCount
        let total = model.toolRows(for: name).count
        let tools = model.hasBeenInspected(name) ? "\(exposed) of \(total) tools on" : "\(exposed) \(exposed == 1 ? "tool" : "tools") on"
        switch model.runState(for: name) {
        case .unsaved: return "Not saved yet"
        case .off: return "Off"
        case .up: return "Running, \(tools)"
        case .down(let error): return Presentation.problem(error)
        case .unknown: return model.paused ? "Bridge paused" : "Bridge not running"
        }
    }
}

struct ToolsSection: View {
    @Environment(AppModel.self) private var model
    var name: String

    var body: some View {
        let rows = model.toolRows(for: name)
        Section {
            if let error = model.inspectError(for: name) {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
            }
            if rows.isEmpty {
                Text(model.hasBeenInspected(name)
                     ? "This server offers no tools."
                     : "Not checked yet. Use Refresh Tools in the toolbar to ask the server what it offers.")
                    .foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                Toggle(isOn: Binding(
                    get: { row.isOn },
                    set: { model.setTool(server: name, tool: row.name, on: $0) })
                ) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(row.name)
                                .font(.body.monospaced())
                            if row.changesThings {
                                HStack(spacing: 3) {
                                    Image(systemName: "exclamationmark.triangle")
                                        .foregroundStyle(.orange)
                                    Text("Can make changes")
                                        .foregroundStyle(.secondary)
                                }
                                .font(.caption)
                                .help("This tool can change or delete things on this Mac. It stays off until you turn it on.")
                            }
                        }
                        if !row.description.isEmpty {
                            Text(row.description)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                                .help(row.description)
                        } else if row.notReported {
                            Text("The server did not list this tool when last checked.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .disabled(model.isReadOnly)
            }
        } header: {
            HStack(spacing: 8) {
                Text("Tools")
                if model.isInspecting(name) {
                    ProgressView()
                        .controlSize(.small)
                }
            }
        } footer: {
            if let date = model.inspectedAt(name) {
                Text("Agents can only see and call the tools that are switched on. Last checked \(date.formatted(.relative(presentation: .named))).")
                    .formFooter()
            } else {
                Text("Agents can only see and call the tools that are switched on.")
                    .formFooter()
            }
        }
    }
}

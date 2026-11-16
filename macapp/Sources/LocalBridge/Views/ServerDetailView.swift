import LocalBridgeCore
import SwiftUI

struct ServerDetailView: View {
    @Environment(AppModel.self) private var model
    var name: String
    var remove: () -> Void
    @State private var copied = false
    @State private var openedConnector: ConnectorApp?
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
        let groups = model.toolGroups(for: name)
        Form {
            Section {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(model.endpointURL(for: name))
                        .font(.title3.monospaced())
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    Button(copied ? "Copied" : "Copy") {
                        copyToPasteboard(model.endpointURL(for: name))
                        copied = true
                        Task {
                            try? await Task.sleep(nanoseconds: 1_500_000_000)
                            copied = false
                        }
                    }
                    .help("Copy the connector URL")
                }
                .padding(.vertical, 2)
                HStack(spacing: 8) {
                    Button("Add to Claude…") { connect(.claude) }
                    Button("Add to ChatGPT…") { connect(.chatGPT) }
                    Spacer()
                }
                LabeledContent("Last used", value: Presentation.usage(model.activity.usage(ofServer: name)))
            } header: {
                Text("Connect")
            } footer: {
                Text(connectHint)
                    .formFooter()
            }

            Section {
                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        if state != .off { StatusIndicator(state: state) }
                        Text(statusText(groups))
                            .foregroundStyle(.secondary)
                    }
                }
                Toggle("Enabled", isOn: server.isEnabled)
                    .disabled(readOnly)
            } footer: {
                Text("While a server is off it is not started and its connector URL does not answer.")
                    .formFooter()
            }

            ToolsSections(name: name, groups: groups)

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
                VStack(alignment: .leading, spacing: 14) {
                    if configurationExpanded ?? expandedByDefault {
                        Text("Values are saved in a settings file only your user can read. A value written as keychain:<service> is read from the Keychain when the server starts.")
                            .formFooter()
                    }
                    HStack {
                        Spacer()
                        Button(role: .destructive, action: remove) {
                            Text("Remove Server…")
                                .foregroundStyle(.red)
                        }
                        .disabled(readOnly)
                    }
                }
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
        .alert(
            "Turn on every tool that can make changes?",
            isPresented: Binding(get: { model.pendingBulkWrite != nil }, set: { if !$0 { model.pendingBulkWrite = nil } })
        ) {
            Button("Turn All On") { model.confirmPendingBulkWrite() }
            Button("Cancel", role: .cancel) { model.pendingBulkWrite = nil }
        } message: {
            Text("Once you save, any agent using this connector URL can call: \((model.pendingBulkWrite?.tools ?? []).joined(separator: ", ")).")
        }
    }

    private func connect(_ app: ConnectorApp) {
        model.openConnector(app, server: name)
        openedConnector = app
    }

    private var connectHint: String {
        let email = model.identity?.email
        let account = email.map { "with \($0)" } ?? "with the email you use here"
        if let app = openedConnector {
            return "The URL is copied. In \(app.name), add a custom connector, paste the URL, and sign in \(account)."
        }
        return "Each button copies the URL and opens that app’s connector settings. Paste it there and sign in \(account)."
    }

    /// What the collapsed Configuration row shows: the command or URL.
    private var configurationSummary: String {
        ServerDiscovery.summary(of: server.wrappedValue)
    }

    private func statusText(_ groups: ToolGroups) -> String {
        let on = ToolGroups.count(on: groups.all)
        let tools = model.hasBeenInspected(name) ? "\(on) of \(groups.all.count) tools on" : "\(on) \(on == 1 ? "tool" : "tools") on"
        switch model.runState(for: name) {
        case .unsaved: return "Not saved yet"
        case .off: return "Off"
        case .up: return "Running, \(tools)"
        case .down(let error): return Presentation.problem(error)
        case .unknown: return model.paused ? "Bridge paused" : "Bridge not running"
        }
    }
}

/// The tools in two groups: what can only read, and what can make changes.
struct ToolsSections: View {
    @Environment(AppModel.self) private var model
    var name: String
    var groups: ToolGroups

    var body: some View {
        if groups.all.isEmpty {
            Section("Tools") {
                if let error = model.inspectError(for: name) {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
                HStack(spacing: 8) {
                    if model.isInspecting(name) {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(model.isInspecting(name)
                         ? "Asking the server what it offers…"
                         : model.hasBeenInspected(name)
                         ? "This server offers no tools."
                         : "Not checked yet. Use Refresh Tools in the toolbar to ask the server what it offers.")
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            if let error = model.inspectError(for: name) {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
            group("Can Read", groups.read, access: .read, footer: nil)
            group("Can Make Changes", groups.write, access: .write, footer: footer)
        }
    }

    private var footer: String {
        var text = "Agents only see the tools that are switched on."
        if let date = model.inspectedAt(name) {
            text += " Last checked \(date.formatted(.relative(presentation: .named)))."
        }
        return text
    }

    @ViewBuilder
    private func group(_ title: String, _ entries: [ToolEntry], access: ToolAccess, footer: String?) -> some View {
        let on = ToolGroups.count(on: entries)
        if !entries.isEmpty || footer != nil {
            Section {
                ForEach(entries) { entry in
                    ToolRowView(server: name, entry: entry)
                }
                if entries.isEmpty {
                    Text("None")
                        .foregroundStyle(.secondary)
                }
            } header: {
                HStack(spacing: 8) {
                    Text(title)
                    if !entries.isEmpty {
                        Text("\(on) of \(entries.count) on")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if model.isInspecting(name) {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Spacer()
                    if !entries.isEmpty {
                        Button(on == entries.count ? "Turn All Off" : "Turn All On") {
                            model.setAllTools(server: name, access: access, on: on != entries.count)
                        }
                        .buttonStyle(.borderless)
                        .font(.subheadline)
                        .disabled(model.isReadOnly)
                    }
                }
            } footer: {
                if let footer {
                    Text(footer)
                        .formFooter()
                }
            }
        }
    }
}

struct ToolRowView: View {
    @Environment(AppModel.self) private var model
    var server: String
    var entry: ToolEntry

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(.body.monospaced())
                if !entry.description.isEmpty {
                    Text(entry.description)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .help(entry.description)
                } else if entry.notReported {
                    Text("The server did not list this tool when last checked.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button("Try…") { model.tryingTool = TryTarget(server: server, tool: entry) }
                .buttonStyle(.borderless)
                .help("Run this tool once on this Mac and see what it returns")
            Toggle(entry.name, isOn: Binding(
                get: { entry.isOn },
                set: { model.setTool(server: server, tool: entry, on: $0) }))
                .labelsHidden()
                .toggleStyle(.switch)
                .disabled(model.isReadOnly)
        }
        .contextMenu {
            if entry.access == .write {
                Button("Treat as Read-Only") { model.moveTool(server: server, tool: entry.name, to: .read) }
            } else {
                Button("Treat as Able to Make Changes") { model.moveTool(server: server, tool: entry.name, to: .write) }
            }
            Button("Try…") { model.tryingTool = TryTarget(server: server, tool: entry) }
        }
        .accessibilityElement(children: .contain)
    }
}

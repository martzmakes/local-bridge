import LocalBridgeCore
import SwiftUI

struct AddServerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var name: String
    /// Once the name is typed by hand it stops following the title.
    @State private var nameEdited: Bool
    @State private var server: ServerConfig

    /// Starts on what other apps on this Mac already have, unless told to start with the form.
    @State private var showingFound: Bool
    /// Found servers the user unticked. Everything found starts ticked.
    @State private var unticked: Set<String> = []

    init(startManually: Bool = false, name: String? = nil, server: ServerConfig = ServerConfig()) {
        _showingFound = State(initialValue: !startManually)
        let title = server.title ?? ""
        _title = State(initialValue: title)
        _name = State(initialValue: name ?? ConfigValidator.proposedServerName(fromTitle: title))
        _nameEdited = State(initialValue: name != nil && name != ConfigValidator.proposedServerName(fromTitle: title))
        _server = State(initialValue: server)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    private var problem: String? {
        if trimmedName.isEmpty { return nil }
        if !ConfigValidator.isValidName(trimmedName) { return "The name \(ConfigValidator.nameRule)." }
        if model.draft.servers[trimmedName] != nil { return "There is already a server with that name." }
        if model.draft.servers.count >= BridgeConfig.maxServers { return "A Mac can have at most \(BridgeConfig.maxServers) servers." }
        return nil
    }

    private var configured: ServerConfig {
        var result = server
        result.title = title.trimmingCharacters(in: .whitespaces).isEmpty ? nil : title
        return result.normalized()
    }

    private var canAdd: Bool {
        guard !trimmedName.isEmpty, problem == nil else { return false }
        return ConfigValidator.validate(configured, path: "server").isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            Text(showingFound ? "Add Servers from This Mac" : "Add Server")
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 4)
            if showingFound {
                found
            } else {
                manual
            }
        }
        .frame(width: 580, height: 560)
        .onAppear {
            if showingFound, model.discovery == nil { model.loadDiscovery() }
        }
    }

    // MARK: - Found on this Mac

    private var chosen: [DiscoveredServer] {
        (model.discovery?.servers ?? []).filter { !unticked.contains($0.id) }
    }

    @ViewBuilder
    private var found: some View {
        let discovery = model.discovery
        Group {
            if discovery == nil {
                VStack(spacing: 10) {
                    ProgressView()
                    Text("Looking in Claude, Cursor and other apps…")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let discovery, discovery.servers.isEmpty, discovery.alreadyRemote.isEmpty {
                ContentUnavailableView {
                    Label("No Servers Found", systemImage: "magnifyingglass")
                } description: {
                    Text(discovery.alreadyAdded > 0
                         ? "Every server set up in Claude, Cursor and other apps on this Mac is already here."
                         : "No MCP servers are set up in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code or Codex on this Mac.")
                } actions: {
                    Button("Add Manually…") { showingFound = false }
                }
            } else if let discovery {
                Form {
                    if !discovery.servers.isEmpty {
                        Section {
                            ForEach(discovery.servers) { server in
                                HStack(spacing: 10) {
                                    Toggle(server.proposedTitle, isOn: Binding(
                                        get: { !unticked.contains(server.id) },
                                        set: { on in
                                            if on { unticked.remove(server.id) } else { unticked.insert(server.id) }
                                        }))
                                        .toggleStyle(.checkbox)
                                        .labelsHidden()
                                    ServerIcon(name: server.proposedName, server: server.config, size: 26)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(server.proposedTitle)
                                        Text("\(server.sourceList) · \(server.summary)")
                                            .font(.callout)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    Spacer(minLength: 0)
                                }
                            }
                        } header: {
                            Text("Found on This Mac")
                        } footer: {
                            Text("They are added the way those apps run them, including any keys they use. Tools that only read start switched on; tools that can make changes start off. Nothing is shared until you save.")
                                .formFooter()
                        }
                    }
                    if !discovery.alreadyRemote.isEmpty {
                        Section {
                            ForEach(discovery.alreadyRemote) { note in
                                LabeledContent {
                                    Text(note.host)
                                        .foregroundStyle(.secondary)
                                } label: {
                                    Label(note.title, systemImage: "globe")
                                }
                            }
                        } header: {
                            Text("Already Remote — Not Needed")
                        } footer: {
                            Text("These are on the internet already, so agents can reach them without the bridge.")
                                .formFooter()
                        }
                    }
                    if !discovery.unreadable.isEmpty {
                        Section {
                            EmptyView()
                        } footer: {
                            Text("Could not read the settings of \(discovery.unreadable.map(\.displayName).joined(separator: ", ")).")
                                .formFooter()
                        }
                    }
                }
                .formStyle(.grouped)
            }
        }
        Divider()
        HStack {
            Button("Add Manually…") { showingFound = false }
            Spacer()
            Button("Cancel", role: .cancel) { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button(chosen.count > 1 ? "Add \(chosen.count) Servers" : "Add Selected") {
                model.importServers(chosen)
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            .disabled(chosen.isEmpty)
        }
        .padding(16)
    }

    // MARK: - By hand

    @ViewBuilder
    private var manual: some View {
            Form {
                Section {
                    TextField("Title", text: $title, prompt: Text("Apple Notes"))
                        .onChange(of: title) { _, newTitle in
                            if !nameEdited { name = ConfigValidator.proposedServerName(fromTitle: newTitle) }
                        }
                    TextField("Name", text: Binding(
                        get: { name },
                        set: { newName in
                            if newName != name { nameEdited = !newName.isEmpty }
                            name = newName
                        }), prompt: Text("notes"))
                        .font(.body.monospaced())
                } footer: {
                    if let problem {
                        Text(problem)
                            .formFooter(.red)
                    } else {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("The name is the last part of the connector URL:")
                            Text(model.draft.endpointURL(forServer: trimmedName.isEmpty ? "name" : trimmedName))
                                .font(.footnote.monospaced())
                                .textSelection(.enabled)
                        }
                        .formFooter()
                    }
                }
                Section("Server") {
                    TransportFields(server: $server)
                    if server.transport == .stdio {
                        KeyValueEditor(title: "Environment", addLabel: "Add Variable", values: $server.env)
                    } else {
                        KeyValueEditor(title: "Headers", addLabel: "Add Header", values: $server.headers)
                    }
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                Button("Found on This Mac…") {
                    showingFound = true
                    if model.discovery == nil { model.loadDiscovery() }
                }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Add") {
                    model.addServer(name: trimmedName, config: configured)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canAdd)
            }
            .padding(16)
    }
}

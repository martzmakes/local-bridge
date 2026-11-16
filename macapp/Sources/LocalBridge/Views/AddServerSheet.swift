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

    init(name: String? = nil, server: ServerConfig = ServerConfig()) {
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
            Text("Add Server")
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 4)
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
                Text("Its tools are looked up next. Nothing is shared until you save.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
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
        .frame(width: 560, height: 540)
    }
}

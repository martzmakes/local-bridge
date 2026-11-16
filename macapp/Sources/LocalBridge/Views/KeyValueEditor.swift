import LocalBridgeCore
import SwiftUI

/// Rows of name and value for environment variables or headers.
///
/// A value that looks secret is shown in a secure field once it has been saved; a `keychain:`
/// value is a reference, not a secret, and is shown as one.
struct KeyValueEditor: View {
    struct Row: Identifiable, Equatable {
        let id = UUID()
        var key: String
        var value: String
        /// Typed in this editing session and not saved yet, so it is still shown as typed.
        var isNew: Bool
    }

    var title: String
    var addLabel: String
    @Binding var values: [String: String]?
    var disabled = false
    @State private var rows: [Row]

    init(title: String, addLabel: String, values: Binding<[String: String]?>, disabled: Bool = false) {
        self.title = title
        self.addLabel = addLabel
        self._values = values
        self.disabled = disabled
        let initial = (values.wrappedValue ?? [:]).sorted { $0.key < $1.key }
        self._rows = State(initialValue: initial.map { Row(key: $0.key, value: $0.value, isNew: false) })
    }

    var body: some View {
        if !rows.isEmpty {
            Text(title)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        ForEach($rows) { $row in
            HStack(spacing: 8) {
                TextField("Name", text: $row.key, prompt: Text("Name"))
                    .labelsHidden()
                    .frame(maxWidth: 200)
                valueField($row)
                Button {
                    rows.removeAll { $0.id == row.id }
                } label: {
                    Image(systemName: "minus.circle")
                }
                .buttonStyle(.borderless)
                .help("Remove")
            }
            .disabled(disabled)
        }
        LabeledContent(rows.isEmpty ? title : "") {
            Button(addLabel) { rows.append(Row(key: "", value: "", isNew: true)) }
                .controlSize(.small)
                .disabled(disabled)
        }
        .onChange(of: rows) { _, newRows in
            var result: [String: String] = [:]
            for row in newRows where !row.key.trimmingCharacters(in: .whitespaces).isEmpty {
                result[row.key.trimmingCharacters(in: .whitespaces)] = row.value
            }
            values = result.isEmpty ? nil : result
        }
    }

    @ViewBuilder
    private func valueField(_ row: Binding<Row>) -> some View {
        let value = row.wrappedValue
        if SecretHeuristics.isKeychainReference(value.value) {
            HStack(spacing: 6) {
                Image(systemName: "key.fill")
                    .foregroundStyle(.secondary)
                    .help("A reference to a Keychain item. The value itself is not in the config file.")
                TextField("Value", text: row.value, prompt: Text("Value"))
                    .labelsHidden()
            }
        } else if !value.isNew && SecretHeuristics.looksSecret(key: value.key, value: value.value) {
            SecureField("Value", text: row.value, prompt: Text("Value"))
                .labelsHidden()
        } else {
            TextField("Value", text: row.value, prompt: Text("Value"))
                .labelsHidden()
        }
    }
}

/// One argument per line.
struct ArgumentsEditor: View {
    @Binding var arguments: [String]
    @State private var text: String

    init(arguments: Binding<[String]>) {
        self._arguments = arguments
        self._text = State(initialValue: arguments.wrappedValue.joined(separator: "\n"))
    }

    var body: some View {
        TextEditor(text: $text)
            .font(.callout.monospaced())
            .multilineTextAlignment(.leading)
            .frame(minHeight: 40, maxHeight: 110)
            .scrollContentBackground(.hidden)
            .padding(6)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
            .onChange(of: text) { _, newText in
                arguments = newText.split(whereSeparator: \.isNewline).map(String.init).filter { !$0.isEmpty }
            }
    }
}

/// The fields that differ by how the server is reached, shared by the detail pane and the add sheet.
struct TransportFields: View {
    @Binding var server: ServerConfig
    var disabled = false

    private var isRemote: Binding<Bool> {
        Binding(
            get: { server.transport.isRemote },
            set: { server.transport = $0 ? .http : .stdio })
    }

    var body: some View {
        Picker("Type", selection: isRemote) {
            Text("Runs a command on this Mac").tag(false)
            Text("Connects to a URL").tag(true)
        }
        .disabled(disabled)
        if server.transport == .stdio {
            TextField("Command", text: $server.command, prompt: Text("/usr/local/bin/node"))
                .disabled(disabled)
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent("Arguments") {
                    Text("One per line")
                        .foregroundStyle(.secondary)
                }
                ArgumentsEditor(arguments: $server.args)
                    .disabled(disabled)
            }
        } else {
            TextField("URL", text: $server.url, prompt: Text("http://127.0.0.1:8123/mcp"))
                .disabled(disabled)
            Picker("Protocol", selection: $server.transport) {
                Text("Streamable HTTP").tag(Transport.http)
                Text("Server-sent events (SSE)").tag(Transport.sse)
            }
            .disabled(disabled)
        }
    }
}

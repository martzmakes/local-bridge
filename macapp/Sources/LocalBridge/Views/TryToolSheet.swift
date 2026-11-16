import LocalBridgeCore
import SwiftUI

/// Runs one tool once on this Mac and shows what it returns. Nothing shown here is kept:
/// not in Activity, not on disk.
struct TryToolSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var target: TryTarget
    private let fields: [ToolFormField]
    /// True when the tool's inputs are not described, so the arguments are typed as JSON.
    private let rawInput: Bool
    @State private var values: [String: String]
    @State private var rawText = ""
    @State private var outcome: ToolRunOutcome?
    @State private var problem: String?
    @State private var isRunning = false
    @State private var confirmingWrite = false

    init(target: TryTarget, values: [String: String]? = nil, outcome: ToolRunOutcome? = nil) {
        self.target = target
        let fields = ToolForm.fields(from: target.tool.inputSchema)
        self.fields = fields
        rawInput = fields.isEmpty && target.tool.inputSchema?.objectValue?["properties"] == nil
        var initial: [String: String] = [:]
        for field in fields { initial[field.name] = ToolForm.initialText(for: field) }
        _values = State(initialValue: values ?? initial)
        _outcome = State(initialValue: outcome)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Try \(target.tool.name)")
                    .font(.headline)
                if !target.tool.description.isEmpty {
                    Text(target.tool.description)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 4)

            Form {
                Section {
                    if rawInput {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Arguments (JSON)")
                            TextEditor(text: $rawText)
                                .font(.callout.monospaced())
                                .frame(minHeight: 60)
                                .scrollContentBackground(.hidden)
                                .padding(6)
                                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                        }
                    } else if fields.isEmpty {
                        Text("This tool takes no input.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(fields) { field in
                        control(for: field)
                    }
                } header: {
                    Text("Input")
                } footer: {
                    if let problem {
                        Text(problem)
                            .formFooter(.red)
                    } else if fields.contains(where: \.required) {
                        Text("Fields marked * are required.")
                            .formFooter()
                    }
                }

                if isRunning || outcome != nil {
                    Section("Result") {
                        result
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Text("Runs on this Mac only. The result is not saved or logged.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Run") { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isRunning)
            }
            .padding(16)
        }
        .frame(width: 580, height: 600)
        .alert("Run \(target.tool.name) for real?", isPresented: $confirmingWrite) {
            Button("Run") { run() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will run \(target.tool.name) on this Mac for real. It can make changes.")
        }
    }

    @ViewBuilder
    private func control(for field: ToolFormField) -> some View {
        let label = field.required ? "\(field.name) *" : field.name
        let text = Binding(get: { values[field.name] ?? "" }, set: { values[field.name] = $0 })
        Group {
            switch field.kind {
            case .boolean:
                Toggle(label, isOn: Binding(get: { values[field.name] == "true" }, set: { values[field.name] = $0 ? "true" : "false" }))
            case .choice(let options):
                Picker(label, selection: text) {
                    if !field.required { Text("Not set").tag("") }
                    ForEach(options, id: \.self) { Text($0).tag($0) }
                }
            case .string:
                TextField(label, text: text, prompt: Text(field.required ? "" : "Optional"))
            case .integer, .number:
                TextField(label, text: text, prompt: Text(field.kind == .integer ? "Whole number" : "Number"))
            case .json:
                TextField(label, text: text, prompt: Text("JSON"), axis: .vertical)
                    .font(.body.monospaced())
                    .lineLimit(1...4)
            }
        }
        .help(field.description)
    }

    @ViewBuilder
    private var result: some View {
        if isRunning {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Running…")
                    .foregroundStyle(.secondary)
            }
        } else if case .failed(let message)? = outcome {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .textSelection(.enabled)
        } else if case .finished(let result)? = outcome {
            LabeledContent {
                Text(Presentation.duration(milliseconds: result.milliseconds))
                    .foregroundStyle(.secondary)
            } label: {
                if result.isError {
                    Label("The tool reported an error", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                } else {
                    Label("Succeeded", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
            ScrollView {
                Text(result.displayText.isEmpty ? "The tool returned nothing." : result.displayText)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 120, maxHeight: 220)
        }
    }

    private func arguments() throws -> JSONValue {
        rawInput ? try ToolForm.rawArguments(rawText) : try ToolForm.arguments(fields: fields, values: values)
    }

    private func start() {
        do {
            _ = try arguments()
            problem = nil
        } catch {
            problem = (error as? ToolFormError)?.message ?? "The input could not be read."
            return
        }
        if target.tool.access == .write {
            confirmingWrite = true
        } else {
            run()
        }
    }

    private func run() {
        guard let arguments = try? arguments() else { return }
        isRunning = true
        outcome = nil
        Task {
            let finished = await model.runTool(server: target.server, tool: target.tool.name, arguments: arguments)
            outcome = finished
            isRunning = false
        }
    }
}

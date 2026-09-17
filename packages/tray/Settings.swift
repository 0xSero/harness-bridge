// The settings sheet: everything about a provider, and the two session preferences.
import AppKit
import SwiftUI

// MARK: - settings

struct SettingsView: View {
    @ObservedObject var store: Store
    let editing: Snapshot.Provider?
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var url = ""
    @State private var key = ""
    @State private var apis: Set<String> = ["chat"]
    @State private var reasoning = "auto"
    @State private var terminalID = "auto"
    @State private var dir = ""

    func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: dir.isEmpty ? (store.snap?.sessionDir ?? NSHomeDirectory()) : dir)
        if panel.runModal() == .OK, let url = panel.url { dir = url.path }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(editing == nil ? "Add provider" : "Provider \(editing!.id)")
                .font(.system(size: 13, weight: .semibold))
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 8) {
                GridRow { Text("name").foregroundStyle(.secondary); TextField("HomeLab", text: $name).frame(width: 260) }
                GridRow {
                    Text("base url").foregroundStyle(.secondary)
                    TextField("http://host:8080/v1", text: $url).frame(width: 260)
                }
                GridRow {
                    Text("api key").foregroundStyle(.secondary)
                    SecureField(editing == nil ? "" : "unchanged — retype to replace", text: $key).frame(width: 260)
                }
                GridRow {
                    Text("dialects").foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        ForEach(DIALECTS, id: \.self) { d in
                            Toggle(d, isOn: Binding(
                                get: { apis.contains(d) },
                                set: { on in if on { apis.insert(d) } else { apis.remove(d) } }))
                                .toggleStyle(.checkbox)
                        }
                    }
                }
                GridRow {
                    Text("reasoning").foregroundStyle(.secondary)
                    Picker("", selection: $reasoning) { ForEach(LEVELS, id: \.self) { Text($0) } }
                        .labelsHidden().frame(width: 160)
                }
            }
            Divider().padding(.vertical, 2)
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 8) {
                GridRow {
                    Text("session dir").foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        TextField(store.snap?.defaultDir ?? "~", text: $dir).frame(width: 200)
                        Button("Choose…") { chooseDirectory() }
                        if !dir.isEmpty { Button("Clear") { dir = "" } }
                    }
                }
                GridRow {
                    Text("terminal").foregroundStyle(.secondary)
                    Picker("", selection: $terminalID) {
                        Text("auto (detect)").tag("auto")
                        ForEach(store.snap?.terminal.options ?? []) { o in
                            Text(o.installed ? o.label : "\(o.label) — not installed").tag(o.id)
                        }
                        Text("custom").tag("custom")
                    }
                    .labelsHidden().frame(width: 220)
                }
            }
            Text("The key is stored 0600 in ~/.config/harness-bridge/config.json.")
                .font(.system(size: 10)).foregroundStyle(.secondary)
            HStack {
                if let p = editing {
                    Button("Remove", role: .destructive) { store.remove(p.id); dismiss() }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    if editing == nil || !name.isEmpty {
                        store.saveProvider(name: name, url: url, key: key,
                                           apis: DIALECTS.filter { apis.contains($0) }, reasoning: reasoning)
                    }
                    store.setTerminal(terminalID)
                    if dir != (store.snap?.sessionDir ?? "") { store.setDir(dir) }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.isEmpty || url.isEmpty || (editing == nil && key.isEmpty))
            }
        }
        .padding(18)
        .frame(width: 470)
        .onAppear {
            terminalID = store.snap?.terminal.configured ?? "auto"
            dir = store.snap?.sessionDir ?? ""
        }
    }
}

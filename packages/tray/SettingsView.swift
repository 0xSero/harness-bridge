// Settings: every provider (editable), and the whole model catalogue.
import AppKit
import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: Store
    /// Closes the window this view is hosted in.
    var close: () -> Void

    enum Tab: String, CaseIterable { case providers = "Providers", models = "Models" }

    @State private var tab: Tab = .providers
    @State private var editing: String?          // provider id, or nil for a new one
    @State private var name = ""
    @State private var url = ""
    @State private var key = ""
    @State private var apis: Set<String> = ["chat"]
    @State private var reasoning = "auto"
    @State private var filter = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(14)

            Divider()

            switch tab {
            case .providers: providersTab
            case .models: modelsTab
            }

            Divider()
            HStack {
                Text("Keys are stored 0600 in ~/.config/harness-bridge/config.json.")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Button("Done") { close() }.keyboardShortcut(.defaultAction)
            }
            .padding(14)
        }
        .frame(width: 520, height: 520)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { load(store.snap?.providers.first(where: \.selected)) }
    }

    // MARK: providers

    private var providersTab: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(text: "configured", count: store.snap?.providers.count)
            ForEach(store.snap?.providers ?? []) { p in
                Row(symbol: p.selected ? "checkmark.circle.fill" : "circle",
                    title: p.name, detail: "\(p.apiUrl) · \(p.apis.joined(separator: ", ")) · \(p.reasoning)",
                    selected: p.id == editing) { load(p) } trailing: {
                    IconButton(symbol: "delete", help: "Remove \(p.name)", tint: .red) {
                        store.removeProvider(p.id)
                    }
                    .padding(.trailing, 6)
                }
            }
            Button {
                load(nil)
            } label: {
                Label("Add provider", systemImage: "plus")
                    .font(.system(size: 11))
            }
            .buttonStyle(.link)
            .padding(.horizontal, 14).padding(.vertical, 6)

            Divider().padding(.vertical, 4)

            ScrollView {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 8) {
                    GridRow {
                        Text("name").foregroundStyle(.secondary)
                        TextField("HomeLab", text: $name).frame(width: 300)
                    }
                    GridRow {
                        Text("base url").foregroundStyle(.secondary)
                        TextField("http://host:8080/v1", text: $url).frame(width: 300)
                    }
                    GridRow {
                        Text("api key").foregroundStyle(.secondary)
                        SecureField(editing == nil ? "" : "unchanged unless you type a new one", text: $key)
                            .frame(width: 300)
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
                        Picker("", selection: $reasoning) {
                            ForEach(LEVELS, id: \.self) { Text($0) }
                        }
                        .labelsHidden().frame(width: 160)
                    }
                }
                .padding(.horizontal, 14)
            }
            .frame(maxHeight: 190)

            HStack {
                Spacer()
                Button(editing == nil ? "Add" : "Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(name.isEmpty || url.isEmpty || (editing == nil && key.isEmpty))
            }
            .padding(.horizontal, 14).padding(.top, 8)
        }
    }

    /// Fill the form from a provider, or clear it for a new one.
    private func load(_ p: Snapshot.Provider?) {
        editing = p?.id
        name = p?.name ?? ""
        url = p?.apiUrl ?? ""
        key = ""
        apis = Set(p?.apis ?? ["chat"])
        reasoning = p?.reasoning ?? "auto"
    }

    private func save() {
        store.saveProvider(id: editing, name: name, url: url, key: key,
                           apis: DIALECTS.filter { apis.contains($0) }, reasoning: reasoning)
        load(nil)
    }

    // MARK: models

    private var modelsTab: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(.secondary)
                TextField("filter", text: $filter).textFieldStyle(.plain).font(.system(size: 12))
            }
            .padding(.horizontal, 14).padding(.vertical, 8)

            let shown = (store.snap?.catalog ?? []).filter { filter.isEmpty || $0.id.localizedCaseInsensitiveContains(filter) }
            SectionHeader(text: "models", count: shown.count)
            ScrollView {
                ForEach(shown) { m in
                    Row(symbol: m.id == store.snap?.selected.model ? "checkmark.circle.fill" : "circle",
                        title: m.id, detail: m.detail,
                        selected: m.id == store.snap?.selected.model) {
                        store.selectModel(m.id)
                    } trailing: {
                        IconButton(symbol: isPinned(m.id) ? "pin.fill" : "pin",
                                   help: isPinned(m.id) ? "Unpin" : "Pin to the panel") {
                            store.setPinned(m.id, !isPinned(m.id))
                        }
                        .padding(.trailing, 6)
                    }
                }
            }
        }
    }

    private func isPinned(_ id: String) -> Bool {
        (store.snap?.pinned ?? []).contains { $0.id == id }
    }
}
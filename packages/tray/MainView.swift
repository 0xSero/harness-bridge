// The panel: the model in use and anything pinned beside it, where a session opens, and what
// can be launched.
import AppKit
import SwiftUI

enum Style {
    static let pad: CGFloat = 16
    static let rowInset: CGFloat = 10
    static let radius: CGFloat = 7
}

/// A section heading with a hairline rule, so sections read as blocks rather than a run-on list.
struct SectionHeader: View {
    let text: String
    var count: Int? = nil
    var body: some View {
        HStack(spacing: 6) {
            Text(text.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .kerning(0.7)
                .foregroundStyle(.secondary)
            if let count {
                Text("\(count)").font(.system(size: 10, weight: .medium)).foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(.horizontal, Style.pad)
        .padding(.top, 18)
        .padding(.bottom, 7)
    }
}

/// A clickable line: leading symbol, title, optional detail, optional trailing control.
struct Row<Trailing: View>: View {
    var symbol: String? = nil
    var tint: Color = .secondary
    var title: String
    var detail: String = ""
    var selected = false
    var enabled = true
    var action: () -> Void
    @ViewBuilder var trailing: Trailing
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 12))
                        .foregroundStyle(selected ? Color.accentColor : tint)
                        .frame(width: 16)
                }
                VStack(alignment: .leading, spacing: 1.5) {
                    Text(title).font(.system(size: 13)).lineLimit(1)
                    if !detail.isEmpty {
                        Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                trailing
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: Style.radius)
                    .fill(selected ? Color.accentColor.opacity(0.15)
                          : (hover && enabled ? Color.primary.opacity(0.05) : .clear)),
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.42)
        .onHover { hover = $0 }
        .padding(.horizontal, Style.pad - 9)
    }
}

extension Row where Trailing == EmptyView {
    init(symbol: String? = nil, tint: Color = .secondary, title: String, detail: String = "",
         selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) {
        self.init(symbol: symbol, tint: tint, title: title, detail: detail,
                  selected: selected, enabled: enabled, action: action) { EmptyView() }
    }
}

/// A small icon button for per-row actions.
struct IconButton: View {
    let symbol: String
    var help: String
    var tint: Color = .secondary
    var action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11))
                .foregroundStyle(hover ? tint : Color.secondary.opacity(0.75))
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hover = $0 }
    }
}

/// The Local AI mark from the bundle. A build without the asset still renders something.
struct Mark: View {
    var size: CGFloat = 28
    var body: some View {
        if let logo = NSImage(named: "LocalAIMark") {
            Image(nsImage: logo).resizable().interpolation(.high)
                .frame(width: size, height: size)
        } else {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(Color.accentColor)
                .frame(width: size, height: size)
                .overlay(Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(.white))
        }
    }
}

struct PopoverView: View {
    @ObservedObject var store: Store
    /// Settings opens in its own window (see AppDelegate.showSettings).
    var openSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView { content }
            Divider()
            if !store.status.isEmpty { statusLine; Divider() }
            footer
        }
        // a definite height: without one the ScrollView collapses and the popover sizes to nothing
        .frame(width: 420, height: 620)
        .background(Color(nsColor: .windowBackgroundColor))
        .task { store.refresh() }
    }

    /// Always in view, whether or not a snapshot ever arrived: an error the user cannot see is
    /// a panel that looks dead.
    private var statusLine: some View {
        Text(store.status)
            .font(.system(size: 10.5))
            .foregroundStyle(store.status.contains("…") ? Color.secondary : Color.red)
            .lineLimit(3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Style.pad).padding(.vertical, 8)
    }

    private var activeProvider: Snapshot.Provider? {
        store.snap?.providers.first(where: \.selected)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 11) {
            Mark()
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text("Local AI").font(.system(size: 14, weight: .semibold))
                    if store.busy { ProgressView().controlSize(.mini).scaleEffect(0.7) }
                }
                Picker("", selection: Binding(
                    get: { activeProvider?.id ?? "" },
                    set: { store.useProvider($0) },
                )) {
                    ForEach(store.snap?.providers ?? []) { p in
                        Text(p.name).tag(p.id)
                    }
                    if store.snap?.providers.isEmpty ?? true { Text("no provider").tag("") }
                }
                .labelsHidden().pickerStyle(.menu).controlSize(.small)
                .fixedSize()
            }
            Spacer(minLength: 0)
            Button("Web UI") { store.openWeb() }
                .buttonStyle(.link).font(.system(size: 11.5))
        }
        .padding(.horizontal, Style.pad)
        .padding(.vertical, 14)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let snap = store.snap {
                models(snap)
                session(snap)
                harnesses(snap)
            } else if store.busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("reading state…").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, Style.pad).padding(.vertical, 20)
            } else {
                Row(symbol: "arrow.clockwise", title: "nothing loaded", detail: "click to try again") {
                    store.refresh()
                }
                .padding(.top, 14)
            }
        }
        .padding(.bottom, 14)
    }

    /// One list: the model in use comes first, then whatever else was pinned. Never duplicated.
    @ViewBuilder private func models(_ snap: Snapshot) -> some View {
        SectionHeader(text: "models", count: snap.pinned.count)
        if snap.pinned.isEmpty {
            Row(symbol: "circle.dashed", title: "nothing selected",
                detail: "choose one in Settings") { openSettings() }
        }
        ForEach(snap.pinned) { m in
            let live = m.id == snap.live?.id
            Row(symbol: live ? "record.circle.fill" : "circle",
                tint: live ? Color.accentColor : .secondary,
                title: m.id,
                detail: live ? [m.detail, "in use"].filter { !$0.isEmpty }.joined(separator: " · ") : m.detail,
                selected: live) {
                store.selectModel(m.id)
            } trailing: {
                if !live {
                    IconButton(symbol: "pin.slash", help: "Unpin") { store.setPinned(m.id, false) }
                }
            }
        }
        Button("All \(snap.catalog.count) models…") { openSettings() }
            .buttonStyle(.link).font(.system(size: 11))
            .padding(.horizontal, Style.pad).padding(.top, 6)
    }

    @ViewBuilder private func session(_ snap: Snapshot) -> some View {
        SectionHeader(text: "session opens in")
        Row(symbol: "folder", title: fold(snap.sessionDir), detail: "") { store.chooseDirectory() }
            .contextMenu { Button("Choose folder…") { store.chooseDirectory() } }
        HStack(spacing: 11) {
            Image(systemName: "terminal").font(.system(size: 12)).foregroundStyle(.secondary).frame(width: 16)
            Picker("", selection: Binding(get: { snap.terminal.configured },
                                          set: { store.setTerminal($0) })) {
                Text("Automatic (\(snap.terminal.active))").tag("auto")
                ForEach(snap.terminal.options) { o in
                    Text(o.installed ? o.label : "\(o.label) — not installed").tag(o.id)
                }
            }
            .labelsHidden().pickerStyle(.menu).controlSize(.regular)
            Spacer()
        }
        .padding(.horizontal, Style.pad).padding(.vertical, 3)
    }

    @ViewBuilder private func harnesses(_ snap: Snapshot) -> some View {
        SectionHeader(text: "harnesses")
        ForEach(snap.harnesses) { h in
            Row(symbol: h.installed ? "terminal.fill" : "arrow.down.circle",
                tint: Color.secondary.opacity(h.installed ? 1 : 0.55),
                title: h.label, detail: harnessDetail(h), enabled: h.compatible) {
                store.launch(h.id)
            } trailing: {
                Text(h.dialect)
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
            }
        }
    }

    private func harnessDetail(_ h: Snapshot.Harness) -> String {
        if !h.compatible { return "\(h.dialect) · not served by this endpoint" }
        if !h.installed { return h.installable ? "will install, then launch" : h.hint }
        return h.reasons ? "\(h.dialect) · reasoning configurable" : h.dialect
    }

    private func fold(_ path: String) -> String {
        let home = NSHomeDirectory()
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text("0.1.0").font(.system(size: 10.5)).foregroundStyle(.tertiary)
            Spacer()
            Button("Settings") { openSettings() }.font(.system(size: 11.5))
            Button("Quit") { NSApplication.shared.terminate(nil) }.font(.system(size: 11.5))
        }
        .padding(.horizontal, Style.pad).padding(.vertical, 11)
    }
}
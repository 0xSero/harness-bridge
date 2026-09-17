// harness-bridge tray — a macOS menu bar front end over the `hb` CLI.
// Every action shells out to the same core the CLI and web UI use; no state of its own.
import AppKit
import Foundation

let HB = ProcessInfo.processInfo.environment["HB_BIN"] ?? "hb"

func hb(_ args: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = [HB] + args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    do { try p.run() } catch { return (127, "cannot run \(HB): \(error.localizedDescription)") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

/// ANSI-free view of a CLI listing: `hb models` prints "→ id   meta"
func rows(_ output: String) -> [(String, Bool)] {
    output.split(separator: "\n").compactMap { line in
        let s = String(line)
        guard !s.isEmpty, !s.hasPrefix(" ") || s.hasPrefix("→") || s.hasPrefix("*") else { return nil }
        if s.contains("models from") { return nil }
        let selected = s.hasPrefix("→") || s.hasPrefix("*")
        var body = s.drop { $0 == "→" || $0 == "*" || $0 == " " }
        if let cut = body.range(of: "  ") { body = body[..<cut.lowerBound] }
        let id = body.trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? nil : (id, selected)
    }
}

final class Tray: NSObject, NSApplicationDelegate {
    var status: NSStatusItem!
    let menu = NSMenu()

    func applicationDidFinishLaunching(_ n: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "⇄"
        rebuild()
    }

    @objc func rebuild() {
        menu.removeAllItems()
        let (_, state) = hb(["status"])
        let header = state.split(separator: "\n").last.map(String.init) ?? "harness-bridge"
        let title = NSMenuItem(title: header, action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        let (_, pout) = hb(["providers"])
        let provs = rows(pout)
        menu.addItem(submenu("Providers", provs.map { ($0.0, #selector(selectProvider(_:))) }))
        menu.addItem(submenu("Models", rows(hb(["models"]).1).map { ($0.0, #selector(selectModel(_:))) }))
        menu.addItem(submenu("Harnesses", rows(hb(["harnesses"]).1).map { ($0.0, #selector(launchHarness(_:))) }))

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Add provider…", action: #selector(addProvider), keyEquivalent: "a"))
        menu.addItem(NSMenuItem(title: "Open web UI", action: #selector(openWeb), keyEquivalent: "w"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        status.menu = menu
    }

    func submenu(_ label: String, _ items: [(String, Selector)]) -> NSMenuItem {
        let parent = NSMenuItem(title: label, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        if items.isEmpty {
            let none = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
            none.isEnabled = false
            sub.addItem(none)
        }
        for (name, sel) in items {
            let item = NSMenuItem(title: name, action: sel, keyEquivalent: "")
            item.target = self
            item.representedObject = name
            sub.addItem(item)
        }
        parent.submenu = sub
        return parent
    }

    @objc func selectProvider(_ sender: NSMenuItem) {
        _ = hb(["providers", "add"])
        _ = hb(["--provider", sender.representedObject as? String ?? ""])
        rebuild()
    }
    @objc func selectModel(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        _ = hb(["use", id])
        rebuild()
    }
    @objc func launchHarness(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, !id.isEmpty else { return }
        let (code, out) = hb(["run", "--harness", id])
        if code != 0 { alert("Launch failed", out) }
        rebuild()
    }

    @objc func addProvider() {
        let name = NSAlert.prompt("Provider name", "") ?? ""
        guard !name.isEmpty else { return }
        let url = NSAlert.prompt("Base URL (…/v1)", "https://") ?? ""
        guard !url.isEmpty else { return }
        let key = NSAlert.prompt("API key", "") ?? ""
        let api = NSAlert.pick("API dialect", ["chat", "messages", "responses"])
        let (code, out) = hb(["providers", "add", "--name", name, "--url", url, "--key", key, "--api", api])
        if code != 0 { alert("Could not add provider", out) }
        rebuild()
    }

    @objc func openWeb() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [HB, "serve"]
        try? p.run()
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:4141")!)
    }

    func alert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.runModal()
    }
}

extension NSAlert {
    static func prompt(_ title: String, _ placeholder: String) -> String? {
        let a = NSAlert()
        a.messageText = title
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.placeholderString = placeholder
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        return a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }
    static func pick(_ title: String, _ options: [String]) -> String {
        let a = NSAlert()
        a.messageText = title
        let pop = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
        pop.addItems(withTitles: options)
        a.accessoryView = pop
        a.addButton(withTitle: "OK")
        _ = a.runModal()
        return pop.titleOfSelectedItem ?? options[0]
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let tray = Tray()
app.delegate = tray
app.run()
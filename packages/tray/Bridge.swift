// harness-bridge tray — a menu bar panel over the `harness-bridge` CLI.
// The CLI does the work; this only presents it. All state comes from `snapshot --json`.
import AppKit
import SwiftUI

// MARK: - talking to the CLI

/// A bundle opened from Finder or `open` inherits a minimal PATH, and the installed CLI is a
/// `#!/usr/bin/env bun` shim — so both the CLI and `bun` are resolved by absolute path.
let HB: String = {
    if let explicit = ProcessInfo.processInfo.environment["HB_BIN"], !explicit.isEmpty { return explicit }
    let home = NSHomeDirectory()
    for path in ["\(home)/.bun/bin/harness-bridge", "\(home)/.local/bin/harness-bridge",
                 "/opt/homebrew/bin/harness-bridge", "/usr/local/bin/harness-bridge"]
    where FileManager.default.isExecutableFile(atPath: path) { return path }
    return "harness-bridge"
}()

let HB_ENV: [String: String] = {
    var env = ProcessInfo.processInfo.environment
    let home = NSHomeDirectory()
    let dirs = [(HB as NSString).deletingLastPathComponent, "\(home)/.bun/bin", "\(home)/.local/bin",
                "/opt/homebrew/bin", "/usr/local/bin"].filter { FileManager.default.fileExists(atPath: $0) }
    env["PATH"] = (dirs + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
    return env
}()

func hbProcess(_ args: [String]) -> Process {
    let p = Process()
    if HB.contains("/") {
        p.executableURL = URL(fileURLWithPath: HB); p.arguments = args
    } else {
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = [HB] + args
    }
    p.environment = HB_ENV
    return p
}

/// Run the CLI and hand back its output. Synchronous: every call is short, and the panel is
/// rebuilt around the result anyway.
@discardableResult
func hb(_ args: [String]) -> (Int32, String) {
    let p = hbProcess(args)
    let out = Pipe()
    p.standardOutput = out; p.standardError = out
    do { try p.run() } catch { return (127, "cannot run \(HB): \(error.localizedDescription)") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

func portOpen(_ port: UInt16) -> Bool {
    let s = socket(AF_INET, SOCK_STREAM, 0)
    guard s >= 0 else { return false }
    defer { close(s) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    return r == 0
}

// MARK: - what the CLI reports

struct Snapshot: Decodable {
    struct Provider: Decodable, Identifiable {
        let id, name, apiUrl: String
        let apis: [String]
        let reasoning: String
        let selected: Bool
    }
    struct Selected: Decodable { let provider: String?; let model: String? }
    struct Model: Decodable, Identifiable {
        let id: String; let name: String?; let contextWindow: Int?; let vision: Bool?
    }
    struct Harness: Decodable, Identifiable {
        let id, label, dialect, hint: String
        let reasons, installed, installable, compatible: Bool
    }
    struct TerminalView: Decodable {
        struct Option: Decodable, Identifiable { let id: String; let label: String; let installed: Bool }
        let active: String
        let configured: String
        let options: [Option]
    }
    let providers: [Provider]
    let selected: Selected
    let models: [Model]
    let harnesses: [Harness]
    let terminal: TerminalView
    let sessionDir: String
    let defaultDir: String
    let error: String
}

let LEVELS = ["auto", "off", "low", "medium", "high"]
let DIALECTS = ["chat", "messages", "responses"]

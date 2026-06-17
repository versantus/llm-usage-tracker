import Foundation

/// Wires Claude Code to report usage, driven entirely from the app — the
/// "Connect Claude Code" button. It installs the bundled `lut` binary to
/// ~/.local/bin and then runs it, so the hook-wiring logic stays in one place
/// (the binary), identical to the curl installer.
@MainActor
final class ClaudeConnector: ObservableObject {
    @Published var connected: Bool = false
    @Published var busy: Bool = false
    @Published var lastMessage: String?

    /// Watcher surfaces (no Stop-style hook), with live presence + enabled state.
    @Published var surfaces: [SurfaceState] = []

    struct SurfaceState: Identifiable {
        let id: String        // the `lut` surface name
        let label: String
        var available: Bool
        var enabled: Bool
    }

    /// id, label, and the path whose existence means "this tool is present".
    private let surfaceDefs: [(id: String, label: String, probe: String)] = [
        ("codex", "Codex CLI", ".codex/sessions"),
        ("cowork", "Cowork", "Library/Application Support/Claude/local-agent-mode-sessions"),
        ("copilot", "GitHub Copilot", ".copilot"),
        ("gemini", "Gemini CLI", ".gemini"),
        ("ollama", "Ollama (desktop)", "Library/Application Support/Ollama/db.sqlite")
    ]

    private let home = FileManager.default.homeDirectoryForCurrentUser

    private var installedBinary: URL {
        home.appendingPathComponent(".local/bin/lut")
    }
    private var bundledBinary: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("lut")
    }
    private var settingsFile: URL {
        home.appendingPathComponent(".claude/settings.json")
    }
    private func sessionsDir(_ rel: String) -> URL { home.appendingPathComponent(rel) }
    private func agentPlist(_ suffix: String) -> URL {
        home.appendingPathComponent("Library/LaunchAgents/uk.co.versantus.usage-tracker.\(suffix).plist")
    }

    init() {
        refreshState()
    }

    /// Detect hook + watcher state from disk.
    func refreshState() {
        let fm = FileManager.default
        connected = hookIsWired()
        surfaces = surfaceDefs.map { def in
            var available = fm.fileExists(atPath: sessionsDir(def.probe).path)
            if def.id == "copilot" && !available {
                // Copilot also lives in VS Code workspaceStorage.
                available = fm.fileExists(
                    atPath: sessionsDir("Library/Application Support/Code/User/workspaceStorage").path)
            }
            return SurfaceState(
                id: def.id,
                label: def.label,
                available: available,
                enabled: fm.fileExists(atPath: agentPlist(def.id).path)
            )
        }
    }

    /// Toggle a background watcher via the installed binary.
    func setWatcher(_ surface: String, _ on: Bool) {
        busy = true
        lastMessage = nil
        Task {
            do {
                try installBinary() // ensure the latest binary (has the subcommands)
                let out = try run(installedBinary.path, [surface, on ? "enable" : "disable"])
                refreshState()
                lastMessage = out.trimmingCharacters(in: .whitespacesAndNewlines)
            } catch {
                lastMessage = "Failed: \((error as? ConnectError)?.message ?? error.localizedDescription)"
            }
            busy = false
        }
    }

    private func hookIsWired() -> Bool {
        guard let data = try? Data(contentsOf: settingsFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hooks = json["hooks"] as? [String: Any],
              let stop = hooks["Stop"] as? [[String: Any]] else { return false }
        for entry in stop {
            guard let inner = entry["hooks"] as? [[String: Any]] else { continue }
            for h in inner {
                if let cmd = h["command"] as? String,
                   cmd.contains("lut") && cmd.contains("hook") {
                    return true
                }
            }
        }
        return false
    }

    /// Copy the bundled binary into ~/.local/bin/lut (executable).
    private func installBinary() throws {
        guard let src = bundledBinary, FileManager.default.fileExists(atPath: src.path) else {
            throw ConnectError.noBundledBinary
        }
        let fm = FileManager.default
        try fm.createDirectory(at: installedBinary.deletingLastPathComponent(),
                               withIntermediateDirectories: true)
        if fm.fileExists(atPath: installedBinary.path) {
            try? fm.removeItem(at: installedBinary)
        }
        try fm.copyItem(at: src, to: installedBinary)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installedBinary.path)
        // Clear quarantine so the copied binary runs without a Gatekeeper prompt.
        _ = try? run("/usr/bin/xattr", ["-d", "com.apple.quarantine", installedBinary.path])
        // Ad-hoc re-sign the copied binary so AMFI doesn't kill it.
        _ = try? run("/usr/bin/codesign", ["--force", "--sign", "-", installedBinary.path])
    }

    /// Install the binary, then `lut connect` with the given identity/server.
    func connect(name: String, email: String, serverURL: String, ingestToken: String) {
        busy = true
        lastMessage = nil
        Task {
            do {
                try installBinary()
                var args = ["connect", "--name", name, "--email", email, "--server-url", serverURL]
                if !ingestToken.isEmpty { args += ["--ingest-token", ingestToken] }
                let out = try run(installedBinary.path, args)
                refreshState()
                lastMessage = connected
                    ? "Connected. New Claude Code sessions will report on each Stop."
                    : "Ran, but the hook isn't showing as wired:\n\(out)"
            } catch {
                lastMessage = "Failed: \((error as? ConnectError)?.message ?? error.localizedDescription)"
            }
            busy = false
        }
    }

    /// Remove the Stop hook (leaves config + binary in place).
    func disconnect() {
        busy = true
        lastMessage = nil
        Task {
            do {
                let bin = FileManager.default.isExecutableFile(atPath: installedBinary.path)
                    ? installedBinary.path : (bundledBinary?.path ?? installedBinary.path)
                _ = try run(bin, ["unwire"])
                refreshState()
                lastMessage = "Disconnected — Stop hook removed."
            } catch {
                lastMessage = "Failed: \(error.localizedDescription)"
            }
            busy = false
        }
    }

    /// Run a process, returning combined stdout+stderr; throws on non-zero exit.
    @discardableResult
    private func run(_ launchPath: String, _ args: [String]) throws -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: launchPath)
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        try proc.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        let out = String(data: data, encoding: .utf8) ?? ""
        if proc.terminationStatus != 0 {
            throw ConnectError.process(out.isEmpty ? "exit \(proc.terminationStatus)" : out)
        }
        return out
    }

    enum ConnectError: Error {
        case noBundledBinary
        case process(String)

        var message: String {
            switch self {
            case .noBundledBinary:
                return "The lut binary isn't bundled in this app build. Rebuild with ./build.sh."
            case .process(let m): return m
            }
        }
    }
}

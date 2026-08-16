import AppKit
import Foundation

/// Update checking for both halves of the tracker: this app, and the `lut`
/// helper it installs to ~/.local/bin. They ship from one GitHub release and
/// share a version number, so a single lookup answers for both — but they
/// update by different routes (the app replaces its own bundle; `lut` knows how
/// to replace itself, so we just call `lut update`).
///
/// POLICY: the check runs automatically once a day; installing never does. An
/// update re-signs the helper and rewrites LaunchAgents, which can make macOS
/// re-prompt for permissions — that belongs behind a deliberate click.
@MainActor
final class Updater: ObservableObject {
    /// Version of this app bundle (stamped from shared/version.ts at build time).
    let appVersion: String =
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"

    @Published var helperVersion: String?
    @Published var latestVersion: String?
    @Published var checking = false
    @Published var applying = false
    @Published var lastChecked: Date?
    @Published var message: String?
    /// Set when the app has been replaced and only a relaunch is outstanding.
    @Published var needsRelaunch = false

    private let repo = "versantus/llm-usage-tracker"
    private var releasesAPI: URL { URL(string: "https://api.github.com/repos/\(repo)/releases/latest")! }
    var releasesPage: URL { URL(string: "https://github.com/\(repo)/releases")! }

    private var assets: [String: URL] = [:]
    private var checkTimer: Timer?

    private var installedHelper: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/lut")
    }

    /// Release asset holding this machine's app build.
    private var appAssetName: String {
        #if arch(arm64)
        return "UsageTracker-macos-arm64.zip"
        #else
        return "UsageTracker-macos-x64.zip"
        #endif
    }

    var appUpdateAvailable: Bool {
        guard let latest = latestVersion else { return false }
        return Self.compareVersions(latest, appVersion) > 0
    }

    var helperUpdateAvailable: Bool {
        guard let latest = latestVersion, let helper = helperVersion else { return false }
        return Self.compareVersions(latest, helper) > 0
    }

    var updateAvailable: Bool { appUpdateAvailable || helperUpdateAvailable }

    /// Whether an app asset for this architecture exists in the release.
    var appAssetPublished: Bool { assets[appAssetName] != nil }

    // MARK: - Version comparison

    /// Numeric-component comparison; mirrors compareVersions() in shared/version.ts.
    /// A plain string compare would rank "1.10.0" below "1.9.0".
    nonisolated static func compareVersions(_ a: String, _ b: String) -> Int {
        func parts(_ v: String) -> [Int] {
            var s = v.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
            s = s.components(separatedBy: CharacterSet(charactersIn: "-+")).first ?? s
            return s.split(separator: ".").map { Int($0) ?? 0 }
        }
        let l = parts(a), r = parts(b)
        for i in 0..<max(l.count, r.count) {
            let lv = i < l.count ? l[i] : 0
            let rv = i < r.count ? r[i] : 0
            if lv != rv { return lv < rv ? -1 : 1 }
        }
        return 0
    }

    // MARK: - Lifecycle

    /// Read local versions, check once, then once a day. Notify-only.
    func start() {
        refreshHelperVersion()
        Task { await check() }
        checkTimer = Timer.scheduledTimer(withTimeInterval: 24 * 60 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check() }
        }
    }

    func refreshHelperVersion() {
        helperVersion = (try? run(installedHelper.path, ["version"]))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Check

    func check() async {
        guard !checking else { return }
        checking = true
        message = nil
        defer { checking = false }

        var req = URLRequest(url: releasesAPI)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        // GitHub rejects unidentified clients.
        req.setValue("UsageTracker/\(appVersion)", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 15

        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                message = "Update check failed (\((response as? HTTPURLResponse)?.statusCode ?? 0))."
                return
            }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  var tag = json["tag_name"] as? String else {
                message = "Update check failed: unexpected response."
                return
            }
            if tag.hasPrefix("v") { tag.removeFirst() }

            var found: [String: URL] = [:]
            for a in (json["assets"] as? [[String: Any]]) ?? [] {
                if let name = a["name"] as? String,
                   let urlString = a["browser_download_url"] as? String,
                   let url = URL(string: urlString) {
                    found[name] = url
                }
            }
            assets = found
            latestVersion = tag
            lastChecked = Date()
            refreshHelperVersion()
        } catch {
            message = "Update check failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Apply

    /// Update whichever halves are behind. The helper first: it's the piece that
    /// does the tracking, and it succeeds or fails without disturbing the app.
    func applyAll() async {
        guard !applying else { return }
        applying = true
        message = nil
        defer { applying = false }

        var done: [String] = []

        if helperUpdateAvailable {
            switch updateHelper() {
            case .success(let v): done.append("helper → \(v)")
            case .failure(let m):
                message = "Helper update failed: \(m)"
                return
            }
        }

        if appUpdateAvailable {
            guard let url = assets[appAssetName] else {
                message = done.isEmpty
                    ? "Release \(latestVersion ?? "?") has no \(appAssetName)."
                    : "\(done.joined(separator: ", ")). No \(appAssetName) in this release, so the app is unchanged."
                return
            }
            do {
                try await updateApp(from: url)
                done.append("app → \(latestVersion ?? "?")")
                needsRelaunch = true
            } catch {
                message = "App update failed: \(error.localizedDescription)"
                return
            }
        }

        refreshHelperVersion()
        message = done.isEmpty
            ? "Already up to date."
            : done.joined(separator: ", ") + (needsRelaunch ? ". Relaunch to finish." : ".")
    }

    /// Delegate to `lut update` — the binary owns its own replace logic, so the
    /// download, ad-hoc re-signing and watcher restart all stay in one place.
    private func updateHelper() -> Result<String, UpdateError> {
        guard FileManager.default.isExecutableFile(atPath: installedHelper.path) else {
            return .failure(.message("no helper installed — press Connect Claude Code first"))
        }
        do {
            let out = try run(installedHelper.path, ["update", "--json"])
            guard let data = out.data(using: .utf8),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .failure(.message("unexpected output from lut update"))
            }
            if (json["ok"] as? Bool) == true {
                return .success((json["to"] as? String) ?? "?")
            }
            return .failure(.message((json["message"] as? String) ?? "unknown error"))
        } catch {
            return .failure(.message(error.localizedDescription))
        }
    }

    /// Download the release zip, unpack it, and swap this bundle for the new one.
    private func updateApp(from url: URL) async throws {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("lut-app-update-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        var req = URLRequest(url: url)
        req.setValue("UsageTracker/\(appVersion)", forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 300
        let (downloaded, response) = try await URLSession.shared.download(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw UpdateError.message("download returned \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }

        let zip = work.appendingPathComponent("app.zip")
        try fm.moveItem(at: downloaded, to: zip)

        // ditto handles the resource forks and symlinks inside an .app that
        // Foundation's unzip helpers mangle.
        let extracted = work.appendingPathComponent("x")
        try fm.createDirectory(at: extracted, withIntermediateDirectories: true)
        _ = try run("/usr/bin/ditto", ["-x", "-k", zip.path, extracted.path])

        guard let newApp = (try fm.contentsOfDirectory(at: extracted, includingPropertiesForKeys: nil))
            .first(where: { $0.pathExtension == "app" }) else {
            throw UpdateError.message("archive contained no .app")
        }
        // Refuse to install something that isn't actually newer — a mis-tagged
        // release must not be able to walk the app backwards.
        let newInfo = NSDictionary(contentsOf: newApp.appendingPathComponent("Contents/Info.plist"))
        let newVersion = (newInfo?["CFBundleShortVersionString"] as? String) ?? ""
        guard Self.compareVersions(newVersion, appVersion) > 0 else {
            throw UpdateError.message("downloaded build is \(newVersion.isEmpty ? "unversioned" : newVersion), not newer than \(appVersion)")
        }

        let current = Bundle.main.bundleURL
        guard fm.isWritableFile(atPath: current.deletingLastPathComponent().path) else {
            throw UpdateError.message("\(current.deletingLastPathComponent().path) isn't writable — move the app to /Applications or update manually")
        }
        // Atomic swap, keeping the old bundle until the new one is in place.
        _ = try fm.replaceItemAt(current, withItemAt: newApp)
    }

    /// Relaunch into the freshly installed bundle. The detached shell outlives
    /// this process, so `open` runs after we're gone and doesn't just re-focus
    /// the still-running instance.
    func relaunch() {
        let path = Bundle.main.bundleURL.path
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open -n \"\(path)\""]
        try? p.run()
        NSApp.terminate(nil)
    }

    // MARK: - Process helper

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
            throw UpdateError.message(out.isEmpty ? "exit \(proc.terminationStatus)" : out)
        }
        return out
    }

    enum UpdateError: Error, LocalizedError {
        case message(String)
        var errorDescription: String? {
            switch self { case .message(let m): return m }
        }
    }
}

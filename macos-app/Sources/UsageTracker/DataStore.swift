import AppKit
import Foundation
import Combine

enum LoadState: Equatable {
    case idle
    case loading
    case loaded
    case error(String)
}

/// Fetches and holds the aggregates the UI renders, refreshing on demand,
/// on a fallback timer, and live via the server's SSE `/events` stream.
@MainActor
final class DataStore: ObservableObject {
    @Published var summary: Summary?
    @Published var models: [ModelRow] = []
    @Published var categories: [CategoryRow] = []
    @Published var overTime: [OverTimeRow] = []
    @Published var categoriesOverTime: [CategoryOverTimeRow] = []
    @Published var state: LoadState = .idle
    @Published var lastUpdated: Date?
    @Published var live = false

    private let settings: AppSettings
    private var sseTask: Task<Void, Never>?
    private var timer: Timer?
    private var debounceTask: Task<Void, Never>?

    init(settings: AppSettings) {
        self.settings = settings
    }

    var totals: Totals { summary?.totals ?? Totals() }

    private func request(_ path: String, withRange: Bool) -> URLRequest? {
        guard settings.isConfigured else { return nil }
        var urlStr = settings.baseURL + path
        if withRange, settings.rangeDays > 0 {
            urlStr += (path.contains("?") ? "&" : "?") + "days=\(trimmedDays(settings.rangeDays))"
        }
        guard let url = URL(string: urlStr) else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 20
        if let auth = settings.authHeader {
            req.setValue(auth, forHTTPHeaderField: "Authorization")
        }
        return req
    }

    /// Render `0.5` as `0.5` but `7.0` as `7` for the query string.
    private func trimmedDays(_ d: Double) -> String {
        d == d.rounded() ? String(Int(d)) : String(d)
    }

    private func fetch<T: Decodable & Sendable>(_ path: String, as type: T.Type, withRange: Bool = true) async throws -> T {
        guard let req = request(path, withRange: withRange) else {
            throw AppError.notConfigured
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw AppError.network("No response") }
        if http.statusCode == 401 { throw AppError.unauthorized }
        if http.statusCode == 503 { throw AppError.serverLocked }
        guard (200..<300).contains(http.statusCode) else {
            throw AppError.network("HTTP \(http.statusCode)")
        }
        // Decode off the main actor — large all-time payloads would otherwise
        // stall the UI on every refresh.
        return try await Task.detached(priority: .userInitiated) {
            try makeDecoder().decode(T.self, from: data)
        }.value
    }

    func refresh() async {
        guard settings.isConfigured else {
            state = .error("Set a server URL in Settings")
            return
        }
        if state != .loaded { state = .loading }
        do {
            async let summary = fetch("/api/summary", as: Summary.self)
            async let models = fetch("/api/by-model", as: [ModelRow].self)
            async let time = fetch("/api/over-time", as: [OverTimeRow].self)
            // Category endpoints are absent on pre-v1.2 servers — degrade to empty.
            async let cats = fetch("/api/by-category", as: [CategoryRow].self)
            async let catTime = fetch("/api/over-time?by=category", as: [CategoryOverTimeRow].self)

            // Await everything, then assign in one burst — three staggered
            // @Published writes would invalidate every observing view thrice.
            let (s, m, t) = try await (summary, models, time)
            let c = (try? await cats) ?? []
            let ct = (try? await catTime) ?? []
            self.summary = s
            self.models = m
            self.overTime = t
            self.categories = c
            self.categoriesOverTime = ct
            self.lastUpdated = Date()
            self.state = .loaded
        } catch {
            self.state = .error((error as? AppError)?.message ?? error.localizedDescription)
        }
    }

    /// Per-user breakdown for the drill-down view (honours the selected range).
    func userDetail(_ userId: String) async -> Result<UserDetail, AppError> {
        let enc = userId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? userId
        do {
            return .success(try await fetch("/api/by-user/\(enc)", as: UserDetail.self))
        } catch let e as AppError {
            return .failure(e)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }

    /// Quick reachability + auth check, used by the Settings "Test" button.
    func test() async -> Result<String, AppError> {
        do {
            let s = try await fetch("/api/summary", as: Summary.self, withRange: false)
            return .success("Connected — \(s.totals.users) users, \(s.totals.sessions) sessions")
        } catch let e as AppError {
            return .failure(e)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }

    // MARK: - Live updates

    func start() {
        Task { await refresh() }
        startSSE()
        // Fallback poll in case SSE drops or the endpoint is gated differently.
        // Skipped while nothing is visible — a hidden menu-bar app shouldn't
        // hammer the server; we catch up the moment it's looked at again.
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.somethingVisible else { return }
                await self.refresh()
            }
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    private var somethingVisible: Bool {
        NSApp.isActive || NSApp.windows.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
    }

    /// Coalesce bursts of SSE events into one refresh per second; hidden apps
    /// skip entirely (the activate observer / timer catches them up).
    private func scheduleRefresh() {
        guard somethingVisible else { return }
        guard debounceTask == nil else { return }
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            await MainActor.run { self?.debounceTask = nil }
            await self?.refresh()
        }
    }

    func stop() {
        sseTask?.cancel()
        sseTask = nil
        timer?.invalidate()
        timer = nil
        live = false
    }

    /// Reconnect after a settings change.
    func reconnect() {
        stop()
        start()
    }

    private func startSSE() {
        guard let req = request("/events", withRange: false) else { return }
        sseTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                    if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                        await MainActor.run { self?.live = false }
                        throw AppError.network("SSE HTTP \(http.statusCode)")
                    }
                    await MainActor.run { self?.live = true }
                    // Refresh only on real `session` events (each frame is an
                    // `event:` line then a `data:` line — reacting to both
                    // doubled every refresh, and heartbeat pings shouldn't
                    // trigger any).
                    var currentEvent = ""
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line.hasPrefix("event:") {
                            currentEvent = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:"), currentEvent == "session" {
                            await self?.scheduleRefresh()
                        }
                    }
                } catch {
                    await MainActor.run { self?.live = false }
                }
                if Task.isCancelled { break }
                // Backoff before reconnecting.
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }
}

enum AppError: Error {
    case notConfigured
    case unauthorized
    case serverLocked
    case network(String)

    var message: String {
        switch self {
        case .notConfigured: return "No server URL configured"
        case .unauthorized: return "Unauthorized — check username/password"
        case .serverLocked: return "Server auth not configured (503)"
        case .network(let m): return m
        }
    }
}

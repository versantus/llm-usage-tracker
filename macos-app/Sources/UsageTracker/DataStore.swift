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
    @Published var overTime: [OverTimeRow] = []
    @Published var state: LoadState = .idle
    @Published var lastUpdated: Date?
    @Published var live = false

    private let settings: AppSettings
    private var sseTask: Task<Void, Never>?
    private var timer: Timer?

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

    private func fetch<T: Decodable>(_ path: String, as type: T.Type, withRange: Bool = true) async throws -> T {
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
        return try makeDecoder().decode(T.self, from: data)
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
            self.summary = try await summary
            self.models = try await models
            self.overTime = try await time
            self.lastUpdated = Date()
            self.state = .loaded
        } catch {
            self.state = .error((error as? AppError)?.message ?? error.localizedDescription)
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
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
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
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        // Any data frame means something changed -> refresh.
                        if line.hasPrefix("data:") || line.hasPrefix("event:") {
                            await self?.refresh()
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
